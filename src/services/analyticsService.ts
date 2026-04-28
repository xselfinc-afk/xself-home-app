import { supabase } from '../lib/supabase';

type AnalyticsCounter = 'view_count' | 'click_count' | 'add_to_cart_count' | 'order_count';

/**
 * Atomically increment an engagement counter on a product via Supabase RPC.
 *
 * Fire-and-forget — never throws, never blocks the UI.
 * The database function (increment_product_counter) is SECURITY DEFINER
 * so anon users can call it safely.
 */
export function incrementProductCounter(
  supplierProductId: string,
  counter: AnalyticsCounter,
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
}
