/**
 * Hybrid (official-first) delivery-fee tests — pure; no network, no secrets, no DB.
 * Run: npx tsx src/__tests__/officialDeliveryFee.test.ts
 *
 * Locks the official GIGA product/price/v1 → fee math used by
 * scripts/refreshGigaDeliveryFeesHybrid.ts. See docs/delivery-architecture.md.
 */
import assert from 'node:assert/strict';
import { applyBuffer } from '../../scripts/refreshGigaDeliveryFees';
import { pickOfficialRawFeeCents, buildFailureUpsert, buildOfficialUpsert, type OfficialPriceRow } from '../../scripts/refreshGigaDeliveryFeesHybrid';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('Hybrid official-delivery-fee tests');

// 1) Official fee extraction — confirmed production SKUs (shippingFee == maxAmount)
it('official extraction: confirmed production SKUs use shippingFee', () => {
  const cases: [OfficialPriceRow, number][] = [
    [{ sku: 'W409P327401', currency: 'USD', price: 130, shippingFee: 51.78, shippingFeeRange: { minAmount: 51.78, maxAmount: 51.78 } }, 5178],
    [{ sku: 'W409P327407', currency: 'USD', shippingFee: 47.99, shippingFeeRange: { minAmount: 47.99, maxAmount: 47.99 } }, 4799],
    [{ sku: 'W2899P372844', currency: 'USD', shippingFee: 46.42, shippingFeeRange: { minAmount: 46.42, maxAmount: 46.42 } }, 4642],
    [{ sku: 'W1785P308517', currency: 'USD', shippingFee: 97.60, shippingFeeRange: { minAmount: 97.60, maxAmount: 97.60 } }, 9760],
  ];
  for (const [row, cents] of cases) {
    const p = pickOfficialRawFeeCents(row);
    assert.equal(p.status, 'ok');
    if (p.status === 'ok') { assert.equal(p.rawFeeCents, cents); assert.equal(p.usedField, 'shippingFee'); assert.equal(p.warning, undefined); }
  }
});

// 2) Never-undercharge guard
it('never-undercharge: maxAmount > shippingFee → uses maxAmount + warns', () => {
  const p = pickOfficialRawFeeCents({ sku: 'W2827P203712', currency: 'USD', shippingFee: 84.81, shippingFeeRange: { minAmount: 88.28, maxAmount: 88.28 } });
  assert.equal(p.status, 'ok');
  if (p.status === 'ok') { assert.equal(p.rawFeeCents, 8828); assert.equal(p.usedField, 'shippingFeeRange.maxAmount'); assert.ok(p.warning && /undercharge/.test(p.warning)); }
});

// 3) 8% buffer rounding (reused applyBuffer — unchanged math)
it('8% buffer rounds up to whole dollar', () => {
  assert.equal(applyBuffer(5178, 8), 5600);   // 51.78 → 56.00
  assert.equal(applyBuffer(4799, 8), 5200);   // 47.99 → 52.00
  assert.equal(applyBuffer(4642, 8), 5100);   // 46.42 → 51.00
  assert.equal(applyBuffer(9760, 8), 10600);  // 97.60 → 106.00
  assert.equal(applyBuffer(8828, 8), 9600);   // 88.28 → 96.00
});

// 4) Missing-fee / no-row / non-USD → non-ok status (signals portal fallback)
it('missing fee + no range → no_fee', () => {
  const p = pickOfficialRawFeeCents({ sku: 'X', currency: 'USD', shippingFee: null, shippingFeeRange: null });
  assert.equal(p.status, 'no_fee');
});
it('no row → unavailable(no_row)', () => {
  const p = pickOfficialRawFeeCents(undefined);
  assert.equal(p.status, 'unavailable');
  if (p.status === 'unavailable') assert.equal(p.reason, 'no_row');
});
it('non-USD → currency_mismatch', () => {
  const p = pickOfficialRawFeeCents({ sku: 'E', currency: 'EUR', shippingFee: 10, shippingFeeRange: { minAmount: 12, maxAmount: 12 } });
  assert.equal(p.status, 'currency_mismatch');
});
it('shippingFee null but range present → ok via maxAmount', () => {
  const p = pickOfficialRawFeeCents({ sku: 'R', currency: 'USD', shippingFee: null, shippingFeeRange: { minAmount: 50, maxAmount: 50 } });
  assert.equal(p.status, 'ok');
  if (p.status === 'ok') { assert.equal(p.rawFeeCents, 5000); assert.equal(p.usedField, 'shippingFeeRange.maxAmount'); }
});

// 5) Both-fail never-overwrite: failure patch excludes ALL fee columns
it('both-fail patch never touches fee columns (preserves cached fee)', () => {
  const patch = buildFailureUpsert('W409P327401', 2, 'api_error', 'official=no_row; portal=session_expired', '2026-06-23T00:00:00Z');
  for (const feeCol of ['charged_fee_cents', 'fulfillment_fee_cents', 'shipping_fee_cents', 'packing_fee_cents', 'source', 'currency']) {
    assert.equal(Object.prototype.hasOwnProperty.call(patch, feeCol), false, `failure patch must NOT include ${feeCol}`);
  }
  assert.equal(patch.consecutive_failures, 3);
  assert.equal(patch.last_error_code, 'api_error');
});

// 5b) Official success patch shape (source/labels/columns)
it('official success patch: correct source, packing null, shipping=fulfillment, buffered charge', () => {
  const row: OfficialPriceRow = { sku: 'W409P327401', currency: 'USD', price: 130, shippingFee: 51.78, shippingFeeRange: { minAmount: 51.78, maxAmount: 51.78 } };
  const p = pickOfficialRawFeeCents(row);
  assert.equal(p.status, 'ok');
  if (p.status !== 'ok') return;
  const patch = buildOfficialUpsert('W409P327401', p, row, '2026-06-23T00:00:00Z');
  assert.equal(patch.source, 'giga_openapi_price_v1');
  assert.equal(patch.fee_source_account, 'dropship_82482447');
  assert.equal(patch.product_id_source, 'official_api');
  assert.equal(patch.packing_fee_cents, null);
  assert.equal(patch.fulfillment_fee_cents, 5178);
  assert.equal(patch.shipping_fee_cents, 5178);
  assert.equal(patch.charged_fee_cents, 5600);
  assert.equal(patch.consecutive_failures, 0);
  // raw_snapshot must be fee-safe only (no secrets/cookies/headers)
  assert.deepEqual(Object.keys(patch.raw_snapshot as object).sort(), ['currency', 'price', 'shippingFee', 'shippingFeeRange', 'sku']);
});

console.log(`\n${passed} hybrid official-delivery-fee assertions passed.`);
