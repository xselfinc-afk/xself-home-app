/**
 * searchService — the single client entry for product search.
 *
 * Home Search, Discover's search state, and the image-keyword path all call
 * searchProducts(); the heavy lifting lives in the `search_products` RPC
 * (see supabase/migrations/20260902_search_products_rpc.sql): fixed public
 * recall boundary, SKU-exact-first deterministic ranking, trigram typo
 * tolerance. The client no longer downloads the whole catalogue to filter
 * in memory.
 *
 * Session-level TTL cache (120s): a cache hit is returned as-is and is NOT
 * revalidated in the background — no SWR, so a query's results never reshuffle
 * mid-session. clearSearchCache() runs when the search UI unmounts.
 *
 * Request consistency: callers pass an AbortSignal (wired to supabase-js) and
 * keep their own monotonically-increasing request sequence as the second
 * guard — a late response for an old query is dropped by the caller.
 */

import { supabase } from '../lib/supabase';
import { adaptStandardizedRow } from './detailProductAdapter';
import type { Product } from '../data/products';

export interface SearchResult {
  items: Product[];
  /** Per-item availability keyed by supplier_product_id (false = inventory-delisted). */
  availability: Record<string, boolean>;
  totalCount: number;
  tookMs: number;
  fromCache: boolean;
}

const CACHE_TTL_MS = 120_000;
const cache = new Map<string, { at: number; result: SearchResult }>();

export function clearSearchCache(): void {
  cache.clear();
}

function cacheKey(query: string, limit: number, offset: number): string {
  return `${query.trim().toLowerCase()}|${limit}|${offset}`;
}

export async function searchProducts(
  query: string,
  opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<SearchResult> {
  const q = query.trim();
  const limit = opts.limit ?? 30;
  const offset = opts.offset ?? 0;
  if (!q) return { items: [], availability: {}, totalCount: 0, tookMs: 0, fromCache: false };

  const key = cacheKey(q, limit, offset);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.result, fromCache: true };
  }

  const t0 = Date.now();
  let rpc = supabase.rpc('search_products', { p_query: q, p_limit: limit, p_offset: offset });
  if (opts.signal) rpc = rpc.abortSignal(opts.signal);
  const { data, error } = await rpc;
  const tookMs = Date.now() - t0;

  if (error) {
    // AbortError surfaces here too — rethrow so callers can tell "cancelled"
    // from "failed" (callers show error+Retry only for real failures).
    throw new Error(error.message || 'search failed');
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const availability: Record<string, boolean> = {};
  const items: Product[] = rows.flatMap((r) => {
    try {
      const p = adaptStandardizedRow(r as never);
      availability[p.id] = r.is_available !== false;
      return [p];
    } catch {
      return [];
    }
  });
  const totalCount = Number(rows[0]?.total_count ?? items.length);

  const result: SearchResult = { items, availability, totalCount, tookMs, fromCache: false };
  cache.set(key, { at: Date.now(), result });
  if (__DEV__) {
    console.log(`[search] "${q}" → ${items.length}/${totalCount} in ${tookMs}ms`);
  }
  return result;
}
