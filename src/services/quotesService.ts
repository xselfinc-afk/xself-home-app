/**
 * Client-side wrapper around the `get-active-quote` Supabase Edge Function.
 *
 * MVP rule: the function requires an authenticated bearer JWT and returns the
 * single freshest active, non-expired quote for the (product_id, JWT email)
 * pair. Returns null when nothing applies or when the user is unauthenticated.
 */

import { supabase } from '../lib/supabase';

export interface ActiveQuote {
  id:                   string;
  redeem_token:         string;
  product_id:           string;
  supplier_sku:         string;
  quoted_price_cents:   number;
  original_price_cents: number;
  max_qty:              number;
  currency:             string;
  expires_at:           string;            // ISO timestamp
  status:               'active' | 'used' | 'expired' | 'revoked';
}

export async function fetchActiveQuote(productId: string): Promise<ActiveQuote | null> {
  if (!productId) return null;
  const { data, error } = await supabase.functions.invoke('get-active-quote', {
    body: { product_id: productId },
  });
  if (error) {
    if (__DEV__) console.warn('[quotesService] fetchActiveQuote failed:', error.message);
    return null;
  }
  return (data?.quote ?? null) as ActiveQuote | null;
}
