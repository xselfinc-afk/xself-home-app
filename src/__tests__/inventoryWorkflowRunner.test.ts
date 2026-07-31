/**
 * Persisted inventory-workflow tests (pure; no I/O, no database).
 *
 * Covers the sprint's required behaviours: multi-confirmation accumulation across runs,
 * idempotent re-processing, fail-closed handling of unknown / stale / failure evidence,
 * allowlist enforcement, and the execution guard.
 *
 * Run: npx tsx src/__tests__/inventoryWorkflowRunner.test.ts
 */
import assert from 'node:assert/strict';
import {
  planWorkflowUpdate,
  buildSignalsFromCacheRows,
  observationClass,
  observationKey,
  recommendationBucket,
  requiresFounderApproval,
  parseAllowlist,
  canExecuteAction,
  usableCacheRows,
  INITIAL_SNAPSHOT,
  type CacheRow,
  type PersistedWorkflowRow,
} from '../services/inventoryWorkflowRunner';
import { classifyInventoryResult, type InventoryResultStatus } from '../services/inventoryResult';
import type { InventoryWorkflowState } from '../services/inventoryStateMachine';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const STALE_MS = 24 * 3600 * 1000;
const SKU = 'W5881P505001';

/** Build a classified result from synthetic cache rows. */
function observe(rows: CacheRow[], nowMs = NOW) {
  const { signals, hasEvidence, observedAtMs } = buildSignalsFromCacheRows(rows, nowMs, STALE_MS);
  const result = classifyInventoryResult(signals, {
    source: 'cache', accountType: 'pickup', supplierProductId: SKU, sku: 'XH-DK-HM-505001',
    checkedAt: new Date(nowMs).toISOString(),
  });
  return { result, hasEvidence, observedAtMs };
}

function row(qty: number, ageH = 1, over: Partial<CacheRow> = {}): CacheRow {
  return {
    product_id: SKU, warehouse_code: 'CA8', warehouse_state: 'CA', quantity: qty,
    supports_pickup: true, supports_shipping: false, sync_status: 'ok', source_type: 'website_scrape',
    last_synced_at: new Date(NOW - ageH * 3600_000).toISOString(), ...over,
  };
}

function persisted(state: InventoryWorkflowState, oos = 0, ins = 0, key: string | null = null, version = 1): PersistedWorkflowRow {
  return {
    supplier_product_id: SKU, supplier_sku: 'XH-DK-HM-505001', workflow_state: state,
    consecutive_out_of_stock: oos, consecutive_in_stock: ins, last_observation_key: key, version,
  };
}

function plan(rows: CacheRow[], prior: PersistedWorkflowRow | null, nowMs = NOW) {
  const { result, hasEvidence, observedAtMs } = observe(rows, nowMs);
  return planWorkflowUpdate({ supplierProductId: SKU, persisted: prior, result, hasEvidence, observedAtMs });
}

function main() {
  // ── 1. first zero: published_in_stock → pending_out_of_stock ───────────────
  it('1. first confirmed zero → pending_out_of_stock (never delist)', () => {
    const p = plan([row(0)], persisted('published_in_stock'));
    assert.equal(p.result.status, 'confirmed_out_of_stock');
    assert.equal(p.next.state, 'pending_out_of_stock');
    assert.equal(p.next.consecutiveOutOfStock, 1);
    assert.equal(p.stateChanged, true);
  });

  // ── 2. second consecutive zero → eligible_for_delist (the defect being fixed) ──
  it('2. second consecutive zero → eligible_for_delist (accumulates across runs)', () => {
    const p = plan([row(0)], persisted('pending_out_of_stock', 1, 0, 'older-key'));
    assert.equal(p.next.state, 'eligible_for_delist');
    assert.equal(p.next.consecutiveOutOfStock, 2);
    assert.equal(p.transition.proposedAction, 'propose_delist');
  });

  it('2b. REGRESSION: without persistence the counter resets and delist is unreachable', () => {
    // Simulates the old behaviour (prior always reconstructed as the initial snapshot).
    const p = plan([row(0)], null);
    assert.equal(p.prior.state, INITIAL_SNAPSHOT.state);
    assert.equal(p.next.state, 'pending_out_of_stock'); // can never reach eligible_for_delist
    assert.notEqual(p.next.state, 'eligible_for_delist');
  });

  // ── 3. idempotency: same observation twice does not double-count ───────────
  it('3. re-processing the SAME observation does not increment counters or write history', () => {
    const rows = [row(0)];
    const first = plan(rows, persisted('published_in_stock'));
    assert.equal(first.next.consecutiveOutOfStock, 1);

    // Persist the result of the first run, then process the identical evidence again.
    const after = persisted('pending_out_of_stock', 1, 0, first.observationKey, 2);
    const second = plan(rows, after);
    assert.equal(second.alreadyProcessed, true);
    assert.equal(second.next.consecutiveOutOfStock, 1, 'counter must NOT advance twice');
    assert.equal(second.next.state, 'pending_out_of_stock');
    assert.equal(second.stateChanged, false, 'no history row for a duplicate observation');
    assert.equal(second.needsRowWrite, false, 'no row write for a duplicate observation');
  });

  it('3b. a genuinely NEW scrape of the same status produces a new key and does advance', () => {
    const first = plan([row(0, 5)], persisted('published_in_stock'));
    const newer = plan([row(0, 1)], persisted('pending_out_of_stock', 1, 0, first.observationKey, 2));
    assert.notEqual(newer.observationKey, first.observationKey);
    assert.equal(newer.alreadyProcessed, false);
    assert.equal(newer.next.consecutiveOutOfStock, 2);
  });

  // ── 4. unknown inventory never advances ───────────────────────────────────
  it('4. unknown inventory (no evidence) does NOT advance counters and is never zero', () => {
    const p = plan([], persisted('published_in_stock', 0, 0));
    assert.equal(p.observationClass, 'no_evidence');
    assert.notEqual(p.result.status, 'confirmed_out_of_stock');
    assert.equal(p.next.consecutiveOutOfStock, 0);
    assert.equal(p.next.state, 'published_in_stock');
    assert.equal(p.stateChanged, false);
  });

  // ── 5. stale evidence never advances ──────────────────────────────────────
  it('5. stale evidence does NOT advance counters and is not a confirmed zero', () => {
    const p = plan([row(0, 48)], persisted('pending_out_of_stock', 1, 0)); // 48h old > 24h threshold
    assert.equal(p.result.status, 'stale');
    assert.equal(p.observationClass, 'hold');
    assert.equal(p.next.consecutiveOutOfStock, 1, 'counter frozen on stale evidence');
    assert.equal(p.next.state, 'pending_out_of_stock');
  });

  // ── 6. failures never advance ─────────────────────────────────────────────
  it('6. auth/parse/network failures hold state and raise an exception', () => {
    for (const status of ['authentication_required', 'captcha_required', 'parse_failed', 'network_failed'] as InventoryResultStatus[]) {
      const p = planWorkflowUpdate({
        supplierProductId: SKU,
        persisted: persisted('pending_out_of_stock', 1, 0),
        result: { ...observe([row(0)]).result, status },
        hasEvidence: true,
        observedAtMs: NOW,
      });
      assert.equal(p.observationClass, 'hold', status);
      assert.equal(p.next.consecutiveOutOfStock, 1, `counter must not advance on ${status}`);
      assert.equal(p.transition.isException, true, status);
    }
  });

  // ── 7. positive recovery before delist eligibility ────────────────────────
  it('7. recovery to in-stock before delist eligibility returns to published_in_stock', () => {
    const p = plan([row(12)], persisted('pending_out_of_stock', 1, 0));
    assert.equal(p.next.state, 'published_in_stock');
    assert.equal(p.next.consecutiveOutOfStock, 0, 'zero streak cleared on recovery');
    assert.equal(p.transition.proposedAction, 'clear_to_published');
  });

  // ── 8. delisted item receives first positive observation ──────────────────
  it('8. delisted_out_of_stock + first in-stock → relist_pending', () => {
    const p = plan([row(7)], persisted('delisted_out_of_stock', 3, 0));
    assert.equal(p.next.state, 'relist_pending');
    assert.equal(p.next.consecutiveInStock, 1);
    assert.equal(p.transition.proposedAction, 'mark_relist_pending');
  });

  // ── 9. required consecutive positives → eligible_for_relist ───────────────
  it('9. relist_pending + second in-stock → eligible_for_relist', () => {
    const p = plan([row(7)], persisted('relist_pending', 0, 1));
    assert.equal(p.next.state, 'eligible_for_relist');
    assert.equal(p.next.consecutiveInStock, 2);
    assert.equal(p.transition.proposedAction, 'propose_relist');
  });

  // ── 10. allowlist enforcement ─────────────────────────────────────────────
  it('10. allowlist: empty parses to null (never "all"); execution refuses without it', () => {
    assert.equal(parseAllowlist(''), null);
    assert.equal(parseAllowlist(undefined), null);
    assert.deepEqual(parseAllowlist(' A , B ,A '), ['A', 'B']);
    const g = canExecuteAction({
      sku: SKU, allowlist: null, currentState: 'eligible_for_delist',
      requiredState: 'eligible_for_delist', recommendedObservationKey: 'k', currentObservationKey: 'k',
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, 'not_in_allowlist');
  });

  // ── 11. dry-run writes nothing (plan carries no side effects) ─────────────
  it('11. planning is side-effect free and reports exactly what a write would be', () => {
    const p = plan([row(0)], persisted('published_in_stock'));
    assert.ok(typeof p.needsRowWrite === 'boolean' && typeof p.stateChanged === 'boolean');
    assert.equal(p.expectedVersion, 1, 'version carried for optimistic concurrency');
  });

  // ── 12. concurrency protection ────────────────────────────────────────────
  it('12. expectedVersion is surfaced so a concurrent writer can be detected', () => {
    const p = plan([row(0)], persisted('published_in_stock', 0, 0, null, 7));
    assert.equal(p.expectedVersion, 7);
    const fresh = plan([row(0)], null);
    assert.equal(fresh.expectedVersion, null, 'no row yet → insert path, not update');
  });

  // ── 13. transition-history deduplication ──────────────────────────────────
  it('13. duplicate observation yields no history row; distinct observations do', () => {
    const rows = [row(0)];
    const first = plan(rows, persisted('published_in_stock'));
    assert.equal(first.stateChanged, true);
    const dup = plan(rows, persisted('pending_out_of_stock', 1, 0, first.observationKey, 2));
    assert.equal(dup.stateChanged, false);
    assert.equal(observationKey({ supplierProductId: SKU, status: 'confirmed_out_of_stock', observedAtMs: NOW, totalQuantity: 0 }),
                 observationKey({ supplierProductId: SKU, status: 'confirmed_out_of_stock', observedAtMs: NOW, totalQuantity: 0 }),
                 'key must be deterministic');
  });

  // ── 14. execution refuses a non-eligible SKU ──────────────────────────────
  it('14. execution refuses when the SKU is not in the required eligible state', () => {
    const g = canExecuteAction({
      sku: SKU, allowlist: [SKU], currentState: 'pending_out_of_stock',
      requiredState: 'eligible_for_delist', recommendedObservationKey: 'k', currentObservationKey: 'k',
    });
    assert.equal(g.ok, false);
    assert.match(g.reason, /state_mismatch/);
  });

  // ── 15. execution detects evidence changed after recommendation ───────────
  it('15. execution refuses when evidence changed since the recommendation', () => {
    const g = canExecuteAction({
      sku: SKU, allowlist: [SKU], currentState: 'eligible_for_delist',
      requiredState: 'eligible_for_delist', recommendedObservationKey: 'old', currentObservationKey: 'new',
    });
    assert.equal(g.ok, false);
    assert.equal(g.reason, 'evidence_changed_since_recommendation');
  });

  it('15b. execution proceeds only when allowlist, state and evidence all agree', () => {
    const g = canExecuteAction({
      sku: SKU, allowlist: [SKU], currentState: 'eligible_for_delist',
      requiredState: 'eligible_for_delist', recommendedObservationKey: 'k', currentObservationKey: 'k',
    });
    assert.equal(g.ok, true);
  });

  // ── 16. recommendation buckets + approval ─────────────────────────────────
  it('16. recommendation buckets map correctly and action buckets require approval', () => {
    const b = (state: InventoryWorkflowState, cls: 'advance' | 'hold' | 'no_evidence' = 'advance') =>
      recommendationBucket({ next: { state, consecutiveOutOfStock: 0, consecutiveInStock: 0 }, observationClass: cls });
    assert.equal(b('eligible_for_delist'), 'eligible_for_delist');
    assert.equal(b('eligible_for_relist'), 'eligible_for_relist');
    assert.equal(b('pending_out_of_stock'), 'pending_confirmation');
    assert.equal(b('relist_pending'), 'pending_confirmation');
    assert.equal(b('published_in_stock'), 'no_action');
    assert.equal(b('eligible_for_delist', 'hold'), 'blocked_unknown', 'non-authoritative never proposes an action');
    assert.equal(b('eligible_for_delist', 'no_evidence'), 'blocked_unknown');
    assert.equal(requiresFounderApproval('eligible_for_delist'), true);
    assert.equal(requiresFounderApproval('eligible_for_relist'), true);
    assert.equal(requiresFounderApproval('no_action'), false);
    assert.equal(requiresFounderApproval('pending_confirmation'), false);
  });

  // ── evidence hygiene ──────────────────────────────────────────────────────
  it('17. untrusted cache sources are excluded from evidence', () => {
    const mixed: CacheRow[] = [
      row(5),
      row(9, 1, { source_type: 'price_synthesis' }),
      row(9, 1, { sync_status: 'error' }),
    ];
    assert.equal(usableCacheRows(mixed).length, 1);
  });

  it('18. thin CA stock is in-stock, never out-of-stock (W244P172637 protection)', () => {
    const p = plan([row(3)], persisted('published_in_stock'));
    assert.equal(p.result.status, 'confirmed_in_stock_ca');
    assert.equal(p.next.state, 'published_in_stock');
    assert.equal(p.next.consecutiveOutOfStock, 0);
    assert.equal(recommendationBucket(p), 'no_action', 'thin stock must not propose a delist');
  });

  it('19. observationClass is fail-closed for every status', () => {
    assert.equal(observationClass('confirmed_out_of_stock', true), 'advance');
    assert.equal(observationClass('confirmed_in_stock_ca', true), 'advance');
    assert.equal(observationClass('inventory_unknown', true), 'hold');
    assert.equal(observationClass('stale', true), 'hold');
    assert.equal(observationClass('authentication_required', true), 'hold');
    assert.equal(observationClass('confirmed_out_of_stock', false), 'no_evidence');
  });

  console.log(`\n${passed} passed`);
}
main();
