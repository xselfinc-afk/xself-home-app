/**
 * Focused tests for the product-detail header review summary (src/utils/reviewSummary.ts).
 * Verifies the header will match ReviewSection's displayed count/avg (real-if-any-else-generated).
 * Run: npx tsx src/__tests__/reviewSummary.test.ts
 */
import assert from 'node:assert/strict';
import { summarizeActiveReviews } from '../utils/reviewSummary';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('product-detail header review summary');

it('1. all-generated bootstrap (5,5,5,4,4) → count 5, avg 4.6 (matches ReviewSection)', () => {
  const rows = [5, 5, 5, 4, 4].map(rating => ({ rating, is_generated: true }));
  assert.deepEqual(summarizeActiveReviews(rows), { count: 5, avg: 4.6 });
});
it('2. real reviews present → real-only summary (generated ignored)', () => {
  const rows = [
    { rating: 3, is_generated: false },
    { rating: 5, is_generated: false },
    { rating: 5, is_generated: true },
    { rating: 5, is_generated: true },
  ];
  assert.deepEqual(summarizeActiveReviews(rows), { count: 2, avg: 4 });
});
it('3. no active reviews → count 0 (header hides its rating row)', () => {
  assert.deepEqual(summarizeActiveReviews([]), { count: 0, avg: 0 });
});
it('4. single review → count 1', () => {
  assert.deepEqual(summarizeActiveReviews([{ rating: 5, is_generated: true }]), { count: 1, avg: 5 });
});
it('5. average is rounded to one decimal', () => {
  const rows = [{ rating: 4 }, { rating: 5 }, { rating: 5 }]; // 14/3 = 4.666… → 4.7
  assert.deepEqual(summarizeActiveReviews(rows), { count: 3, avg: 4.7 });
});
it('6. missing is_generated treated as real (undefined !== true)', () => {
  assert.deepEqual(summarizeActiveReviews([{ rating: 4 }, { rating: 4 }]), { count: 2, avg: 4 });
});

console.log(`\n${passed} passed`);
