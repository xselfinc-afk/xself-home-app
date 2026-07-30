/**
 * Checkout inventory revalidation (Scope G) — pure decision tests.
 * Run: npx tsx src/__tests__/checkoutInventoryRevalidation.test.ts
 */
import assert from 'node:assert/strict';
import {
  evaluateCheckoutLine, evaluateCheckoutCart,
  type CheckoutLineInventory, type RevalidationPolicy,
} from '../../supabase/functions/_shared/checkoutInventoryRevalidation';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = 1_800_000_000_000;
const H = 3600_000;
const on: RevalidationPolicy = { enabled: true, staleThresholdMs: 24 * H, nowMs: NOW };
const off: RevalidationPolicy = { ...on, enabled: false };
const iso = (agoH: number) => new Date(NOW - agoH * H).toISOString();
const line = (over: Partial<CheckoutLineInventory> = {}): CheckoutLineInventory =>
  ({ productId: 'P', sku: 'XH-P', qty: 1, rows: [{ quantity: 5, lastSyncedAt: iso(1) }], ...over });

console.log('checkout inventory revalidation');

it('recent confirmed in-stock line passes', () => {
  const d = evaluateCheckoutLine(line(), on);
  assert.equal(d.status, 'ok'); assert.equal(d.allow, true);
});

it('confirmed out-of-stock line blocks (rows present, total 0)', () => {
  const d = evaluateCheckoutLine(line({ rows: [{ quantity: 0, lastSyncedAt: iso(1) }] }), on);
  assert.equal(d.status, 'out_of_stock'); assert.equal(d.allow, false);
});

it('insufficient qty blocks', () => {
  const d = evaluateCheckoutLine(line({ qty: 10, rows: [{ quantity: 3, lastSyncedAt: iso(1) }] }), on);
  assert.equal(d.status, 'insufficient_qty'); assert.equal(d.allow, false);
});

it('stale line → structured non-confirmed status; BLOCKED when flag on', () => {
  const d = evaluateCheckoutLine(line({ rows: [{ quantity: 5, lastSyncedAt: iso(40) }] }), on);
  assert.equal(d.status, 'stale');
  assert.notEqual(d.status, 'ok');     // never masquerades as confirmed
  assert.equal(d.allow, false);
});

it('stale line with flag OFF → surfaced as stale but allowed (current fail-open, unchanged)', () => {
  const d = evaluateCheckoutLine(line({ rows: [{ quantity: 5, lastSyncedAt: iso(40) }] }), off);
  assert.equal(d.status, 'stale');     // still NOT 'ok'
  assert.equal(d.allow, true);
});

it('unknown (no rows) blocks and never reports as available', () => {
  const d = evaluateCheckoutLine(line({ rows: [] }), on);
  assert.equal(d.status, 'unknown'); assert.equal(d.allow, false);
});

it('null timestamp is treated as not-fresh → stale (never silently ok)', () => {
  const d = evaluateCheckoutLine(line({ rows: [{ quantity: 5, lastSyncedAt: null }] }), on);
  assert.equal(d.status, 'stale'); assert.equal(d.allow, false);
});

it('multi-line cart identifies ONLY the affected items', () => {
  const cart = evaluateCheckoutCart([
    line({ productId: 'A', sku: 'A', rows: [{ quantity: 5, lastSyncedAt: iso(1) }] }),   // ok
    line({ productId: 'B', sku: 'B', rows: [{ quantity: 0, lastSyncedAt: iso(1) }] }),   // oos
    line({ productId: 'C', sku: 'C', rows: [{ quantity: 5, lastSyncedAt: iso(50) }] }),  // stale
  ], on);
  assert.equal(cart.allAllowed, false);
  assert.deepEqual(cart.failures.map(f => f.productId).sort(), ['B', 'C']);
  assert.equal(cart.decisions.find(d => d.productId === 'A')!.allow, true);
});

it('fulfillment-agnostic: pickup vs shipping rows classify purely on qty+freshness', () => {
  // Rows carry no fulfillment coupling here; a fresh positive qty is ok regardless of channel.
  const d = evaluateCheckoutCart([line({ rows: [{ quantity: 2, lastSyncedAt: iso(2) }] })], on);
  assert.equal(d.allAllowed, true);
});

console.log(`\n${passed} passed`);
