/**
 * Commerce Catalog (Phase 2) grouping/filtering tests — pure; no I/O, no DB, no React.
 * Run: npx tsx src/__tests__/commerceCatalog.test.ts
 */
import assert from 'node:assert/strict';
import { buildCommerceCatalog, filterProducts, labelForDepartment, labelForCategory, labelForType } from '../services/commerceCatalog';
import { COMMERCE_TAXONOMY_NAVIGATION_ENABLED, COMMERCE_TAXONOMY_ENABLED } from '../config/commerceTaxonomy';
import type { Product } from '../data/products';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

// Minimal Product stubs — classifyCommerce reads name/category/categoryLabel; UI reads images/price.
const P = (name: string, spec: string, label: string, img = 'https://cdn/x.jpg'): Product => ({
  id: name.replace(/\s+/g, '-'), name, category: spec, categoryLabel: label,
  desc: '', price: 199, discountPercent: 0, rating: 4.6, reviewCount: 10, stock: 5,
  images: [img],
} as unknown as Product);

const PRODUCTS: Product[] = [
  P('Oak 5-Drawer Dresser', 'Dressers, Chests & Wardrobes', 'Dresser'),
  P('Walnut 6-Drawer Dresser', 'Dressers, Chests & Wardrobes', 'Dresser'),
  P('Pine Nightstand', 'Nightstands', 'Nightstand'),
  P('Linen 3-Seat Sofa', 'Sofas', 'Sofa'),
  P('Modern TV Stand for 65" TV', 'Cabinets', 'TV Stand'),
  P('Farmhouse Sideboard Buffet', 'Servers, Sideboards & Buffets', 'Sideboard'),
  P('48" Bathroom Vanity with Sink', 'Bathroom Vanities', 'Bathroom'),
  P('Wooden Pet House Cat Litter Enclosure', 'Pens & Hutches', 'Table'),
];

console.log('commerce catalog tests');

it('flags default OFF', () => {
  assert.equal(COMMERCE_TAXONOMY_NAVIGATION_ENABLED, false);
  assert.equal(COMMERCE_TAXONOMY_ENABLED, false);
});

it('groups into Department → Category → Product Type with real counts', () => {
  const cat = buildCommerceCatalog(PRODUCTS);
  assert.equal(cat.total, 8);
  const furniture = cat.departments.find(d => d.id === 'furniture');
  assert.ok(furniture, 'furniture department exists');
  assert.equal(furniture!.count, 6); // 2 dresser + 1 nightstand + 1 sofa + 1 tv-stand + 1 sideboard
  const bedroom = furniture!.categories.find(c => c.id === 'bedroom-furniture');
  assert.equal(bedroom!.count, 3);
  const dresser = bedroom!.types.find(t => t.id === 'dresser');
  assert.equal(dresser!.count, 2);
  assert.equal(dresser!.label, 'Dresser'); // explicit label, not slug
});

it('bathroom + pet route to their own departments (not furniture)', () => {
  const cat = buildCommerceCatalog(PRODUCTS);
  assert.ok(cat.departments.find(d => d.id === 'bathroom'));
  assert.ok(cat.departments.find(d => d.id === 'pet-supplies'));
});

it('departments are ordered and active-only; each node carries a representative image', () => {
  const cat = buildCommerceCatalog(PRODUCTS);
  assert.equal(cat.departments[0].id, 'furniture'); // registry order → furniture first
  for (const d of cat.departments) { assert.ok(d.count > 0); assert.ok(d.image); }
});

it('no product falls to needs-review for this set', () => {
  assert.equal(buildCommerceCatalog(PRODUCTS).needsReview, 0);
});

it('filterProducts narrows by department/category/product type', () => {
  assert.equal(filterProducts(PRODUCTS, { department: 'furniture' }).length, 6);
  assert.equal(filterProducts(PRODUCTS, { category: 'bedroom-furniture' }).length, 3);
  assert.equal(filterProducts(PRODUCTS, { productType: 'dresser' }).length, 2);
  assert.equal(filterProducts(PRODUCTS, { department: 'furniture', category: 'bedroom-furniture', productType: 'nightstand' }).length, 1);
  assert.equal(filterProducts(PRODUCTS, { department: 'bathroom' }).length, 1);
});

it('type counts within a category sum to the category count', () => {
  const cat = buildCommerceCatalog(PRODUCTS);
  for (const d of cat.departments) for (const c of d.categories) {
    assert.equal(c.types.reduce((s, t) => s + t.count, 0), c.count, `${c.id} types sum`);
  }
});

it('no empty navigation targets — every dept/category/type has count > 0', () => {
  const cat = buildCommerceCatalog(PRODUCTS);
  for (const d of cat.departments) {
    assert.ok(d.count > 0, `dept ${d.id}`);
    for (const c of d.categories) {
      assert.ok(c.count > 0, `category ${c.id}`);
      for (const t of c.types) assert.ok(t.count > 0, `type ${t.id}`);
    }
  }
});

it('all products reachable through exactly one path (dept counts sum to total − needsReview)', () => {
  const cat = buildCommerceCatalog(PRODUCTS);
  const reachable = cat.departments.reduce((s, d) => s + d.count, 0);
  assert.equal(reachable, cat.total - cat.needsReview);
  assert.equal(reachable, PRODUCTS.length); // needsReview is 0 for this set
});

it('display names come from ONE centralized registry (labels, never slugs)', () => {
  assert.equal(labelForDepartment('furniture'), 'Furniture');
  assert.equal(labelForCategory('accent-storage-furniture'), 'Accent & Storage Furniture');
  assert.equal(labelForType('dresser'), 'Dresser');
  // Nodes carry the registry label, not their slug id.
  const cat = buildCommerceCatalog(PRODUCTS);
  for (const d of cat.departments) {
    assert.notEqual(d.label, d.id);
    for (const c of d.categories) { assert.notEqual(c.label, c.id); for (const t of c.types) assert.notEqual(t.label, t.id); }
  }
});

console.log(`\n${passed} passed`);
