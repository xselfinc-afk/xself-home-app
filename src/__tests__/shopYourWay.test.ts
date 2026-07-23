/**
 * Shop your way (Phase 2.5) mapping tests — pure; no I/O, no DB, no React.
 * Run: npx tsx src/__tests__/shopYourWay.test.ts
 *
 * Proves the three lenses are distinct, non-empty, lead with the right intent, route
 * ONLY to existing screens (no dead routes), and that switching lens changes content.
 */
import assert from 'node:assert/strict';
import { buildCommerceCatalog } from '../services/commerceCatalog';
import { buildShopYourWay } from '../services/shopYourWay';
import type { Product } from '../data/products';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const P = (name: string, spec: string, label: string): Product => ({
  id: name.replace(/\s+/g, '-'), name, category: spec, categoryLabel: label,
  desc: '', price: 199, discountPercent: 0, rating: 4.6, reviewCount: 10, stock: 5,
  images: ['https://cdn/x.jpg'],
} as unknown as Product);

const PRODUCTS: Product[] = [
  P('Linen 3-Seat Sofa', 'Sofas', 'Sofa'),                              // living-room-furniture / sofa
  P('Oak 5-Drawer Dresser', 'Dressers, Chests & Wardrobes', 'Dresser'), // bedroom-furniture / dresser
  P('Farmhouse Sideboard Buffet', 'Servers, Sideboards & Buffets', 'Sideboard'), // accent-storage-furniture / sideboard
  P('48" Bathroom Vanity with Sink', 'Bathroom Vanities', 'Bathroom'),  // bathroom / bathroom-vanity
];

const catalog = buildCommerceCatalog(PRODUCTS);
const syw = buildShopYourWay(catalog);

console.log('shop your way tests');

it('room leads with rooms present in the catalog, skips absent rooms, routes to CommerceResults', () => {
  const labels = syw.room.map(e => e.label);
  assert.ok(labels.includes('Living Room'));
  assert.ok(labels.includes('Bedroom'));
  assert.ok(labels.includes('Bathroom'));
  assert.equal(labels.includes('Dining Room'), false); // no dining products → skipped (no dead route)
  assert.equal(labels.includes('Home Office'), false);
  for (const e of syw.room) assert.equal(e.route.screen, 'CommerceResults');
});

it('product leads with high-intent product types, each carrying a productType route', () => {
  const ids = syw.product.map(e => e.id);
  assert.ok(ids.includes('sofa'));
  assert.ok(ids.includes('dresser'));
  assert.ok(ids.includes('sideboard'));
  assert.ok(ids.includes('bathroom-vanity'));
  for (const e of syw.product) {
    assert.equal(e.route.screen, 'CommerceResults');
    assert.ok(e.route.screen === 'CommerceResults' && !!e.route.params.productType, 'product entry has productType');
  }
});

it('need surfaces existing approved Collections (Collection route)', () => {
  assert.ok(syw.need.length >= 1);
  for (const e of syw.need) {
    assert.equal(e.route.screen, 'Collection');
    assert.ok(e.route.screen === 'Collection' && !!e.route.params.key, 'need entry has a collection key');
  }
});

it('the three lenses are DISTINCT — switching lens changes content', () => {
  const roomIds = new Set(syw.room.map(e => e.id));
  const prodIds = new Set(syw.product.map(e => e.id));
  const needIds = new Set(syw.need.map(e => e.id));
  const overlap = (a: Set<string>, b: Set<string>) => [...a].some(x => b.has(x));
  assert.equal(overlap(roomIds, prodIds), false, 'room vs product disjoint');
  assert.equal(overlap(roomIds, needIds), false, 'room vs need disjoint');
  assert.equal(overlap(prodIds, needIds), false, 'product vs need disjoint');
});

it('no dead routes — every entry routes to an existing screen', () => {
  const ok = new Set(['CommerceResults', 'Collection']);
  for (const e of [...syw.room, ...syw.product, ...syw.need]) assert.ok(ok.has(e.route.screen), `bad screen ${e.route.screen}`);
});

console.log(`\n${passed} passed`);
