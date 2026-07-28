/**
 * Pilot-scoped browse-feed family collapse (Option C) — pure tests for
 * collapsePilotFamilies + source guards that the three browse feeds call it while
 * Search stays per-SKU. Run: npx tsx src/__tests__/productFamilyCollapse.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collapsePilotFamilies } from '../services/productFamilyCollapse';
import type { Product } from '../data/products';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const p = (over: Partial<Product>): Product => ({
  id: 'x', name: 'Thing', category: '', desc: '', price: 0, discountPercent: 0,
  rating: 0, reviewCount: 0, stock: 0, image: '', images: ['img'], ...over,
} as unknown as Product);

const PILOT_UNIFORM = 'dr-vg-n733p307938b';        // nightstand, both $199
const PILOT_RANGE   = 'cb-vg-w409p327399-4door-w63'; // buffet, $279 / $219
const NON_PILOT     = 'dr-9-drawer-dresser-63-large-deep'; // title-derived
const HELD          = 'dr-vg-xw000032aaa-5drawer-wmissing'; // blocked -vg-

console.log('pilot-scoped browse-feed family collapse (Option C)');

it('a pilot family collapses to ONE representative card at the first-seen slot; non-pilot untouched', () => {
  const a = p({ id: 'N733P307938B', price: 199, product_family_key: PILOT_UNIFORM });
  const b = p({ id: 'N733P307938W', price: 199, product_family_key: PILOT_UNIFORM });
  const single = p({ id: 'X1', price: 50, product_family_key: NON_PILOT });
  const out = collapsePilotFamilies([a, single, b]);
  assert.equal(out.length, 2, 'two nightstand SKUs become one card; single stays');
  assert.equal(out[0].id, 'N733P307938B', 'representative emitted at first family slot');
  assert.equal(out[1].id, 'X1', 'non-pilot card keeps its position');
  assert.equal(out[0].familyHasPriceRange, false, 'uniform price → no range');
  assert.equal(out[0].familyMinPrice, 199);
});

it('per-child price range → familyMinPrice + "From $X" flag', () => {
  const wal = p({ id: 'W409P327401', price: 279, product_family_key: PILOT_RANGE });
  const nat = p({ id: 'W409P327404', price: 219, product_family_key: PILOT_RANGE });
  const out = collapsePilotFamilies([wal, nat]);
  assert.equal(out.length, 1);
  assert.equal(out[0].familyMinPrice, 219, 'min of member prices');
  assert.equal(out[0].familyHasPriceRange, true);
});

it('NON-pilot and HELD families are NOT collapsed (every SKU keeps its own card)', () => {
  const t1 = p({ id: 'T1', product_family_key: NON_PILOT });
  const t2 = p({ id: 'T2', product_family_key: NON_PILOT });
  assert.equal(collapsePilotFamilies([t1, t2]).length, 2, 'title-derived family stays per-SKU');
  const h1 = p({ id: 'H1', product_family_key: HELD });
  const h2 = p({ id: 'H2', product_family_key: HELD });
  assert.equal(collapsePilotFamilies([h1, h2]).length, 2, 'held -vg- family stays per-SKU');
});

it('representative prefers a member that has an image', () => {
  const noImg = p({ id: 'A', price: 199, product_family_key: PILOT_UNIFORM, images: [] });
  const withImg = p({ id: 'B', price: 199, product_family_key: PILOT_UNIFORM, images: ['x'] });
  const out = collapsePilotFamilies([noImg, withImg]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'B', 'imageless member never chosen as representative');
});

it('a singleton pilot family (one sellable child) is left untouched — not annotated', () => {
  const solo = p({ id: 'S', price: 199, product_family_key: PILOT_UNIFORM });
  const out = collapsePilotFamilies([solo]);
  assert.equal(out.length, 1);
  assert.equal(out[0].familyHasPriceRange, undefined, 'no collapse ⇒ no range flag');
});

it('products without a family key pass through unchanged', () => {
  const a = p({ id: 'A' }); const b = p({ id: 'B' });
  assert.deepEqual(collapsePilotFamilies([a, b]).map(x => x.id), ['A', 'B']);
});

it('source guard: Home / Discover / Collection call collapsePilotFamilies; Discover keeps a full search pool', () => {
  const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
  assert.ok(app.includes('return collapsePilotFamilies(mapped)'), 'Home mapRows collapses');
  const disc = readFileSync(join(process.cwd(), 'src/screens/DiscoverScreen.tsx'), 'utf8');
  assert.ok(disc.includes('collapsePilotFamilies(mapped)'), 'Discover grid collapses');
  assert.ok(disc.includes('setSearchAllItems('), 'Discover keeps a full per-SKU search pool');
  const coll = readFileSync(join(process.cwd(), 'src/screens/CollectionScreen.tsx'), 'utf8');
  assert.ok(coll.includes('collapsePilotFamilies(mapped)'), 'Collection collapses');
});

console.log(`\n${passed} collapse assertions passed.`);
