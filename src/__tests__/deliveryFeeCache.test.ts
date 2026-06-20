/**
 * Pure tests for computeDeliveryFeeFromCache — the checkout-time Delivery fee source
 * (reads cached giga_delivery_fee_cache rows; NO network, NO DB). Run:
 *   npx tsx src/__tests__/deliveryFeeCache.test.ts
 * See supabase/functions/_shared/deliveryFee.ts.
 */
import assert from 'node:assert/strict';
import { computeDeliveryFeeFromCache, type GigaCacheRow } from '../../supabase/functions/_shared/deliveryFee';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('computeDeliveryFeeFromCache tests');

const W = 'W3204P484603';
const seededRow: GigaCacheRow = {
  supplier_product_id: W, charged_fee_cents: 5800, currency: 'USD',
  packing_fee_cents: 445, shipping_fee_cents: 4874, fulfillment_fee_cents: 5319,
};

// ── Happy path (the seeded production row) ──────────────────────────────────────
it('seeded SKU, qty 1 → available, deliveryFeeCents 5800 ($58.00)', () => {
  const r = computeDeliveryFeeFromCache([seededRow], [{ sku: W, qty: 1 }]);
  assert.equal(r.available, true);
  assert.equal(r.deliveryFeeCents, 5800);
  assert.equal(r.reason, null);
  assert.equal(r.source, 'giga_portal_price_list_cache');
  assert.deepEqual(r.unavailableSkus, []);
});
it('charged_fee_cents is PER UNIT → × qty (qty 3 → 17400)', () => {
  const r = computeDeliveryFeeFromCache([seededRow], [{ sku: W, qty: 3 }]);
  assert.equal(r.available, true);
  assert.equal(r.deliveryFeeCents, 17400);
  assert.equal(r.shippingFeeCents, 4874 * 3);
  assert.equal(r.packingFeeCents, 445 * 3);
});
it('multi-line all priced → summed', () => {
  const rows: GigaCacheRow[] = [seededRow, { supplier_product_id: 'SKU2', charged_fee_cents: 1000, currency: 'USD' }];
  const r = computeDeliveryFeeFromCache(rows, [{ sku: W, qty: 1 }, { sku: 'SKU2', qty: 2 }]);
  assert.equal(r.available, true);
  assert.equal(r.deliveryFeeCents, 5800 + 2000);
});

// ── Missing / null fee → unavailable (no_cached_fee), no partial delivery ────────
it('SKU not in cache → unavailable, no_cached_fee, listed in unavailableSkus', () => {
  const r = computeDeliveryFeeFromCache([], [{ sku: 'NOPE', qty: 1 }]);
  assert.equal(r.available, false);
  assert.equal(r.deliveryFeeCents, null);
  assert.equal(r.reason, 'no_cached_fee');
  assert.deepEqual(r.unavailableSkus, ['NOPE']);
});
it('row exists but charged_fee_cents null → no_cached_fee', () => {
  const r = computeDeliveryFeeFromCache([{ supplier_product_id: W, charged_fee_cents: null, currency: 'USD' }], [{ sku: W, qty: 1 }]);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'no_cached_fee');
  assert.deepEqual(r.unavailableSkus, [W]);
});
it('one of two lines missing → WHOLE result unavailable (no partial delivery)', () => {
  const r = computeDeliveryFeeFromCache([seededRow], [{ sku: W, qty: 1 }, { sku: 'SKU2', qty: 1 }]);
  assert.equal(r.available, false);
  assert.equal(r.deliveryFeeCents, null);
  assert.deepEqual(r.unavailableSkus, ['SKU2']);
});

// ── Currency guard ───────────────────────────────────────────────────────────
it('non-USD currency → unavailable, currency_mismatch', () => {
  const r = computeDeliveryFeeFromCache([{ supplier_product_id: W, charged_fee_cents: 5800, currency: 'GBP' }], [{ sku: W, qty: 1 }]);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'currency_mismatch');
  assert.deepEqual(r.unavailableSkus, [W]);
});
it('null currency is allowed (treated as USD)', () => {
  const r = computeDeliveryFeeFromCache([{ supplier_product_id: W, charged_fee_cents: 5800, currency: null }], [{ sku: W, qty: 1 }]);
  assert.equal(r.available, true);
  assert.equal(r.deliveryFeeCents, 5800);
});

// ── No items ─────────────────────────────────────────────────────────────────
it('no items → unavailable, no_items', () => {
  const r = computeDeliveryFeeFromCache([seededRow], []);
  assert.equal(r.available, false);
  assert.equal(r.reason, 'no_items');
});

// ── Age/staleness is IGNORED (no last_success_at gating) ───────────────────────
it('age ignored: row with no last_success_at still priced', () => {
  const r = computeDeliveryFeeFromCache([{ supplier_product_id: W, charged_fee_cents: 5800 }], [{ sku: W, qty: 1 }]);
  assert.equal(r.available, true);
  assert.equal(r.deliveryFeeCents, 5800);
});

console.log(`\n${passed} cache-fee assertions passed.`);
