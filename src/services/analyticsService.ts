import { supabase } from '../lib/supabase';
import { AppEventsLogger } from 'react-native-fbsdk-next';
import { ga4AddToCart, ga4BeginCheckout, ga4Purchase, ga4ViewItem, type Ga4PurchaseArgs } from './ga4Analytics';
import type { Ga4ItemFacts } from './ga4Events';

type AnalyticsCounter = 'view_count' | 'click_count' | 'add_to_cart_count' | 'order_count';

/**
 * Atomically increment an engagement counter on a product via Supabase RPC.
 *
 * Fire-and-forget — never throws, never blocks the UI.
 * The database function (increment_product_counter) is SECURITY DEFINER
 * so anon users can call it safely.
 *
 * Meta App Events piggyback on the SAME trigger points (no second analytics
 * lifecycle): view_count → ViewContent, add_to_cart_count → AddToCart. Each
 * action mints ONE event_id used verbatim by BOTH the iOS SDK event and the
 * server relay (meta-capi-relay), so Meta dedupes the pair into one event.
 * Every Meta path is contained — failures can never affect the app or the
 * existing Supabase counters.
 */
export function incrementProductCounter(
  supplierProductId: string,
  counter: AnalyticsCounter,
  /** Optional product facts so GA4 can carry name/price; the counter and Meta
   *  paths ignore it. Never required — the id alone is a complete GA4 item. */
  item?: Omit<Ga4ItemFacts, 'productId'>,
): void {
  if (!supplierProductId) return;
  Promise.resolve(
    supabase.rpc('increment_product_counter', {
      p_supplier_product_id: supplierProductId,
      p_counter: counter,
    }),
  ).then(({ error }) => {
    if (error && __DEV__) {
      console.warn(
        `[Analytics] ${counter} increment failed for ${supplierProductId}:`,
        error.message,
      );
    }
  }).catch(() => { /* swallow network errors — analytics must never crash the app */ });

  if (counter === 'view_count') emitMetaProductEvent('ViewContent', supplierProductId);
  else if (counter === 'add_to_cart_count') emitMetaProductEvent('AddToCart', supplierProductId);

  // GA4 (Firebase Analytics) — same trigger points, third contained side channel.
  // Meta event ids, names and payloads above are untouched by this.
  if (counter === 'view_count') ga4ViewItem({ productId: supplierProductId, ...item });
  else if (counter === 'add_to_cart_count') ga4AddToCart({ productId: supplierProductId, ...item, qty: item?.qty ?? 1 });
}

// ── Meta App Events (A+B, deduped) ───────────────────────────────────────────

/** One stable id per ACTION, shared by the SDK event and the server relay. */
function mintEventId(prefix: string, sku: string): string {
  return `${prefix}:${sku}:${Date.now()}`;
}

function emitMetaProductEvent(name: 'ViewContent' | 'AddToCart', sku: string): void {
  const eventId = mintEventId(name === 'ViewContent' ? 'view' : 'atc', sku);
  // B: iOS SDK event (SKAdNetwork/AEM attribution). `_eventId` is Meta's SDK-side dedup key.
  try {
    AppEventsLogger.logEvent(name === 'ViewContent'
      ? AppEventsLogger.AppEvents.ViewedContent
      : AppEventsLogger.AppEvents.AddedToCart,
    { fb_content_type: 'product', fb_content_id: sku, _eventId: eventId });
  } catch { /* SDK unavailable (e.g. old binary) — server path still fires */ }
  // A: server relay (token stays server-side). Fire-and-forget.
  Promise.resolve(
    supabase.functions.invoke('meta-capi-relay', {
      body: { events: [{ event_name: name, event_id: eventId, sku }] },
    }),
  ).catch(() => { /* contained */ });
}

/** Client-side InitiateCheckout — event_id ic:{checkoutSessionId}, matching the
 *  server's create-checkout-order event exactly (Meta dedupes to one). */
export function logMetaInitiateCheckout(checkoutSessionId: string, totalDollars: number, skus: string[]): void {
  if (!checkoutSessionId) return;
  try {
    AppEventsLogger.logEvent(AppEventsLogger.AppEvents.InitiatedCheckout, totalDollars, {
      fb_content_type: 'product',
      fb_content_id: skus.join(','),
      fb_currency: 'USD',
      _eventId: `ic:${checkoutSessionId}`,
    });
  } catch { /* contained */ }
}

/** Client-side Purchase — fired ONLY at the existing success-confirmation points
 *  (OrderSuccess navigation), never earlier. event_id purchase:{orderId} matches
 *  the webhook's authoritative server event exactly. */
export function logMetaPurchase(orderId: string, totalDollars: number, skus: string[]): void {
  if (!orderId) return;
  try {
    AppEventsLogger.logPurchase(totalDollars, 'USD', {
      fb_content_type: 'product',
      fb_content_id: skus.join(','),
      _eventId: `purchase:${orderId}`,
    });
  } catch { /* contained */ }
}

// ── GA4 checkout events (Firebase Analytics) ─────────────────────────────────
// Called next to the Meta twins at the same existing points in Checkout. GA4 has
// no event_id; purchase dedup is a once-per-order-id ledger inside ga4Analytics.

/** GA4 begin_checkout — call where logMetaInitiateCheckout is called. */
export function logGa4BeginCheckout(lines: Ga4ItemFacts[], valueDollars: number): void {
  ga4BeginCheckout(lines, valueDollars);
}

/** GA4 purchase — call only at the existing success-confirmation points, with the
 *  backend's totals. Sent at most once per order id; skipped when there is no
 *  server total (pay-after-pickup places the order without a charge). */
export function logGa4Purchase(args: Ga4PurchaseArgs): void {
  ga4Purchase(args);
}
