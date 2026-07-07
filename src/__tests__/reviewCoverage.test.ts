/**
 * Review-coverage pure-logic tests — no I/O, no Supabase, no secrets.
 * Covers computeMissing (the set-difference core of the review-coverage guard).
 * Run: npx tsx src/__tests__/reviewCoverage.test.ts
 */
import assert from 'node:assert/strict';
import { computeMissing, type CoverageRow } from '../../scripts/checkReviewCoverage';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

function row(id: string, cat: string | null = 'DR'): CoverageRow {
  return { supplier_product_id: id, category_code: cat };
}

console.log('review coverage tests');

it('all sellable reviewed → no missing', () => {
  const sellable = [row('A'), row('B'), row('C')];
  const reviewed = new Set(['A', 'B', 'C']);
  assert.equal(computeMissing(sellable, reviewed).length, 0);
});

it('one unreviewed → returned', () => {
  const sellable = [row('A'), row('B'), row('C')];
  const reviewed = new Set(['A', 'C']);
  const missing = computeMissing(sellable, reviewed);
  assert.deepEqual(missing.map(m => m.supplier_product_id), ['B']);
});

it('empty reviewed set → all sellable missing', () => {
  const sellable = [row('A'), row('B')];
  const missing = computeMissing(sellable, new Set<string>());
  assert.deepEqual(missing.map(m => m.supplier_product_id), ['A', 'B']);
});

it('rows with empty supplier_product_id are ignored (cannot be keyed)', () => {
  const sellable = [row(''), row('B')];
  const missing = computeMissing(sellable, new Set<string>());
  assert.deepEqual(missing.map(m => m.supplier_product_id), ['B']);
});

it('order + category are preserved on the missing rows', () => {
  const sellable = [row('A', 'CB'), row('B', 'DR'), row('C', 'CB')];
  const reviewed = new Set(['B']);
  const missing = computeMissing(sellable, reviewed);
  assert.deepEqual(missing.map(m => `${m.supplier_product_id}:${m.category_code}`), ['A:CB', 'C:CB']);
});

it('does not treat a reviewed id absent from sellable as missing', () => {
  const sellable = [row('A')];
  const reviewed = new Set(['A', 'Z']); // Z reviewed but not sellable → irrelevant
  assert.equal(computeMissing(sellable, reviewed).length, 0);
});

console.log(`\n${passed} passed`);
