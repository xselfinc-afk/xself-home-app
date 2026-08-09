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
import * as fs from 'node:fs';
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

// ── 配送时效文案的两处必须一致 ──────────────────────────────────────────────
//
// 这句话由服务端 plan-fulfillment 和客户端 CheckoutScreen 各自持有一份。两处不一致时，
// 用户会在同一次结账里看到两种说法 —— 这是这次改动唯一的真实风险，所以钉住它。
//
// 它是运营承诺，不是算出来的：系统里没有任何配送时效数据（2026-08-09 审计，
// GIGA 的 price / detailInfo / inventory / warehouse 只返回费用、入仓日期与地址）。
// 因此这里只校验两处同步与「不得由距离推导」，不校验天数本身 —— 那是业务决定。
{
  const copySrcClient = fs.readFileSync('src/screens/CheckoutScreen.tsx', 'utf8');
  const copySrcServer = fs.readFileSync('supabase/functions/plan-fulfillment/index.ts', 'utf8');
  const clientCopy = copySrcClient.match(/const DELIVERY_TIMING_COPY = '([^']+)'/)?.[1] ?? null;
  const serverCopy = copySrcServer.match(/if \(usePickup\) return '[^']+';\s*\n\s*return '([^']+)';/)?.[1] ?? null;

  it('配送时效文案：服务端与客户端一字不差', () => {
    assert.ok(clientCopy, 'CheckoutScreen 必须有 DELIVERY_TIMING_COPY');
    assert.ok(serverCopy, 'plan-fulfillment 必须返回配送时效文案');
    assert.equal(serverCopy, clientCopy, '两处配送时效文案必须完全一致，否则同一次结账会出现两种说法');
  });

  it('配送时效不得由距离推导，运费仍走服务端真实金额', () => {
    // 距离参数在配送分支必须保持不用 —— 按距离分档的猜测正是当初被回滚掉的做法。
    assert.ok(/function estimatedDelivery\(_distanceMiles: number/.test(copySrcServer), '距离参数必须保持未使用');
    const branch = copySrcServer.slice(copySrcServer.indexOf('function estimatedDelivery'), copySrcServer.indexOf('/** Add business days'));
    assert.equal(/_distanceMiles\s*[<>=]/.test(branch), false, '配送文案不得依赖距离');
    // 运费仍然来自服务端权威金额，不得因为这次文案改动混进硬编码。
    assert.ok(/plan\.deliveryFeeCents != null \? plan\.deliveryFeeCents \/ 100 : 0/.test(copySrcClient),
      'Delivery 金额必须仍取 plan.deliveryFeeCents');
  });
}

console.log(`\n${passed} parity assertions passed.`);
