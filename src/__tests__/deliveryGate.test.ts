/**
 * Client-capability version-gate tests (pure; no network, no secrets).
 * Run: npx tsx src/__tests__/deliveryGate.test.ts
 *
 * Proves the legacy/new branching used by plan-fulfillment + create-checkout-order:
 *   • NEW clients get the dynamic fee (or a blocked checkout) — no $99.
 *   • OLD clients always get a numeric, non-null fee and are NEVER blocked.
 * See supabase/functions/_shared/deliveryFee.ts.
 */
import assert from 'node:assert/strict';
import {
  LEGACY_DELIVERY_FEE_DOLLARS,
  resolvePlanShippingDollars,
  resolveCheckoutShippingCents,
} from '../../supabase/functions/_shared/deliveryFee';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('Delivery version-gate tests');

// ── plan-fulfillment shipping (dollars) ──────────────────────────────────────
it('NEW client: pickup → 0', () => {
  assert.equal(resolvePlanShippingDollars({ usePickup: true, clientSupportsDynamicDelivery: true, deliveryFeeCents: null }), 0);
});
it('NEW client: delivery with fee → dynamic dollars', () => {
  assert.equal(resolvePlanShippingDollars({ usePickup: false, clientSupportsDynamicDelivery: true, deliveryFeeCents: 8828 }), 88.28);
});
it('NEW client: delivery, fee unavailable → null (no $99)', () => {
  assert.equal(resolvePlanShippingDollars({ usePickup: false, clientSupportsDynamicDelivery: true, deliveryFeeCents: null }), null);
});
it('OLD client: delivery → legacy numeric (99), NEVER null', () => {
  const v = resolvePlanShippingDollars({ usePickup: false, clientSupportsDynamicDelivery: false, deliveryFeeCents: null });
  assert.equal(v, LEGACY_DELIVERY_FEE_DOLLARS);
  assert.notEqual(v, null);
  assert.equal(typeof v, 'number');
});
it('OLD client: pickup → 0', () => {
  assert.equal(resolvePlanShippingDollars({ usePickup: true, clientSupportsDynamicDelivery: false, deliveryFeeCents: null }), 0);
});

// ── create-checkout-order shippingCents ──────────────────────────────────────
it('NEW client: pickup → {cents:0}', () => {
  assert.deepEqual(resolveCheckoutShippingCents({ usePickup: true, clientSupportsDynamicDelivery: true, deliveryAvailable: false, deliveryFeeCents: null, legacyShippingDollars: 99 }), { cents: 0 });
});
it('NEW client: delivery available → charge dynamic fee cents', () => {
  assert.deepEqual(resolveCheckoutShippingCents({ usePickup: false, clientSupportsDynamicDelivery: true, deliveryAvailable: true, deliveryFeeCents: 8828, legacyShippingDollars: null }), { cents: 8828 });
});
it('NEW client: delivery unavailable → BLOCK (fail closed, no $99)', () => {
  const r = resolveCheckoutShippingCents({ usePickup: false, clientSupportsDynamicDelivery: true, deliveryAvailable: false, deliveryFeeCents: null, legacyShippingDollars: 99 });
  assert.deepEqual(r, { block: 'delivery_fee_unavailable' });
});
it('NEW client: deliveryFeeCents null even if "available" → BLOCK', () => {
  const r = resolveCheckoutShippingCents({ usePickup: false, clientSupportsDynamicDelivery: true, deliveryAvailable: true, deliveryFeeCents: null, legacyShippingDollars: 99 });
  assert.deepEqual(r, { block: 'delivery_fee_unavailable' });
});
it('OLD client: delivery → legacy numeric cents, NEVER blocked', () => {
  const r = resolveCheckoutShippingCents({ usePickup: false, clientSupportsDynamicDelivery: false, deliveryAvailable: false, deliveryFeeCents: null, legacyShippingDollars: 99 });
  assert.deepEqual(r, { cents: 9900 });
  assert.ok(!('block' in r), 'old client must never be blocked');
});
it('OLD client: delivery with non-numeric legacy → falls back to LEGACY constant, still numeric', () => {
  const r = resolveCheckoutShippingCents({ usePickup: false, clientSupportsDynamicDelivery: false, deliveryAvailable: false, deliveryFeeCents: null, legacyShippingDollars: null });
  assert.deepEqual(r, { cents: LEGACY_DELIVERY_FEE_DOLLARS * 100 });
});
it('OLD client: pickup → {cents:0}', () => {
  assert.deepEqual(resolveCheckoutShippingCents({ usePickup: true, clientSupportsDynamicDelivery: false, deliveryAvailable: false, deliveryFeeCents: null, legacyShippingDollars: 99 }), { cents: 0 });
});

console.log(`\n${passed} version-gate assertions passed.`);
