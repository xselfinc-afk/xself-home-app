/**
 * "Explore the collection" → Furniture department destination invariants (Phase 2.5).
 * Pure source-structure test (no RN renderer in the repo's test tooling).
 * Run: npx tsx src/__tests__/furnitureDestination.test.ts   (from repo root)
 *
 * Proves the corrected CTA destination:
 *   - Hero CTA uses the SAME Furniture route as the "Shop by department → Furniture" card.
 *   - It no longer routes to make-room / spring-sale / any Collection key.
 *   - The unapproved make-room collection config is gone; spring-sale/spring-collection remain.
 *   - Back navigation (department screen) and Product Detail (results) stay connected.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
const browse = readFileSync(join(process.cwd(), 'src/screens/commerce/CommerceBrowseScreen.tsx'), 'utf8');
const results = readFileSync(join(process.cwd(), 'src/screens/commerce/CommerceResultsScreen.tsx'), 'utf8');
const col = readFileSync(join(process.cwd(), 'src/screens/CollectionScreen.tsx'), 'utf8');

const FURN_ROUTE = "navigation.navigate('CommerceBrowse', { level: 'department', department: 'furniture' })";

console.log('furniture destination tests');

it('1. Hero CTA uses the same CommerceBrowse department route as All Categories → Department', () => {
  assert.ok(app.includes(FURN_ROUTE), 'hero CTA opens CommerceBrowse department=furniture');
  // The canonical department route (All Categories → Department) uses the same screen + level.
  assert.ok(browse.includes("navigation.navigate('CommerceBrowse', { level: 'department', department: d })"), 'All Categories opens the same CommerceBrowse department route (openDept)');
});

it('2. Hero CTA no longer routes to make-room / spring-sale / any Collection key', () => {
  assert.equal(app.includes('make-room'), false, 'no make-room reference in App.tsx');
  assert.equal(app.includes("navigation.navigate('Collection', { key:"), false, 'hero no longer opens a Collection');
});

it('3. No make-room collection config remains', () => {
  assert.equal(col.includes("'make-room'"), false, 'make-room key removed from CollectionScreen');
  assert.equal(col.includes('Make Room for What Matters'), false, 'make-room title removed');
});

it('4. Existing legitimate collection keys remain unchanged', () => {
  assert.ok(col.includes("'spring-sale': {"), 'spring-sale kept');
  assert.ok(col.includes("'spring-collection': {"), 'spring-collection kept');
  assert.ok(col.includes("key === 'spring-sale' && topDiscount > 0"), 'spring-sale dynamic subtitle restored (make-room removed)');
});

it('5. Back navigation from the Furniture department screen is connected', () => {
  assert.ok(browse.includes('navigation.goBack()'), 'CommerceBrowse back nav present');
});

it('6. Product navigation from Furniture (department → type → results) reaches Product Detail', () => {
  assert.ok(browse.includes("navigation.navigate('CommerceResults'"), 'department opens results');
  assert.ok(results.includes("navigation.navigate('ProductDetail', { product: item })"), 'results open Product Detail');
});

console.log(`\n${passed} passed`);
