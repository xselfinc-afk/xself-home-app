/**
 * Inventory-automation config defaults + pure safety-limit policy tests.
 * Run: npx tsx src/__tests__/inventorySafetyLimits.test.ts
 */
import assert from 'node:assert/strict';
import {
  INVENTORY_AUTOMATION_DEFAULTS, applyInventoryConfigRow,
  evaluateSourceScanAllowed, evaluateDelistBatchAllowed, evaluateFailureRateAllowed,
  type InventoryAutomationConfig,
} from '../services/inventoryAutomationConfig';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('inventory automation safety limits');

it('DEFAULTS ship all automation + catalog mutation DISABLED', () => {
  const d = INVENTORY_AUTOMATION_DEFAULTS;
  assert.equal(d.automationEnabled, false);
  assert.equal(d.pickupScanEnabled, false);
  assert.equal(d.dropshipScanEnabled, false);
  assert.equal(d.autoDelistEnabled, false);
  assert.equal(d.autoRelistEnabled, false);
  assert.equal(d.caPriorityEnabled, false);
  assert.equal(d.checkoutRevalidationEnabled, false);
  assert.equal(d.bulkChangeRequiresApproval, true);
  assert.equal(d.outOfStockConfirmations, 2);
  assert.equal(d.relistConfirmations, 2);
  // 500 covers the whole published catalogue (353) in one run without truncating it.
  assert.equal(d.maxScanPerRun, 500);
  assert.equal(d.maxDelistPerRun, 5);
  assert.equal(d.maxDelistPercent, 5);
  // Browser-free Open API scan — disabled by default like every other source.
  assert.equal(d.apiScanEnabled, false);
  assert.equal(d.maxFailurePercent, 20);
});

it('EVERY boolean config field is registered in BOOL_FIELDS', () => {
  // A boolean absent from BOOL_FIELDS parses through the integer branch, where parseInt('true')
  // is NaN and the row is dropped: the switch looks enabled in the database but does nothing.
  // This caught inventory_api_scan_enabled and inventory_visibility_enforcement_enabled during the
  // Step 3 rollout, after the config rows had already been written.
  const d = INVENTORY_AUTOMATION_DEFAULTS;
  for (const [field, value] of Object.entries(d)) {
    if (typeof value !== 'boolean') continue;
    const key = Object.entries({
      automationEnabled: 'inventory_automation_enabled',
      pickupScanEnabled: 'inventory_pickup_scan_enabled',
      dropshipScanEnabled: 'inventory_dropship_scan_enabled',
      apiScanEnabled: 'inventory_api_scan_enabled',
      autoDelistEnabled: 'inventory_auto_delist_enabled',
      autoRelistEnabled: 'inventory_auto_relist_enabled',
      bulkChangeRequiresApproval: 'inventory_bulk_change_requires_approval',
      caPriorityEnabled: 'inventory_ca_priority_enabled',
      checkoutRevalidationEnabled: 'inventory_checkout_revalidation_enabled',
      visibilityEnforcementEnabled: 'inventory_visibility_enforcement_enabled',
    }).find(([f]) => f === field)?.[1];
    assert.ok(key, `boolean field ${field} has no config key mapping`);
    const flipped = applyInventoryConfigRow({ ...d }, key!, 'true');
    assert.equal((flipped as Record<string, unknown>)[field], true,
      `config key ${key} does not flip ${field} — it is probably missing from BOOL_FIELDS`);
  }
});

it('open_api is a first-class scan source, gated off by default', () => {
  const d = { ...INVENTORY_AUTOMATION_DEFAULTS };
  assert.deepEqual(evaluateSourceScanAllowed(d, 'open_api').blocks.sort(),
    ['automation_disabled', 'source_disabled']);
  const on = { ...d, automationEnabled: true, apiScanEnabled: true };
  assert.equal(evaluateSourceScanAllowed(on, 'open_api').allowed, true);
  // Enabling the API scan must not enable the browser sources.
  assert.equal(evaluateSourceScanAllowed(on, 'pickup').allowed, false);
  assert.equal(evaluateSourceScanAllowed(on, 'dropship').allowed, false);
});

it('failure-rate abort: a run that could not read the catalogue changes nothing', () => {
  const d = { ...INVENTORY_AUTOMATION_DEFAULTS };
  assert.equal(evaluateFailureRateAllowed(d, 0).allowed, true);
  assert.equal(evaluateFailureRateAllowed(d, 20).allowed, true);   // at the limit
  assert.equal(evaluateFailureRateAllowed(d, 20.01).allowed, false);
  assert.deepEqual(evaluateFailureRateAllowed(d, 55).blocks, ['exceeds_max_failure_percent']);
});

it('config row parse: booleans + positive ints; junk ignored', () => {
  let c = { ...INVENTORY_AUTOMATION_DEFAULTS };
  c = applyInventoryConfigRow(c, 'inventory_automation_enabled', 'true');
  c = applyInventoryConfigRow(c, 'inventory_max_delist_per_run', '10');
  c = applyInventoryConfigRow(c, 'inventory_max_delist_per_run', 'abc'); // ignored
  c = applyInventoryConfigRow(c, 'unknown_key', 'true');                 // ignored
  assert.equal(c.automationEnabled, true);
  assert.equal(c.maxDelistPerRun, 10);
});

const enabled = (over: Partial<InventoryAutomationConfig> = {}): InventoryAutomationConfig => ({
  ...INVENTORY_AUTOMATION_DEFAULTS, automationEnabled: true, autoDelistEnabled: true,
  pickupScanEnabled: true, dropshipScanEnabled: true, ...over,
});

it('source scan blocked when automation disabled', () => {
  const r = evaluateSourceScanAllowed({ ...INVENTORY_AUTOMATION_DEFAULTS, pickupScanEnabled: true }, 'pickup');
  assert.equal(r.allowed, false);
  assert.ok(r.blocks.includes('automation_disabled'));
});

it('source scan blocked when that source disabled', () => {
  const r = evaluateSourceScanAllowed({ ...enabled(), dropshipScanEnabled: false }, 'dropship');
  assert.equal(r.allowed, false);
  assert.ok(r.blocks.includes('source_disabled'));
});

it('delist batch blocked when auto-delist disabled (the Phase-1 default)', () => {
  const r = evaluateDelistBatchAllowed(INVENTORY_AUTOMATION_DEFAULTS, { proposedDelistCount: 1, totalPublished: 100 });
  assert.equal(r.allowed, false);
  assert.ok(r.blocks.includes('automation_disabled'));
  assert.ok(r.blocks.includes('auto_delist_disabled'));
});

it('delist batch blocked when exceeding max_delist_per_run', () => {
  const r = evaluateDelistBatchAllowed(enabled({ maxDelistPerRun: 5, maxDelistPercent: 100 }), { proposedDelistCount: 6, totalPublished: 100 });
  assert.equal(r.allowed, false);
  assert.ok(r.blocks.includes('exceeds_max_delist_per_run'));
  assert.ok(r.blocks.includes('requires_human_approval'));
});

it('delist batch blocked when exceeding max_delist_percent', () => {
  const r = evaluateDelistBatchAllowed(enabled({ maxDelistPerRun: 100, maxDelistPercent: 5 }), { proposedDelistCount: 10, totalPublished: 100 });
  assert.equal(r.allowed, false);
  assert.ok(r.blocks.includes('exceeds_max_delist_percent'));
});

it('abnormal bulk change requires approval when over caps', () => {
  const r = evaluateDelistBatchAllowed(enabled({ maxDelistPerRun: 2, bulkChangeRequiresApproval: true }), { proposedDelistCount: 50, totalPublished: 100 });
  assert.ok(r.blocks.includes('requires_human_approval'));
});

it('within-cap delist allowed only when fully enabled', () => {
  const r = evaluateDelistBatchAllowed(enabled({ maxDelistPerRun: 5, maxDelistPercent: 50 }), { proposedDelistCount: 3, totalPublished: 100 });
  assert.equal(r.allowed, true);
  assert.equal(r.blocks.length, 0);
});

console.log(`\n${passed} passed`);
