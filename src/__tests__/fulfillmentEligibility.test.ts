/**
 * Phase 0 — pure fulfillment-eligibility resolver tests (dual-radius pickup + reused
 * authoritative canShip). No production call site; resolver is unused by the app.
 *
 * canShip cases build a real DeliveryFeeResult via the EXISTING authoritative validator
 * (computeDeliveryFeeFromCache) to prove reuse — canShip is never re-implemented as cents>0.
 *
 * Run: npx tsx src/__tests__/fulfillmentEligibility.test.ts
 */
import assert from 'node:assert/strict';
import {
  resolveFulfillmentEligibility,
  distanceMiles,
  pickupRadiusMiles,
  type WarehouseInput,
  type ResolveInput,
} from '../../supabase/functions/_shared/fulfillmentEligibility';
import { computeDeliveryFeeFromCache, type GigaCacheRow } from '../../supabase/functions/_shared/deliveryFee';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

// ── Geometry helpers: place a warehouse exactly N miles due-north of the buyer, using the
//    resolver's OWN distance fn so construction and assertion can never drift. ──
const BUYER = { lat: 34.0, lng: -117.0 };
const MI_PER_DEG_LAT = distanceMiles(BUYER.lat, BUYER.lng, BUYER.lat + 1, BUYER.lng); // exact due-north
const northMiles = (miles: number) => ({ lat: BUYER.lat + miles / MI_PER_DEG_LAT, lng: BUYER.lng });

const wh = (over: Partial<WarehouseInput> & { miles?: number; state: string }): WarehouseInput => {
  const c = over.miles != null ? northMiles(over.miles) : { lat: over.lat ?? BUYER.lat, lng: over.lng ?? BUYER.lng };
  return {
    code: over.code ?? 'W', state: over.state,
    lat: over.lat !== undefined ? over.lat : c.lat,
    lng: over.lng !== undefined ? over.lng : c.lng,
    active: over.active ?? true, supportsPickup: over.supportsPickup ?? true,
  };
};

// Authoritative shipping availability for one SKU from cache rows (reuses production validator).
const ship = (rows: GigaCacheRow[], sku: string) => computeDeliveryFeeFromCache(rows, [{ sku, qty: 1 }]);
const feeRow = (sku: string, cents: number | null): GigaCacheRow => ({ supplier_product_id: sku, charged_fee_cents: cents, currency: 'USD' });

const base = (over: Partial<ResolveInput>): ResolveInput => ({
  childSku: 'SKU', buyerCoords: BUYER, inventory: [{ warehouseCode: 'W', quantity: 5 }],
  warehouses: [wh({ code: 'W', state: 'CA', miles: 10 })],
  delivery: { available: true }, ...over,
});

console.log('fulfillment eligibility resolver (Phase 0)');

it('radius config: CA=100, non-CA (default)=50', () => {
  assert.equal(pickupRadiusMiles('CA'), 100);
  assert.equal(pickupRadiusMiles('NJ'), 50);
  assert.equal(pickupRadiusMiles('tx'), 50);
  assert.equal(pickupRadiusMiles(null), 50);
});

it('1. CA warehouse at 99 / 100 / 101 miles', () => {
  const mk = (m: number) => resolveFulfillmentEligibility(base({ warehouses: [wh({ code: 'W', state: 'CA', miles: m })] }));
  assert.equal(mk(99).canPickup, true, '99mi inside');
  assert.equal(mk(101).canPickup, false, '101mi outside');
  const d100 = distanceMiles(BUYER.lat, BUYER.lng, northMiles(100).lat, northMiles(100).lng);
  assert.ok(Math.abs(d100 - 100) < 0.05, 'constructed ≈100mi');
  assert.equal(mk(100).canPickup, d100 <= 100, '100mi boundary follows <=100 inclusively');
});

it('2. OOS (NJ) warehouse at 49 / 50 / 51 miles', () => {
  const mk = (m: number) => resolveFulfillmentEligibility(base({ warehouses: [wh({ code: 'W', state: 'NJ', miles: m })] }));
  assert.equal(mk(49).canPickup, true, '49mi inside');
  assert.equal(mk(51).canPickup, false, '51mi outside');
  const d50 = distanceMiles(BUYER.lat, BUYER.lng, northMiles(50).lat, northMiles(50).lng);
  assert.ok(Math.abs(d50 - 50) < 0.05, 'constructed ≈50mi');
  assert.equal(mk(50).canPickup, d50 <= 50, '50mi boundary follows <=50 inclusively');
});

it('3. nearest warehouse has NO SKU inventory; a farther qualifying warehouse does', () => {
  const r = resolveFulfillmentEligibility(base({
    warehouses: [wh({ code: 'NEAR', state: 'CA', miles: 20 }), wh({ code: 'FAR', state: 'CA', miles: 80 })],
    inventory: [{ warehouseCode: 'FAR', quantity: 3 }], // NEAR has zero stock for this SKU
  }));
  assert.equal(r.canPickup, true);
  assert.deepEqual(r.qualifyingPickupWarehouses, ['FAR'], 'nearest-with-no-stock is excluded; farther-with-stock qualifies');
});

it('4. multiple qualifying warehouses', () => {
  const r = resolveFulfillmentEligibility(base({
    warehouses: [wh({ code: 'A', state: 'CA', miles: 20 }), wh({ code: 'B', state: 'CA', miles: 60 })],
    inventory: [{ warehouseCode: 'A', quantity: 1 }, { warehouseCode: 'B', quantity: 2 }],
  }));
  assert.equal(r.canPickup, true);
  assert.deepEqual(r.qualifyingPickupWarehouses.sort(), ['A', 'B']);
});

it('5. inventory quantity zero → no pickup', () => {
  const r = resolveFulfillmentEligibility(base({ inventory: [{ warehouseCode: 'W', quantity: 0 }] }));
  assert.equal(r.canPickup, false);
});

it('6. supports_pickup=false → no pickup (even near, in stock)', () => {
  const r = resolveFulfillmentEligibility(base({ warehouses: [wh({ code: 'W', state: 'CA', miles: 5, supportsPickup: false })] }));
  assert.equal(r.canPickup, false);
});

it('7. inactive warehouse → no pickup', () => {
  const r = resolveFulfillmentEligibility(base({ warehouses: [wh({ code: 'W', state: 'CA', miles: 5, active: false })] }));
  assert.equal(r.canPickup, false);
});

it('8. missing warehouse coordinates → no pickup', () => {
  const r = resolveFulfillmentEligibility(base({ warehouses: [{ code: 'W', state: 'CA', lat: null, lng: null, active: true, supportsPickup: true }] }));
  assert.equal(r.canPickup, false);
});

it('9. valid FREE-shipping ($0) record counts as shippable (authoritative validator)', () => {
  const d = ship([feeRow('SKU', 0)], 'SKU');
  assert.equal(d.available, true, 'validator permits $0 fee');
  const r = resolveFulfillmentEligibility(base({ buyerCoords: null, delivery: d }));
  assert.equal(r.canShip, true, 'canShip mirrors validator.available — NOT cents>0');
});

it('10. missing delivery-fee record → not shippable', () => {
  const d = ship([], 'SKU');
  assert.equal(d.available, false);
  const r = resolveFulfillmentEligibility(base({ buyerCoords: null, delivery: d }));
  assert.equal(r.canShip, false);
});

it('11. parse_error record (charged_fee_cents null) → not shippable', () => {
  const d = ship([feeRow('SKU', null)], 'SKU'); // parse failure leaves cents null → no_cached_fee
  assert.equal(d.available, false);
  const r = resolveFulfillmentEligibility(base({ buyerCoords: null, delivery: d }));
  assert.equal(r.canShip, false);
});

it('12. all four RESOLVED fulfillment states', () => {
  const pickWh = [wh({ code: 'W', state: 'CA', miles: 10 })];
  const noPickWh = [wh({ code: 'W', state: 'CA', miles: 999 })]; // in stock but far → no pickup
  const inv = [{ warehouseCode: 'W', quantity: 5 }];
  const both = resolveFulfillmentEligibility({ childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: pickWh, delivery: { available: true } });
  const pick = resolveFulfillmentEligibility({ childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: pickWh, delivery: { available: false } });
  const shipOnly = resolveFulfillmentEligibility({ childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: noPickWh, delivery: { available: true } });
  const none = resolveFulfillmentEligibility({ childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: noPickWh, delivery: { available: false } });
  assert.equal(both.display, 'pickup_and_shipping');
  assert.equal(pick.display, 'pickup_only');
  assert.equal(shipOnly.display, 'shipping_only');
  assert.equal(none.display, 'unavailable');
  assert.equal(none.resolved, true, 'neither-available is a RESOLVED state');
});

it('13. UNKNOWN (buyer coords null OR fee error) is NOT represented as resolved neither-available', () => {
  const noZip = resolveFulfillmentEligibility(base({ buyerCoords: null, delivery: { available: false } }));
  assert.equal(noZip.resolved, false);
  assert.equal(noZip.display, 'unknown', 'pickup unknown → unknown, never "unavailable"');
  const feeErr = resolveFulfillmentEligibility(base({ delivery: 'error' }));
  assert.equal(feeErr.resolved, false);
  assert.equal(feeErr.display, 'unknown', 'ship lookup error → unknown, never a definite state');
});

it('14. W1417-style: OOS-only stock, pickup-capable OOS warehouse, shipping invalid', () => {
  const njWh = [wh({ code: 'NJ3', state: 'NJ', miles: 30 })]; // 30mi ≤ 50 OOS radius
  const njFar = [wh({ code: 'NJ3', state: 'NJ', miles: 70 })]; // 70mi > 50
  const inv = [{ warehouseCode: 'NJ3', quantity: 8 }];
  const noShip = ship([feeRow('W1417', null)], 'W1417'); // parse_error / no valid fee
  const near = resolveFulfillmentEligibility({ childSku: 'W1417', buyerCoords: BUYER, inventory: inv, warehouses: njWh, delivery: noShip });
  const far = resolveFulfillmentEligibility({ childSku: 'W1417', buyerCoords: BUYER, inventory: inv, warehouses: njFar, delivery: noShip });
  assert.equal(near.display, 'pickup_only', 'within 50mi of stocking OOS pickup warehouse → pickup-only');
  assert.equal(far.display, 'unavailable', 'outside 50mi + invalid shipping → resolved neither-available');
});

// ── Regression proof: current production CA behavior is unchanged. ──
it('R. CA regression: 100mi rule preserved; with current data (OOS supports_pickup=false) OOS never picks up', () => {
  // CA rule identical to the locked 100mi rule.
  const ca99 = resolveFulfillmentEligibility(base({ warehouses: [wh({ code: 'W', state: 'CA', miles: 99 })] }));
  const ca150 = resolveFulfillmentEligibility(base({ warehouses: [wh({ code: 'W', state: 'CA', miles: 150 })] }));
  assert.equal(ca99.canPickup, true);
  assert.equal(ca150.canPickup, false);
  // Current PRODUCTION warehouse data has OOS supports_pickup=false → even a 5mi OOS warehouse
  // with stock yields NO pickup. So Phase 0 introduces ZERO change until the data flips (Phase 1).
  const oosNoPickup = resolveFulfillmentEligibility(base({
    warehouses: [wh({ code: 'NJ3', state: 'NJ', miles: 5, supportsPickup: false })],
    inventory: [{ warehouseCode: 'NJ3', quantity: 9 }],
  }));
  assert.equal(oosNoPickup.canPickup, false, 'OOS pickup only activates when supports_pickup flips in Phase 1');
});

console.log(`\n${passed} fulfillment eligibility assertions passed.`);
