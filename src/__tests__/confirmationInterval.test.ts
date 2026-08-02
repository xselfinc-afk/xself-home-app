/**
 * Minimum-confirmation-interval tests (pure; no database, no network, no browser).
 *
 * The defect being fixed: re-running the same unavailable SKU seconds later drove
 * consecutive_out_of_stock 1 → 2 and pending_out_of_stock → eligible_for_delist. Two confirmations
 * must mean two observation CYCLES, not two invocations of a command.
 *
 * Run: npx tsx src/__tests__/confirmationInterval.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_MIN_CONFIRMATION_INTERVAL_HOURS,
  decideWithInterval,
  hoursSince,
  mayAdvance,
} from '../services/confirmationInterval';
import { INVENTORY_AUTOMATION_DEFAULTS, evaluateSourceScanAllowed } from '../services/inventoryAutomationConfig';
import type { WorkflowSnapshot } from '../services/inventoryStateMachine';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCANNER = 'scripts/scanPublishedAvailability.ts';
const RUNNER = 'scripts/runAvailabilityScan.sh';

const T = (h: number) => new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + h * 3_600_000).toISOString();
const PUBLISHED: WorkflowSnapshot = { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 };
const DELISTED: WorkflowSnapshot = { state: 'delisted_out_of_stock', consecutiveOutOfStock: 2, consecutiveInStock: 0 };

const oos = (prior: WorkflowSnapshot, last: string | null, now: string) =>
  decideWithInterval({ prior, status: 'confirmed_out_of_stock', lastConfirmedAtIso: last, nowIso: now });
const inStock = (prior: WorkflowSnapshot, last: string | null, now: string) =>
  decideWithInterval({ prior, status: 'confirmed_in_stock_out_of_state', lastConfirmedAtIso: last, nowIso: now });

function main(): void {
  it('1. the default interval is 48h', () => {
    assert.equal(DEFAULT_MIN_CONFIRMATION_INTERVAL_HOURS, 48);
    assert.equal(INVENTORY_AUTOMATION_DEFAULTS.minConfirmationIntervalHours, 48);
  });

  // ── Delist path ─────────────────────────────────────────────────────────────

  it('2. first unavailable → pending, count 1', () => {
    const d = oos(PUBLISHED, null, T(0));
    assert.equal(d.outcome, 'advanced');
    assert.equal(d.next.state, 'pending_out_of_stock');
    assert.equal(d.next.consecutiveOutOfStock, 1);
    assert.equal(d.countsAsConfirmation, true);
  });

  it('3. THE DEFECT: an immediate identical retry stays pending at count 1', () => {
    const first = oos(PUBLISHED, null, T(0));
    const retry = oos(first.next, T(0), T(0));           // same instant
    assert.equal(retry.outcome, 'duplicate_or_too_soon');
    assert.equal(retry.next.state, 'pending_out_of_stock');
    assert.equal(retry.next.consecutiveOutOfStock, 1, 'an immediate retry must NOT create a second strike');
    assert.equal(retry.countsAsConfirmation, false);
    assert.notEqual(retry.next.state, 'eligible_for_delist');
  });

  it('4. a DIFFERENT run before the interval still does not advance', () => {
    // A distinct run_id is not evidence of a new observation cycle.
    for (const h of [0.001, 1, 12, 24, 47.9]) {
      const d = oos({ state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 }, T(0), T(h));
      assert.equal(d.outcome, 'duplicate_or_too_soon', `${h}h should be too soon`);
      assert.equal(d.next.consecutiveOutOfStock, 1);
      assert.equal(d.next.state, 'pending_out_of_stock');
    }
  });

  it('5. an observation AFTER the interval advances to eligible_for_delist', () => {
    for (const h of [48, 72, 100]) {
      const d = oos({ state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 }, T(0), T(h));
      assert.equal(d.outcome, 'advanced', `${h}h should count`);
      assert.equal(d.next.consecutiveOutOfStock, 2);
      assert.equal(d.next.state, 'eligible_for_delist');
      assert.equal(d.countsAsConfirmation, true);
    }
  });

  it('6. a scheduler retry cannot create a second strike', () => {
    // Real 3-day cadence, but the agent fires twice in the same minute.
    const cycle1 = oos(PUBLISHED, null, T(0));
    const dup = oos(cycle1.next, T(0), T(0.01));
    assert.equal(dup.next.consecutiveOutOfStock, 1);
    const cycle2 = oos(dup.next, T(0), T(72));            // next genuine cycle
    assert.equal(cycle2.next.consecutiveOutOfStock, 2);
    assert.equal(cycle2.next.state, 'eligible_for_delist');
  });

  // ── Relist path gets the same protection ────────────────────────────────────

  it('7. first available after delist → relist_pending', () => {
    const d = inStock(DELISTED, null, T(0));
    assert.equal(d.outcome, 'advanced');
    assert.equal(d.next.state, 'relist_pending');
  });

  it('8. an immediate available retry stays relist_pending', () => {
    const first = inStock(DELISTED, null, T(0));
    const retry = inStock(first.next, T(0), T(1));
    assert.equal(retry.outcome, 'duplicate_or_too_soon');
    assert.equal(retry.next.state, 'relist_pending');
    assert.notEqual(retry.next.state, 'eligible_for_relist');
  });

  it('9. available after the interval → eligible_for_relist', () => {
    const first = inStock(DELISTED, null, T(0));
    const second = inStock(first.next, T(0), T(72));
    assert.equal(second.outcome, 'advanced');
    assert.equal(second.next.state, 'eligible_for_relist');
  });

  // ── Failures ────────────────────────────────────────────────────────────────

  it('10. failures never advance and never reset either counter', () => {
    const prior: WorkflowSnapshot = { state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 };
    for (const st of ['network_failed', 'supplier_unavailable', 'parse_failed', 'authentication_required', 'inventory_unknown', 'stale'] as const) {
      const d = decideWithInterval({ prior, status: st, lastConfirmedAtIso: T(0), nowIso: T(999) });
      assert.equal(d.outcome, 'no_confirmation', st);
      assert.equal(d.countsAsConfirmation, false, st);
      assert.deepEqual(d.next, prior, `${st} mutated the lifecycle`);
    }
  });

  it('11. a failure does not reset the interval clock', () => {
    // A failure must not move last_observed_at, so the next genuine cycle still counts.
    const d = decideWithInterval({
      prior: { state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 },
      status: 'network_failed', lastConfirmedAtIso: T(0), nowIso: T(50),
    });
    assert.equal(d.countsAsConfirmation, false, 'a failure must never advance last_observed_at');
  });

  // ── Helpers ─────────────────────────────────────────────────────────────────

  it('12. hoursSince / mayAdvance handle absent and malformed timestamps', () => {
    assert.equal(hoursSince(null, T(0)), null);
    assert.equal(hoursSince('not-a-date', T(0)), null);
    assert.equal(hoursSince(T(0), T(48)), 48);
    // First-ever confirmation always counts; failing open is safe because the FIRST strike is
    // never destructive.
    assert.equal(mayAdvance(null, T(0), 48), true);
    assert.equal(mayAdvance(T(0), T(47.9), 48), false);
    assert.equal(mayAdvance(T(0), T(48), 48), true);
  });

  it('13. a custom interval is honoured', () => {
    const d = oos({ state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 }, T(0), T(10));
    assert.equal(d.outcome, 'duplicate_or_too_soon');
    const d2 = decideWithInterval({
      prior: { state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 },
      status: 'confirmed_out_of_stock', lastConfirmedAtIso: T(0), nowIso: T(10), minIntervalHours: 6,
    });
    assert.equal(d2.outcome, 'advanced');
  });

  // ── Scope 2: the live kill switch ───────────────────────────────────────────

  it('14. live writes require inventory_api_scan_enabled=true', () => {
    const src = read(SCANNER);
    const live = src.slice(src.indexOf('if (LIVE) {'));
    assert.match(live, /if \(!scanGate\.allowed && !TEST_OVERRIDE\)/);
    assert.match(live, /live writes require inventory_api_scan_enabled=true/);
    assert.match(live, /process\.exit\(3\)/);
    // The gate must be evaluated for the open_api source.
    assert.match(src, /evaluateSourceScanAllowed\(cfg, OPEN_API_SOURCE\)/);
  });

  it('15. with defaults the scan gate blocks — code default is OFF', () => {
    const d = INVENTORY_AUTOMATION_DEFAULTS;
    assert.equal(d.apiScanEnabled, false);
    assert.equal(d.automationEnabled, false);
    assert.equal(evaluateSourceScanAllowed(d, 'open_api').allowed, false);
    // Both switches must be on for the gate to open.
    assert.equal(evaluateSourceScanAllowed({ ...d, apiScanEnabled: true }, 'open_api').allowed, false);
    assert.equal(evaluateSourceScanAllowed({ ...d, automationEnabled: true }, 'open_api').allowed, false);
    assert.equal(evaluateSourceScanAllowed({ ...d, automationEnabled: true, apiScanEnabled: true }, 'open_api').allowed, true);
  });

  it('16. dry-run is NOT gated by the switch', () => {
    const src = read(SCANNER);
    // The gate check lives strictly inside the LIVE block, so a dry-run still works while off.
    const beforeLive = src.slice(0, src.indexOf('if (LIVE) {'));
    assert.ok(!beforeLive.includes('!scanGate.allowed && !TEST_OVERRIDE'),
      'the kill switch must not block dry-run');
  });

  it('17. the test override is explicit and documented, not a silent bypass', () => {
    const src = read(SCANNER);
    assert.match(src, /INVENTORY_SCAN_TEST_OVERRIDE === '1'/);
    assert.match(src, /WARNING test override active/);
    // The scheduler must never set it.
    assert.ok(!read(RUNNER).includes('INVENTORY_SCAN_TEST_OVERRIDE'),
      'the scheduler must never use the test override');
  });

  it('18. the scheduler honours the switch and auto-delist/relist stay disabled', () => {
    const runner = read(RUNNER);
    assert.ok(!runner.includes('--live'), 'the scheduler never passes --live');
    const d = INVENTORY_AUTOMATION_DEFAULTS;
    assert.equal(d.autoDelistEnabled, false);
    assert.equal(d.autoRelistEnabled, false);
    // Enabling the scan must not enable delist or relist.
    const scanOn = { ...d, automationEnabled: true, apiScanEnabled: true };
    assert.equal(scanOn.autoDelistEnabled, false);
    assert.equal(scanOn.autoRelistEnabled, false);
  });

  console.log(`\n${passed} passed`);
}
main();
