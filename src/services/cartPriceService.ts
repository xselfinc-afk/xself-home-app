/**
 * Cart price freshness — display-level sync for Cart / Checkout.
 *
 * Refreshes existing cart lines against (a) the current catalog price in
 * `sellable_products` and (b) the signed-in customer's active Special Offer
 * quotes (get-active-quote). Runs on Cart focus and Checkout (cart-mode) mount.
 *
 * DISPLAY/ADVISORY ONLY: the charge-time authority is create-checkout-order,
 * which re-prices every line server-side (quote override + catalog reconcile).
 * This service just keeps what the customer SEES in step with the server so
 * checkout does not surprise them.
 *
 * Pure logic lives in cartPriceLogic.ts (unit-tested, no I/O).
 */

import { supabase } from '../lib/supabase';
import type { CartItem, CartLineUpdate } from '../context/CartContext';
import { fetchActiveQuote, type ActiveQuote } from './quotesService';
import { computeCartLineUpdates, type CatalogPriceRow } from './cartPriceLogic';

export { computeCartLineUpdates, effectiveCatalogPrice, isQuoteActive } from './cartPriceLogic';
export type { CatalogPriceRow } from './cartPriceLogic';

/**
 * IMPURE: fetch fresh catalog + quote data for the given cart and return the
 * line updates to apply. Never throws — returns [] on any failure so Cart /
 * Checkout rendering is never blocked by a refresh problem.
 */
export async function fetchCartPriceUpdates(cart: CartItem[], isSignedIn: boolean): Promise<CartLineUpdate[]> {
  if (cart.length === 0) return [];
  try {
    const productIds = [...new Set(cart.map(i => i.productId))];

    const { data, error } = await supabase
      .from('sellable_products')
      .select('supplier_product_id, selling_price, price')
      .in('supplier_product_id', productIds);
    const catalogByProductId = new Map<string, CatalogPriceRow>(
      !error && data ? (data as CatalogPriceRow[]).map(r => [r.supplier_product_id, r]) : [],
    );

    // Quotes are account-scoped — guests skip straight to catalog-only refresh.
    const quotesByProductId = new Map<string, ActiveQuote | null>();
    if (isSignedIn) {
      const results = await Promise.all(productIds.map(id => fetchActiveQuote(id)));
      productIds.forEach((id, idx) => quotesByProductId.set(id, results[idx]));
    }

    return computeCartLineUpdates(cart, quotesByProductId, catalogByProductId, Date.now());
  } catch {
    return [];
  }
}
