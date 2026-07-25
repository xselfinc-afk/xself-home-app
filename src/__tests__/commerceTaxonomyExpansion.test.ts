/**
 * Commerce Semantic Layer expansion — Outdoor Décor + Fitness & Sports.
 * Pure; no I/O, no DB, no React. Run: npx tsx src/__tests__/commerceTaxonomyExpansion.test.ts
 *
 * Locks the ADDITIVE taxonomy expansion: new registry nodes, classification
 * (specific-before-general + false-positive safeguards), generated navigation,
 * empty-node hiding, and that existing Furniture classification is untouched.
 */
import assert from 'node:assert/strict';
import {
  classifyCommerce, validateRegistry, DEPARTMENTS, CATEGORIES, PRODUCT_TYPES,
} from '../utils/commerceTaxonomy';
import { buildCommerceCatalog, filterProducts } from '../services/commerceCatalog';
import type { Product } from '../data/products';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const type = (name: string) => classifyCommerce({ name, category: '', categoryLabel: '' }).productType;

console.log('commerce taxonomy expansion tests');

// ── Registry integrity ──
it('registry validates with zero invariant violations', () => {
  assert.deepEqual(validateRegistry(), []);
});
it('all department / category / product-type slugs are unique', () => {
  const d = DEPARTMENTS.map(x => x.id), c = CATEGORIES.map(x => x.id), t = PRODUCT_TYPES.map(x => x.id);
  assert.equal(new Set(d).size, d.length, 'dept slugs unique');
  assert.equal(new Set(c).size, c.length, 'category slugs unique');
  assert.equal(new Set(t).size, t.length, 'product-type slugs unique');
});
it('new categories belong to valid departments', () => {
  const dept = new Map(CATEGORIES.map(c => [c.id, c.department]));
  assert.equal(dept.get('outdoor-decor'), 'outdoor-garden');
  assert.equal(dept.get('fitness'), 'fitness-sports');
  assert.equal(dept.get('sports'), 'fitness-sports');
});
it('new product types belong to the correct category (no orphans)', () => {
  const cat = new Map(PRODUCT_TYPES.map(t => [t.id, t.category]));
  assert.equal(cat.get('water-fountains'), 'outdoor-decor');
  assert.equal(cat.get('statues-sculptures'), 'outdoor-decor');
  for (const t of ['elliptical-trainers', 'exercise-bikes', 'step-machines', 'trampolines', 'treadmills', 'vibration-platforms', 'weight-benches', 'weight-racks', 'gym-mats', 'other-exercise-equipment']) assert.equal(cat.get(t), 'fitness', t);
  for (const t of ['outdoor-bikes', 'table-tennis-tables', 'golf-bag-push-carts', 'golf-sets', 'inflatable-paddle-boards', 'basketball-hoops', 'kick-scooters', 'soccer-tables', 'pool-tables', 'rod-racks', 'water-sports']) assert.equal(cat.get(t), 'sports', t);
});
it('fitness-sports department is declared and activated (not future)', () => {
  const fs = DEPARTMENTS.find(d => d.id === 'fitness-sports');
  assert.ok(fs, 'fitness-sports declared');
  assert.notEqual(fs!.future, true, 'fitness-sports is active');
});
it('no existing canonical slug renamed (spot-check preserved)', () => {
  const t = new Set(PRODUCT_TYPES.map(x => x.id));
  for (const s of ['dresser', 'sofa', 'sideboard', 'bathroom-vanity', 'outdoor-bench', 'pet-house', 'tv-stand', 'storage-cabinet']) assert.ok(t.has(s), `type ${s} preserved`);
  const d = new Set(DEPARTMENTS.map(x => x.id));
  for (const s of ['furniture', 'bathroom', 'outdoor-garden', 'pet-supplies', 'kids-baby']) assert.ok(d.has(s), `dept ${s} preserved`);
});

// ── Classification (spec §11) ──
it('classification: required cases resolve as specified', () => {
  const cases: [string, string][] = [
    ['Garden Fountain 3 Tier', 'water-fountains'],
    ['Solar Powered Water Fountain', 'water-fountains'],
    ['Fountain Pump Replacement', 'needs-review'],       // pump alone → not a fountain
    ['Garden Angel Statue', 'statues-sculptures'],
    ['Outdoor Bronze Sculpture', 'statues-sculptures'],
    ['Small Indoor Figurine', 'needs-review'],           // indoor figurine not forced in
    ['Folding Treadmill', 'treadmills'],
    ['Walking Pad Under Desk', 'treadmills'],
    ['Treadmill Mat Protector', 'gym-mats'],             // mat beats treadmill
    ['Stationary Bike', 'exercise-bikes'],
    ['Spin Bike', 'exercise-bikes'],
    ['Mountain Bike 27.5', 'outdoor-bikes'],
    ['Ping Pong Table', 'table-tennis-tables'],
    ['Foosball Table', 'soccer-tables'],
    ['Billiard Table 8ft', 'pool-tables'],
    ['Inflatable SUP Paddle Board', 'inflatable-paddle-boards'],
    ['Kayak Single Seat', 'water-sports'],
    ['Basketball Goal Portable', 'basketball-hoops'],
    ['Fishing Rod Rack Wall Mount', 'rod-racks'],
    ['Squat Weight Rack', 'weight-racks'],
    ['Mysterious Gadget XYZ', 'needs-review'],           // ambiguous stays needs-review
  ];
  for (const [n, e] of cases) assert.equal(type(n), e, n);
});

// ── Generated navigation ──
const P = (name: string): Product => ({
  id: name.replace(/\W+/g, '-'), name, category: '', categoryLabel: '', images: ['https://cdn/x.jpg'],
  desc: '', price: 199, discountPercent: 0, rating: 4.6, reviewCount: 10, stock: 5,
} as unknown as Product);

it('generated nav: new nodes appear when matching products exist; Furniture unaffected', () => {
  const cat = buildCommerceCatalog([
    P('Garden Water Fountain'), P('Bronze Garden Statue'),
    P('Folding Treadmill'), P('Ping Pong Table'),
    P('Linen Sofa Couch'), // furniture control
  ]);
  const fs = cat.departments.find(d => d.id === 'fitness-sports');
  assert.ok(fs, 'Fitness & Sports appears');
  assert.ok(fs!.categories.some(c => c.id === 'fitness'), 'Fitness category');
  assert.ok(fs!.categories.some(c => c.id === 'sports'), 'Sports category');
  assert.ok(fs!.categories.find(c => c.id === 'fitness')!.types.some(t => t.id === 'treadmills'), 'Treadmills leaf');
  const og = cat.departments.find(d => d.id === 'outdoor-garden');
  assert.ok(og && og.categories.some(c => c.id === 'outdoor-decor'), 'Outdoor Décor under Garden & Outdoor');
  const furn = cat.departments.find(d => d.id === 'furniture');
  assert.ok(furn && furn.categories.some(c => c.id === 'living-room-furniture'), 'Furniture navigation unaffected');
});
it('empty nodes hidden: no fitness-sports when no matching products', () => {
  const cat = buildCommerceCatalog([P('Linen Sofa Couch'), P('5-Drawer Dresser')]);
  assert.ok(!cat.departments.some(d => d.id === 'fitness-sports'), 'fitness-sports hidden when empty');
  assert.ok(!cat.departments.some(d => d.id === 'outdoor-garden'), 'outdoor-garden hidden when empty');
});
it('filterProducts narrows by the new department / category / product type', () => {
  const pool = [P('Garden Water Fountain'), P('Folding Treadmill'), P('Ping Pong Table'), P('Linen Sofa Couch')];
  assert.equal(filterProducts(pool, { department: 'fitness-sports' }).length, 2);
  assert.equal(filterProducts(pool, { category: 'sports' }).length, 1);
  assert.equal(filterProducts(pool, { productType: 'treadmills' }).length, 1);
  assert.equal(filterProducts(pool, { department: 'outdoor-garden', category: 'outdoor-decor', productType: 'water-fountains' }).length, 1);
});

// ── Rule correction: pet treadmills & golf storage excludes (word-boundary) ──
it('pet treadmills are excluded from human treadmills (→ needs-review)', () => {
  assert.notEqual(type('Small Dog Treadmill'), 'treadmills');
  assert.notEqual(type('Pet Treadmill for Dogs'), 'treadmills');
  assert.notEqual(type('Puppy Exercise Treadmill'), 'treadmills');
  assert.equal(type('Small Dog Treadmill'), 'needs-review');
  assert.equal(type('2025 New Quiet Smart Pet Treadmill, Adjustable Speed, Perfect for Small/Medium Dogs'), 'needs-review');
});
it('human treadmills still classify as treadmills (no substring false-positives)', () => {
  assert.equal(type('Folding Home Treadmill'), 'treadmills');
  assert.equal(type('Walking Pad'), 'treadmills');
  assert.equal(type('Folding Treadmill for Home Gym'), 'treadmills');
  assert.equal(type('Walking Pad for Home Office'), 'treadmills');
  assert.equal(type('Treadmill for Carpet Floors'), 'treadmills');       // 'carpet' must NOT trip 'pet'
  assert.equal(type('Treadmill with Application LCD'), 'treadmills');     // 'application' must NOT trip 'cat'
});
it('golf storage/organizers are excluded from golf club sets (→ not golf-sets)', () => {
  assert.notEqual(type('Golf Bag Organizer Storage Rack'), 'golf-sets');
  assert.notEqual(type('Golf Club Storage Rack'), 'golf-sets');
  assert.notEqual(type('Golf Equipment Organizer'), 'golf-sets');
  assert.notEqual(type('Premium Wooden Golf Clubs Storage Rack Fit 2 Golf Bags'), 'golf-sets'); // real 'golf clubs' match, excluded
});
it('real golf club sets & push carts still classify correctly', () => {
  assert.equal(type('Complete Golf Club Set'), 'golf-sets');
  assert.equal(type('Junior Golf Set'), 'golf-sets');
  assert.equal(type('Golf Bag Push Cart'), 'golf-bag-push-carts');
  assert.equal(type('Golf Club Set with Shot Tracking'), 'golf-sets');   // 'tracking' must NOT trip 'rack'
});

// ── Validated GIGA supplier crosswalk (spec category reaches specLc via Product.category) ──
const clsCat = (name: string, category: string) => classifyCommerce({ name, category, categoryLabel: '' }).productType;

it('Outdoor Bikes crosswalk: authoritative, but exercise/stationary bikes are NOT forced outdoors', () => {
  assert.equal(clsCat('FKZNPJ 24 Inch Youth', 'Outdoor Bikes'), 'outdoor-bikes');        // weak title → crosswalk
  assert.notEqual(clsCat('Stationary Exercise Bike', 'Outdoor Bikes'), 'outdoor-bikes'); // guard
  assert.equal(clsCat('Stationary Exercise Bike', 'Outdoor Bikes'), 'exercise-bikes');
  assert.equal(clsCat('Recumbent Cycle', 'Outdoor Bikes'), 'exercise-bikes');
  assert.equal(clsCat('20 Inch Kids Mountain Bike', 'Outdoor Bikes'), 'outdoor-bikes');  // validated real sample
});
it('Water Fountains crosswalk: fills weak titles but never resurrects pump/components', () => {
  assert.equal(clsCat('Decorative Cascading Water Feature', 'Water Fountains'), 'water-fountains'); // weak title → fallback
  assert.notEqual(clsCat('Replacement Pump for Fountain', 'Water Fountains'), 'water-fountains');
  assert.equal(clsCat('Replacement Pump for Fountain', 'Water Fountains'), 'needs-review');         // exclude wins over fallback
});
it('Step Machines crosswalk: weak stepper title resolves via fallback', () => {
  assert.equal(clsCat('Home Cardio Climber', 'Step Machines'), 'step-machines');
});
it('Statues & Sculptures crosswalk: garden ok; indoor/holiday figurine stays needs-review', () => {
  assert.equal(clsCat('Large Garden Statue', 'Statues & Sculptures'), 'statues-sculptures');
  assert.equal(clsCat('Holiday Figurine in Santa Outfit', 'Statues & Sculptures'), 'needs-review');
  assert.equal(clsCat('Christmas Dog Figurine Statue', 'Statues & Sculptures'), 'needs-review');    // figurine exclude wins over fallback
});
it('Treadmills crosswalk: human treadmills ok; pet treadmills stay needs-review', () => {
  assert.equal(clsCat('Folding Home Treadmill', 'Treadmills'), 'treadmills');
  assert.equal(clsCat('Quiet Running Machine', 'Treadmills'), 'treadmills');       // weak title → fallback
  assert.equal(clsCat('Small Dog Treadmill', 'Treadmills'), 'needs-review');       // excludeWord wins over fallback
});
it('Golf Sets crosswalk: real sets ok; organizers stay needs-review; push cart unaffected', () => {
  assert.equal(clsCat('Complete Golf Club Set', 'Golf Sets'), 'golf-sets');
  assert.equal(clsCat('Golf Bag Organizer Storage Rack', 'Golf Sets'), 'needs-review');
  assert.equal(clsCat('Premium Wooden Golf Clubs Storage Rack', 'Golf Sets'), 'needs-review'); // excludeWord wins over fallback
  assert.equal(clsCat('Golf Bag Push Cart', 'Golf Sets'), 'golf-bag-push-carts');              // specific title rule wins
});
it('existing furniture SPEC_FALLBACK unaffected by the invariant guard', () => {
  assert.equal(clsCat('Nondescript Item', 'Cabinets'), 'storage-cabinet');
  assert.equal(clsCat('Generic Piece', 'Sofas'), 'sofa');
  assert.equal(clsCat('Plain Unit', 'Nightstands'), 'nightstand');
});

console.log(`\n${passed} passed`);
