/**
 * Availability persistence tests (pure; no database, no network, no browser).
 *
 * Phase 1 writes evidence and lifecycle only. The two properties that must hold no matter what:
 *   1. A failed read can NEVER become a zero, and can never displace the last confirmed answer.
 *   2. No publication field can be written — not by convention, but provably.
 *
 * Run: npx tsx src/__tests__/availabilityPersistence.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FORBIDDEN_WRITE_COLUMNS,
  FORBIDDEN_WRITE_TABLES,
  assertNoPublicationWrite,
  planPersistence,
  tallyPlans,
  type PriorCurrentRow,
} from '../services/availabilityPersistence';
import { classifyBatch, type AvailabilityResult, type BatchOutcome } from '../services/openApiAvailability';
import { transitionInventoryState, type WorkflowSnapshot } from '../services/inventoryStateMachine';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCANNER = 'scripts/scanPublishedAvailability.ts';

const RUN = 'run-1';
const T0 = '2026-08-01T00:00:00.000Z';
const T1 = '2026-08-04T00:00:00.000Z';

const res = (sku: string, outcome: BatchOutcome): AvailabilityResult => classifyBatch([sku], outcome)[0];
const okRow = (sku: string, avail: boolean) => res(sku, { kind: 'ok', rows: [{ sku, skuAvailable: avail }] });

const prior = (over: Partial<PriorCurrentRow> = {}): PriorCurrentRow => ({
  supplier_product_id: 'A', available: true, status: 'confirmed_available',
  checked_at: T0, last_confirmed_available_at: T0, last_confirmed_unavailable_at: null,
  consecutive_failures: 0, ...over,
});

function main(): void {
  // ── Confirmed answers persist ───────────────────────────────────────────────

  it('1. live available result persists available=true', () => {
    const p = planPersistence(okRow('A', true), null, RUN, T0);
    assert.equal(p.currentUpsert?.available, true);
    assert.equal(p.currentUpsert?.status, 'confirmed_available');
    assert.equal(p.currentUpsert?.last_confirmed_available_at, T0);
    assert.equal(p.currentUpsert?.last_confirmed_unavailable_at, null);
    assert.equal(p.checkRow.available, true);
    assert.equal(p.failureUpdate, null);
  });

  it('2. live unavailable result persists available=false and first-strike state', () => {
    const r = okRow('A', false);
    const p = planPersistence(r, null, RUN, T0);
    assert.equal(p.currentUpsert?.available, false);
    assert.equal(p.currentUpsert?.status, 'confirmed_out_of_stock');
    assert.equal(p.currentUpsert?.last_confirmed_unavailable_at, T0);

    // First strike in the lifecycle: pending, NOT delist-eligible.
    const snap: WorkflowSnapshot = { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 };
    const tr = transitionInventoryState(snap, r.inventoryStatus);
    assert.equal(tr.next.state, 'pending_out_of_stock');
    assert.equal(tr.next.consecutiveOutOfStock, 1);
    assert.notEqual(tr.proposedAction, 'propose_delist');
  });

  it('3. a second consecutive unavailable advances to delist eligibility', () => {
    const r = okRow('A', false);
    const first = transitionInventoryState(
      { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 }, r.inventoryStatus);
    const second = transitionInventoryState(first.next, r.inventoryStatus);
    assert.equal(second.next.consecutiveOutOfStock, 2);
    assert.equal(second.next.state, 'eligible_for_delist');
    assert.equal(second.proposedAction, 'propose_delist');
  });

  it('4. relist needs two confirmations too', () => {
    const up = okRow('A', true);
    const delisted: WorkflowSnapshot = { state: 'delisted_out_of_stock', consecutiveOutOfStock: 2, consecutiveInStock: 0 };
    const one = transitionInventoryState(delisted, up.inventoryStatus);
    assert.equal(one.next.state, 'relist_pending');
    assert.notEqual(one.proposedAction, 'propose_relist');
    const two = transitionInventoryState(one.next, up.inventoryStatus);
    assert.equal(two.next.state, 'eligible_for_relist');
    assert.equal(two.proposedAction, 'propose_relist');
  });

  // ── Failures are inert ──────────────────────────────────────────────────────

  it('5. API failure never writes availability and never advances the zero count', () => {
    const failures: BatchOutcome[] = [
      { kind: 'network_error', message: 'ETIMEDOUT' },
      { kind: 'rate_limited', message: '429' },
      { kind: 'api_error', message: 'HTTP 500' },
      { kind: 'malformed', message: 'bad json' },
      { kind: 'ok', rows: { code: 0, error: 'Oops' } },
    ];
    for (const f of failures) {
      const r = res('A', f);
      const p = planPersistence(r, prior(), RUN, T1);
      assert.equal(p.currentUpsert, null, `${r.status} must not write the current row`);
      assert.equal(p.checkRow.available, null);
      // Counters must not move.
      const snap: WorkflowSnapshot = { state: 'pending_out_of_stock', consecutiveOutOfStock: 1, consecutiveInStock: 0 };
      const tr = transitionInventoryState(snap, r.inventoryStatus);
      assert.equal(tr.next.consecutiveOutOfStock, 1, `${r.status} advanced the zero count`);
      assert.equal(tr.next.state, 'pending_out_of_stock');
      assert.ok(tr.isException);
    }
  });

  it('6. a failure annotates telemetry but leaves the confirmed answer standing', () => {
    const p = planPersistence(res('A', { kind: 'network_error', message: 'ETIMEDOUT' }), prior({ available: true }), RUN, T1);
    assert.equal(p.currentUpsert, null);
    assert.equal(p.failureUpdate?.consecutive_failures, 1);
    assert.equal(p.failureUpdate?.last_failure_status, 'network_failed');
    // Nothing in the failure patch can change availability.
    assert.ok(!('available' in (p.failureUpdate as object)));
    assert.ok(!('status' in (p.failureUpdate as object)));
  });

  it('7. a failure with NO prior row invents nothing', () => {
    const p = planPersistence(res('A', { kind: 'api_error', message: 'boom' }), null, RUN, T0);
    assert.equal(p.currentUpsert, null);
    assert.equal(p.failureUpdate, null, 'must not fabricate a current row from a failed read');
    assert.equal(p.checkRow.status, 'api_failed');   // still audited
  });

  it('8. a SKU missing from the response does not become unavailable', () => {
    const r = res('B', { kind: 'ok', rows: [{ sku: 'A', skuAvailable: true }] });
    assert.equal(r.status, 'missing_sku');
    const p = planPersistence(r, prior({ supplier_product_id: 'B' }), RUN, T1);
    assert.equal(p.currentUpsert, null);
    assert.notEqual(p.checkRow.available, false);
    assert.equal(p.checkRow.available, null);
  });

  it('9. a confirmed answer clears the failure streak', () => {
    const p = planPersistence(okRow('A', true), prior({ consecutive_failures: 4 }), RUN, T1);
    assert.equal(p.currentUpsert?.consecutive_failures, 0);
  });

  // ── Idempotency ─────────────────────────────────────────────────────────────

  it('10. planning is pure and an identical re-run is idempotent', () => {
    const r = okRow('A', true);
    assert.deepEqual(planPersistence(r, null, RUN, T0), planPersistence(r, null, RUN, T0));
    // Re-running against the state it just wrote reports the answer as unchanged.
    const again = planPersistence(r, prior({ available: true, status: 'confirmed_available' }), RUN, T1);
    assert.equal(again.currentUnchanged, true);
    assert.equal(again.currentUpsert?.available, true);
  });

  it('11. a changed answer is NOT reported as unchanged', () => {
    const p = planPersistence(okRow('A', false), prior({ available: true, status: 'confirmed_available' }), RUN, T1);
    assert.equal(p.currentUnchanged, false);
    // The available history is preserved while the unavailable side is stamped.
    assert.equal(p.currentUpsert?.last_confirmed_available_at, T0);
    assert.equal(p.currentUpsert?.last_confirmed_unavailable_at, T1);
  });

  it('12. tally reports inserted / unchanged / failure counts', () => {
    const plans = [
      planPersistence(okRow('A', true), null, RUN, T0),
      planPersistence(okRow('B', false), null, RUN, T0),
      planPersistence(res('C', { kind: 'network_error', message: 'x' }), prior({ supplier_product_id: 'C' }), RUN, T0),
      planPersistence(okRow('D', true), prior({ supplier_product_id: 'D' }), RUN, T0),
    ];
    const t = tallyPlans(plans);
    assert.equal(t.total, 4);
    assert.equal(t.confirmed, 3);
    assert.equal(t.failures, 1);
    assert.equal(t.failureAnnotations, 1);
    assert.equal(t.unchanged, 1);   // D
  });

  // ── No publication mutation is possible ─────────────────────────────────────

  it('13. no plan may carry a publication column', () => {
    const plans = [
      planPersistence(okRow('A', true), null, RUN, T0),
      planPersistence(okRow('B', false), prior({ supplier_product_id: 'B' }), RUN, T0),
      planPersistence(res('C', { kind: 'api_error', message: 'x' }), prior({ supplier_product_id: 'C' }), RUN, T0),
    ];
    assert.doesNotThrow(() => assertNoPublicationWrite(plans));
    // The guard actually fires when violated.
    const tainted = [{ ...plans[0], checkRow: { ...plans[0].checkRow, published: false } as never }];
    assert.throws(() => assertNoPublicationWrite(tainted as never), /publication column "published"/);
  });

  it('14. the live writer contains NO write against any forbidden table', () => {
    const src = read(SCANNER);
    for (const t of FORBIDDEN_WRITE_TABLES) {
      const write = new RegExp(`from\\('${t}'\\)[\\s\\S]{0,120}?\\.(insert|update|upsert|delete)\\(`);
      assert.ok(!write.test(src), `scanner writes to forbidden table ${t}`);
    }
    // And it never names a publication column in a payload.
    for (const c of FORBIDDEN_WRITE_COLUMNS) {
      assert.ok(!new RegExp(`^\\s*${c}:`, 'm').test(src), `scanner sets forbidden column ${c}`);
    }
    // It must not call the publication authority either.
    assert.ok(!src.includes('refresh_product_inventory_status'), 'scanner must not invoke the publication writer');
  });

  it('15. only the three permitted tables are written', () => {
    const src = read(SCANNER);
    const writes = [...src.matchAll(/from\('([a-z_]+)'\)\s*\n?\s*\.(insert|update|upsert|delete)\(/g)].map(m => m[1]);
    const allowed = new Set(['product_availability_checks', 'product_availability_current', 'inventory_workflow_states']);
    for (const w of writes) assert.ok(allowed.has(w), `unexpected write target: ${w}`);
    assert.ok(writes.length > 0, 'expected the live writer to write something');
  });

  it('16. dry-run remains the default and performs zero writes', () => {
    const src = read(SCANNER);
    assert.match(src, /const LIVE = has\('--live'\)/);
    assert.match(src, /const DRY = !LIVE/);
    // Every write sits inside the `if (LIVE)` block.
    const liveIdx = src.indexOf('if (LIVE) {');
    assert.ok(liveIdx > 0, 'live block missing');
    const beforeLive = src.slice(0, liveIdx);
    for (const verb of ['.insert(', '.upsert(', '.update(', '.delete(']) {
      assert.ok(!beforeLive.includes(verb), `write verb "${verb}" appears outside the LIVE block`);
    }
  });

  it('17. --skus and --limit scoping are honoured', () => {
    const src = read(SCANNER);
    assert.match(src, /ONLY_SKUS\.length\) targets = targets\.filter/);
    assert.match(src, /targets\.slice\(0, LIMIT \|\| cfg\.maxScanPerRun\)/);
  });

  it('17b. the lifecycle read uses the real column name and inspects its error', () => {
    const src = read(SCANNER);
    // Regression: selecting a non-existent `state` column returned PGRST 42703, and destructuring
    // only { data } swallowed it. priorState stayed empty, pinning the consecutive counters at 1 —
    // so the second strike, and therefore delist eligibility, could never be reached.
    assert.match(src, /select\('supplier_product_id,workflow_state,consecutive_out_of_stock,consecutive_in_stock,last_observed_at,last_observation_key,version'\)/);
    assert.ok(!/select\('supplier_product_id,state,/.test(src), 'the column is workflow_state, not state');
    assert.match(src, /if \(error\) die\(1, `inventory_workflow_states read failed/);
  });

  it('17c. every Supabase read in the scanner inspects its error', () => {
    const src = read(SCANNER);
    // A read whose error is ignored can silently return nothing and corrupt the lifecycle.
    const reads = [...src.matchAll(/const \{ data([^}]*)\} = await sb\s*\n?\s*\.from\(|const \{ data([^}]*)\} = await sb\.from\(/g)];
    for (const m of reads) {
      const destructured = (m[1] ?? m[2] ?? '');
      assert.ok(destructured.includes('error'), `a read destructures { data${destructured}} without error`);
    }
  });

  it('17d. the workflow write is version-guarded and idempotency-checked', () => {
    const src = read(SCANNER);
    const live = src.slice(src.indexOf('if (LIVE) {'));
    // Idempotency: an already-committed observation writes nothing.
    assert.match(live, /if \(meta && meta\.key === observationKey\) \{ alreadyProcessed\+\+; continue; \}/);
    // Optimistic concurrency: the update matches on the version we read.
    assert.match(live, /\.eq\('version', meta\.version\)/);
    assert.match(live, /if \(\(data \?\? \[\]\)\.length === 0\) \{ versionConflicts\+\+; continue; \}/);
    // A brand-new row inserts at version 1 rather than blind-upserting.
    assert.match(live, /\.insert\(\{ \.\.\.row, version: 1 \}\)/);
  });

  it('18. delist and relist are NOT performed in this phase', () => {
    const src = read(SCANNER);
    const live = src.slice(src.indexOf('if (LIVE) {'));
    assert.match(live, /products_delisted=0/);
    assert.match(live, /products_relisted=0/);
    // A failure must skip the workflow write entirely, and a too-soon repeat must be inert.
    assert.match(live, /if \(d\.outcome === 'no_confirmation'\) continue;/);
    assert.match(live, /if \(d\.outcome === 'duplicate_or_too_soon'\) \{ tooSoon\+\+; continue; \}/);
  });

  console.log(`\n${passed} passed`);
}
main();
