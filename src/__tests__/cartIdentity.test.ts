/**
 * Cart-line identity safety (Phase 1) — proves the cart keys lines by the physical
 * sellable identity `productId` (= supplier_product_id, globally unique), NEVER by
 * `sku_custom` (which has no uniqueness guarantee). Pure: cartReducer imports only
 * `react`, no react-native, so it runs under tsx.
 *
 * Run: npx tsx src/__tests__/cartIdentity.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cartReducer } from '../context/CartContext';
import type { CartItem } from '../context/CartContext';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const item = (over: Partial<CartItem> = {}): Omit<CartItem, 'qty'> => ({
  sku: 'SKU', productId: 'P', name: 'Thing', price: 100, img: '', color: '', size: '', ...over,
});

console.log('cart identity safety (Phase 1)');

it('1. two different productIds sharing one sku_custom stay SEPARATE cart lines', () => {
  let s = cartReducer([], { type: 'ADD_ITEM', item: item({ sku: 'DUP', productId: 'P1', color: 'Black' }), qty: 1 });
  s = cartReducer(s, { type: 'ADD_ITEM', item: item({ sku: 'DUP', productId: 'P2', color: 'White' }), qty: 1 });
  assert.equal(s.length, 2, 'colliding sku_custom must NOT merge distinct supplier_product_ids');
  assert.deepEqual(s.map(l => l.productId).sort(), ['P1', 'P2']);
  assert.deepEqual(s.map(l => l.color).sort(), ['Black', 'White'], 'each line keeps its own option attrs');
});

it('2. same productId merges quantity into one line', () => {
  let s = cartReducer([], { type: 'ADD_ITEM', item: item({ productId: 'P1' }), qty: 2 });
  s = cartReducer(s, { type: 'ADD_ITEM', item: item({ productId: 'P1' }), qty: 3 });
  assert.equal(s.length, 1);
  assert.equal(s[0].qty, 5);
});

it('3. REMOVE_ITEM affects only the targeted productId', () => {
  const start: CartItem[] = [
    { ...item({ productId: 'P1', sku: 'DUP' }), qty: 1 },
    { ...item({ productId: 'P2', sku: 'DUP' }), qty: 1 },
  ];
  const s = cartReducer(start, { type: 'REMOVE_ITEM', productId: 'P1' });
  assert.deepEqual(s.map(l => l.productId), ['P2'], 'only P1 removed even though both share sku_custom');
});

it('4. UPDATE_QTY affects only the targeted productId', () => {
  const start: CartItem[] = [
    { ...item({ productId: 'P1', sku: 'DUP' }), qty: 1 },
    { ...item({ productId: 'P2', sku: 'DUP' }), qty: 1 },
  ];
  const s = cartReducer(start, { type: 'UPDATE_QTY', productId: 'P2', qty: 7 });
  assert.equal(s.find(l => l.productId === 'P1')!.qty, 1);
  assert.equal(s.find(l => l.productId === 'P2')!.qty, 7);
});

it('5. UPDATE_QTY to 0 removes only the targeted productId line', () => {
  const start: CartItem[] = [
    { ...item({ productId: 'P1' }), qty: 2 },
    { ...item({ productId: 'P2' }), qty: 2 },
  ];
  const s = cartReducer(start, { type: 'UPDATE_QTY', productId: 'P1', qty: 0 });
  assert.deepEqual(s.map(l => l.productId), ['P2']);
});

it('6. a quoted line REPLACES the same productId (does not merge qty)', () => {
  let s = cartReducer([], { type: 'ADD_ITEM', item: item({ productId: 'P1' }), qty: 2 });
  s = cartReducer(s, { type: 'ADD_ITEM', item: item({ productId: 'P1', price: 80, quoteToken: 'tok' }), qty: 1 });
  assert.equal(s.length, 1);
  assert.equal(s[0].qty, 1, 'quote replaces, does not sum');
  assert.equal(s[0].quoteToken, 'tok');
  assert.equal(s[0].price, 80);
});

it('7. REFRESH_LINES applies price to the matching productId only', () => {
  const start: CartItem[] = [
    { ...item({ productId: 'P1' }), qty: 1, price: 100 },
    { ...item({ productId: 'P2' }), qty: 1, price: 50 },
  ];
  const s = cartReducer(start, { type: 'REFRESH_LINES', updates: [{ productId: 'P1', price: 90, quoteToken: undefined, originalPrice: undefined }] });
  assert.equal(s.find(l => l.productId === 'P1')!.price, 90);
  assert.equal(s.find(l => l.productId === 'P2')!.price, 50, 'unrelated line untouched');
});

// ── Source-structure guard: checkout carries the selected productId end-to-end ──
it('8. Checkout sends productId per line (plan + server payload) and keys memo on productId', () => {
  const co = readFileSync(join(process.cwd(), 'src/screens/CheckoutScreen.tsx'), 'utf8');
  assert.ok(co.includes('${i.productId}:${i.qty}'), 'orderItemsKey memo keyed on productId');
  assert.ok(/planItems\s*=\s*orderItems\.map\(i => \(\{ sku: i\.sku, productId: i\.productId/.test(co), 'plan-fulfillment items carry productId');
  assert.ok(/productId: i\.productId/.test(co), 'server order payload carries productId per line');
});

console.log(`\n${passed} cart identity assertions passed.`);
