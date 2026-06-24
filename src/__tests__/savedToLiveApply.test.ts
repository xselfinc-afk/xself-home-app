/**
 * Saved-to-live APPLY decision-logic tests — pure; no network, no DB, no secrets, no orchestrator run.
 * The orchestrator is import-safe (require.main guard), so importing it does NOT trigger a GIGA call.
 * Run: npx tsx src/__tests__/savedToLiveApply.test.ts
 */
import assert from 'node:assert/strict';
import { classifyPublishApply, collectLiveAndHeld, classifyFeeText, computeApplyScopes } from '../../scripts/gigaSavedToLiveOrchestrator';
import { maskClientId, deliveryCredsStatus, MISSING_CREDS_HELP } from '../../scripts/lib/deliveryCreds';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('Saved-to-live APPLY decision tests');

// G1: publish exit 2 with partial-success report (10 published, 9 in_stock) → partial, not full failure
it('classifyPublishApply: exit 2 + progress → partial success (not hard stop)', () => {
  const c = classifyPublishApply(
    { ok: false, exit_code: 2, stop_reason: null },
    { results: { published: 10, normalized: 10, titled: 10, priced: 10, inventory_in_stock: 9 }, reached_stage: 'inventory' },
  );
  assert.equal(c.hardStop, false);
  assert.equal(c.partialSuccess, true);
  assert.equal(c.fullSuccess, false);
});

// G2: hard-stop tokens → hard abort preserved, no partial
it('classifyPublishApply: hard-stop token → hardStop, no partial', () => {
  for (const tok of ['permission_b20003', 'captcha_or_login', 'http_401_403', 'rate_limited', 'unknown_response_shape']) {
    const c = classifyPublishApply({ ok: false, exit_code: 2, stop_reason: tok }, { results: { published: 10 } });
    assert.equal(c.hardStop, true);
    assert.equal(c.partialSuccess, false);
    assert.equal(c.stopReason, tok);
  }
});

it('classifyPublishApply: exit 0 → full success (not partial, not hard)', () => {
  const c = classifyPublishApply({ ok: true, exit_code: 0, stop_reason: null }, { results: { published: 10 } });
  assert.equal(c.fullSuccess, true); assert.equal(c.partialSuccess, false); assert.equal(c.hardStop, false);
});

it('classifyPublishApply: exit 2 + zero progress → neither partial nor hard', () => {
  const c = classifyPublishApply({ ok: false, exit_code: 2, stop_reason: null }, { results: { published: 0, normalized: 0 }, reached_stage: 'plan' });
  assert.equal(c.hardStop, false); assert.equal(c.partialSuccess, false); assert.equal(c.fullSuccess, false);
});

// G1 (live/held): 10 scoped, 9 live, 1 held (inventory unknown/0) → fee scope = 9, held listed
it('collectLiveAndHeld: 9 live, 1 held due to inventory unknown/0', () => {
  const scope = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'B062P331054'];
  const liveSet = new Set(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  const ok = { normalization_status: 'done', published: true, inventory_status: 'in_stock', total_available_qty: 10, product_title: 't', primary_image: 'x', price: 1, selling_price: 2 };
  const stdBySku = new Map<string, any>([
    ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map(s => [s, ok] as [string, any]),
    ['B062P331054', { normalization_status: 'done', published: false, inventory_status: 'unknown', total_available_qty: 0, product_title: 't', primary_image: 'x', price: 1, selling_price: 2 }],
  ]);
  const r = collectLiveAndHeld(scope, liveSet, stdBySku);
  assert.equal(r.actualLiveSkus.length, 9);
  assert.equal(r.heldSkus.length, 1);
  assert.equal(r.heldSkus[0].sku, 'B062P331054');
  assert.ok(/inventory/.test(r.heldSkus[0].reason), `reason should mention inventory, got: ${r.heldSkus[0].reason}`);
});

// D: fee-text classification drives the needs_* buckets
it('classifyFeeText: detects creds-missing / no-mapping / hard-stop', () => {
  assert.equal(classifyFeeText('Official fetch: official_creds_missing → all SKUs use portal fallback').credsMissing, true);
  assert.equal(classifyFeeText(' Official    : NO creds → portal fallback only').credsMissing, true);
  assert.equal(classifyFeeText('• preserved W1  official=...; no portal mapping; ...').noMapping, true);
  assert.equal(classifyFeeText('• preserved W1  official=unavailable(no_row); ...').officialNoRow, true);
  assert.equal(classifyFeeText('error B20003 permission invalid').hardStop, 'permission_b20003');
  assert.equal(classifyFeeText('9 official, 0 portal-fallback').hardStop, null);
});

// A: credential masking — never reveals the full id or the secret
it('maskClientId never reveals full id / secret', () => {
  assert.equal(maskClientId(''), '(none)');
  assert.equal(maskClientId(null), '(none)');
  assert.equal(maskClientId('ab'), '****');
  const m = maskClientId('35db1234567890');
  assert.ok(m.startsWith('35db'));
  assert.ok(!m.includes('1234567890'), 'masked id must not contain the rest of the client id');
});

// A: missing creds → clear recovery help, no secret, no crash
it('deliveryCredsStatus: missing creds → recovery help (no secret)', () => {
  const savedId = process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID;
  const savedSec = process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET;
  delete process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID;
  delete process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET;
  const s = deliveryCredsStatus();
  assert.equal(s.present, false);
  assert.equal(s.line, MISSING_CREDS_HELP);
  if (savedId !== undefined) process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID = savedId;
  if (savedSec !== undefined) process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET = savedSec;
});

// A/B (D1/D2): would_import=0 → import skipped; 5 publishable; B062 (missing_inventory) held, not published
it('computeApplyScopes: would_import=0 → import scope empty, 5 publishable, B062 pre-held', () => {
  const already = ['SJ000159AAN', 'N721S000044K-1', 'N711P345166B', 'N711P410389B', 'N721S000064K']
    .map(sku => ({ sku, status: 'already_imported', would_import: false, would_publish: true }));
  const rows = [
    ...already,
    { sku: 'B062P331054', status: 'missing_inventory', would_import: false, would_publish: true, inventory_status: 'unknown', total_available_qty: 0 },
    { sku: 'W409P327401', status: 'ready', would_import: false, would_publish: false }, // already live → not in scope at all
  ];
  const s = computeApplyScopes(rows);
  assert.deepEqual(s.importSkus, []);                                       // nothing new → import skipped
  assert.deepEqual([...s.publishSkus].sort(), [...already.map(r => r.sku)].sort()); // exactly the 5 publishable
  assert.equal(s.publishSkus.includes('B062P331054'), false);              // missing_inventory excluded from publish
  assert.equal(s.publishSkus.includes('W409P327401'), false);              // 'ready' (not in scope) excluded
  assert.equal(s.preHeldSkus.length, 1);
  assert.equal(s.preHeldSkus[0].sku, 'B062P331054');
  assert.ok(/missing_inventory/.test(s.preHeldSkus[0].reason), `held reason should mention missing_inventory, got: ${s.preHeldSkus[0].reason}`);
});

// D3: import scope includes only would_import rows (and those are also publishable after import)
it('computeApplyScopes: would_import row → import scope; out_of_stock excluded from publish', () => {
  const rows = [
    { sku: 'NEW1', status: 'new', would_import: true, would_publish: false },
    { sku: 'OLD1', status: 'already_imported', would_import: false, would_publish: true },
    { sku: 'OOS1', status: 'missing_inventory', would_import: false, would_publish: true, inventory_status: 'out_of_stock', total_available_qty: 0 },
  ];
  const s = computeApplyScopes(rows);
  assert.deepEqual(s.importSkus, ['NEW1']);                                 // only would_import
  assert.deepEqual([...s.publishSkus].sort(), ['NEW1', 'OLD1']);            // new (after import) + already-imported
  assert.deepEqual(s.preHeldSkus.map(h => h.sku), ['OOS1']);               // missing_inventory pre-held
});

console.log(`\n${passed} saved-to-live apply assertions passed.`);
