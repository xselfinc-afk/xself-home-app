/**
 * Cart price freshness — PURE logic core (no I/O, no Supabase, no react-native).
 * Import-safe for node/tsx tests. The impure fetch wrapper lives in
 * cartPriceService.ts; see that file for when/where this runs.
 *
 * All imports here are type-only so nothing executes at module load.
 */

import type { CartItem, CartLineUpdate } from '../context/CartContext';
import type { ActiveQuote } from './quotesService';

/** Minimal catalog row shape used for repricing. */
export interface CatalogPriceRow {
  supplier_product_id: string;
  selling_price: number | null;
  price: number | null;
}

/** Customer-facing catalog price: selling_price wins when > 0, else price (resolveCustomerPrice rule). */
export function effectiveCatalogPrice(row: CatalogPriceRow): number | null {
  if (typeof row.selling_price === 'number' && row.selling_price > 0) return row.selling_price;
  if (typeof row.price === 'number' && row.price > 0) return row.price;
  return null;
}

/** True when the quote is currently redeemable. */
export function isQuoteActive(q: ActiveQuote | null | undefined, nowMs: number): q is ActiveQuote {
  return !!q && q.status === 'active' && new Date(q.expires_at).getTime() > nowMs;
}

/**
 * PURE: derive per-line updates from fresh catalog + quote data.
 *
 * Rules (in priority order, per line):
 *   1. Active quote matching (product_id AND supplier_sku) → quoted price + token
 *      (+ originalPrice for the strikethrough).
 *   2. Line carries a quoteToken but no active quote matches anymore
 *      (expired/used/revoked) → revert to catalog price, clear token fields.
 *   3. Plain line whose catalog price differs from the snapshot → catalog price
 *      (both directions: drops show savings; rises prevent a price_changed
 *      surprise at checkout).
 * Lines without a change are omitted from the result.
 */
export function computeCartLineUpdates(
  lines: CartItem[],
  quotesByProductId: Map<string, ActiveQuote | null>,
  catalogByProductId: Map<string, CatalogPriceRow>,
  nowMs: number,
): CartLineUpdate[] {
  const updates: CartLineUpdate[] = [];
  for (const line of lines) {
    const quote = quotesByProductId.get(line.productId);
    const catalogRow = catalogByProductId.get(line.productId);
    const catalogPrice = catalogRow ? effectiveCatalogPrice(catalogRow) : null;

    if (isQuoteActive(quote, nowMs) && quote.supplier_sku === line.sku) {
      const quoted = quote.quoted_price_cents / 100;
      const original = quote.original_price_cents / 100;
      if (line.price !== quoted || line.quoteToken !== quote.redeem_token) {
        updates.push({ productId: line.productId, price: quoted, quoteToken: quote.redeem_token, originalPrice: original });
      }
      continue;
    }

    if (line.quoteToken) {
      // Offer no longer applies — fall back to the current catalog price (or the
      // pre-offer original as a last resort) and clear the offer fields.
      const fallback = catalogPrice ?? line.originalPrice ?? line.price;
      updates.push({ productId: line.productId, price: fallback, quoteToken: undefined, originalPrice: undefined });
      continue;
    }

    if (catalogPrice != null && catalogPrice !== line.price) {
      updates.push({ productId: line.productId, price: catalogPrice, quoteToken: undefined, originalPrice: undefined });
    }
  }
  return updates;
}
