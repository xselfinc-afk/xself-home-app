import { supabase, supabaseConfigured } from '../lib/supabase';

export type WarehouseStockEntry = {
  warehouseCode: string;
  availableQty: number;
};

export type SkuInventory = {
  sku: string;
  warehouseStock: WarehouseStockEntry[];
};

/**
 * Fetch warehouse-level stock for a list of SKUs.
 * Signing happens server-side in the giga-warehouse-stock Edge Function.
 */
export type WarehouseStockResult = { inventory: SkuInventory[]; stale: boolean };

export async function fetchSkuWarehouseStock(skus: string[]): Promise<WarehouseStockResult> {
  if (skus.length === 0) return { inventory: [], stale: false };

  console.log('[GigaInventory] Fetching warehouse stock for', skus.length, 'SKU(s):', skus);

  if (!supabaseConfigured) {
    throw new Error('[GigaInventory] Supabase not configured — set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY');
  }

  const { data, error } = await supabase.functions.invoke('giga-warehouse-stock', {
    body: { skus },
  });

  if (error) {
    // FunctionsHttpError.context is the raw Response — read body for the real reason
    let detail = '';
    try {
      const body = await (error as any).context?.json?.();
      detail = body?.error ? ` — ${body.error}` : '';
    } catch { /* response body not JSON or already consumed */ }
    throw new Error(`[GigaInventory] Edge function error: ${error.message}${detail}`);
  }

  console.log('[GigaInventory] Raw response data:', JSON.stringify(data).slice(0, 500));

  // Response shape: { data: [ { sku, warehouseStockList: [ { warehouseCode, availableQty } ] } ] }
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];

  const result: SkuInventory[] = rows.map((row: any) => ({
    sku: String(row.sku ?? ''),
    warehouseStock: Array.isArray(row.warehouseStockList)
      ? row.warehouseStockList.map((w: any) => ({
          warehouseCode: String(w.warehouseCode ?? ''),
          availableQty: Number(w.availableQty ?? w.stockQty ?? 0),
        }))
      : [],
  }));

  console.log(
    '[GigaInventory] Parsed',
    result.length,
    'SKU(s):',
    result.map(r => `${r.sku}:[${r.warehouseStock.map(w => `${w.warehouseCode}×${w.availableQty}`).join(',')}]`).join(' | '),
  );

  return { inventory: result, stale: Boolean(data?.stale) };
}
