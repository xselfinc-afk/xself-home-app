import type { SupabaseClient } from '@supabase/supabase-js';
import {
  gigaRequest,
  fetchProductDetails,
  fetchProductPrices,
  fetchNewArrivalSkuList,
} from './gigaApiClient';

type SupplierApiItem = {
  sku?: string;
  id?: string | number;
  skuId?: string | number;
  productId?: string | number;

  title?: string;
  productName?: string;
  skuName?: string;

  description?: string | null;
  characteristics?: string[];

  price?: number | string;
  salePrice?: number | string;
  minPrice?: number | string;
  maxPrice?: number | string;
  cost?: number | string;
  costPrice?: number | string;
  discountedPrice?: number | string;
  exclusivePrice?: number | string;
  spotPrice?: Array<{
    price?: number | string;
    discountedPrice?: number | string;
    exclusivePrice?: number | string;
    [key: string]: unknown;
  }>;

  images?: string[];
  imageList?: string[];
  imageUrls?: string[];
  mainImage?: string;
  image?: string;
  mainImageUrl?: string;

  stock?: number | string;
  inventory?: number | string;
  skuAvailable?: boolean;

  warehouse_address?: string | null;
  warehouseAddress?: string | null;

  [key: string]: unknown;
};

type SupplierProductRow = {
  supplier_product_id: string;
  title: string;
  description: string | null;
  price: number;
  images: string[];
  inventory: number;
  pickup_address: string | null;
  raw_payload: unknown;
};

export type SyncResult = {
  fetched: number;
  upserted: number;
};

function cleanHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeSupplierItem(item: SupplierApiItem): SupplierProductRow {
  const supplierProductId =
    item.sku ??
    item.skuId ??
    item.id ??
    item.productId ??
    '';

  const title =
    item.title ??
    item.productName ??
    item.skuName ??
    '';

  const descriptionRaw =
    typeof item.description === 'string' && item.description.trim()
      ? cleanHtml(item.description)
      : Array.isArray(item.characteristics) && item.characteristics.length > 0
        ? item.characteristics.map(text => cleanHtml(String(text))).join('\n')
        : null;

  const priceRaw =
    item.price ??
    item.discountedPrice ??
    item.exclusivePrice ??
    item.salePrice ??
    item.minPrice ??
    item.maxPrice ??
    item.cost ??
    item.costPrice ??
    (Array.isArray(item.spotPrice) && item.spotPrice.length > 0
      ? item.spotPrice[0]?.price ??
        item.spotPrice[0]?.discountedPrice ??
        item.spotPrice[0]?.exclusivePrice
      : undefined) ??
    0;

  const imagesRaw =
    item.images ??
    item.imageList ??
    item.imageUrls ??
    item.mainImage ??
    item.image ??
    item.mainImageUrl ??
    [];

  const inventoryRaw =
    item.stock ??
    item.inventory ??
    (item.skuAvailable ? 1 : 0);

  const pickupAddress =
    item.warehouse_address ??
    item.warehouseAddress ??
    null;

  return {
    supplier_product_id: String(supplierProductId),
    title: String(title),
    description: descriptionRaw,
    price: Number(priceRaw || 0),
    images: Array.isArray(imagesRaw)
      ? imagesRaw.map(String)
      : imagesRaw
        ? [String(imagesRaw)]
        : [],
    inventory: Number(inventoryRaw || 0),
    pickup_address: pickupAddress ? String(pickupAddress) : null,
    raw_payload: item,
  };
}

export async function upsertPickupProducts(
  supabase: SupabaseClient,
  items: SupplierApiItem[],
): Promise<SyncResult> {
  const uniqueMap = new Map<string, SupplierApiItem>();

  for (const item of items) {
    const key = String(item.sku ?? item.skuId ?? item.id ?? '');
    if (key) {
      uniqueMap.set(key, item);
    }
  }

  const uniqueItems = Array.from(uniqueMap.values());
  const rows: SupplierProductRow[] = uniqueItems.map(normalizeSupplierItem);

  const { error, count } = await supabase
    .from('supplier_products')
    .upsert(rows, {
      onConflict: 'supplier_product_id',
      count: 'exact',
    });

  if (error) {
    throw new Error(`[SupplierSync] Upsert failed: ${error.message}`);
  }

  const upserted = count ?? rows.length;

  console.log(`[SupplierSync] Upserted ${upserted} products into supplier_products`);

  return {
    fetched: items.length,
    upserted,
  };
}

// GIGA "Product List Query" — returns the buyer's full "My Saved Items" list.
// Note: this endpoint exposes NO favorite filter (only time/sort params), so it
// returns ALL saved items, not the website's "Favorite" sub-tab.
const SAVED_ITEMS_PATH = '/b2b-overseas-api/v1/buyer/product/skus/v1';

// Documented pageSize range for the list query is min 100 / max 10000
// (default 5000 when blank). 500 keeps each page reasonable while we paginate.
const SAVED_ITEMS_PAGE_SIZE = 500;

// The detail + price endpoints cap each request at 200 SKUs (OpenAPI doc).
// Enrichment is therefore chunked so a large saved-items list never exceeds it.
const ENRICH_BATCH_SIZE = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function syncPickupProducts(
  supabase: SupabaseClient,
): Promise<SyncResult> {
  console.log('[SupplierSync] Fetching products from GIGA Product List Query (My Saved Items — all pages)');

  // ── 1. Page through ALL saved items (previously capped at the first 100) ──
  const items: SupplierApiItem[] = [];
  let page = 1;
  let totalPages = 1;
  let serverTotal: number | null = null;

  do {
    const res = await gigaRequest(SAVED_ITEMS_PATH, { page, pageSize: SAVED_ITEMS_PAGE_SIZE });
    const data = (res && res.data) ? res.data : {};
    const pageInfo = data.pageInfo ?? {};
    totalPages = Number(pageInfo.totalPage ?? pageInfo.totalPages ?? 1) || 1;
    const reported = Number(pageInfo.total ?? pageInfo.totalCount ?? data.total ?? data.totalCount);
    if (Number.isFinite(reported)) serverTotal = reported;
    const records: SupplierApiItem[] = Array.isArray(data.records)
      ? data.records
      : (Array.isArray(data.list) ? data.list : []);
    items.push(...records);
    console.log(
      `[SupplierSync] Page ${page}/${totalPages} — pageSize=${SAVED_ITEMS_PAGE_SIZE} — ${records.length} records ` +
      `(cumulative ${items.length}${serverTotal != null ? '/' + serverTotal : ''})`,
    );
    page += 1;
  } while (page <= totalPages);

  console.log(
    `[SupplierSync] Saved-items list complete — fetched ${items.length} SKUs across ${totalPages} page(s)` +
    `${serverTotal != null ? ` (server total=${serverTotal})` : ''}`,
  );

  const skuList = items.map(item => item.sku).filter(Boolean).map(String);

  // ── 2. Enrich with detail + price in ≤200-SKU batches (per-call API cap) ──
  const batches = chunk(skuList, ENRICH_BATCH_SIZE);
  console.log(`[SupplierSync] Enriching ${skuList.length} SKUs in ${batches.length} batch(es) of ≤${ENRICH_BATCH_SIZE}`);

  const detailItems: SupplierApiItem[] = [];
  const priceItems: SupplierApiItem[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    const detailRes = await fetchProductDetails(batch);
    const dItems =
      detailRes?.data?.records ||
      detailRes?.data?.list ||
      detailRes?.data?.items ||
      detailRes?.data ||
      [];
    if (Array.isArray(dItems)) detailItems.push(...dItems);

    const priceRes = await fetchProductPrices(batch);
    const pItems =
      priceRes?.data?.records ||
      priceRes?.data?.list ||
      priceRes?.data?.items ||
      priceRes?.data ||
      [];
    if (Array.isArray(pItems)) priceItems.push(...pItems);

    console.log(
      `[SupplierSync] Batch ${b + 1}/${batches.length} — skus=${batch.length} ` +
      `details=${Array.isArray(dItems) ? dItems.length : 'non-array'} ` +
      `prices=${Array.isArray(pItems) ? pItems.length : 'non-array'}`,
    );
  }

  // ── 3. Merge listing + detail + price by SKU (semantics unchanged) ────────
  const priceMap = new Map<string, SupplierApiItem>();
  for (const item of priceItems) {
    const key = String(item.sku ?? item.skuId ?? item.id ?? '');
    if (key) priceMap.set(key, item);
  }

  // Build SKU list map so firstArrivalDate/addedTime/updateTime are preserved in raw_payload
  const skuListMap = new Map<string, SupplierApiItem>();
  for (const item of items) {
    const key = String(item.sku ?? item.skuId ?? item.id ?? '');
    if (key) skuListMap.set(key, item);
  }

  const mergedItems: SupplierApiItem[] = detailItems.map((detailItem: SupplierApiItem) => {
    const key = String(detailItem.sku ?? detailItem.skuId ?? detailItem.id ?? '');
    const skuListItem = skuListMap.get(key) ?? {};
    const priceItem = priceMap.get(key) ?? {};
    // skuListItem spread first so detail/price fields win on conflict
    return { ...skuListItem, ...detailItem, ...priceItem };
  });

  console.log(
    `[SupplierSync] Merged ${mergedItems.length} items ready for upsert ` +
    `(saved-items fetched=${items.length}, detail records=${detailItems.length}, price records=${priceItems.length})`,
  );

  return upsertPickupProducts(supabase, mergedItems);
}

/**
 * Fetch all pages of the supplier's "New Arrivals" SKU list,
 * enrich with details + prices, and upsert into supplier_products
 * with isNewArrival=true stamped in raw_payload.
 *
 * Products not already in the DB are inserted; existing ones are updated.
 * The normalization pipeline reads isNewArrival from raw_payload (Tier 1).
 */
export async function syncNewArrivalProducts(
  supabase: SupabaseClient,
): Promise<SyncResult> {
  console.log('[NewArrivalSync] Fetching supplier new arrivals (all pages)');

  // Collect all new-arrival SKUs across pages
  const allItems: SupplierApiItem[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const res = await fetchNewArrivalSkuList(page);
    const pageInfo = res?.data?.pageInfo ?? {};
    totalPages = Number(pageInfo.totalPage ?? 1);
    const records: SupplierApiItem[] = res?.data?.records ?? [];
    console.log(`[NewArrivalSync] Page ${page}/${totalPages} — ${records.length} records`);
    allItems.push(...records);
    page += 1;
  } while (page <= totalPages);

  console.log('[NewArrivalSync] Total new arrival SKUs from supplier:', allItems.length);

  const skuList = allItems.map(item => item.sku).filter(Boolean).map(String);

  const detailRes = await fetchProductDetails(skuList);
  const detailItems: SupplierApiItem[] = detailRes?.data?.records ?? detailRes?.data?.list ?? detailRes?.data ?? [];

  const priceRes = await fetchProductPrices(skuList);
  const priceItems: SupplierApiItem[] = priceRes?.data?.records ?? priceRes?.data?.list ?? priceRes?.data ?? [];

  const skuListMap = new Map<string, SupplierApiItem>();
  for (const item of allItems) {
    const key = String(item.sku ?? '');
    if (key) skuListMap.set(key, item);
  }

  const priceMap = new Map<string, SupplierApiItem>();
  for (const item of priceItems) {
    const key = String(item.sku ?? item.skuId ?? item.id ?? '');
    if (key) priceMap.set(key, item);
  }

  const mergedItems: SupplierApiItem[] = detailItems.map((detailItem: SupplierApiItem) => {
    const key = String(detailItem.sku ?? detailItem.skuId ?? detailItem.id ?? '');
    const skuListItem = skuListMap.get(key) ?? {};
    const priceItem = priceMap.get(key) ?? {};
    return {
      ...skuListItem,
      ...detailItem,
      ...priceItem,
      isNewArrival: true,           // explicit flag — triggers Tier 1 in assignNewArrival()
      new_arrival_source: 'supplier_page',
    };
  });

  console.log('[NewArrivalSync] Merged items ready for upsert:', mergedItems.length);

  return upsertPickupProducts(supabase, mergedItems);
}