/**
 * Cart price freshness tests — pure; no I/O, no Supabase, no secrets.
 * Covers computeCartLineUpdates (the display-sync core used on Cart focus and
 * Checkout mount). Run: npx tsx src/__tests__/cartPriceRefresh.test.ts
 */
import assert from 'node:assert/strict';
import {
  computeCartLineUpdates,
  effectiveCatalogPrice,
  isQuoteActive,
  type CatalogPriceRow,
} from '../services/cartPriceLogic';
import type { CartItem } from '../context/CartContext';
import type { ActiveQuote } from '../services/quotesService';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = 1_800_000_000_000; // fixed clock
const FUTURE = new Date(NOW + 3_600_000).toISOString();
const PAST = new Date(NOW - 3_600_000).toISOString();

function line(over: Partial<CartItem> = {}): CartItem {
  return { sku: 'SKU1', productId: 'P1', name: 'Chair', price: 100, img: '', qty: 1, color: '', size: '', ...over };
}
function quote(over: Partial<ActiveQuote> = {}): ActiveQuote {
  return {
    id: 'q1', redeem_token: 'tok-1', product_id: 'P1', supplier_sku: 'SKU1',
    quoted_price_cents: 8000, original_price_cents: 10000, max_qty: 1,
    currency: 'USD', expires_at: FUTURE, status: 'active', ...over,
  };
}
function catalog(price: number, selling: number | null = price): CatalogPriceRow {
  return { supplier_product_id: 'P1', selling_price: selling, price };
}

console.log('cart price refresh tests');

// ── helpers ──
it('effectiveCatalogPrice: selling_price wins when > 0, falls back to price', () => {
  assert.equal(effectiveCatalogPrice({ supplier_product_id: 'x', selling_price: 96.99, price: 33.25 }), 96.99);
  assert.equal(effectiveCatalogPrice({ supplier_product_id: 'x', selling_price: 0, price: 33.25 }), 33.25);
  assert.equal(effectiveCatalogPrice({ supplier_product_id: 'x', selling_price: null, price: null }), null);
});
it('isQuoteActive: active + unexpired only', () => {
  assert.equal(isQuoteActive(quote(), NOW), true);
  assert.equal(isQuoteActive(quote({ expires_at: PAST }), NOW), false);
  assert.equal(isQuoteActive(quote({ status: 'used' }), NOW), false);
  assert.equal(isQuoteActive(null, NOW), false);
});

// ── quote application (Bug 2: offer created AFTER add-to-cart) ──
it('applies an active quote to a stale plain line (price + token + strikethrough)', () => {
  const u = computeCartLineUpdates([line()], new Map([['P1', quote()]]), new Map([['P1', catalog(100)]]), NOW);
  assert.deepEqual(u, [{ productId: 'P1', price: 80, quoteToken: 'tok-1', originalPrice: 100 }]);
});
it('does NOT apply a quote whose supplier_sku differs from the cart line sku', () => {
  const u = computeCartLineUpdates([line()], new Map([['P1', quote({ supplier_sku: 'OTHER' })]]), new Map([['P1', catalog(100)]]), NOW);
  assert.deepEqual(u, []); // catalog price unchanged (100) → no update at all
});
it('already-quoted line with same token/price → no redundant update', () => {
  const l = line({ price: 80, quoteToken: 'tok-1', originalPrice: 100 });
  const u = computeCartLineUpdates([l], new Map([['P1', quote()]]), new Map([['P1', catalog(100)]]), NOW);
  assert.deepEqual(u, []);
});

// ── quote expiry/revocation reverts ──
it('expired quote on a quoted line reverts to catalog price and clears offer fields', () => {
  const l = line({ price: 80, quoteToken: 'tok-1', originalPrice: 100 });
  const u = computeCartLineUpdates([l], new Map([['P1', quote({ expires_at: PAST })]]), new Map([['P1', catalog(100)]]), NOW);
  assert.deepEqual(u, [{ productId: 'P1', price: 100, quoteToken: undefined, originalPrice: undefined }]);
});
it('quoted line with NO quote returned (revoked/used) also reverts', () => {
  const l = line({ price: 80, quoteToken: 'tok-1', originalPrice: 100 });
  const u = computeCartLineUpdates([l], new Map([['P1', null]]), new Map([['P1', catalog(95)]]), NOW);
  assert.deepEqual(u, [{ productId: 'P1', price: 95, quoteToken: undefined, originalPrice: undefined }]);
});

// ── catalog drift on plain lines ──
it('catalog price drop updates the line (customer sees the lower price)', () => {
  const u = computeCartLineUpdates([line({ price: 100 })], new Map(), new Map([['P1', catalog(90)]]), NOW);
  assert.deepEqual(u, [{ productId: 'P1', price: 90, quoteToken: undefined, originalPrice: undefined }]);
});
it('catalog price rise updates the line (prevents price_changed surprise at checkout)', () => {
  const u = computeCartLineUpdates([line({ price: 100 })], new Map(), new Map([['P1', catalog(110)]]), NOW);
  assert.deepEqual(u, [{ productId: 'P1', price: 110, quoteToken: undefined, originalPrice: undefined }]);
});
it('unchanged catalog price → empty result (no cart churn)', () => {
  const u = computeCartLineUpdates([line({ price: 100 })], new Map(), new Map([['P1', catalog(100)]]), NOW);
  assert.deepEqual(u, []);
});
it('missing catalog row → line untouched (defensive)', () => {
  const u = computeCartLineUpdates([line()], new Map(), new Map(), NOW);
  assert.deepEqual(u, []);
});

// ── mixed cart ──
it('mixed cart: quote applies to its line; other line follows catalog', () => {
  const lines = [line(), line({ sku: 'SKU2', productId: 'P2', price: 50 })];
  const quotes = new Map([['P1', quote()]]);
  const cat = new Map<string, CatalogPriceRow>([
    ['P1', catalog(100)],
    ['P2', { supplier_product_id: 'P2', selling_price: 45, price: 40 }],
  ]);
  const u = computeCartLineUpdates(lines, quotes, cat, NOW);
  assert.deepEqual(u, [
    { productId: 'P1', price: 80, quoteToken: 'tok-1', originalPrice: 100 },
    { productId: 'P2', price: 45, quoteToken: undefined, originalPrice: undefined },
  ]);
});

console.log(`\n${passed} cart price refresh assertions passed.`);
