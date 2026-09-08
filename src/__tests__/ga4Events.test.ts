/**
 * GA4 event shape + purchase ledger tests — pure; no React Native, no Firebase,
 * no network. Run: npx tsx src/__tests__/ga4Events.test.ts
 */
import assert from 'node:assert/strict';
import {
  buildPurchaseParams, itemsValue, serverTotalsFrom, toGa4Item, toGa4Items,
  PurchaseLedger, type LedgerStore,
} from '../services/ga4Events';

let passed = 0;
function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => { passed++; console.log(`  ✓ ${name}`); });
}

function memoryStore(initial: string | null = null, failWrites = false): LedgerStore & { writes: number } {
  let value = initial;
  return {
    writes: 0,
    async get() { return value; },
    async set(v) { this.writes++; if (failWrites) throw new Error('disk full'); value = v; },
  };
}

(async () => {
  console.log('ga4Events');

  await it('maps a product to a GA4 item with item_id = supplier product id', () => {
    assert.deepEqual(toGa4Item({ productId: 'D720094424', name: 'Chair', price: 119, qty: 2 }),
      { item_id: 'D720094424', item_name: 'Chair', price: 119, quantity: 2 });
  });

  await it('drops items with no id and defaults quantity to 1', () => {
    assert.equal(toGa4Item({ productId: '' }), null);
    assert.deepEqual(toGa4Items([{ productId: 'A' }, { productId: ' ' }]), [{ item_id: 'A', quantity: 1 }]);
  });

  await it('sums item value in dollars', () => {
    assert.equal(itemsValue(toGa4Items([{ productId: 'A', price: 10.5, qty: 2 }, { productId: 'B', price: 0.1, qty: 3 }])), 21.3);
  });

  await it('reads server totals from a nested totals object or top-level cents, never invents one', () => {
    assert.deepEqual(serverTotalsFrom({ totals: { totalCents: 12941, subtotalCents: 11900, shippingCents: 0, taxCents: 1041 } }),
      { totalCents: 12941, subtotalCents: 11900, shippingCents: 0, taxCents: 1041 });
    assert.deepEqual(serverTotalsFrom({ totalCents: 500 }), { totalCents: 500, subtotalCents: undefined, shippingCents: undefined, taxCents: undefined });
    assert.equal(serverTotalsFrom({ orderId: 'x' }), null);
    assert.equal(serverTotalsFrom(null), null);
    assert.equal(serverTotalsFrom({ totals: { totalCents: -1 } }), null);
  });

  await it('builds purchase from server facts: transaction_id = order id, USD, dollars', () => {
    const p = buildPurchaseParams({
      orderId: 'ord_123', orderNumber: 'XS-55555',
      totals: { totalCents: 12941, taxCents: 1041, shippingCents: 0 },
      items: [{ productId: 'D720094424', name: 'Chair', price: 119, qty: 1 }],
      fulfillmentMethod: 'pickup',
    });
    assert.deepEqual(p, {
      transaction_id: 'ord_123', currency: 'USD', value: 129.41,
      items: [{ item_id: 'D720094424', item_name: 'Chair', price: 119, quantity: 1 }],
      tax: 10.41, shipping: 0, order_number: 'XS-55555', fulfillment_method: 'pickup',
    });
    assert.equal(buildPurchaseParams({ orderId: '', totals: { totalCents: 1 }, items: [] }), null);
  });

  await it('ledger claims an order id exactly once and persists it', async () => {
    const store = memoryStore();
    const ledger = new PurchaseLedger(store);
    assert.equal(await ledger.claim('ord_1'), true);
    assert.equal(await ledger.claim('ord_1'), false);
    assert.equal(await ledger.claim('ord_2'), true);
    assert.equal(store.writes, 2);
    const again = new PurchaseLedger(store);           // fresh process, same storage
    assert.equal(await again.claim('ord_1'), false);
    assert.equal(await again.claim('ord_3'), true);
  });

  await it('ledger still dedupes within a session when storage fails', async () => {
    const ledger = new PurchaseLedger(memoryStore(null, true));
    assert.equal(await ledger.claim('ord_9'), true);
    assert.equal(await ledger.claim('ord_9'), false);
  });

  await it('ledger ignores a corrupt store', async () => {
    const ledger = new PurchaseLedger(memoryStore('{not json'));
    assert.equal(await ledger.claim('ord_c'), true);
    assert.equal(await ledger.claim('ord_c'), false);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
