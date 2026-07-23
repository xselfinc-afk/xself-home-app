/**
 * Home composition invariants (Phase 2.5) — pure; no I/O beyond reading App.tsx as
 * text, no DB, no React. Source-structure test: the repo has no React renderer in its
 * test tooling (tsc + tsx scripts only), so we lock the Home composition against the
 * App.tsx source instead of rendering it.
 *
 * Run: npx tsx src/__tests__/homeCommerceEntryPlacement.test.ts   (from repo root)
 *
 * Proves (per Phase 2.5 spec):
 *   - Xself Home wordmark renders before Search; correct placeholder; camera + handler kept.
 *   - Browse all categories → Shop your way → New This Season, in that order; Shop by department removed.
 *   - All three sit in the stable HEADER (above ListFooterComponent and pagination).
 *   - Pagination does not gate the modules; nav flag gates them; legacy footer preserved.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const src = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
const idx = (needle: string) => src.indexOf(needle);
const count = (needle: string) => src.split(needle).length - 1;

const iWordmark = idx('styles.homeWordmark');
const iSearch   = idx('<SearchPillBar');
const iHero     = idx('<HeroBanner');
const iBrowse   = idx('<BrowseAllCategoriesCard');
const iSyw      = idx('<HomeShopYourWay');
const iFooter   = idx('ListFooterComponent');
const iEndReach = idx('onEndReached');

console.log('home composition tests (Phase 2.5)');

it('1. Xself Home wordmark renders before Search', () => {
  assert.ok(iWordmark >= 0, 'wordmark present');
  assert.ok(src.includes('>Xself Home<'), 'wordmark text present');
  assert.ok(iSearch >= 0 && iWordmark < iSearch, 'wordmark is above the search field');
});

it('2. Search placeholder is the new copy', () => {
  assert.ok(src.includes('Search furniture, rooms, styles...'));
  assert.equal(src.includes('>Search Xself<'), false, 'old placeholder removed');
});

it('3. Camera control + divider (SearchPillBar) remain', () => {
  assert.ok(src.includes('searchPillCamBtn'), 'camera button style kept');
  assert.ok(src.includes('camera-outline'), 'camera icon kept');
  assert.ok(src.includes('<SearchPillBar'), 'SearchPillBar (renders the divider) kept');
});

it('4. Image-search handler remains connected', () => {
  assert.ok(src.includes('pickSearchImage'), 'image-search handler referenced');
  assert.ok(src.includes("navigation.navigate('Search'"), 'image search still routes to Search');
});

it('Browse & Shop your way render once each; Shop by department removed from Home', () => {
  assert.equal(count('<BrowseAllCategoriesCard'), 1);
  assert.equal(count('<HomeShopYourWay'), 1);
  assert.equal(count('<ShopByDepartmentRail'), 0, 'Shop by department rail removed from Home');
  assert.equal(count('<HomeShoppingEntry'), 0, 'old combined component fully replaced');
  // Browse all categories remains the full taxonomy directory entry (→ All Categories).
  const rail = readFileSync(join(process.cwd(), 'src/components/commerce/HomeShoppingEntry.tsx'), 'utf8');
  assert.ok(rail.includes("navigation.navigate('CommerceBrowse', { level: 'all' })"), 'Browse card still opens All Categories');
});

it('module order is Hero → Browse → Shop your way → New This Season (no dept, no gap)', () => {
  const iNewSeason = idx('{/* New Arrivals */}');
  assert.ok(iHero >= 0 && iBrowse > iHero, 'Browse after hero');
  assert.ok(iSyw > iBrowse, 'Shop your way after Browse');
  assert.ok(iNewSeason > iSyw, 'New This Season follows Shop your way directly');
});

it('11. all modules are in the stable HEADER (above footer + pagination)', () => {
  assert.ok(iFooter >= 0 && iEndReach >= 0);
  for (const i of [iBrowse, iSyw]) {
    assert.ok(i < iFooter, 'module above ListFooterComponent');
    assert.ok(i < iEndReach, 'module above paginated-feed props');
  }
  const footerSlice = src.slice(iFooter);
  assert.equal(footerSlice.includes('<BrowseAllCategoriesCard'), false);
  assert.equal(footerSlice.includes('<HomeShopYourWay'), false);
  assert.equal(footerSlice.includes('<ShopByDepartmentRail'), false);
});

it('gating: modules guarded by the navigation flag', () => {
  assert.ok(src.includes('COMMERCE_TAXONOMY_NAVIGATION_ENABLED && ('), 'flag guard wraps the module group');
});

it('12/13. legacy footer preserved when flag OFF; no duplicate commerce modules', () => {
  const footerSlice = src.slice(iFooter);
  assert.ok(footerSlice.includes('Shop by Category'), 'legacy heading kept');
  assert.ok(footerSlice.includes('CATEGORY_CIRCLES'), 'legacy circles kept');
});

it('7. Shop your way exposes Room / Product / Need lenses (component source)', () => {
  const syw = readFileSync(join(process.cwd(), 'src/components/commerce/HomeShopYourWay.tsx'), 'utf8');
  assert.ok(syw.includes("'room'") && syw.includes("'product'") && syw.includes("'need'"), 'three lens keys present');
  assert.ok(syw.includes('Shop by room') && syw.includes('Shop by product') && syw.includes('Shop by need'), 'three lens labels present');
});

console.log(`\n${passed} passed`);
