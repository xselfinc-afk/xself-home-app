/**
 * Discover Native-ad insertion tests — pure; no I/O, no SDK, no React.
 * Covers buildDiscoverFeed / resolveInterval / groupIntoRows.
 * Production interval is 30 (first ad after product 30, repeat every 30).
 * Run: npx tsx src/__tests__/discoverAdInsertion.test.ts
 */
import assert from 'node:assert/strict';
import {
  buildDiscoverFeed,
  groupIntoRows,
  resolveInterval,
  DEFAULT_NATIVE_INTERVAL,
  type DiscoverFeedItem,
} from '../services/discoverAdInsertion';
import type { Product } from '../data/products';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

function prods(n: number): Product[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}` } as unknown as Product));
}
const ON = (interval = 30) => ({ enabled: true, interval });
const ads = (f: DiscoverFeedItem[]) => f.filter(x => x.type === 'ad');
const productIds = (f: DiscoverFeedItem[]) => f.filter(x => x.type === 'product').map(x => (x as any).product.id);

console.log('discover ad insertion tests');

it('default interval is 30', () => {
  assert.equal(DEFAULT_NATIVE_INTERVAL, 30);
});

it('fewer than 30 products → no ad', () => {
  const f = buildDiscoverFeed(prods(29), ON());
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 29);
});

it('exactly 30 products → no trailing orphan ad', () => {
  const f = buildDiscoverFeed(prods(30), ON());
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 30);
});

it('31 products → one ad after item 30', () => {
  const f = buildDiscoverFeed(prods(31), ON());
  assert.equal(ads(f).length, 1);
  assert.equal(f[30].type, 'ad');       // after 30 products
  assert.equal(f[31].type, 'product');  // a product follows
  assert.equal((f[30] as any).key, 'native-ad-1');
});

it('60 products → exactly one ad (after 30; none after 60 = orphan)', () => {
  const f = buildDiscoverFeed(prods(60), ON());
  assert.equal(ads(f).length, 1);
  assert.equal(f[30].type, 'ad');
});

it('61 products → two ads (after 30 and after 60)', () => {
  const f = buildDiscoverFeed(prods(61), ON());
  assert.deepEqual(ads(f).map(a => (a as any).key), ['native-ad-1', 'native-ad-2']);
  assert.equal(f[30].type, 'ad'); // after product 30
  assert.equal(f[61].type, 'ad'); // after product 60 (30 products + 1 ad + 30 products)
});

it('refresh produces stable, deterministic positions + keys', () => {
  const a = buildDiscoverFeed(prods(61), ON());
  const b = buildDiscoverFeed(prods(61), ON());
  assert.deepEqual(a.map(x => x.key), b.map(x => x.key));
});

it('pagination does not duplicate ad slots (keys unique)', () => {
  const f = buildDiscoverFeed(prods(150), ON());
  const keys = ads(f).map(a => (a as any).key);
  assert.equal(new Set(keys).size, keys.length);
});

it('disabled config → no ad items', () => {
  const f = buildDiscoverFeed(prods(100), { enabled: false, interval: 30 });
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 100);
});

it('malformed interval → safe default (30)', () => {
  assert.equal(resolveInterval(Number.NaN), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(0), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(-5), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(15), 15);
  const f = buildDiscoverFeed(prods(31), { enabled: true, interval: 0 });
  assert.equal(f[30].type, 'ad'); // fell back to interval 30
});

it('product order remains unchanged', () => {
  const original = prods(70).map(p => p.id);
  const f = buildDiscoverFeed(prods(70), ON());
  assert.deepEqual(productIds(f), original);
});

it('groupIntoRows: ad lands on a clean row boundary (interval 30 = 10 rows)', () => {
  const rows = groupIntoRows(buildDiscoverFeed(prods(31), ON()));
  // 10 product-rows of 3, then the ad row, then a final product-row of 1
  assert.equal(rows.length, 12);
  assert.equal(rows[10].type, 'ad');
  assert.deepEqual(rows.slice(0, 10).map(r => (r as any).items.length), [3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  assert.equal((rows[11] as any).items.length, 1); // product 31, partial row
});

it('groupIntoRows: disabled feed → only product rows, no ad rows', () => {
  const rows = groupIntoRows(buildDiscoverFeed(prods(40), { enabled: false, interval: 30 }));
  assert.equal(rows.filter(r => r.type === 'ad').length, 0);
});

console.log(`\n${passed} passed`);
