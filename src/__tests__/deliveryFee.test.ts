/**
 * Delivery fee normalization tests (pure; no network, no secrets).
 * Run: npx tsx src/__tests__/deliveryFee.test.ts
 *
 * Locks the GIGA product/price/v1 → server-authoritative Delivery fee math used by
 * plan-fulfillment. See supabase/functions/_shared/deliveryFee.ts + docs/delivery-architecture.md.
 */
import assert from 'node:assert/strict';
import { computeDeliveryFee, type GigaPriceRow } from '../../supabase/functions/_shared/deliveryFee';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('Delivery fee tests');

// Mirrors the live product page for W2827P203712: shipping $84.81, packing $3.47, total $88.28.
it('single SKU reproduces page breakdown (shipping/packing/fee)', () => {
  const rows: GigaPriceRow[] = [{ sku: 'W2827P203712', currency: 'USD', shippingFee: 84.81, shippingFeeRange: { minAmount: 88.28, maxAmount: 88.28 } }];
  const r = computeDeliveryFee(rows, [{ sku: 'W2827P203712', qty: 1 }]);
  assert.equal(r.available, true);
  assert.equal(r.shippingFeeCents, 8481);
  assert.equal(r.packingFeeCents, 347);
  assert.equal(r.deliveryFeeCents, 8828);
  assert.equal(r.isRange, false);
});

it('quantity multiplies the per-unit fee', () => {
  const rows: GigaPriceRow[] = [{ sku: 'A', currency: 'USD', shippingFee: 10, shippingFeeRange: { minAmount: 12, maxAmount: 12 } }];
  const r = computeDeliveryFee(rows, [{ sku: 'A', qty: 3 }]);
  assert.equal(r.deliveryFeeCents, 3600);   // 12.00 × 3
  assert.equal(r.shippingFeeCents, 3000);
  assert.equal(r.packingFeeCents, 600);
});

it('range (min≠max) charges max and flags isRange', () => {
  const rows: GigaPriceRow[] = [{ sku: 'L', currency: 'USD', shippingFee: 84.81, shippingFeeRange: { minAmount: 88.28, maxAmount: 120 } }];
  const r = computeDeliveryFee(rows, [{ sku: 'L', qty: 1 }]);
  assert.equal(r.deliveryFeeCents, 12000);  // charge max
  assert.equal(r.feeMinCents, 8828);
  assert.equal(r.feeMaxCents, 12000);
  assert.equal(r.isRange, true);
});

it('shippingFee null but range present → fee = range.max, packing 0', () => {
  const rows: GigaPriceRow[] = [{ sku: 'X', currency: 'USD', shippingFee: null, shippingFeeRange: { minAmount: 50, maxAmount: 50 } }];
  const r = computeDeliveryFee(rows, [{ sku: 'X', qty: 1 }]);
  assert.equal(r.available, true);
  assert.equal(r.deliveryFeeCents, 5000);
  assert.equal(r.packingFeeCents, 0);
});

it('skuAvailable=false → unavailable, fee null, sku listed', () => {
  const rows: GigaPriceRow[] = [{ sku: 'OOS', currency: 'USD', shippingFee: 10, skuAvailable: false }];
  const r = computeDeliveryFee(rows, [{ sku: 'OOS', qty: 1 }]);
  assert.equal(r.available, false);
  assert.equal(r.deliveryFeeCents, null);
  assert.deepEqual(r.unavailableSkus, ['OOS']);
});

it('missing row → unavailable (no $99 fallback, no fabricated fee)', () => {
  const r = computeDeliveryFee([], [{ sku: 'GHOST', qty: 1 }]);
  assert.equal(r.available, false);
  assert.equal(r.deliveryFeeCents, null);
});

it('non-USD currency → unavailable', () => {
  const rows: GigaPriceRow[] = [{ sku: 'E', currency: 'EUR', shippingFee: 10, shippingFeeRange: { minAmount: 12, maxAmount: 12 } }];
  const r = computeDeliveryFee(rows, [{ sku: 'E', qty: 1 }]);
  assert.equal(r.available, false);
});

it('multi-SKU: all available sums; one unavailable blocks the whole order', () => {
  const rows: GigaPriceRow[] = [
    { sku: 'A', currency: 'USD', shippingFee: 10, shippingFeeRange: { minAmount: 12, maxAmount: 12 } },
    { sku: 'B', currency: 'USD', shippingFee: 20, shippingFeeRange: { minAmount: 25, maxAmount: 25 } },
  ];
  const ok = computeDeliveryFee(rows, [{ sku: 'A', qty: 1 }, { sku: 'B', qty: 2 }]);
  assert.equal(ok.available, true);
  assert.equal(ok.deliveryFeeCents, 1200 + 2500 * 2);  // 6200

  const blocked = computeDeliveryFee(rows, [{ sku: 'A', qty: 1 }, { sku: 'MISSING', qty: 1 }]);
  assert.equal(blocked.available, false);
  assert.equal(blocked.deliveryFeeCents, null);
});

it('reports a diagnostic reason when unavailable (for on-device debugging)', () => {
  assert.equal(computeDeliveryFee([], [{ sku: 'A', qty: 1 }]).reason, 'sku_not_found');
  assert.equal(computeDeliveryFee([{ sku: 'A', currency: 'USD', skuAvailable: false }], [{ sku: 'A', qty: 1 }]).reason, 'sku_unavailable');
  assert.equal(computeDeliveryFee([{ sku: 'A', currency: 'USD', shippingFee: null }], [{ sku: 'A', qty: 1 }]).reason, 'no_fee');
  assert.equal(computeDeliveryFee([{ sku: 'A', currency: 'EUR', shippingFee: 10, shippingFeeRange: { minAmount: 12, maxAmount: 12 } }], [{ sku: 'A', qty: 1 }]).reason, 'currency_mismatch');
  assert.equal(computeDeliveryFee([{ sku: 'A', currency: 'USD', shippingFee: 10, shippingFeeRange: { minAmount: 12, maxAmount: 12 } }], [{ sku: 'A', qty: 1 }]).reason, null);
});

console.log(`\n${passed} delivery-fee assertions passed.`);
