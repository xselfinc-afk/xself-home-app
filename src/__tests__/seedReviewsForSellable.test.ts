/**
 * Focused offline tests for the scoped post-sellable review bootstrap
 * (scripts/seedReviewsForSellable.ts). Pure — importing does NOT run main()
 * (direct-invocation guard), so no DB/seeder is touched.
 * Runtime behaviors (idempotency, genuine-review protection, coverage-after-seed) are
 * verified live against the existing seeder — see the task's idempotency/coverage runs.
 * Run: npx tsx src/__tests__/seedReviewsForSellable.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseOnlySkus, partitionSellable } from '../../scripts/seedReviewsForSellable';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('scoped post-sellable review bootstrap tests');

// ── allowlist parsing ──
it('1. parseOnlySkus parses / trims / dedupes', () => {
  assert.deepEqual(parseOnlySkus('A, B ,B,,C'), ['A', 'B', 'C']);
});
it('2. empty / malformed allowlist → [] (fail-closed signal)', () => {
  assert.deepEqual(parseOnlySkus(''), []);
  assert.deepEqual(parseOnlySkus(undefined), []);
  assert.deepEqual(parseOnlySkus('  , ,  '), []);
});

// ── sellable-only filtering ──
const SELLABLE = new Set(['S1', 'S2']);
it('3. only sellable SKUs are eligible; blocked/non-sellable excluded', () => {
  const { eligible, excluded } = partitionSellable(['S1', 'S2', 'B1'], SELLABLE);
  assert.deepEqual(eligible, ['S1', 'S2']);
  assert.deepEqual(excluded, ['B1']);
});
it('4. none-sellable → empty eligible (helper fail-closes on this)', () => {
  const { eligible, excluded } = partitionSellable(['B1', 'B2'], SELLABLE);
  assert.deepEqual(eligible, []);
  assert.deepEqual(excluded, ['B1', 'B2']);
});
it('5. unrelated SKUs never processed (only requested ∩ sellable)', () => {
  const { eligible } = partitionSellable(['S1'], new Set(['S1', 'S2', 'OTHER']));
  assert.deepEqual(eligible, ['S1']); // S2/OTHER not requested → never touched
});

// ── source-level guarantees (no duplication of the review system) ──
const src = readFileSync('scripts/seedReviewsForSellable.ts', 'utf8');
it('6. reuses the existing seedGeneratedReviews (no second generator)', () => {
  assert.ok(src.includes('scripts/seedGeneratedReviews.ts'), 'delegates to the existing seeder');
  assert.ok(!/reviewGenerator|BANKS\b/.test(src), 'no embedded review generator');
});
it('7. no new review table, no ad hoc review insert', () => {
  assert.ok(!/create\s+table/i.test(src));
  assert.ok(!/\.insert\(/.test(src), 'never inserts rows directly — only spawns the seeder');
});
it('8. sellable-only filter + fail-closed guards are present', () => {
  assert.ok(src.includes("from('sellable_products')"), 'filters on sellable_products');
  assert.ok(/FAIL-CLOSED/.test(src), 'fail-closed on missing allowlist / none sellable');
  assert.ok(src.includes("eq('status', 'active')"), 'verifies active-review coverage');
});
it('9. underlying seeder is idempotent via onConflict key (protects genuine reviews)', () => {
  const seeder = readFileSync('scripts/seedGeneratedReviews.ts', 'utf8');
  assert.ok(seeder.includes("onConflict: 'supplier_product_id,reviewer_name'"),
    'generated reviews upsert on (supplier_product_id, reviewer_name) — repeat runs do not duplicate; genuine reviews (other names) untouched');
});

console.log(`\n${passed} passed`);
