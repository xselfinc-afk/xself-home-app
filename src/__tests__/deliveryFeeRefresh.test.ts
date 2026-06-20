/**
 * Pure-function + guardrail tests for the GIGA delivery-fee refresh script (no network, no DB).
 * Run: npx tsx src/__tests__/deliveryFeeRefresh.test.ts
 *
 * Covers: money parsing, 8% buffer + round-up, drop_ship parsing (incl. failure codes),
 * fee-safe snapshot whitelist, the (tightened) read-only URL guard, the seed-CSV parser,
 * product_id resolution precedence / no_mapping, and a guardrail that the refresh + audit
 * scripts never write product/catalog tables.
 * See scripts/refreshGigaDeliveryFees.ts.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  parseMoneyToCents,
  applyBuffer,
  parseDropShipFee,
  buildFeeSnapshot,
  assertReadOnlyUrl,
  parseSeedCsv,
  pickProductId,
  RefreshError,
} from '../../scripts/refreshGigaDeliveryFees';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
function throwsCode(fn: () => void, code: string): void {
  try { fn(); assert.fail(`expected throw [${code}]`); }
  catch (e) {
    if (e instanceof RefreshError) assert.equal(e.code, code);
    else assert.ok(e instanceof Error);
  }
}

console.log('GIGA delivery-fee refresh — pure + guardrail tests');

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
it('parseMoneyToCents: range "$24.83~$28.35" → null', () => assert.equal(parseMoneyToCents('$24.83~$28.35'), null));

// ── applyBuffer ────────────────────────────────────────────────────────────────
it('applyBuffer: 5319 → 5800 ($53.19 → $58.00)', () => assert.equal(applyBuffer(5319), 5800));
it('applyBuffer: 5000 → 5400', () => assert.equal(applyBuffer(5000), 5400));
it('applyBuffer: 100 → 200', () => assert.equal(applyBuffer(100), 200));
it('applyBuffer: matches ceil((f*1.08)/100)*100 sweep', () => {
  for (const f of [1, 99, 445, 4874, 5319, 6959, 12345]) assert.equal(applyBuffer(f), Math.ceil((f * 1.08) / 100) * 100);
});

// ── parseDropShipFee ────────────────────────────────────────────────────────────
it('parseDropShipFee: confirmed drop_ship → 445/4874/5319, charged 5800', () => {
  const r = parseDropShipFee({ package_fee_show: '$4.45', shipping_fee_show: '$48.74', total_amount: 53.19, total_show: '$53.19', handling_time: { min_day: 1, max_day: 3 }, estimated_ship_day: { min_day: 3, max_day: 5 } });
  assert.equal(r.packingFeeCents, 445);
  assert.equal(r.shippingFeeCents, 4874);
  assert.equal(r.fulfillmentFeeCents, 5319);
  assert.equal(r.chargedFeeCents, 5800);
  assert.equal(r.currency, 'USD');
});
it('parseDropShipFee: missing block → no_drop_ship', () => throwsCode(() => parseDropShipFee(null), 'no_drop_ship'));
it('parseDropShipFee: non-positive total_amount → parse_error', () => throwsCode(() => parseDropShipFee({ total_amount: 0, total_show: '$0' }), 'parse_error'));
it('parseDropShipFee: packing+shipping != fulfillment (>2¢) → fee_mismatch', () => throwsCode(() => parseDropShipFee({ package_fee_show: '$4.45', shipping_fee_show: '$48.74', total_amount: 99.99, total_show: '$99.99' }), 'fee_mismatch'));
it('parseDropShipFee: non-$ show fields → currency_mismatch', () => throwsCode(() => parseDropShipFee({ package_fee_show: '4.45', shipping_fee_show: '48.74', total_amount: 53.19, total_show: '£53.19' }), 'currency_mismatch'));
it('parseDropShipFee: tolerates 1¢ rounding (445+4875 vs 5319)', () => {
  const r = parseDropShipFee({ package_fee_show: '$4.45', shipping_fee_show: '$48.75', total_amount: 53.19, total_show: '$53.19' });
  assert.equal(r.fulfillmentFeeCents, 5319);
});

// ── buildFeeSnapshot ─────────────────────────────────────────────────────────
it('buildFeeSnapshot: keeps only the 6 allowed keys, drops everything else', () => {
  const snap = buildFeeSnapshot({
    package_fee_show: '$4.45', shipping_fee_show: '$48.74', total_amount: 53.19, total_show: '$53.19',
    handling_time: { min_day: 1, max_day: 3, extra: 'x' }, estimated_ship_day: { min_day: 3, max_day: 5 },
    is_support_amazon_drop_ship: false, some_image_url: 'https://cdn.example/x.png?x-cs=secret', cookie: 'PHPSESSID=abc',
  });
  assert.deepEqual(Object.keys(snap).sort(), ['estimated_ship_day', 'handling_time', 'package_fee_show', 'shipping_fee_show', 'total_amount', 'total_show']);
  assert.deepEqual(snap.handling_time, { min_day: 1, max_day: 3 });
  assert.equal((snap as any).some_image_url, undefined);
  assert.equal((snap as any).cookie, undefined);
});

// ── assertReadOnlyUrl (tightened: ONLY price/list allowed; SPA resolver routes removed) ──
it('assertReadOnlyUrl: allows price/list', () => {
  assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=/product/info/price/list&product_id=1420191');
});
it('assertReadOnlyUrl: now refuses product/product and product/search (SPA resolver removed)', () => {
  assert.throws(() => assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=product/product&sku=W3204P484603'), /REFUSED/);
  assert.throws(() => assertReadOnlyUrl('https://www.gigab2b.com/index.php?route=product/search&search=W3204P484603'), /REFUSED/);
});
it('assertReadOnlyUrl: refuses order/sync/dropShip-sync/pickUp-sync/submit/cancel/stripe', () => {
  for (const bad of [
    'https://www.gigab2b.com/index.php?route=/buyer/order/dropShip-sync/v1',
    'https://www.gigab2b.com/index.php?route=/buyer/order/pickUp-sync/v1',
    'https://www.gigab2b.com/index.php?route=order/submit',
    'https://www.gigab2b.com/index.php?route=order/cancel',
    'https://api.stripe.com/v1/payment_intents',
    'https://www.gigab2b.com/index.php?route=/product/info/price/list&sync=1',
  ]) assert.throws(() => assertReadOnlyUrl(bad), /REFUSED/);
});

// ── parseSeedCsv ─────────────────────────────────────────────────────────────
it('parseSeedCsv: header + valid row → one row', () => {
  const r = parseSeedCsv('supplier_product_id,dropship_giga_product_id\nW3204P484603,1420191\n');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0], { supplierProductId: 'W3204P484603', dropshipGigaProductId: '1420191' });
  assert.equal(r.skipped.length, 0);
});
it('parseSeedCsv: skips blanks, comments, missing-col, non-numeric id, sku_custom', () => {
  const r = parseSeedCsv([
    'supplier_product_id,dropship_giga_product_id',
    '# comment',
    '',
    'W3204P484603,1420191',
    'W1445P214051',                 // missing column
    'BADROW,not_a_number',          // non-numeric id
    'XH-CB-LR-214051,1420191',      // sku_custom form
    'T3609P482837,  482837  ',      // whitespace tolerated
  ].join('\n'));
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows.map((x) => x.supplierProductId).sort(), ['T3609P482837', 'W3204P484603']);
  assert.equal(r.rows.find((x) => x.supplierProductId === 'T3609P482837')?.dropshipGigaProductId, '482837');
  assert.equal(r.skipped.length, 3);
});

// ── pickProductId (precedence; none → no_mapping) ──────────────────────────────
it('pickProductId: --product-id (cli) wins', () => assert.deepEqual(pickProductId({ forced: '111', seeded: '222', db: '333' }), { id: '111', source: 'cli' }));
it('pickProductId: seeded csv beats db', () => assert.deepEqual(pickProductId({ seeded: '222', db: '333' }), { id: '222', source: 'manual_csv' }));
it('pickProductId: db when only db', () => assert.deepEqual(pickProductId({ db: '333' }), { id: '333', source: 'db' }));
it('pickProductId: none → null/none (→ no_mapping)', () => assert.deepEqual(pickProductId({}), { id: null, source: 'none' }));

// ── Guardrail: refresh/audit scripts must NOT write product/catalog tables ─────
it('guardrail: refreshGigaDeliveryFees.ts never references catalog tables; writes only the fee cache', () => {
  const src = fs.readFileSync('scripts/refreshGigaDeliveryFees.ts', 'utf8');
  assert.ok(!/['"](supplier_products|standardized_products|sellable_products|giga_products)['"]/.test(src), 'refresh must not reference catalog/product tables');
  assert.ok(/giga_delivery_fee_cache/.test(src) && /\.upsert\(/.test(src), 'refresh should upsert into giga_delivery_fee_cache');
});
it('guardrail: auditDropshipFeeCoverage.ts performs NO writes (read-only)', () => {
  const src = fs.readFileSync('scripts/auditDropshipFeeCoverage.ts', 'utf8');
  assert.ok(!/\.(upsert|insert|update|delete)\(/.test(src), 'audit must be read-only (no upsert/insert/update/delete)');
});

console.log(`\n${passed} refresh assertions passed.`);
