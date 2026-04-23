import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const BASE_URL = Deno.env.get('SUPPLIER_API_BASE_URL') ?? '';
const CLIENT_ID = Deno.env.get('SUPPLIER_CLIENT_ID') ?? '';
const CLIENT_SECRET = Deno.env.get('SUPPLIER_CLIENT_SECRET') ?? '';

// Built-in Supabase env vars — always available in Edge Functions
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

// Price endpoint — confirmed working when available, returns skuAvailable per SKU.
const PRICE_PATH = '/b2b-overseas-api/v1/buyer/product/price/v1';

// Accept cache entries up to 1 hour old as "fresh"; up to 24 h as "stale last resort".
const CACHE_TTL_MINUTES = 60;
const STALE_TTL_MINUTES = 24 * 60;

// All GIGA US warehouse codes (mirrors src/data/warehouses.ts).
// Used to synthesize warehouseStockList from the binary skuAvailable signal.
const WAREHOUSE_CODES = [
  'CA2','CA3','CA4','CA5','CA6','CA7','CA8','CA9','CA10','CA11',
  'CAN1','CAX1','CAN2','CAN3','CAX2','CAX8','CAX3','CAL1',
  'NJ1','NJ2','NJ3','NJ4','NJX3',
  'AT1','AT2','AT3','AT4','AT5','ATX4','ATX6','ATN1',
  'TX1','TXX1','TXX2',
];

// ── Auth helpers ───────────────────────────────────────────────────────────────

function generateNonce(length = 10): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

async function hmacSha256Hex(message: string, key: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function generateSign(path: string, timestamp: string, nonce: string): Promise<string> {
  const msg = `${CLIENT_ID}&${path}&${timestamp}&${nonce}`;
  const key = `${CLIENT_ID}&${CLIENT_SECRET}&${nonce}`;
  const hex = await hmacSha256Hex(msg, key);
  return btoa(hex);
}

// ── CORS ───────────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ──────────────────────────────────────────────────────────────────────

type StockEntry = { warehouseCode: string; availableQty: number };
type SkuStockRow = { sku: string; warehouseStockList: StockEntry[] };

// ── Cache lookup ───────────────────────────────────────────────────────────────
//
// Two lookup strategies — tried in order:
//
//   A. Direct lookup: inventory_cache.product_id matches the alphanumeric SKU directly.
//      This covers entries written by the frontend via inventoryCacheService (from previous
//      successful GIGA API responses).
//
//   B. Bridge lookup: resolve alphanumeric SKU → numeric product_id via
//      giga_products.item_code, then query inventory_cache with numeric IDs.
//      This covers entries written by the Playwright scraper (scrapeGigaInventory /
//      syncGigaFurnitureInventory), which stores the numeric URL product_id as the key.
//
// Returns null when no entries are found (triggers API / stale-cache fallback).
//
async function tryInventoryCache(
  skus: string[],
  maxAgeMinutes: number,
): Promise<SkuStockRow[] | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || skus.length === 0) return null;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();

  // ── Strategy A: direct alphanumeric lookup ───────────────────────────────────
  const directResult = await queryInventoryCacheDirect(supabase, skus, cutoff);
  if (directResult !== null) {
    console.log('[Cache] Served via direct lookup, age≤', maxAgeMinutes, 'min');
    return directResult;
  }

  // ── Strategy B: bridge through giga_products.item_code ─────────────────────
  const bridgeResult = await queryInventoryCacheViaBridge(supabase, skus, cutoff);
  if (bridgeResult !== null) {
    console.log('[Cache] Served via giga_products bridge, age≤', maxAgeMinutes, 'min');
    return bridgeResult;
  }

  return null;
}

/** Strategy A: inventory_cache.product_id = alphanumeric SKU */
async function queryInventoryCacheDirect(
  supabase: ReturnType<typeof createClient>,
  skus: string[],
  cutoff: string,
): Promise<SkuStockRow[] | null> {
  const { data, error } = await supabase
    .from('inventory_cache')
    .select('product_id, warehouse_code, quantity, is_available')
    .in('product_id', skus)
    .eq('sync_status', 'ok')
    .gte('last_synced_at', cutoff);

  if (error || !data || data.length === 0) return null;

  // All requested SKUs must be present
  const grouped = groupByProductId(data);
  return buildResponse(skus, (sku) => grouped.get(sku) ?? null);
}

/** Strategy B: giga_products.item_code → numeric product_id → inventory_cache */
async function queryInventoryCacheViaBridge(
  supabase: ReturnType<typeof createClient>,
  skus: string[],
  cutoff: string,
): Promise<SkuStockRow[] | null> {
  // Step 1: resolve item_code → product_id (numeric)
  const { data: gigaRows, error: gigaErr } = await supabase
    .from('giga_products')
    .select('product_id, item_code')
    .in('item_code', skus);

  if (gigaErr || !gigaRows || gigaRows.length === 0) {
    console.log('[Cache] No giga_products rows for item_codes:', skus.join(','));
    return null;
  }

  // Build forward map: item_code → numeric product_id
  const numericIdByItemCode = new Map<string, string>(
    gigaRows.map(r => [r.item_code as string, r.product_id as string]),
  );

  const numericIds = gigaRows.map(r => r.product_id as string);

  // Step 2: query inventory_cache with numeric product_ids
  const { data: cacheRows, error: cacheErr } = await supabase
    .from('inventory_cache')
    .select('product_id, warehouse_code, quantity, is_available')
    .in('product_id', numericIds)
    .eq('sync_status', 'ok')
    .gte('last_synced_at', cutoff);

  if (cacheErr || !cacheRows || cacheRows.length === 0) {
    console.log('[Cache] No inventory_cache rows for product_ids:', numericIds.join(','));
    return null;
  }

  const grouped = groupByProductId(cacheRows);

  // Map back: resolve the original alphanumeric SKU → stock list via numeric id
  return buildResponse(skus, (sku) => {
    const numericId = numericIdByItemCode.get(sku);
    if (!numericId) return null;
    return grouped.get(numericId) ?? null;
  });
}

function groupByProductId(
  rows: { product_id: string; warehouse_code: string; quantity: number | null; is_available: boolean }[],
): Map<string, StockEntry[]> {
  const grouped = new Map<string, StockEntry[]>();
  for (const row of rows) {
    if (!grouped.has(row.product_id)) grouped.set(row.product_id, []);
    grouped.get(row.product_id)!.push({
      warehouseCode: row.warehouse_code,
      availableQty: row.is_available ? (row.quantity ?? 0) : 0,
    });
  }
  return grouped;
}

/**
 * Build the final SkuStockRow[] response.
 * Returns null if any requested SKU is missing from the cache.
 */
function buildResponse(
  skus: string[],
  getStock: (sku: string) => StockEntry[] | null,
): SkuStockRow[] | null {
  const result: SkuStockRow[] = [];
  for (const sku of skus) {
    const warehouseStockList = getStock(sku);
    if (!warehouseStockList) return null; // incomplete — fall through to next strategy
    result.push({ sku, warehouseStockList });
  }
  return result;
}

// ── GIGA price API ─────────────────────────────────────────────────────────────

async function fetchFromGigaApi(skus: string[]): Promise<SkuStockRow[] | null> {
  if (!BASE_URL || !CLIENT_ID || !CLIENT_SECRET) return null;

  const timestamp = Date.now().toString();
  const nonce = generateNonce();
  const sign = await generateSign(PRICE_PATH, timestamp, nonce);

  const upstreamUrl = `${BASE_URL}${PRICE_PATH}`;
  console.log('[GIGA] upstream URL:', upstreamUrl);
  console.log('[GIGA] upstream body:', JSON.stringify({ skus }));

  let res: Response;
  try {
    res = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-id': CLIENT_ID,
        timestamp,
        nonce,
        sign,
      },
      body: JSON.stringify({ skus }),
    });
  } catch (fetchErr) {
    console.log('[GIGA] fetch threw:', (fetchErr as Error).message);
    return null;
  }

  const rawText = await res.text();
  console.log('[GIGA] upstream status:', res.status);
  console.log('[GIGA] upstream raw response:', rawText.slice(0, 1000));

  if (!res.ok) {
    console.log('[GIGA] API returned non-2xx:', res.status);
    return null;
  }

  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.log('[GIGA] API returned non-JSON');
    return null;
  }

  const gigaData = data as Record<string, unknown>;
  if (String(gigaData?.code) !== '200') {
    console.log('[GIGA] business error code:', gigaData?.code, 'msg:', gigaData?.msg);
    return null;
  }

  const priceRows: unknown[] = Array.isArray(gigaData?.data) ? (gigaData.data as unknown[]) : [];

  const synthesized: SkuStockRow[] = priceRows.map((item) => {
    const row = item as Record<string, unknown>;
    const sku = String(row.sku ?? '');
    const available = Boolean(row.skuAvailable);
    const qty = available ? 999 : 0;
    console.log(`[GIGA] sku=${sku} skuAvailable=${available} → qty=${qty}`);
    return {
      sku,
      warehouseStockList: WAREHOUSE_CODES.map(code => ({
        warehouseCode: code,
        availableQty: qty,
      })),
    };
  });

  console.log('[GIGA] synthesized warehouseStockList for', synthesized.length, 'SKU(s)');
  return synthesized;
}

// ── Server-side cache write (service role — bypasses RLS) ──────────────────────
//
// Called fire-and-forget after a successful GIGA API response.
// Writes one row per (sku, warehouseCode) so future requests are served from
// cache without hitting the upstream API.
//
async function writeToCacheAsync(rows: SkuStockRow[]): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || rows.length === 0) return;

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date().toISOString();
  const cacheRows = rows.flatMap(row =>
    row.warehouseStockList.map(ws => ({
      product_id:          row.sku,
      supplier_product_id: row.sku,
      warehouse_code:      ws.warehouseCode,
      warehouse_state:     warehouseState(ws.warehouseCode),
      quantity:            ws.availableQty,
      is_available:        ws.availableQty > 0,
      supports_pickup:     supportsPickup(ws.warehouseCode),
      supports_shipping:   true,
      last_synced_at:      now,
      sync_status:         'ok',
      source_type:         'price_synthesis',
    }))
  );

  const { error } = await supabase
    .from('inventory_cache')
    .upsert(cacheRows, { onConflict: 'product_id,warehouse_code' });

  if (error) {
    console.log('[Cache] Write error (non-fatal):', error.message);
  } else {
    console.log('[Cache] Wrote', cacheRows.length, 'row(s) for', rows.length, 'SKU(s)');
  }
}

function warehouseState(code: string): string | null {
  if (/^CA/i.test(code)) return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code)) return 'NJ';
  if (/^AT/i.test(code)) return 'GA';
  if (/^TX/i.test(code)) return 'TX';
  return null;
}

function supportsPickup(code: string): boolean {
  return warehouseState(code) === 'CA';
}

// ── Main handler ───────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { skus } = await req.json() as { skus: string[] };

    if (!Array.isArray(skus) || skus.length === 0) {
      return new Response(
        JSON.stringify({ error: 'skus array is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    console.log('[GIGA] Request for', skus.length, 'SKU(s):', skus.join(', '));

    // ── 1. Fresh cache (direct or via giga_products bridge) ────────────────────
    const freshCache = await tryInventoryCache(skus, CACHE_TTL_MINUTES);
    if (freshCache) {
      console.log('[GIGA] Returning fresh cache for', freshCache.length, 'SKU(s)');
      return new Response(
        JSON.stringify({ data: freshCache }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 2. Live GIGA price API ─────────────────────────────────────────────────
    const apiResult = await fetchFromGigaApi(skus);
    if (apiResult) {
      console.log('[GIGA] Returning live API result for', apiResult.length, 'SKU(s)');
      // Write to cache server-side (service role — bypasses RLS). Fire and forget.
      writeToCacheAsync(apiResult).catch(e =>
        console.log('[Cache] Background write failed:', (e as Error).message),
      );
      return new Response(
        JSON.stringify({ data: apiResult }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 3. Stale cache fallback (accept up to 24 h old) ────────────────────────
    const staleCache = await tryInventoryCache(skus, STALE_TTL_MINUTES);
    if (staleCache) {
      console.log('[GIGA] Returning stale cache (API failed) for', staleCache.length, 'SKU(s)');
      return new Response(
        JSON.stringify({ data: staleCache, stale: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // ── 4. Complete failure ────────────────────────────────────────────────────
    console.log('[GIGA] All sources failed for SKUs:', skus.join(', '));
    return new Response(
      JSON.stringify({
        error: 'Inventory data unavailable — live API failed and no cached data found',
        errorType: 'inventory_failed',
      }),
      { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log('[GIGA] Unhandled error:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
