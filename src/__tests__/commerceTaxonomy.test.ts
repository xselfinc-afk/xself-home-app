/**
 * Commerce Taxonomy engine tests — pure; no I/O, no DB, no React.
 * Run: npx tsx src/__tests__/commerceTaxonomy.test.ts
 *
 * Validates the FULL hierarchy Department → Category → Product Type → Rooms
 * (stable slugs), the registry invariants, the audit fixes, and needs-review.
 */
import assert from 'node:assert/strict';
import {
  classifyCommerce,
  isNeedsReview,
  validateRegistry,
  DEPARTMENTS,
  CATEGORIES,
  PRODUCT_TYPES,
  ROOMS,
  ROOM_ONLY_IDS,
  NEEDS_REVIEW,
} from '../utils/commerceTaxonomy';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const t = (name: string, category = '', categoryLabel = '') => classifyCommerce({ name, category, categoryLabel });
const deptIds = new Set(DEPARTMENTS.map(d => d.id));
const catById = new Map(CATEGORIES.map(c => [c.id, c]));
const typeIds = new Set(PRODUCT_TYPES.map(pt => pt.id));
const roomIds = new Set(ROOMS.map(r => r.id));

console.log('commerce taxonomy tests');

// ── Registry invariants (Bible §7) ──
it('registry validates with zero invariant violations', () => {
  assert.deepEqual(validateRegistry(), []);
});
it('every Category belongs to exactly one known Department', () => {
  for (const c of CATEGORIES) assert.ok(deptIds.has(c.department), `${c.id} → ${c.department}`);
});
it('every Product Type belongs to exactly one known Category', () => {
  for (const pt of PRODUCT_TYPES) assert.ok(catById.has(pt.category), `${pt.id} → ${pt.category}`);
});
it('Room-exclusive names are NEVER Department ids', () => {
  for (const r of ROOM_ONLY_IDS) assert.ok(!deptIds.has(r), `room "${r}" must not be a department`);
});
it('the v1-mistake names are NOT Departments', () => {
  for (const bad of ['bedroom', 'living-room', 'dining-room', 'home-office', 'cabinets-sideboards']) {
    assert.ok(!deptIds.has(bad), `"${bad}" must not be a department`);
  }
});
it('Product Type ids are never Department ids (sentinel exempt)', () => {
  for (const pt of PRODUCT_TYPES) if (pt.id !== NEEDS_REVIEW) assert.ok(!deptIds.has(pt.id), `"${pt.id}"`);
});
it('future non-furniture departments are supported (declared)', () => {
  for (const d of ['kitchen-dining', 'storage-organization', 'cleaning-household', 'travel', 'pet-supplies', 'outdoor-garden', 'fitness-sports', 'kids-baby', 'automotive']) {
    assert.ok(deptIds.has(d), `department "${d}" should be declared`);
  }
});

// ── Full 4-level paths (Bible examples) ──
it('Furniture → Bedroom Furniture → Dresser → [bedroom]', () => {
  assert.deepEqual(t('5-Drawer Chest of Drawers', 'Dressers, Chests & Wardrobes', 'Dresser'),
    { department: 'furniture', category: 'bedroom-furniture', productType: 'dresser', rooms: ['bedroom'] });
});
it('Furniture → Living Room Furniture → Sofa → [living-room]', () => {
  assert.deepEqual(t('3-Seat Linen Sofa', 'Sofas', 'Sofa'),
    { department: 'furniture', category: 'living-room-furniture', productType: 'sofa', rooms: ['living-room'] });
});
it('Furniture → Accent & Storage Furniture → Sideboard → [living-room, dining-room, entryway]', () => {
  assert.deepEqual(t('Mid Century Sideboard Buffet Cabinet', 'Cabinets', 'Sideboard'),
    { department: 'furniture', category: 'accent-storage-furniture', productType: 'sideboard', rooms: ['living-room', 'dining-room', 'entryway'] });
});
it('Bathroom → Bathroom Furniture → Bathroom Vanity → [bathroom]', () => {
  assert.deepEqual(t('30" Vanity', 'Bathroom Vanities', 'Bathroom'),
    { department: 'bathroom', category: 'bathroom-furniture', productType: 'bathroom-vanity', rooms: ['bathroom'] });
});
it('Outdoor & Garden → Patio Furniture → Outdoor Bench → [outdoor]', () => {
  assert.deepEqual(t('Patio Wicker Bench', 'Patio Seating', 'Other'),
    { department: 'outdoor-garden', category: 'patio-furniture', productType: 'outdoor-bench', rooms: ['outdoor'] });
});
it('Pet Supplies → Pet Furniture → Pet House → []', () => {
  assert.deepEqual(t('Wooden Pet House Cat Litter Box Enclosure', 'Pens & Hutches', 'Table'),
    { department: 'pet-supplies', category: 'pet-furniture', productType: 'pet-house', rooms: [] });
});

// ── "Cabinets & Sideboards" is split into product types, never a Department ──
it('"Cabinets & Sideboards" is not a department; its members split by type', () => {
  assert.ok(!deptIds.has('cabinets-sideboards') && !deptIds.has('cabinets-and-sideboards'));
  assert.equal(t('TV Stand for 65 Inch TV', 'Cabinets', 'TV Stand').productType, 'tv-stand');
  assert.equal(t('4-Shelf Tall Bookshelf', 'Cabinets', 'Bookshelf').productType, 'bookcase');
  assert.equal(t('Shoe Cabinet 4-Tier Shoe Rack', 'Cabinets', 'Cabinet').productType, 'shoe-cabinet');
  assert.equal(t('Rustic Vintage Accent Cabinet', 'Cabinets', 'Cabinet').productType, 'accent-cabinet');
  assert.equal(t('Kitchen Pantry Storage Cabinet', 'Cabinets', 'Cabinet').productType, 'storage-cabinet');
  assert.equal(t('70" Tall Bathroom Storage Cabinet', 'Cabinets', 'Bathroom').department, 'bathroom');
});

// ── Audit fixes ──
it('makeup vanity → Furniture / Bedroom Furniture / bedroom (NOT bathroom)', () => {
  const r = t('Makeup Vanity Desk with Mirror', 'Makeup Vanities', 'Other');
  assert.equal(r.productType, 'makeup-vanity');
  assert.equal(r.department, 'furniture');
  assert.deepEqual(r.rooms, ['bedroom']);
});
it('dressing table (label=Chair) → makeup-vanity / bedroom', () => {
  const r = t('37" Bedside LED Dressing Table + Cushioned Stool', '', 'Chair');
  assert.equal(r.productType, 'makeup-vanity');
  assert.deepEqual(r.rooms, ['bedroom']);
});
it('full-length mirror → full-length-mirror (was unreachable)', () => {
  assert.equal(t('360° Rotating Full Length Mirror', 'Full Length Mirrors', 'Other').productType, 'full-length-mirror');
});
it('no bare cat/dog/pet substring false-positive', () => {
  assert.notEqual(t('Multi-category Storage Application Cabinet', 'Cabinets', 'Cabinet').department, 'pet-supplies');
});

// ── needs-review (explicit, not silent Other) ──
it('unclassifiable input → needs-review sentinel at every level', () => {
  const r = t('', '', '');
  assert.equal(r.department, NEEDS_REVIEW);
  assert.equal(r.category, NEEDS_REVIEW);
  assert.equal(r.productType, NEEDS_REVIEW);
  assert.deepEqual(r.rooms, []);
  assert.ok(isNeedsReview(r));
});
it('classifyCommerce never yields "other"', () => {
  const r = t('mystery gadget', 'Unknown Supplier Bucket', 'Weird');
  assert.notEqual(r.department, 'other');
  assert.notEqual(r.productType, 'other');
});

// ── Output integrity ──
it('every classification uses only known slugs (dept/category/type/rooms)', () => {
  const samples = [
    t('Sofa', 'Sofas'), t('Dresser', 'Dressers, Chests & Wardrobes'), t('Bathroom Vanity', 'Bathroom Vanities'),
    t('Kids Toy Box Chest', 'Youth, Kids & Baby Furniture'), t('Hall Tree with Bench', 'Coat Racks'),
    t('mystery'),
  ];
  for (const r of samples) {
    assert.ok(deptIds.has(r.department), `dept ${r.department}`);
    assert.ok(catById.has(r.category), `category ${r.category}`);
    assert.ok(typeIds.has(r.productType), `type ${r.productType}`);
    assert.ok(catById.get(r.category)!.department === r.department, 'category→department consistent');
    for (const rm of r.rooms) assert.ok(roomIds.has(rm), `room ${rm}`);
  }
});
it('kids items resolve to kids-baby department', () => {
  assert.equal(t('Kids Toy Box Chest', 'Youth, Kids & Baby Furniture', 'Cabinet').department, 'kids-baby');
  assert.equal(t('Kids 3 Drawer Dresser, Baby Nightstand', 'Youth, Kids & Baby Furniture', 'Nightstand').department, 'kids-baby');
});

console.log(`\n${passed} passed`);
