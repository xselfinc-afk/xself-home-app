/**
 * Real XHR fetcher → canonical classifier wiring (Phase 2A Commit B).
 * Tests the PURE classifyWarehouseResponse used by fetchWarehouseRows (no network I/O;
 * the module's CLI is guarded by require.main===module and session() is lazy).
 * Run: npx tsx src/__tests__/xhrFetcherClassify.test.ts
 */
import assert from 'node:assert/strict';
import { classifyWarehouseResponse } from '../../scripts/fetchGigaWarehouseInventoryFromXhr';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
const call = (over: any) => classifyWarehouseResponse({ networkError: false, status: 200, json: null, text: '', supplierProductId: 'W331S00059', sku: 'W331S00059', ...over });
const env = (dists: any) => ({ code: 200, data: { stock_distributions: dists } });

console.log('xhr fetcher → canonical classifier');

it('CA positive → confirmed_in_stock_ca', () => {
  assert.equal(call({ json: env([{ qty: 5, wh_id: 1, warehouse_code: 'CA2' }]) }).status, 'confirmed_in_stock_ca');
});
it('OOS positive → confirmed_in_stock_out_of_state', () => {
  assert.equal(call({ json: env([{ qty: 3, wh_id: 2, warehouse_code: 'NJ2' }]) }).status, 'confirmed_in_stock_out_of_state');
});
it('non-empty all-zero distributions → confirmed_out_of_stock (affirmative per-warehouse zero)', () => {
  const r = call({ json: env([{ qty: 0, warehouse_code: 'CA2' }, { qty: 0, warehouse_code: 'NJ2' }]) });
  assert.equal(r.status, 'confirmed_out_of_stock');
});
it('CRITICAL: EMPTY distributions (clean 200) → inventory_unknown, NEVER zero', () => {
  const r = call({ json: env([]) });
  assert.equal(r.status, 'inventory_unknown');
  assert.notEqual(r.status, 'confirmed_out_of_stock');
});
it('HTTP 401 → authentication_required (never zero)', () => {
  assert.equal(call({ status: 401, json: null }).status, 'authentication_required');
});
it('supplier auth code B20003 → authentication_required', () => {
  assert.equal(call({ json: { code: 'B20003', msg: 'no permission' } }).status, 'authentication_required');
});
it('CAPTCHA / WAF challenge text → captcha_required', () => {
  assert.equal(call({ json: null, text: '<html>Aliyun slider captcha 安全验证</html>' }).status, 'captcha_required');
});
it('unparseable body (200, no json, no captcha) → parse_failed', () => {
  assert.equal(call({ json: null, text: '<html>Service temporarily unavailable</html>' }).status, 'parse_failed');
});
it('network error → network_failed', () => {
  assert.equal(call({ networkError: true, status: 0, json: null }).status, 'network_failed');
});
it('HTTP 5xx → supplier_unavailable', () => {
  assert.equal(call({ status: 503, json: null }).status, 'supplier_unavailable');
});
it('"Login To See Price" auth code path never yields zero', () => {
  // A permission-shaped supplier code must classify as auth, not zero.
  const r = call({ json: { code: 'B20003', msg: 'Login To See Price' } });
  assert.equal(r.status, 'authentication_required');
});

console.log(`\n${passed} passed`);
