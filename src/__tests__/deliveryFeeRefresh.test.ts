/**
 * Pure-function tests for the GIGA delivery-fee refresh script (no network, no DB).
 * Run: npx tsx src/__tests__/deliveryFeeRefresh.test.ts
 *
 * Covers: money parsing, 8% buffer + round-up, drop_ship parsing (incl. failure
 * codes), fee-safe snapshot whitelist, and the read-only URL guard.
 * See scripts/refreshGigaDeliveryFees.ts.
 */
import assert from 'node:assert/strict';
import {
  parseMoneyToCents,
  applyBuffer,
  parseDropShipFee,
  buildFeeSnapshot,
  assertReadOnlyUrl,
  RefreshError,
} from '../../scripts/refreshGigaDeliveryFees';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
function throwsCode(fn: () => void, code: string): void {
  try { fn(); assert.fail(`expected throw [${code}]`); }
  catch (e) {
    if (e instanceof RefreshError) assert.equal(e.code, code);
    else assert.ok(e instanceof Error); // assertReadOnlyUrl throws plain Error
  }
}

console.log('GIGA delivery-fee refresh — pure tests');

// ── parseMoneyToCents ─────────────────────────────────────────────────────────
it('parseMoneyToCents: "$48.74" → 4874', () => assert.equal(parseMoneyToCents('$48.74'), 4874));
it('parseMoneyToCents: "$4.45" → 445', () => assert.equal(parseMoneyToCents('$4.45'), 445));
it('parseMoneyToCents: numeric 53.19 → 5319', () => assert.equal(parseMoneyToCents(53.19), 5319));
it('parseMoneyToCents: "53" → 5300', () => assert.equal(parseMoneyToCents('53'), 5300));
it('parseMoneyToCents: empty/garbage → null', () => {
  assert.equal(parseMoneyToCents(''), null);
  assert.equal(parseMoneyToCents('N/A'), null);
  assert.equal(parseMoneyToCents(null), null);
});
it('parseMoneyToCents: range "$24.83~$28.35" → null (not a single fee)', () =>
  assert.equal(parseMoneyToCents('$24.83~$28.35'), null));

// ── applyBuffer: 8% then round UP to nearest dollar ────────────────────────────
it('applyBuffer: 5319 → 5800 ($53.19 → $58.00)', () => assert.equal(applyBuffer(5319), 5800));
it('applyBuffer: exact dollar still rounds to whole $ (5000 → 5400)', () => assert.equal(applyBuffer(5000), 5400));
it('applyBuffer: 100 → 200 (ceil to next $)', () => assert.equal(applyBuffer(100), 200));
it('applyBuffer: matches Math.ceil((f*1.08)/100)*100 for a sweep', () => {
  for (const f of [1, 99, 445, 4874, 5319, 6959, 12345]) {
    assert.equal(applyBuffer(f), Math.ceil((f * 1.08) / 100) * 100);
  }
});

// ── parseDropShipFee: confirmed live shape for W3204P484603 ────────────────────
it('parseDropShipFee: confirmed drop_ship → 445/4874/5319, charged 5800', () => {
  const r = parseDropShipFee({
    package_fee_show: '$4.45',
    shipping_fee_show: '$48.74',
    total_amount: 53.19,
    total_show: '$53.19',
    handling_time: { min_day: 1, max_day: 3 },
    estimated_ship_day: { min_day: 3, max_day: 5 },
  });
  assert.equal(r.packingFeeCents, 445);
  assert.equal(r.shippingFeeCents, 4874);
  assert.equal(r.fulfillmentFeeCents, 5319);
  assert.equal(r.chargedFeeCents, 5800);
  assert.equal(r.currency, 'USD');
});
it('parseDropShipFee: missing block → no_drop_ship', () =>
  throwsCode(() => parseDropShipFee(null), 'no_drop_ship'));
it('parseDropShipFee: non-positive total_amount → parse_error', () =>
  throwsCode(() => parseDropShipFee({ total_amount: 0, total_show: '$0' }), 'parse_error'));
it('parseDropShipFee: packing+shipping != fulfillment (>2¢) → fee_mismatch', () =>
  throwsCode(() => parseDropShipFee({
    package_fee_show: '$4.45', shipping_fee_show: '$48.74', total_amount: 99.99, total_show: '$99.99',
  }), 'fee_mismatch'));
it('parseDropShipFee: non-$ show fields → currency_mismatch', () =>
  throwsCode(() => parseDropShipFee({
    package_fee_show: '4.45', shipping_fee_show: '48.74', total_amount: 53.19, total_show: '£53.19',
  }), 'currency_mismatch'));
it('parseDropShipFee: tolerates 1¢ rounding (445+4875 vs 5319)', () => {
  const r = parseDropShipFee({ package_fee_show: '$4.45', shipping_fee_show: '$48.75', total_amount: 53.19, total_show: '$53.19' });
  assert.equal(r.fulfillmentFeeCents, 5319);
});

// ── buildFeeSnapshot: ONLY the fee-safe whitelist (no URLs/extra product data) ─
it('buildFeeSnapshot: keeps only the 6 allowed keys, drops everything else', () => {
  const snap = buildFeeSnapshot({
    package_fee_show: '$4.45',
    shipping_fee_show: '$48.74',
    total_amount: 53.19,
    total_show: '$53.19',
    handling_time: { min_day: 1, max_day: 3, extra: 'x' },
    estimated_ship_day: { min_day: 3, max_day: 5 },
    is_support_amazon_drop_ship: false,            // must be dropped
    some_image_url: 'https://cdn.example/x.png?x-cs=secret', // must be dropped
    cookie: 'PHPSESSID=abc',                       // must be dropped
  });
  assert.deepEqual(Object.keys(snap).sort(), [
    'estimated_ship_day', 'handling_time', 'package_fee_show', 'shipping_fee_show', 'total_amount', 'total_show',
  ]);
  assert.deepEqual(snap.handling_time, { min_day: 1, max_day: 3 }); // nested extra stripped
  assert.equal((snap as any).some_image_url, undefined);
  assert.equal((snap as any).cookie, undefined);
});

// ── assertReadOnlyUrl: allow read-only product routes, refuse money/order paths ─
it('assertReadOnlyUrl: allows price/list, product, search', () => {
  assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=/product/info/price/list&product_id=1420191');
  assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=product/product&sku=W3204P484603');
  assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=product/search&search=W3204P484603');
});
it('assertReadOnlyUrl: refuses order/sync/dropShip-sync/pickUp-sync/submit/cancel/stripe', () => {
  for (const bad of [
    'https://www.gigab2b.com/index.php?route=/buyer/order/dropShip-sync/v1',
    'https://www.gigab2b.com/index.php?route=/buyer/order/pickUp-sync/v1',
    'https://www.gigab2b.com/index.php?route=order/submit',
    'https://www.gigab2b.com/index.php?route=order/cancel',
    'https://api.stripe.com/v1/payment_intents',
    'https://www.gigab2b.com/index.php?route=/product/info/price/list&sync=1',
  ]) {
    assert.throws(() => assertReadOnlyUrl(bad), /REFUSED/);
  }
});
it('assertReadOnlyUrl: refuses an unknown read route not in the allowlist', () =>
  assert.throws(() => assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=product/info/detailInfo&product_id=1'), /REFUSED/));

console.log(`\n${passed} refresh assertions passed.`);
