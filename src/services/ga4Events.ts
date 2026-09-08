/**
 * GA4 (Firebase Analytics) event shapes — pure, no React Native imports.
 *
 * Everything here is deterministic and testable with plain node: how a product
 * or order line becomes a GA4 item, how a purchase payload is built from server
 * facts, and the once-per-order ledger that keeps revenue from being counted
 * twice. The React Native wiring (Firebase SDK, AsyncStorage) lives in
 * ga4Analytics.ts and only calls into these functions.
 *
 * Identity: `item_id` is the supplier product id — the same key the cart,
 * the backend and the Meta events already use for this product. Prices are
 * dollars (GA4 convention), currency is always USD.
 */

export const GA4_CURRENCY = 'USD';

export interface Ga4ItemFacts {
  /** supplier_product_id — the product identity used across cart, backend and Meta. */
  productId: string;
  name?: string;
  /** Unit price in dollars. */
  price?: number;
  qty?: number;
}

export interface Ga4Item {
  item_id: string;
  item_name?: string;
  price?: number;
  quantity: number;
}

/** Server-confirmed money for an order, in cents. Only `totalCents` is required. */
export interface Ga4OrderTotals {
  totalCents: number;
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
}

export interface Ga4PurchaseInput {
  orderId: string;
  orderNumber?: string | null;
  totals: Ga4OrderTotals;
  items: Ga4ItemFacts[];
  fulfillmentMethod?: string | null;
}

export interface Ga4PurchaseParams {
  transaction_id: string;
  currency: string;
  value: number;
  items: Ga4Item[];
  tax?: number;
  shipping?: number;
  order_number?: string;
  fulfillment_method?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function centsToDollars(cents: number): number {
  return Number.isFinite(cents) ? Math.round(cents) / 100 : 0;
}

export function toGa4Item(facts: Ga4ItemFacts): Ga4Item | null {
  const id = String(facts.productId ?? '').trim();
  if (!id) return null;
  const qty = Number(facts.qty);
  const item: Ga4Item = { item_id: id, quantity: qty >= 1 ? Math.floor(qty) : 1 };
  if (facts.name) item.item_name = String(facts.name);
  if (typeof facts.price === 'number' && Number.isFinite(facts.price)) item.price = round2(facts.price);
  return item;
}

export function toGa4Items(list: Ga4ItemFacts[]): Ga4Item[] {
  return list.map(toGa4Item).filter((i): i is Ga4Item => i !== null);
}

export function itemsValue(items: Ga4Item[]): number {
  return round2(items.reduce((sum, i) => sum + (i.price ?? 0) * i.quantity, 0));
}

/**
 * Accepts whatever the backend put on the create-checkout-order response and
 * returns server-confirmed totals, or null when there is no server figure.
 * Never derives a total from the client's own arithmetic.
 */
export function serverTotalsFrom(data: unknown): Ga4OrderTotals | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const src = (d.totals && typeof d.totals === 'object') ? (d.totals as Record<string, unknown>) : d;
  const totalCents = Number(src.totalCents);
  if (!Number.isFinite(totalCents) || totalCents < 0) return null;
  const pick = (k: string): number | undefined => {
    const v = Number(src[k]);
    return Number.isFinite(v) ? v : undefined;
  };
  return {
    totalCents,
    subtotalCents: pick('subtotalCents'),
    shippingCents: pick('shippingCents'),
    taxCents: pick('taxCents'),
  };
}

/** Builds the GA4 purchase payload from server facts. Returns null if the order id is missing. */
export function buildPurchaseParams(input: Ga4PurchaseInput): Ga4PurchaseParams | null {
  const orderId = String(input.orderId ?? '').trim();
  if (!orderId) return null;
  const params: Ga4PurchaseParams = {
    transaction_id: orderId,
    currency: GA4_CURRENCY,
    value: centsToDollars(input.totals.totalCents),
    items: toGa4Items(input.items),
  };
  if (typeof input.totals.taxCents === 'number') params.tax = centsToDollars(input.totals.taxCents);
  if (typeof input.totals.shippingCents === 'number') params.shipping = centsToDollars(input.totals.shippingCents);
  if (input.orderNumber) params.order_number = String(input.orderNumber);
  if (input.fulfillmentMethod) params.fulfillment_method = String(input.fulfillmentMethod);
  return params;
}

/* ── Once-per-order ledger ─────────────────────────────────────────────── */

export interface LedgerStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

export const PURCHASE_LEDGER_KEY = 'xself_ga4_purchased_v1';
export const PURCHASE_LEDGER_CAP = 50;

/**
 * Remembers which order ids have already produced a GA4 purchase. The in-memory
 * set answers within a session even when storage is unavailable; the store
 * makes it survive restarts. `claim` returns true exactly once per order id.
 */
export class PurchaseLedger {
  private readonly seen = new Set<string>();
  private loaded = false;

  constructor(private readonly store: LedgerStore) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.store.get();
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) parsed.forEach((id) => { if (typeof id === 'string') this.seen.add(id); });
    } catch { /* unreadable ledger — behave as empty; the in-memory guard still holds */ }
  }

  async claim(orderId: string): Promise<boolean> {
    const id = String(orderId ?? '').trim();
    if (!id) return false;
    await this.load();
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    try {
      const list = Array.from(this.seen).slice(-PURCHASE_LEDGER_CAP);
      await this.store.set(JSON.stringify(list));
    } catch { /* storage failure must not block or duplicate: the set already holds the id */ }
    return true;
  }
}
