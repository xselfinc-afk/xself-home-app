/**
 * Local Delivery + three-method resolver — unit tests (pure functions only; no React, no Supabase).
 *
 * Run with: npx tsx src/__tests__/localDeliveryEligibility.test.ts
 *
 * Locks the phase-1 contract:
 *   - Local Delivery radius is its own constant and never touches the pickup radius (CA 100 / OOS 50).
 *   - Eligible only from a flagged warehouse, only when ONE warehouse covers the order, only inside
 *     the internal radius.
 *   - Default order local_delivery → pickup → third_party_shipping; a stated preference wins while
 *     eligible; a client that never declared support can never be planned for local_delivery.
 *   - Storage projection stays two-valued with delivery_kind carrying the sub-type.
 */

import assert from 'node:assert/strict';
import {
  LOCAL_DELIVERY_RADIUS_MILES,
  PICKUP_RADIUS_MILES_BY_STATE,
  DEFAULT_PICKUP_RADIUS_MILES,
  pickupRadiusMiles,
  localDeliveryEligible,
  normalizeFulfillmentMethod,
  resolveFulfillmentMethod,
  storageFulfillmentMethod,
  deliveryKindOf,
} from '../../supabase/functions/_shared/fulfillmentEligibility';

let failed = 0;
function it(name: string, fn: () => void): void {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${(e as Error).message}`); }
}

console.log('Local Delivery radius is independent of the locked pickup radius');
it('LOCAL_DELIVERY_RADIUS_MILES is 30 and pickup radius is untouched (CA 100 / OOS 50)', () => {
  assert.equal(LOCAL_DELIVERY_RADIUS_MILES, 30);
  assert.equal(PICKUP_RADIUS_MILES_BY_STATE.CA, 100);
  assert.equal(DEFAULT_PICKUP_RADIUS_MILES, 50);
  assert.equal(pickupRadiusMiles('CA'), 100);
  assert.equal(pickupRadiusMiles('TX'), 50);
});

console.log('localDeliveryEligible');
const base = { distanceMiles: 12, supportsLocalDelivery: true, singleWarehouseCoversOrder: true };
it('eligible inside the radius from a flagged single-warehouse plan', () => {
  assert.equal(localDeliveryEligible(base), true);
  assert.equal(localDeliveryEligible({ ...base, distanceMiles: 30 }), true); // boundary inclusive
});
it('not eligible beyond the radius', () => {
  assert.equal(localDeliveryEligible({ ...base, distanceMiles: 30.01 }), false);
  assert.equal(localDeliveryEligible({ ...base, distanceMiles: 45 }), false);
});
it('not eligible from an unflagged warehouse even when near', () => {
  assert.equal(localDeliveryEligible({ ...base, supportsLocalDelivery: false }), false);
});
it('not eligible on a split / best-effort plan', () => {
  assert.equal(localDeliveryEligible({ ...base, singleWarehouseCoversOrder: false }), false);
});
it('not eligible on a non-finite distance', () => {
  assert.equal(localDeliveryEligible({ ...base, distanceMiles: Number.NaN }), false);
});

console.log('normalizeFulfillmentMethod');
it('accepts the three values and the legacy delivery spelling', () => {
  assert.equal(normalizeFulfillmentMethod('pickup'), 'pickup');
  assert.equal(normalizeFulfillmentMethod('local_delivery'), 'local_delivery');
  assert.equal(normalizeFulfillmentMethod('third_party_shipping'), 'third_party_shipping');
  assert.equal(normalizeFulfillmentMethod('delivery'), 'third_party_shipping');
  assert.equal(normalizeFulfillmentMethod('ups'), null);
  assert.equal(normalizeFulfillmentMethod(undefined), null);
});

console.log('resolveFulfillmentMethod — CA scenarios');
const supports = { clientSupportsLocalDelivery: true };
it('0–30 mi, no preference → local_delivery (over pickup)', () => {
  assert.equal(resolveFulfillmentMethod({ preferred: null, pickupEligible: true, localDeliveryEligible: true, ...supports }), 'local_delivery');
});
it('30–100 mi, no preference → pickup (pre-existing default)', () => {
  assert.equal(resolveFulfillmentMethod({ preferred: null, pickupEligible: true, localDeliveryEligible: false, ...supports }), 'pickup');
});
it('>100 mi, no preference → third_party_shipping', () => {
  assert.equal(resolveFulfillmentMethod({ preferred: null, pickupEligible: false, localDeliveryEligible: false, ...supports }), 'third_party_shipping');
});
it('a stated preference wins while eligible', () => {
  assert.equal(resolveFulfillmentMethod({ preferred: 'pickup', pickupEligible: true, localDeliveryEligible: true, ...supports }), 'pickup');
  assert.equal(resolveFulfillmentMethod({ preferred: 'third_party_shipping', pickupEligible: true, localDeliveryEligible: true, ...supports }), 'third_party_shipping');
  assert.equal(resolveFulfillmentMethod({ preferred: 'local_delivery', pickupEligible: true, localDeliveryEligible: true, ...supports }), 'local_delivery');
});
it('preferring pickup when ineligible falls to shipping (unchanged behaviour)', () => {
  assert.equal(resolveFulfillmentMethod({ preferred: 'pickup', pickupEligible: false, localDeliveryEligible: true, ...supports }), 'third_party_shipping');
});
it('preferring local_delivery when ineligible falls to the default order', () => {
  assert.equal(resolveFulfillmentMethod({ preferred: 'local_delivery', pickupEligible: true, localDeliveryEligible: false, ...supports }), 'pickup');
  assert.equal(resolveFulfillmentMethod({ preferred: 'local_delivery', pickupEligible: false, localDeliveryEligible: false, ...supports }), 'third_party_shipping');
});
it('a client that never declared support is NEVER planned for local_delivery', () => {
  const legacy = { clientSupportsLocalDelivery: false };
  assert.equal(resolveFulfillmentMethod({ preferred: null, pickupEligible: true, localDeliveryEligible: true, ...legacy }), 'pickup');
  assert.equal(resolveFulfillmentMethod({ preferred: null, pickupEligible: false, localDeliveryEligible: true, ...legacy }), 'third_party_shipping');
  assert.equal(resolveFulfillmentMethod({ preferred: 'local_delivery', pickupEligible: false, localDeliveryEligible: true, ...legacy }), 'third_party_shipping');
});

console.log('storage projection');
it('orders.fulfillment_method stays two-valued; delivery_kind carries the sub-type', () => {
  assert.equal(storageFulfillmentMethod('pickup'), 'pickup');
  assert.equal(storageFulfillmentMethod('local_delivery'), 'delivery');
  assert.equal(storageFulfillmentMethod('third_party_shipping'), 'delivery');
  assert.equal(deliveryKindOf('pickup'), null);
  assert.equal(deliveryKindOf('local_delivery'), 'local');
  assert.equal(deliveryKindOf('third_party_shipping'), 'third_party');
});

if (failed) { console.error(`\n${failed} assertion group(s) failed`); process.exit(1); }
console.log('\nAll Local Delivery / three-method tests passed');
