import { supabase } from '../lib/supabase';

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
export async function fetchSkuWarehouseStock(skus: string[]): Promise<SkuInventory[]> {
  if (skus.length === 0) return [];

  console.log('[GigaInventory] Fetching warehouse stock for', skus.length, 'SKU(s):', skus);

  const { data, error } = await supabase.functions.invoke('giga-warehouse-stock', {
    body: { skus },
  });

  if (error) {
    throw new Error(`[GigaInventory] Edge function error: ${error.message}`);
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

  return result;
}
