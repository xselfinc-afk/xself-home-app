/**
 * Native-ad insertion tests — pure; no I/O, no SDK, no React.
 * Covers buildDiscoverFeed / resolveInterval / resolveMax / groupIntoRows for both
 * Discover (interval 24, max 2) and Search (interval 24, max 1) placements.
 * Run: npx tsx src/__tests__/discoverAdInsertion.test.ts
 */
import assert from 'node:assert/strict';
import {
  buildDiscoverFeed,
  groupIntoRows,
  resolveInterval,
  resolveMax,
  DEFAULT_NATIVE_INTERVAL,
  DEFAULT_NATIVE_MAX,
  type DiscoverFeedItem,
} from '../services/discoverAdInsertion';
import type { Product } from '../data/products';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

function prods(n: number): Product[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}` } as unknown as Product));
}
// Discover: interval 24, max 2. Search: interval 24, max 1.
const DISCOVER = (interval = 24, max = 2) => ({ enabled: true, interval, max });
const SEARCH = (interval = 24, max = 1) => ({ enabled: true, interval, max });
const ads = (f: DiscoverFeedItem[]) => f.filter(x => x.type === 'ad');
const productIds = (f: DiscoverFeedItem[]) => f.filter(x => x.type === 'product').map(x => (x as any).product.id);

console.log('native ad insertion tests');

it('defaults: interval 24, max 2', () => {
  assert.equal(DEFAULT_NATIVE_INTERVAL, 24);
  assert.equal(DEFAULT_NATIVE_MAX, 2);
});

// ── Discover (max 2) ──
it('discover: fewer than 24 products → no ad', () => {
  assert.equal(ads(buildDiscoverFeed(prods(23), DISCOVER())).length, 0);
});
it('discover: exactly 24 products → no trailing ad', () => {
  const f = buildDiscoverFeed(prods(24), DISCOVER());
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 24);
});
it('discover: 25 products → one ad after product 24', () => {
  const f = buildDiscoverFeed(prods(25), DISCOVER());
  assert.equal(ads(f).length, 1);
  assert.equal(f[24].type, 'ad');
  assert.equal(f[25].type, 'product');
});
it('discover: exactly 48 products → only one ad (48 would be orphan)', () => {
  const f = buildDiscoverFeed(prods(48), DISCOVER());
  assert.equal(ads(f).length, 1);
  assert.equal(f[24].type, 'ad');
});
it('discover: 49 products → two ads after 24 and 48', () => {
  const f = buildDiscoverFeed(prods(49), DISCOVER());
  assert.deepEqual(ads(f).map(a => (a as any).key), ['native-ad-1', 'native-ad-2']);
  assert.equal(f[24].type, 'ad'); // after product 24
  assert.equal(f[49].type, 'ad'); // after product 48 (24 + 1 ad + 24)
});
it('discover: large result set → max stays 2', () => {
  assert.equal(ads(buildDiscoverFeed(prods(300), DISCOVER())).length, 2);
});
it('discover: disabled config → no ads', () => {
  assert.equal(ads(buildDiscoverFeed(prods(300), { enabled: false, interval: 24, max: 2 })).length, 0);
});
it('discover: malformed interval/max → safe defaults', () => {
  assert.equal(resolveInterval(0), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(Number.NaN), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveMax(0), DEFAULT_NATIVE_MAX);
  assert.equal(resolveMax(Number.NaN), DEFAULT_NATIVE_MAX);
  assert.equal(resolveMax(5), 5);
  // interval 0 → 24, max 0 → 2: 25 products → one ad after 24
  const f = buildDiscoverFeed(prods(25), { enabled: true, interval: 0, max: 0 });
  assert.equal(f[24].type, 'ad');
});
it('discover: refresh produces deterministic stable slots', () => {
  const a = buildDiscoverFeed(prods(49), DISCOVER());
  const b = buildDiscoverFeed(prods(49), DISCOVER());
  assert.deepEqual(a.map(x => x.key), b.map(x => x.key));
});
it('discover: product order remains unchanged', () => {
  const original = prods(80).map(p => p.id);
  assert.deepEqual(productIds(buildDiscoverFeed(prods(80), DISCOVER())), original);
});
it('discover: groupIntoRows — ad lands on a clean 3-col boundary (24 = 8 rows)', () => {
  const rows = groupIntoRows(buildDiscoverFeed(prods(25), DISCOVER()), 3);
  assert.equal(rows[8].type, 'ad'); // 8 product-rows of 3, then the ad
  assert.deepEqual(rows.slice(0, 8).map(r => (r as any).items.length), [3, 3, 3, 3, 3, 3, 3, 3]);
});

// ── Search (max 1) ──
it('search: 24 or fewer results → no ad', () => {
  assert.equal(ads(buildDiscoverFeed(prods(24), SEARCH())).length, 0);
  assert.equal(ads(buildDiscoverFeed(prods(10), SEARCH())).length, 0);
});
it('search: 25+ results → one ad after result 24', () => {
  const f = buildDiscoverFeed(prods(25), SEARCH());
  assert.equal(ads(f).length, 1);
  assert.equal(f[24].type, 'ad');
});
it('search: max stays 1 even for large result sets', () => {
  assert.equal(ads(buildDiscoverFeed(prods(200), SEARCH())).length, 1);
  assert.equal(ads(buildDiscoverFeed(prods(49), SEARCH())).length, 1);
});
it('search: disabled config → no ad', () => {
  assert.equal(ads(buildDiscoverFeed(prods(100), { enabled: false, interval: 24, max: 1 })).length, 0);
});
it('search: product order remains unchanged', () => {
  const original = prods(60).map(p => p.id);
  assert.deepEqual(productIds(buildDiscoverFeed(prods(60), SEARCH())), original);
});
it('search: groupIntoRows — 2-col boundary (24 = 12 rows)', () => {
  const rows = groupIntoRows(buildDiscoverFeed(prods(25), SEARCH()), 2);
  assert.equal(rows[12].type, 'ad'); // 12 product-rows of 2, then the ad
});

console.log(`\n${passed} passed`);
