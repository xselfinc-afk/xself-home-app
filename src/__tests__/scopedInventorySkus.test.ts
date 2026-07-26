/**
 * Focused tests for the scoped `--skus` inventory extension in
 * scripts/syncGigaFurnitureInventory.ts. Pure/offline — importing the module does NOT
 * run run() (direct-invocation guard), so no Playwright/DB is touched.
 * Run: npx tsx src/__tests__/scopedInventorySkus.test.ts
 */
import assert from 'node:assert/strict';
import { parseSkusArg, buildScopedTargets } from '../../scripts/syncGigaFurnitureInventory';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('scoped inventory --skus tests');

// ── parseSkusArg ──────────────────────────────────────────────────────────────
it('1. parses `--skus A,B,C` (space form)', () => {
  assert.deepEqual(parseSkusArg(['--skus', 'W1,W2,W3']), ['W1', 'W2', 'W3']);
});
it('2. parses `--skus=A,B` (equals form)', () => {
  assert.deepEqual(parseSkusArg(['--skus=W1,W2']), ['W1', 'W2']);
});
it('3. dedupes and trims, drops empty tokens', () => {
  assert.deepEqual(parseSkusArg(['--skus', 'W1, W2 ,W2,,  ,W3']), ['W1', 'W2', 'W3']);
});
it('4. no flag → empty (default furniture behavior preserved)', () => {
  assert.deepEqual(parseSkusArg(['--dry-run']), []);
  assert.deepEqual(parseSkusArg([]), []);
});
it('5. malformed/empty allowlist → empty (run() fail-closes on this)', () => {
  assert.deepEqual(parseSkusArg(['--skus', '']), []);
  assert.deepEqual(parseSkusArg(['--skus=']), []);
  assert.deepEqual(parseSkusArg(['--skus', ' , , ']), []);
});

// ── buildScopedTargets ──────────────────────────────────────────────────────────
const ALLOW = ['W5397P453895', 'W2921P221486'];
it('6. sources supplier rows into the CandidateProduct shape', () => {
  const out = buildScopedTargets([{ supplier_product_id: 'W5397P453895', title: 'Fountain' }], ALLOW);
  assert.equal(out.length, 1);
  assert.equal(out[0].product_id, 'W5397P453895');
  assert.ok(out[0].product_url.includes('sku=W5397P453895'));
  assert.equal(out[0].title, 'Fountain');
  assert.equal(out[0].inventory_status, null);
});
it('7. strictly excludes any SKU not in the allowlist', () => {
  const out = buildScopedTargets([
    { supplier_product_id: 'W5397P453895', title: 'in' },
    { supplier_product_id: 'W9999XUNRELATED', title: 'furniture etc' },
  ], ALLOW);
  assert.deepEqual(out.map(p => p.product_id), ['W5397P453895']);
});
it('8. dedupes repeated rows', () => {
  const out = buildScopedTargets([
    { supplier_product_id: 'W2921P221486', title: 'a' },
    { supplier_product_id: 'W2921P221486', title: 'a-dup' },
  ], ALLOW);
  assert.equal(out.length, 1);
});
it('9. a malformed row (null/empty SKU) does not corrupt the others', () => {
  const out = buildScopedTargets([
    { supplier_product_id: null, title: 'bad' },
    { supplier_product_id: '', title: 'bad2' },
    { title: 'no-id' } as any,
    { supplier_product_id: 'W5397P453895', title: 'good' },
  ], ALLOW);
  assert.deepEqual(out.map(p => p.product_id), ['W5397P453895']);
});
it('10. importing the module did NOT execute run() (direct-invocation guard holds)', () => {
  // If run() had executed on import, this test process would have hit the session/DB checks
  // and exited before reaching here. Reaching here + both exports being functions proves it.
  assert.equal(typeof parseSkusArg, 'function');
  assert.equal(typeof buildScopedTargets, 'function');
});

console.log(`\n${passed} passed`);
