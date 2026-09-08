/**
 * GA4 via Firebase Analytics — the React Native wiring.
 *
 * Side channel only. Every exported function returns void, never throws, and
 * never awaits anything the caller could be blocked by: a missing native
 * module, an unconfigured Firebase app, a rejected log call or a broken
 * AsyncStorage all end inside this file. Product, cart, checkout and payment
 * code call these at the same points where the Supabase counters and Meta App
 * Events already fire, and never learn whether GA4 succeeded.
 *
 * Event shapes and the once-per-order purchase ledger are pure functions in
 * ga4Events.ts; this file only adds the SDK and the storage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAnalytics, logAddToCart, logBeginCheckout, logEvent, logViewItem,
  type Analytics, type Item,
} from '@react-native-firebase/analytics';
import {
  GA4_CURRENCY, PURCHASE_LEDGER_KEY, PurchaseLedger,
  buildPurchaseParams, itemsValue, toGa4Item, toGa4Items,
  type Ga4Item, type Ga4ItemFacts, type Ga4OrderTotals,
} from './ga4Events';

let instance: Analytics | null = null;
function sdk(): Analytics {
  if (!instance) instance = getAnalytics();
  return instance;
}

/** Ga4Item → the SDK's Item shape (same fields; the SDK type is all-optional). */
function asSdkItem(item: Ga4Item): Item {
  const out: Item = { item_id: item.item_id, quantity: item.quantity };
  if (item.item_name !== undefined) out.item_name = item.item_name;
  if (item.price !== undefined) out.price = item.price;
  return out;
}

/** Runs `fn` and swallows both synchronous throws and rejected promises. */
function contained(label: string, fn: () => unknown): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((e) => { if (__DEV__) console.warn(`[GA4] ${label} failed:`, e); });
    }
  } catch (e) {
    if (__DEV__) console.warn(`[GA4] ${label} failed:`, e);
  }
}

const ledger = new PurchaseLedger({
  get: () => AsyncStorage.getItem(PURCHASE_LEDGER_KEY),
  set: (value) => AsyncStorage.setItem(PURCHASE_LEDGER_KEY, value),
});

export function ga4ViewItem(facts: Ga4ItemFacts): void {
  contained('view_item', () => {
    const item = toGa4Item({ ...facts, qty: 1 });
    if (!item) return;
    return logViewItem(sdk(), { currency: GA4_CURRENCY, value: item.price ?? 0, items: [asSdkItem(item)] });
  });
}

export function ga4AddToCart(facts: Ga4ItemFacts): void {
  contained('add_to_cart', () => {
    const item = toGa4Item(facts);
    if (!item) return;
    return logAddToCart(sdk(), { currency: GA4_CURRENCY, value: itemsValue([item]), items: [asSdkItem(item)] });
  });
}

export function ga4BeginCheckout(lines: Ga4ItemFacts[], valueDollars?: number): void {
  contained('begin_checkout', () => {
    const items = toGa4Items(lines);
    if (!items.length) return;
    const value = typeof valueDollars === 'number' && Number.isFinite(valueDollars) ? valueDollars : itemsValue(items);
    return logBeginCheckout(sdk(), { currency: GA4_CURRENCY, value, items: items.map(asSdkItem) });
  });
}

export interface Ga4PurchaseArgs {
  orderId: string;
  orderNumber?: string | null;
  /** Server-confirmed totals from create-checkout-order. `null` → no purchase is sent. */
  totals: Ga4OrderTotals | null;
  items: Ga4ItemFacts[];
  fulfillmentMethod?: string | null;
}

/**
 * Sends `purchase` once per order id. Value is the backend's total; when the
 * backend returned no total (pay-after-pickup places the order with $0 due and
 * no charge yet) nothing is sent rather than a figure this device computed.
 */
export function ga4Purchase(args: Ga4PurchaseArgs): void {
  contained('purchase', async () => {
    if (!args.totals) {
      if (__DEV__) console.warn('[GA4] purchase skipped: no server total for order', args.orderId);
      return;
    }
    const params = buildPurchaseParams({ ...args, totals: args.totals });
    if (!params) return;
    if (!(await ledger.claim(params.transaction_id))) {
      if (__DEV__) console.log('[GA4] purchase already sent for', params.transaction_id);
      return;
    }
    // logEvent's 'purchase' overload accepts custom parameters (order_number,
    // fulfillment_method) alongside the standard ones.
    logEvent(sdk(), 'purchase', { ...params, items: params.items.map(asSdkItem) });
    if (__DEV__) console.log('[GA4] purchase sent', params.transaction_id, params.value);
  });
}
