/**
 * Commerce Catalog loader (Phase 2) — the live-data I/O layer.
 *
 * Reads the same `sellable_products` view the storefront already uses
 * (LIST_SELECT + adaptStandardizedRow) and caches the adapted list in-memory
 * for the session so the taxonomy screens don't refetch on every navigation.
 * Read-only: no schema changes, no product-data writes.
 *
 * Kept separate from commerceCatalog.ts (pure grouping) so the grouping logic
 * stays free of React-Native transitive imports and remains unit-testable.
 */
import { supabase } from '../lib/supabase';
import { LIST_SELECT, adaptStandardizedRow, type StandardizedRow } from './detailProductAdapter';
import type { Product } from '../data/products';

let _cache: Product[] | null = null;

export async function loadSellableProducts(force = false): Promise<Product[]> {
  if (_cache && !force) return _cache;
  const { data, error } = await supabase.from('sellable_products').select(LIST_SELECT);
  if (error || !data) return _cache ?? [];
  const mapped: Product[] = (data as unknown as StandardizedRow[]).flatMap(r => {
    try { return [adaptStandardizedRow(r)]; } catch { return []; }
  });
  // Only products with a real image are shown (matches storefront behavior).
  _cache = mapped.filter(p => p.images && p.images.length > 0);
  return _cache;
}

export function clearCommerceCatalogCache() { _cache = null; }
