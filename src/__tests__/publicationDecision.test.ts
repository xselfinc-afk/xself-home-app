/**
 * Publication decision tests (pure; no database, no network, no browser).
 *
 * The two properties that protect customers and the Founder respectively:
 *   1. A product can only be delisted on FRESH, CONFIRMED-UNAVAILABLE evidence.
 *   2. A product a human hid can NEVER be resurrected by automation.
 *
 * A third property protects the storefront: relisting re-asserts every gate `sellable_products`
 * enforces, so automation cannot surface a product that would be broken or invisible anyway.
 *
 * Run: npx tsx src/__tests__/publicationDecision.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_GRACE_HOURS,
  decidePublication,
  isApplied,
  tallyDecisions,
  type AvailabilityRow,
  type ProductRow,
} from '../services/publicationDecision';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260806_publish_from_availability.sql'), 'utf8');
const RUNNER = fs.readFileSync(path.join(ROOT, 'scripts/applyInventoryLifecycleActions.ts'), 'utf8');

const T = (h: number) => new Date(Date.UTC(2026, 7, 2, 0, 0, 0) + h * 3_600_000).toISOString();
const NOW = T(0);

/** A healthy, published product that satisfies every quality gate. */
const good = (over: Partial<ProductRow> = {}): ProductRow => ({
  supplierProductId: 'SKU1', published: true, delistReason: null,
  normalizationStatus: 'done', productTitle: 'Oak Dresser', primaryImage: 'https://x/img.jpg',
  price: 100, sellingPrice: 199, inventoryStatus: 'in_stock', totalAvailableQty: 5, ...over,
});
/** The same product after the lifecycle delisted it. */
const delisted = (over: Partial<ProductRow> = {}): ProductRow =>
  good({ published: false, delistReason: 'inventory_unavailable', ...over });

const avail = (a: boolean, hoursAgo = 1): AvailabilityRow =>
  ({ available: a, status: a ? 'confirmed_available' : 'confirmed_out_of_stock', checkedAt: T(-hoursAgo) });

const decideDelist = (p: ProductRow | null, a: AvailabilityRow | null, held = false) =>
  decidePublication({ product: p, availability: a, action: 'delist', heldManually: held, nowIso: NOW });
const decideRelist = (p: ProductRow | null, a: AvailabilityRow | null, held = false) =>
  decidePublication({ product: p, availability: a, action: 'relist', heldManually: held, nowIso: NOW });

function main(): void {
  // ── Delist ──────────────────────────────────────────────────────────────────

  it('1. fresh confirmed-unavailable evidence delists', () => {
    const d = decideDelist(good(), avail(false));
    assert.equal(d.outcome, 'delisted');
    assert.equal(d.willApply, true);
  });

  it('2. delist refuses without evidence, on stale evidence, or on the wrong answer', () => {
    assert.equal(decideDelist(good(), null).outcome, 'skipped_no_availability_evidence');
    assert.equal(decideDelist(good(), avail(false, DEFAULT_GRACE_HOURS + 1)).outcome, 'skipped_evidence_stale');
    assert.equal(decideDelist(good(), avail(true)).outcome, 'skipped_evidence_not_unavailable');
  });

  it('3. a failure can never reach the delist path (only confirmed rows are persisted)', () => {
    // product_availability_current cannot store a failure — CHECK constraint. Assert the SQL agrees.
    assert.match(SQL, /IF v_avail IS NOT false THEN RETURN 'skipped_evidence_not_unavailable'/);
  });

  // ── Relist — the dangerous direction ───────────────────────────────────────

  it('4. THE KEY GUARD: a manually unpublished product is NEVER auto-relisted', () => {
    for (const reason of [null, 'manual', 'quality_gate']) {
      const d = decideRelist(good({ published: false, delistReason: reason }), avail(true));
      assert.equal(d.outcome, 'skipped_not_inventory_delisted', `delist_reason=${reason}`);
      assert.equal(d.willApply, false);
    }
  });

  it('5. an inventory-delisted product with fresh available evidence relists', () => {
    const d = decideRelist(delisted(), avail(true));
    assert.equal(d.outcome, 'relisted');
    assert.equal(d.willApply, true);
  });

  it('6. relist re-asserts EVERY sellable_products quality gate', () => {
    const cases: Array<[Partial<ProductRow>, string]> = [
      [{ normalizationStatus: 'pending' }, 'skipped_quality_normalization'],
      [{ productTitle: '   ' }, 'skipped_quality_title'],
      [{ productTitle: null }, 'skipped_quality_title'],
      [{ primaryImage: '' }, 'skipped_quality_image'],
      [{ price: 0 }, 'skipped_quality_price'],
      [{ sellingPrice: null }, 'skipped_quality_selling_price'],
      [{ inventoryStatus: 'out_of_stock' }, 'skipped_no_fulfillment_path'],
      [{ totalAvailableQty: 0 }, 'skipped_no_fulfillment_qty'],
    ];
    for (const [over, expected] of cases) {
      assert.equal(decideRelist(delisted(over), avail(true)).outcome, expected, JSON.stringify(over));
    }
  });

  it('7. relist refuses on stale or contradicting evidence', () => {
    assert.equal(decideRelist(delisted(), avail(true, DEFAULT_GRACE_HOURS + 1)).outcome, 'skipped_evidence_stale');
    assert.equal(decideRelist(delisted(), avail(false)).outcome, 'skipped_evidence_not_available');
    assert.equal(decideRelist(delisted(), null).outcome, 'skipped_no_availability_evidence');
  });

  // ── Holds, idempotency, absence ────────────────────────────────────────────

  it('8. an active manual hold blocks BOTH directions', () => {
    assert.equal(decideDelist(good(), avail(false), true).outcome, 'skipped_manual_hold');
    assert.equal(decideRelist(delisted(), avail(true), true).outcome, 'skipped_manual_hold');
  });

  it('9. already in the requested state is an idempotent no-op', () => {
    assert.equal(decideDelist(good({ published: false }), avail(false)).outcome, 'skipped_already_unpublished');
    assert.equal(decideRelist(good({ published: true }), avail(true)).outcome, 'skipped_already_published');
  });

  it('10. a missing product decides nothing', () => {
    assert.equal(decideDelist(null, avail(false)).outcome, 'skipped_product_not_found');
  });

  it('11. decisions are pure', () => {
    assert.deepEqual(decideRelist(delisted(), avail(true)), decideRelist(delisted(), avail(true)));
  });

  it('12. tally separates applied from skipped', () => {
    const t = tallyDecisions([
      decideDelist(good(), avail(false)),
      decideDelist(good(), avail(true)),
      decideRelist(delisted(), avail(true)),
    ]);
    assert.equal(t.total, 3);
    assert.equal(t.wouldApply, 2);
    assert.equal(t.skipped, 1);
    assert.ok(isApplied('delisted') && isApplied('relisted'));
  });

  // ── The preview must match the SQL enforcement boundary ────────────────────

  it('13. every TypeScript outcome exists verbatim in the SQL function', () => {
    const outcomes = [
      'skipped_product_not_found', 'skipped_manual_hold', 'skipped_no_availability_evidence',
      'skipped_evidence_stale', 'skipped_evidence_not_unavailable', 'skipped_evidence_not_available',
      'skipped_not_inventory_delisted', 'skipped_quality_normalization', 'skipped_quality_title',
      'skipped_quality_image', 'skipped_quality_price', 'skipped_quality_selling_price',
      'skipped_no_fulfillment_path', 'skipped_no_fulfillment_qty', 'delisted', 'relisted',
    ];
    for (const o of outcomes) {
      assert.ok(SQL.includes(`'${o}'`), `SQL is missing outcome ${o} — preview and enforcement have diverged`);
    }
  });

  it('14. the SQL never writes warehouse or inventory fields', () => {
    const body = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    const updates = body.match(/UPDATE public\.standardized_products[\s\S]*?WHERE/g) ?? [];
    assert.ok(updates.length > 0);
    for (const u of updates) {
      for (const forbidden of ['inventory_status', 'total_available_qty', 'has_ca_pickup', 'available_warehouse_count', 'inventory_last_synced_at']) {
        assert.ok(!u.includes(forbidden), `SQL update writes ${forbidden}`);
      }
      assert.ok(u.includes('published'), 'update must set published');
    }
  });

  it('15. the runner cannot write publication directly — only via the RPC', () => {
    assert.match(RUNNER, /\.rpc\('set_publication_from_availability'/);
    const writes = [...RUNNER.matchAll(/from\('([a-z_]+)'\)\s*\n?\s*\.(insert|update|upsert|delete)\(/g)].map(m => m[1]);
    assert.deepEqual(writes, [], `runner performs direct table writes: ${writes.join(',')}`);
  });

  it('16. the runner requires an explicit allowlist and approval', () => {
    assert.match(RUNNER, /require --only=SKU/);
    assert.match(RUNNER, /--approve requires --approved-by/);
    assert.match(RUNNER, /if \(!APPROVE\)/);
    assert.ok(!/--all\b/.test(RUNNER), 'there must be no "all" mode');
  });

  console.log(`\n${passed} passed`);
}
main();
