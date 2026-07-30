/**
 * Canonical inventory RESULT classification tests — pure, no I/O.
 * The load-bearing safety property: no failure/absence is ever confirmed_out_of_stock.
 * Run: npx tsx src/__tests__/inventoryResult.test.ts
 */
import assert from 'node:assert/strict';
import {
  classifyInventoryResult, xhrSignalsFromEnvelope, countsAsConfirmedZero,
  type ClassifyMeta, type RawInventorySignals,
} from '../services/inventoryResult';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const META: ClassifyMeta = {
  source: 'giga_pickup', accountType: 'pickup', supplierProductId: 'W331S00059',
  sku: 'XH-CB-BD-S00059', checkedAt: '2026-07-30T00:00:00.000Z', sessionId: 'pickup',
};
const c = (s: RawInventorySignals) => classifyInventoryResult(s, META);
const caStateOf = (code: string) => (/^CA/i.test(code) ? 'CA' : 'NJ');

console.log('inventory result classification');

it('explicit California stock → confirmed_in_stock_ca (P-CA, counts stock)', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true,
    parsedWarehouses: [{ warehouseCode: 'CA2', warehouseState: 'CA', quantity: 8, supportsPickup: true }] });
  assert.equal(r.status, 'confirmed_in_stock_ca');
  assert.equal(r.hasCaStock, true);
  assert.equal(r.totalQuantity, 8);
});

it('explicit out-of-state shippable stock → confirmed_in_stock_out_of_state', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true,
    parsedWarehouses: [{ warehouseCode: 'NJ2', warehouseState: 'NJ', quantity: 5, supportsShipping: true }] });
  assert.equal(r.status, 'confirmed_in_stock_out_of_state');
  assert.equal(r.hasCaStock, false);
  assert.equal(r.hasShippableStock, true);
});

it('CA wins when both CA and OOS have stock', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses: [
    { warehouseCode: 'NJ2', warehouseState: 'NJ', quantity: 5 },
    { warehouseCode: 'CA2', warehouseState: 'CA', quantity: 1 },
  ] });
  assert.equal(r.status, 'confirmed_in_stock_ca');
});

it('explicit zero stock (affirmative "0 Available") → confirmed_out_of_stock', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true,
    parsedWarehouses: [], affirmativeZeroSignal: true });
  assert.equal(r.status, 'confirmed_out_of_stock');
  assert.equal(countsAsConfirmedZero(r.status), true);
  assert.equal(r.totalQuantity, 0);
});

it('auth expired (HTTP 401) → authentication_required (NOT zero)', () => {
  const r = c({ httpStatus: 401 });
  assert.equal(r.status, 'authentication_required');
  assert.equal(countsAsConfirmedZero(r.status), false);
});

it('auth expired (login page redirect) → authentication_required', () => {
  assert.equal(c({ isLoginPage: true }).status, 'authentication_required');
});

it('"Login To See Price" → authentication_required (never zero)', () => {
  const r = c({ httpStatus: 200, loginToSeePrice: true });
  assert.equal(r.status, 'authentication_required');
  assert.equal(countsAsConfirmedZero(r.status), false);
});

it('CAPTCHA / challenge → captcha_required', () => {
  assert.equal(c({ isCaptcha: true }).status, 'captcha_required');
});

it('supplier permission code B20003 → authentication_required', () => {
  assert.equal(c({ httpStatus: 200, supplierErrorCode: 'B20003' }).status, 'authentication_required');
});

it('supplier non-200 business error → supplier_unavailable', () => {
  assert.equal(c({ httpStatus: 200, supplierErrorCode: 'E9001' }).status, 'supplier_unavailable');
});

it('HTTP 5xx → supplier_unavailable', () => {
  assert.equal(c({ httpStatus: 503 }).status, 'supplier_unavailable');
});

it('parse failure (unparseable body) → parse_failed', () => {
  assert.equal(c({ httpStatus: 200, bodyParseable: false }).status, 'parse_failed');
});

it('missing warehouse selector → parse_failed (NOT zero)', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: false });
  assert.equal(r.status, 'parse_failed');
  assert.equal(countsAsConfirmedZero(r.status), false);
});

it('network timeout → network_failed', () => {
  assert.equal(c({ networkError: true }).status, 'network_failed');
});

it('stale cache read (age > threshold) → stale', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true,
    parsedWarehouses: [{ warehouseCode: 'CA2', warehouseState: 'CA', quantity: 9 }],
    ageMs: 40 * 60 * 60 * 1000, staleThresholdMs: 24 * 60 * 60 * 1000 });
  assert.equal(r.status, 'stale');
});

it('CRITICAL: no positive rows WITHOUT an affirmative zero → inventory_unknown (never zero)', () => {
  const r = c({ httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses: [] });
  assert.equal(r.status, 'inventory_unknown');
  assert.equal(countsAsConfirmedZero(r.status), false);
});

it('empty XHR envelope (clean 200, no distributions) → inventory_unknown (audited fix, never zero)', () => {
  const sig = xhrSignalsFromEnvelope({ httpStatus: 200, json: { code: 200, data: { stock_distributions: [] } }, warehouseStateOf: caStateOf });
  assert.equal(c(sig).status, 'inventory_unknown');
});

it('XHR auth error envelope (B20003) → authentication_required, not empty→zero', () => {
  const sig = xhrSignalsFromEnvelope({ httpStatus: 200, json: { code: 'B20003', msg: 'no permission' }, warehouseStateOf: caStateOf });
  assert.equal(c(sig).status, 'authentication_required');
});

it('XHR with CA distribution → confirmed_in_stock_ca', () => {
  const sig = xhrSignalsFromEnvelope({ httpStatus: 200, warehouseStateOf: caStateOf,
    json: { code: 200, data: { stock_distributions: [{ warehouse_code: 'CA2', qty: 3 }] } } });
  assert.equal(c(sig).status, 'confirmed_in_stock_ca');
});

it('XHR HTTP 401 → authentication_required', () => {
  assert.equal(c(xhrSignalsFromEnvelope({ httpStatus: 401 })).status, 'authentication_required');
});

console.log(`\n${passed} passed`);
