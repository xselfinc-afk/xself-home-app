import { supabase, supabaseConfigured } from '../lib/supabase';
import type { SkuInventory } from './gigaInventoryService';

// Cache entries fresher than this are considered valid
const CACHE_TTL_MINUTES = 60;

// Known city names for warehouse codes — best-effort, null for unrecognised codes.
// Does NOT gate any logic; state and pickup are derived via pattern matching below.
const KNOWN_CITY: Record<string, string> = {
  CA2: 'City of Industry', CA3: 'Fontana', CA4: 'Rancho Cucamonga',
  CA5: 'Ontario', CA6: 'Rancho Cucamonga', CA7: 'Fontana', CA8: 'Fontana',
  CA9: 'Ontario', CA10: 'Ontario', CA11: 'Ontario', CAN1: 'El Monte',
  CAX1: 'Rancho Cucamonga', CAN2: 'Ontario', CAN3: 'Compton',
  CAX2: 'Rancho Cucamonga', CAX8: 'Carson', CAX3: 'Rancho Cucamonga', CAL1: 'La Puente',
  NJ1: 'Cranbury', NJ2: 'Dayton', NJ3: 'Dayton', NJ4: 'Cranbury', NJX3: 'Elkton',
  AT1: 'Lithia Springs', AT2: 'Lithia Springs', AT3: 'Braselton',
  AT4: 'Savannah', AT5: 'Bloomingdale', ATX4: 'Commerce', ATX6: 'Buford', ATN1: 'Savannah',
  TX1: 'Grand Prairie', TXX1: 'Houston', TXX2: 'Pearland',
};

/**
 * Derive US state abbreviation from warehouse code prefix.
 * Works for any code the seller website may show — not limited to a hardcoded list.
 *   CA* → 'CA'   (NJX* must be checked before NJ* — Elkton is in MD)
 *   NJX* → 'MD'  TXX* must be checked before TX* — same prefix collision
 *   NJ* → 'NJ'
 *   AT* → 'GA'
 *   TX* → 'TX'
 */
function warehouseState(code: string): string | null {
  if (/^CA/i.test(code)) return 'CA';
  if (/^NJX/i.test(code)) return 'MD';  // e.g. NJX3 = Elkton, MD
  if (/^NJ/i.test(code)) return 'NJ';
  if (/^AT/i.test(code)) return 'GA';
  if (/^TX/i.test(code)) return 'TX';
  return null;
}

/** California warehouses support pickup; all others are ship-only. */
function supportsPickup(code: string): boolean {
  return warehouseState(code) === 'CA';
}

/**
 * Read cached inventory for a list of product IDs.
 * Returns only entries fresher than maxAgeMinutes.
 * Returns empty array on any error — callers fall through to live fetch.
 */
export async function readInventoryFromCache(
  productIds: string[],
  maxAgeMinutes = CACHE_TTL_MINUTES,
): Promise<SkuInventory[]> {
  if (!supabaseConfigured || productIds.length === 0) return [];

  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('inventory_cache')
    .select('product_id, warehouse_code, quantity, is_available')
    .in('product_id', productIds)
    .eq('sync_status', 'ok')
    .gte('last_synced_at', cutoff);

  if (error) {
    console.log('[InventoryCache] Read error:', error.message);
    return [];
  }
  if (!data || data.length === 0) return [];

  const grouped = new Map<string, { warehouseCode: string; availableQty: number }[]>();
  for (const row of data) {
    if (!grouped.has(row.product_id)) grouped.set(row.product_id, []);
    grouped.get(row.product_id)!.push({
      warehouseCode: row.warehouse_code,
      availableQty: row.is_available ? row.quantity : 0,
    });
  }

  return Array.from(grouped.entries()).map(([sku, warehouseStock]) => ({
    sku,
    warehouseStock,
  }));
}

/**
 * Upsert GIGA inventory results into inventory_cache.
 * One row per (product_id, warehouse_code). Fire-and-forget safe.
 */
export async function writeInventoryToCache(inventory: SkuInventory[]): Promise<void> {
  if (!supabaseConfigured || inventory.length === 0) return;

  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];

  for (const inv of inventory) {
    for (const ws of inv.warehouseStock) {
      rows.push({
        product_id: inv.sku,
        supplier_product_id: inv.sku,
        warehouse_code: ws.warehouseCode,
        warehouse_state: warehouseState(ws.warehouseCode),
        warehouse_city: KNOWN_CITY[ws.warehouseCode] ?? null,
        quantity: ws.availableQty,
        is_available: ws.availableQty > 0,
        supports_pickup: supportsPickup(ws.warehouseCode),
        supports_shipping: true,
        last_synced_at: now,
        sync_status: 'ok',
        source_type: 'price_synthesis',
      });
    }
  }

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('inventory_cache')
    .upsert(rows, { onConflict: 'product_id,warehouse_code' });

  if (error) {
    console.log('[InventoryCache] Write error:', error.message);
  } else {
    console.log('[InventoryCache] Wrote', rows.length, 'row(s) for', inventory.length, 'SKU(s)');
  }
}

/**
 * Return product IDs that have at least one CA warehouse with is_available=true.
 * Used by DiscoverScreen to boost CA-pickup products in "Recommended" sort.
 * Returns empty set on any error — callers degrade gracefully.
 */
export async function fetchCaAvailableProductIds(): Promise<Set<string>> {
  if (!supabaseConfigured) return new Set();

  const { data, error } = await supabase
    .from('inventory_cache')
    .select('product_id')
    .eq('warehouse_state', 'CA')
    .eq('is_available', true)
    .eq('sync_status', 'ok');

  if (error) {
    console.log('[InventoryCache] CA availability query error:', error.message);
    return new Set();
  }

  return new Set((data ?? []).map(r => r.product_id as string));
}
