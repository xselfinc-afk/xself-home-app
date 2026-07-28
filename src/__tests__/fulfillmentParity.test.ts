/**
 * Resolver PARITY contract — the advisory path (fulfillment-eligibility endpoint) and the
 * plan-fulfillment (checkout) eligibility path must produce the SAME canPickup / canShip /
 * fulfillment state / qualifying pickup radius for identical inventory, warehouse, fee, SKU,
 * and ZIP inputs. Parity is now PROVEN by this test — not implicit.
 *
 * The advisory path is resolveFulfillmentEligibility (shared, imported directly — it is the exact
 * function the endpoint calls). `planFulfillmentEligibility` below is a faithful, commented mirror
 * of the deployed plan-fulfillment predicate (index.ts): pickup candidate filter
 *   ranked.filter(r => r.distanceMiles <= pickupRadiusMiles(r.warehouse.state) && r.warehouse.supports_pickup)
 * plus active + valid-coords + stocks-this-SKU (warehouseHasAllStock / active query / resolved coords),
 * and canShip = computeDeliveryFeeFromCache(...).available — the SAME shared radius fn + fee validator
 * both runtimes use. If plan-fulfillment's predicate ever drifts, this mirror + test must be updated.
 *
 * Run: npx tsx src/__tests__/fulfillmentParity.test.ts
 */
import assert from 'node:assert/strict';
import {
  resolveFulfillmentEligibility,
  pickupRadiusMiles,
  distanceMiles,
  type WarehouseInput,
  type ResolveInput,
} from '../../supabase/functions/_shared/fulfillmentEligibility';
import { computeDeliveryFeeFromCache, type GigaCacheRow } from '../../supabase/functions/_shared/deliveryFee';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const BUYER = { lat: 34.0, lng: -117.0 };
const MI_PER_DEG = distanceMiles(BUYER.lat, BUYER.lng, BUYER.lat + 1, BUYER.lng);
const north = (mi: number) => ({ lat: BUYER.lat + mi / MI_PER_DEG, lng: BUYER.lng });

// Faithful mirror of plan-fulfillment's pickup eligibility (see header). Returns the same
// {canPickup, canShip, radius} the checkout planner derives for these inputs.
function planFulfillmentEligibility(input: ResolveInput): { canPickup: boolean; canShip: boolean; radius: number | null } {
  const stock = new Map<string, number>();
  for (const r of input.inventory) stock.set(r.warehouseCode, (stock.get(r.warehouseCode) ?? 0) + (Number(r.quantity) || 0));
  let canPickup = false;
  let radius: number | null = null;
  if (input.buyerCoords) {
    for (const w of input.warehouses) {
      if (!w.active) continue;                 // active=true query
      if (!w.supportsPickup) continue;         // pickupCandidates: r.warehouse.supports_pickup
      if (w.lat == null || w.lng == null) continue; // resolvedWarehouses excludes null coords
      if ((stock.get(w.code) ?? 0) <= 0) continue;  // warehouseHasAllStock for this SKU
      const d = distanceMiles(input.buyerCoords.lat, input.buyerCoords.lng, w.lat, w.lng);
      if (d <= pickupRadiusMiles(w.state)) { canPickup = true; radius = pickupRadiusMiles(w.state); }
    }
  }
  const canShip = input.delivery !== 'error' && (input.delivery as { available: boolean }).available === true;
  return { canPickup, canShip, radius };
}
function stateOf(canPickup: boolean, canShip: boolean, resolved: boolean): string {
  if (!resolved) return 'unknown';
  if (canPickup && canShip) return 'pickup_and_shipping';
  if (canPickup) return 'pickup_only';
  if (canShip) return 'shipping_only';
  return 'unavailable';
}

const validFee = () => computeDeliveryFeeFromCache([{ supplier_product_id: 'S', charged_fee_cents: 500, currency: 'USD' } as GigaCacheRow], [{ sku: 'S', qty: 1 }]);
const invalidFee = () => computeDeliveryFeeFromCache([], [{ sku: 'S', qty: 1 }]); // no_cached_fee → available=false
const wh = (o: Partial<WarehouseInput> & { state: string; miles?: number }): WarehouseInput => {
  const c = o.miles != null ? north(o.miles) : { lat: o.lat ?? BUYER.lat, lng: o.lng ?? BUYER.lng };
  return { code: o.code ?? 'W', state: o.state, lat: o.lat !== undefined ? o.lat : c.lat, lng: o.lng !== undefined ? o.lng : c.lng, active: o.active ?? true, supportsPickup: o.supportsPickup ?? true };
};
const inv = [{ warehouseCode: 'W', quantity: 5 }];

function parity(name: string, input: ResolveInput, expectState: string) {
  it(name, () => {
    const adv = resolveFulfillmentEligibility(input);
    const plan = planFulfillmentEligibility(input);
    const resolved = input.buyerCoords !== null && input.delivery !== 'error';
    assert.equal(adv.canPickup, plan.canPickup, 'canPickup parity');
    assert.equal(adv.canShip, plan.canShip, 'canShip parity');
    assert.equal(adv.display, stateOf(plan.canPickup, plan.canShip, resolved), 'fulfillment state parity');
    assert.equal(adv.display, expectState, `expected state ${expectState}`);
    // Qualifying pickup radius parity (only meaningful when pickup is possible).
    if (adv.canPickup) {
      const code = adv.qualifyingPickupWarehouses[0];
      const w = input.warehouses.find(x => x.code === code)!;
      assert.equal(pickupRadiusMiles(w.state), plan.radius, 'qualifying pickup radius parity');
    }
  });
}

console.log('advisory ↔ plan-fulfillment eligibility parity');

// Buyer is fixed at BUYER; each warehouse's `miles` sets its distance FROM BUYER (due-north).
parity('CA near (50mi): pickup_and_shipping', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'CA', miles: 50 })], delivery: validFee() }, 'pickup_and_shipping');
parity('CA far (150mi): shipping_only', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'CA', miles: 150 })], delivery: validFee() }, 'shipping_only');
parity('OOS near (30mi ≤50): pickup_and_shipping', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'NJ', miles: 30 })], delivery: validFee() }, 'pickup_and_shipping');
parity('OOS far (70mi >50): shipping_only', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'NJ', miles: 70 })], delivery: validFee() }, 'shipping_only');
parity('shipping-only (near but supports_pickup=false)', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'CA', miles: 10, supportsPickup: false })], delivery: validFee() }, 'shipping_only');
parity('pickup-only (near pickup + invalid fee)', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'CA', miles: 40 })], delivery: invalidFee() }, 'pickup_only');
parity('neither (far + invalid fee)', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'CA', miles: 200 })], delivery: invalidFee() }, 'unavailable');
parity('missing coordinates (near but null coords)', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [{ code: 'W', state: 'CA', lat: null, lng: null, active: true, supportsPickup: true }], delivery: validFee() }, 'shipping_only');
parity('invalid fee only (no pickup wh + missing fee)', { childSku: 'S', buyerCoords: BUYER, inventory: inv, warehouses: [wh({ code: 'W', state: 'NJ', miles: 200 })], delivery: invalidFee() }, 'unavailable');

console.log(`\n${passed} parity assertions passed.`);
