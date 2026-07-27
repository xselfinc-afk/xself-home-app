/**
 * HomeShopYourWay layout invariants — pure source-structure test (tsc + tsx only,
 * no React renderer in the repo's tooling), matching homeCommerceEntryPlacement.test.ts.
 *
 * Run: npx tsx src/__tests__/homeShopYourWayLayout.test.ts   (from repo root)
 *
 * Locks the two Home "Shop your way" fixes so they can't silently regress:
 *   - Issue 1: the lens pills live in a HORIZONTAL ScrollView (never a fixed-width
 *     non-scrolling row), so every mode stays fully readable/tappable and the last
 *     pill is never clipped on a narrow phone. First/last edge padding preserved.
 *   - Issue 2: while the catalog is still loading (content === null) the rail renders
 *     skeleton cards instead of a blank rail — the module is never visually empty.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const syw = readFileSync(join(process.cwd(), 'src/components/commerce/HomeShopYourWay.tsx'), 'utf8');
const count = (needle: string) => syw.split(needle).length - 1;

console.log('HomeShopYourWay layout invariants');

it('Issue 1: lens pills are in a horizontal ScrollView, not a fixed non-scrolling row', () => {
  // The old clipping container must be gone.
  assert.equal(syw.includes('<View style={styles.pills}>'), false, 'non-scrolling <View style={styles.pills}> removed');
  // The pills row must be a horizontal ScrollView using styles.pills as content.
  const pillsScrollIdx = syw.indexOf('contentContainerStyle={styles.pills}');
  assert.ok(pillsScrollIdx >= 0, 'pills use contentContainerStyle={styles.pills}');
  const before = syw.slice(Math.max(0, pillsScrollIdx - 200), pillsScrollIdx);
  assert.ok(before.includes('<ScrollView'), 'pills container is a ScrollView');
  assert.ok(before.includes('horizontal'), 'pills ScrollView is horizontal (never wraps/clips)');
});

it('Issue 1: first/last edge padding preserved on the pills rail', () => {
  const m = syw.match(/pills:\s*\{[^}]*\}/);
  assert.ok(m, 'styles.pills defined');
  assert.ok(/paddingHorizontal:\s*16/.test(m![0]), 'pills keep 16pt horizontal edge padding');
  assert.ok(syw.includes('pillsScroll:'), 'pillsScroll style (flexGrow:0) defined so the row does not expand vertically');
});

it('Issue 1: exactly three lens modes exist by design (room / product / need)', () => {
  assert.ok(syw.includes("{ key: 'room', label: 'Shop by room' }"));
  assert.ok(syw.includes("{ key: 'product', label: 'Shop by product' }"));
  assert.ok(syw.includes("{ key: 'need', label: 'Shop by need' }"));
  // No hidden/unreachable fourth mode.
  assert.equal(count("label: 'Shop by "), 3, 'exactly three mode labels — no inaccessible extra modes');
});

it('Issue 2: rail shows skeleton cards while content === null (never a blank rail)', () => {
  assert.ok(syw.includes('content === null'), 'render branches on the loading state');
  assert.ok(syw.includes('styles.skeletonCard'), 'skeleton placeholder cards rendered while loading');
  const m = syw.match(/skeletonCard:\s*\{[^}]*\}/);
  assert.ok(m, 'skeletonCard style defined');
  assert.ok(/borderRadius/.test(m![0]) && /height/.test(m![0]), 'skeleton matches card shape (height + radius)');
});

it('Issue 2: the content rail remains a single horizontal rail (no competing vertical scroll)', () => {
  assert.ok(syw.includes('contentContainerStyle={styles.rail}'), 'content rail still present');
  // Two horizontal ScrollViews total: the pills row + the content rail.
  assert.ok(count('horizontal') >= 2, 'both pills and rail are horizontal ScrollViews');
});

console.log(`\n${passed} passed`);
