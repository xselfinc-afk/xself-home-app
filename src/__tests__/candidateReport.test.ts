/**
 * Focused tests for the --candidate-scan extension of scripts/planGigaSavedItems.ts.
 * Pure logic only (no network/DB): importing the script does NOT run main() because the
 * direct-invocation guard is false when this test file is process.argv[1].
 * Run: npx tsx src/__tests__/candidateReport.test.ts
 */
import assert from 'node:assert/strict';
import {
  computeHeadline, csvCell, toCsv, skuAvailabilityOf, imageCountOf, priceValueOf, normTitle, TAXONOMY_VERSION,
  type CandidateShape,
} from '../../scripts/planGigaSavedItems';
import { classifyCommerce } from '../utils/commerceTaxonomy';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('candidate report extension tests');

const ready: CandidateShape = {
  in_sell: false, in_supplier: false, in_std: false,
  title: 'Folding Treadmill', image_count: 3, price: 199, api_failed: false,
  duplicate_of: '', product_type_id: 'treadmills', sku_available: 'available',
};
const H = (o: Partial<CandidateShape>) => computeHeadline({ ...ready, ...o });

it('headline: a fully valid canonical item is ready', () => {
  assert.equal(H({}), 'ready');
});
it('headline: exactly one bucket per precedence tier', () => {
  assert.equal(H({ in_sell: true }), 'already_published');
  assert.equal(H({ in_supplier: true }), 'already_imported');
  assert.equal(H({ in_std: true }), 'already_imported');
  assert.equal(H({ image_count: 0 }), 'blocked_or_invalid');
  assert.equal(H({ price: 0 }), 'blocked_or_invalid');
  assert.equal(H({ price: null }), 'blocked_or_invalid');
  assert.equal(H({ title: '' }), 'blocked_or_invalid');
  assert.equal(H({ api_failed: true }), 'blocked_or_invalid');
  assert.equal(H({ duplicate_of: 'W1' }), 'duplicate');
  assert.equal(H({ product_type_id: 'needs-review' }), 'needs_review');
  assert.equal(H({ sku_available: 'unavailable' }), 'unavailable');
});
it('headline precedence: higher tier always wins', () => {
  assert.equal(H({ in_sell: true, duplicate_of: 'x', product_type_id: 'needs-review', image_count: 0 }), 'already_published');
  assert.equal(H({ in_supplier: true, image_count: 0 }), 'already_imported');            // imported > blocked
  assert.equal(H({ image_count: 0, duplicate_of: 'x' }), 'blocked_or_invalid');          // blocked > duplicate
  assert.equal(H({ duplicate_of: 'x', product_type_id: 'needs-review' }), 'duplicate');  // duplicate > needs_review
  assert.equal(H({ product_type_id: 'needs-review', sku_available: 'unavailable' }), 'needs_review'); // needs_review > unavailable
});
it('unknown availability never becomes unavailable', () => {
  assert.equal(H({ sku_available: 'unknown' }), 'ready');
  assert.equal(skuAvailabilityOf({}), 'unknown');
  assert.equal(skuAvailabilityOf(undefined), 'unknown');
  assert.equal(skuAvailabilityOf({ skuAvailable: true }), 'available');
  assert.equal(skuAvailabilityOf({ skuAvailable: false }), 'unavailable');
  assert.equal(skuAvailabilityOf({}, { skuAvailable: false }), 'unavailable'); // falls back to price record
});
it('csv escaping: commas, quotes, newlines, null/undefined', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell(5), '5');
  assert.equal(toCsv(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
});
it('field extractors: image count, price value, normalized title', () => {
  assert.equal(imageCountOf({ imageUrls: ['a', 'b'] }), 2);
  assert.equal(imageCountOf({ mainImageUrl: 'x' }), 1);
  assert.equal(imageCountOf({}), 0);
  assert.equal(imageCountOf(undefined), 0);
  assert.equal(priceValueOf({ price: '12.5' }), 12.5);
  assert.equal(priceValueOf({ price: 0 }), 0);
  assert.equal(priceValueOf({}), null);
  assert.equal(priceValueOf(undefined), null);
  assert.equal(normTitle('  Foo   Bar '), 'foo bar');
});
it('taxonomy results come from the production classifyCommerce (single authority)', () => {
  assert.equal(classifyCommerce({ name: 'Small Dog Treadmill', category: 'Treadmills', categoryLabel: '' }).productType, 'needs-review');
  assert.equal(classifyCommerce({ name: 'Folding Treadmill', category: 'Treadmills', categoryLabel: '' }).productType, 'treadmills');
  assert.equal(classifyCommerce({ name: 'Vague Item', category: 'Outdoor Bikes', categoryLabel: '' }).productType, 'outdoor-bikes'); // crosswalk
});
it('taxonomy_version constant matches the validated crosswalk commit', () => {
  assert.equal(TAXONOMY_VERSION, '56438dda');
});

console.log(`\n${passed} passed`);
