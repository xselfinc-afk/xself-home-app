/**
 * Discover Native-ad insertion tests — pure; no I/O, no SDK, no React.
 * Covers buildDiscoverFeed / resolveInterval / groupIntoRows.
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
const ON = (interval = 21) => ({ enabled: true, interval });
const ads = (f: DiscoverFeedItem[]) => f.filter(x => x.type === 'ad');
const productIds = (f: DiscoverFeedItem[]) => f.filter(x => x.type === 'product').map(x => (x as any).product.id);

console.log('discover ad insertion tests');

it('fewer than 21 products → no ad', () => {
  const f = buildDiscoverFeed(prods(20), ON());
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 20);
});

it('exactly 21 products → no trailing orphan ad', () => {
  const f = buildDiscoverFeed(prods(21), ON());
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 21);
});

it('22 products → one ad after item 21', () => {
  const f = buildDiscoverFeed(prods(22), ON());
  assert.equal(ads(f).length, 1);
  // ad sits at flat index 21 (after 21 products), and a product follows it
  assert.equal(f[21].type, 'ad');
  assert.equal(f[22].type, 'product');
  assert.equal((f[21] as any).key, 'native-ad-1');
});

it('42 products → exactly one ad (after 21; none after 42 = orphan)', () => {
  const f = buildDiscoverFeed(prods(42), ON());
  assert.equal(ads(f).length, 1);
  assert.equal(f[21].type, 'ad');
});

it('43 products → two ads (after 21 and after 42)', () => {
  const f = buildDiscoverFeed(prods(43), ON());
  assert.deepEqual(ads(f).map(a => (a as any).key), ['native-ad-1', 'native-ad-2']);
  assert.equal(f[21].type, 'ad'); // after product 21
  assert.equal(f[43].type, 'ad'); // after product 42 (21 products + 1 ad + 21 products)
});

it('refresh produces stable, deterministic positions + keys', () => {
  const a = buildDiscoverFeed(prods(43), ON());
  const b = buildDiscoverFeed(prods(43), ON());
  assert.deepEqual(a.map(x => x.key), b.map(x => x.key));
});

it('pagination does not duplicate ad slots (keys unique)', () => {
  const f = buildDiscoverFeed(prods(100), ON());
  const keys = ads(f).map(a => (a as any).key);
  assert.equal(new Set(keys).size, keys.length); // all unique
});

it('disabled config → no ad items', () => {
  const f = buildDiscoverFeed(prods(100), { enabled: false, interval: 21 });
  assert.equal(ads(f).length, 0);
  assert.equal(f.length, 100);
});

it('malformed interval → safe default (21)', () => {
  assert.equal(resolveInterval(Number.NaN), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(0), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(-5), DEFAULT_NATIVE_INTERVAL);
  assert.equal(resolveInterval(10), 10);
  const f = buildDiscoverFeed(prods(22), { enabled: true, interval: 0 });
  assert.equal(f[21].type, 'ad'); // fell back to interval 21
});

it('product order remains unchanged', () => {
  const original = prods(50).map(p => p.id);
  const f = buildDiscoverFeed(prods(50), ON());
  assert.deepEqual(productIds(f), original);
});

it('groupIntoRows: ad lands on a clean row boundary (interval 21 = 7 rows)', () => {
  const rows = groupIntoRows(buildDiscoverFeed(prods(22), ON()));
  // 7 product-rows of 3, then the ad row, then a final product-row of 1
  assert.equal(rows.length, 9);
  assert.equal(rows[7].type, 'ad');
  assert.deepEqual(rows.slice(0, 7).map(r => (r as any).items.length), [3, 3, 3, 3, 3, 3, 3]);
  assert.equal((rows[8] as any).items.length, 1); // product 22, partial row
});

it('groupIntoRows: disabled feed → only product rows, no ad rows', () => {
  const rows = groupIntoRows(buildDiscoverFeed(prods(30), { enabled: false, interval: 21 }));
  assert.equal(rows.filter(r => r.type === 'ad').length, 0);
});

console.log(`\n${passed} passed`);
