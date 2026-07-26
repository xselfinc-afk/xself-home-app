/**
 * Focused tests: auto-publish planner base classification aligned with Commerce Taxonomy.
 * Pure/offline — importing planGigaAutoPublish does NOT run main() (direct-invocation guard).
 * Run: npx tsx src/__tests__/autoPublishPlanner.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseBucketOf } from '../../scripts/planGigaAutoPublish';
import { classifyCommerce, NEEDS_REVIEW } from '../utils/commerceTaxonomy';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const canon = (name: string, category = '') => classifyCommerce({ name, category, categoryLabel: '' }).productType !== NEEDS_REVIEW;
// Realistic wrapper: commerceCanonical derived from the production classifier.
const bucket = (name: string, o: { img?: boolean; cost?: number; category?: string; normTitle?: string } = {}) =>
  baseBucketOf({ img: o.img ?? true, normCost: o.cost ?? 199, title: name, normTitle: o.normTitle ?? name, commerceCanonical: canon(name, o.category) }).bucket;

console.log('auto-publish planner taxonomy-alignment tests');

it('1. Outdoor Décor canonical (water fountain) is NOT rejected by HARD_JUNK', () => {
  assert.equal(bucket('Bear Outdoor Water Fountain with LED Lights, Garden Patio'), 'CLEAN');
});
it('2. Fitness & Sports canonical (step machine) is NOT rejected', () => {
  assert.equal(bucket('Stair Stepper Vertical Climber Workout Machine'), 'CLEAN');
});
it('3. Kids outdoor bike is NOT rejected merely for "kids"', () => {
  assert.equal(bucket('16 inch kids bike with training wheels, outdoor'), 'CLEAN');
});
it('4. Garden/outdoor words do NOT override canonical taxonomy (statue)', () => {
  const b = bucket('Large Garden Statue, Outdoor Sculpture, Solar');
  assert.notEqual(b, 'REJECT');
  assert.equal(b, 'CLEAN');
});
it('5. needs-review classification is HELD (not published), not rejected when no junk word', () => {
  assert.equal(canon('Mysterious Gadget XYZ'), false);
  assert.equal(bucket('Mysterious Gadget XYZ Contraption'), 'HOLD_QUALITY');
});
it('6. existing furniture behavior unchanged (canonical dresser → CLEAN)', () => {
  assert.equal(bucket('5-Drawer Chest of Drawers Dresser'), 'CLEAN');
  assert.equal(bucket('Linen Sofa Couch 3-Seat'), 'CLEAN');
});
it('7. missing price remains REJECT', () => {
  assert.equal(baseBucketOf({ img: true, normCost: 0, title: 'Garden Fountain', normTitle: 'Garden Fountain', commerceCanonical: true }).reason, 'no_price');
});
it('8. missing image remains REJECT', () => {
  assert.equal(baseBucketOf({ img: false, normCost: 199, title: 'Garden Fountain', normTitle: 'Garden Fountain', commerceCanonical: true }).reason, 'no_image');
});
it('9. safety exclusions enforced: pet treadmill & golf organizer never publish (held/rejected, not CLEAN)', () => {
  assert.equal(canon('Small Dog Treadmill Pet Exercise Machine'), false);          // excludeWord → needs-review
  assert.notEqual(bucket('Small Dog Treadmill Pet Exercise Machine'), 'CLEAN');     // held or rejected (junk 'dog')
  assert.equal(canon('Golf Bag Organizer Storage Rack for Garage'), false);         // excludeWord → needs-review
  assert.notEqual(bucket('Golf Bag Organizer Storage Rack for Garage'), 'CLEAN');
});
it('10. runGigaAutoPublish consumes the plan without a separate eligibility rule', () => {
  const src = readFileSync('scripts/runGigaAutoPublish.ts', 'utf8');
  assert.ok(src.includes('proposed_batch'), 'runner consumes plan.proposed_batch');
  assert.ok(!/HARD_JUNK/.test(src), 'runner has no separate HARD_JUNK eligibility rule');
  assert.ok(!/classifyCommerce/.test(src), 'runner does not re-classify (planner is authority)');
});

console.log(`\n${passed} passed`);
