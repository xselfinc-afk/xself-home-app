import assert from 'node:assert/strict';
import {
  buildCustomerServiceProductSnapshot,
  buildSearchResults,
  calculateInventoryFreshness,
  validateReaderQuery,
  validateSku,
} from '../services/customerServiceProductSnapshot';

const now = new Date('2026-07-31T12:00:00.000Z');
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'product-1',
  sku_custom: 'XH-TEST-001',
  product_title: 'Oak Side Table',
  selling_price: 199,
  price: 90,
  inventory_status: 'in_stock',
  total_available_qty: 4,
  inventory_last_synced_at: '2026-07-31T06:00:00.000Z',
  fulfillment_buffer: 20,
  estimated_payment_fee: 7.08,
  estimated_net_profit: 81.92,
  estimated_net_margin: 0.4116,
  primary_image: 'https://images.example.test/item.jpg',
  specifications_json: { Material: 'Oak' },
  key_features_json: ['Two drawers'],
  published: true,
  ...overrides,
});

const sellable = buildCustomerServiceProductSnapshot(row(), {
  now,
  sourceEnvironment: 'supabase:test',
  inSellableView: true,
});
assert.equal(sellable.inventory_availability, 'sellable');
assert.equal(sellable.inventory_freshness, 'fresh');
assert.equal(sellable.cost_completeness, 'partial');
assert.equal(sellable.purchase_cost, 90);
assert.equal(sellable.payload_hash.length, 64);

assert.equal(calculateInventoryFreshness('2026-07-30T00:00:00Z', now), 'stale');
assert.equal(calculateInventoryFreshness('2026-07-20T00:00:00Z', now), 'expired');
assert.equal(calculateInventoryFreshness(null, now), 'missing');

const out = buildCustomerServiceProductSnapshot(row({ inventory_status: 'out_of_stock', total_available_qty: 0 }), {
  now,
  sourceEnvironment: 'supabase:test',
  inSellableView: false,
});
assert.equal(out.inventory_availability, 'out_of_stock');

const unknown = buildCustomerServiceProductSnapshot(row({ inventory_last_synced_at: null }), {
  now,
  sourceEnvironment: 'supabase:test',
  inSellableView: false,
});
assert.equal(unknown.inventory_availability, 'unknown');

const unknownWithZeroQuantity = buildCustomerServiceProductSnapshot(row({
  inventory_status: 'unknown',
  total_available_qty: 0,
  inventory_last_synced_at: null,
}), {
  now,
  sourceEnvironment: 'supabase:test',
  inSellableView: false,
});
assert.equal(unknownWithZeroQuantity.inventory_availability, 'unknown');

const unpublished = buildCustomerServiceProductSnapshot(row({ published: false }), {
  now,
  sourceEnvironment: 'supabase:test',
  inSellableView: false,
});
assert.equal(unpublished.inventory_availability, 'unpublished');

const conflict = buildSearchResults([
  sellable,
  { ...sellable, product_id: 'product-2' },
], 'XH-TEST-001');
assert.equal(conflict.length, 2);
assert.ok(conflict.every((item) => item.has_sku_conflict));
assert.ok(conflict.every((item) => item.exact_sku_match));

assert.equal(validateSku('XH-TEST-001'), 'XH-TEST-001');
assert.throws(() => validateSku('../secret'), /INVALID_SKU/);
assert.equal(validateReaderQuery('oak table'), 'oak table');
assert.throws(() => validateReaderQuery(''), /INVALID_QUERY/);

console.log('customerServiceProductSnapshot tests passed');
