// Deno-compatible XHR fetcher for GIGA per-warehouse inventory.
// Ported from scripts/fetchGigaWarehouseInventoryFromXhr.ts.
//
// Session cookies come from the Supabase Edge Function secret GIGA_SESSION_JSON
// (Playwright storageState JSON). Only cookies whose domain matches gigab2b.com
// are used; the gmd_device_id cookie value, if present, is also forwarded as the
// x-gmd-device-id header.
//
// Public surface:
//   loadSessionFromEnv()       — reads GIGA_SESSION_JSON, returns SessionContext or null
//   resolveProductId(idOrSku)  — alphanumeric SKU → numeric product_id
//   fetchWarehouseRows(pid)    — per-warehouse exact qty rows for a numeric product_id

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Warehouse helpers (mirror src/data/warehouses.ts) ────────────────────────
export function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}
export function supportsPickup(code: string): boolean {
  return warehouseState(code) === 'CA';
}

// ── Session ──────────────────────────────────────────────────────────────────
interface SessionCookie { name: string; value: string; domain: string; path?: string }
export interface SessionContext { cookieHeader: string; deviceId: string | null }

export function loadSessionFromEnv(): SessionContext | null {
  const raw = Deno.env.get('GIGA_SESSION_JSON');
  if (!raw) {
    console.log('[xhr] GIGA_SESSION_JSON not set — XHR path disabled');
    return null;
  }
  let parsed: { cookies?: SessionCookie[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.log('[xhr] GIGA_SESSION_JSON parse error:', (err as Error).message);
    return null;
  }
  const all = parsed.cookies ?? [];
  const gigaCookies = all.filter(c => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (gigaCookies.length === 0) {
    console.log('[xhr] No gigab2b.com cookies in GIGA_SESSION_JSON');
    return null;
  }
  const device = all.find(c => c.name === 'gmd_device_id');
  return {
    cookieHeader: gigaCookies.map(c => `${c.name}=${c.value}`).join('; '),
    deviceId: device ? device.value : null,
  };
}

function xhrHeaders(productId: string, session: SessionContext): Record<string, string> {
  const h: Record<string, string> = {
    'cookie':              session.cookieHeader,
    'user-agent':          USER_AGENT,
    'accept':              'application/json, text/javascript, */*; q=0.01',
    'accept-language':     'en-US,en;q=0.9',
    'x-requested-with':    'XMLHttpRequest',
    'referer':             `https://www.gigab2b.com/index.php?route=product/product&product_id=${productId}`,
    'sec-ch-ua':           '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':    '?0',
    'sec-ch-ua-platform':  '"macOS"',
    'sec-fetch-dest':      'empty',
    'sec-fetch-mode':      'cors',
    'sec-fetch-site':      'same-origin',
  };
  if (session.deviceId) h['x-gmd-device-id'] = session.deviceId;
  return h;
}

// ── Types ────────────────────────────────────────────────────────────────────
interface WarehouseDistributionRow {
  qty: number;
  wh_id: number;
  warehouse_code: string;
}

interface PriceWarehouseResponse {
  code: number;
  msg?: string;
  data?: {
    stock_distributions?: WarehouseDistributionRow[];
    out_cloud?: unknown;
  };
}

interface BaseInfosResponse {
  code: number;
  msg?: string;
  data?: { product_info?: { sku?: string; product_name?: string } };
}

export interface NormalizedRow {
  product_id: string;
  supplier_product_id: string;
  warehouse_code: string;
  warehouse_state: string | null;
  quantity: number;
  quantity_raw: string;
  quantity_exact: boolean;
  is_available: boolean;
  supports_pickup: boolean;
  supports_shipping: boolean;
  source_type: 'website_scrape';
  sync_status: 'ok';
  last_synced_at: string;
  total_available: number;
}

// ── Endpoint calls ───────────────────────────────────────────────────────────
async function callJson<T>(
  url: string,
  productIdForReferer: string,
  session: SessionContext,
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: xhrHeaders(productIdForReferer, session),
      redirect: 'follow',
    });
  } catch (err) {
    console.log('[xhr] GET threw:', (err as Error).message);
    return null;
  }
  const text = await res.text();
  try { return JSON.parse(text) as T; } catch { return null; }
}

async function fetchBaseInfos(productId: string, session: SessionContext): Promise<BaseInfosResponse | null> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/info/baseInfos&product_id=${productId}`;
  return callJson<BaseInfosResponse>(url, productId, session);
}

async function fetchPriceWarehouse(productId: string, session: SessionContext): Promise<PriceWarehouseResponse | null> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/price/warehouse&product_id=${productId}`;
  return callJson<PriceWarehouseResponse>(url, productId, session);
}

async function searchForProductId(sku: string, session: SessionContext): Promise<string | null> {
  const url = 'https://www.gigab2b.com/index.php?route=/product/list/search';
  const body = JSON.stringify({
    page: 1, limit: 50, dimension_type: 1, scene: 1,
    search: sku, sort: '', order: '',
  });
  const headers: Record<string, string> = {
    'cookie':              session.cookieHeader,
    'user-agent':          USER_AGENT,
    'accept':              'application/json, text/javascript, */*; q=0.01',
    'content-type':        'application/json;charset=UTF-8',
    'x-requested-with':    'XMLHttpRequest',
    'origin':              'https://www.gigab2b.com',
    'referer':             `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(sku)}`,
    'sec-fetch-dest':      'empty',
    'sec-fetch-mode':      'cors',
    'sec-fetch-site':      'same-origin',
    'ori-status-in-response': 'code',
  };
  if (session.deviceId) headers['x-gmd-device-id'] = session.deviceId;

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body, redirect: 'follow' });
  } catch (err) {
    console.log('[xhr] search POST threw:', (err as Error).message);
    return null;
  }
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { code?: number; data?: { product_list?: unknown } };
    const arr = j?.data?.product_list;
    if (Array.isArray(arr) && arr.length > 0) return String(arr[0]);
  } catch { /* fall through */ }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function resolveProductId(
  idOrSku: string,
  session: SessionContext,
): Promise<{ productId: string; sku: string | null } | null> {
  if (/^\d+$/.test(idOrSku)) {
    return { productId: idOrSku, sku: null };
  }
  const numeric = await searchForProductId(idOrSku, session);
  if (!numeric) {
    console.log(`[xhr] resolveProductId("${idOrSku}") — search returned no product_list`);
    return null;
  }
  return { productId: numeric, sku: idOrSku };
}

export async function fetchWarehouseRows(
  productId: string,
  knownSku: string | null,
  session: SessionContext,
): Promise<{ rows: NormalizedRow[]; supplierId: string | null; total: number }> {
  let supplierId = knownSku ?? null;
  if (!supplierId) {
    const base = await fetchBaseInfos(productId, session);
    supplierId = base?.data?.product_info?.sku ?? null;
  }

  const wh = await fetchPriceWarehouse(productId, session);
  const dists = wh?.data?.stock_distributions ?? [];

  const now = new Date().toISOString();
  const total = dists.reduce((s, d) => s + (Number(d.qty) || 0), 0);

  const rows: NormalizedRow[] = supplierId
    ? dists.map(d => ({
        product_id:          supplierId!,
        supplier_product_id: supplierId!,
        warehouse_code:      String(d.warehouse_code).toUpperCase(),
        warehouse_state:     warehouseState(d.warehouse_code),
        quantity:            Number(d.qty),
        quantity_raw:        String(d.qty),
        quantity_exact:      true,
        is_available:        Number(d.qty) > 0,
        supports_pickup:     supportsPickup(d.warehouse_code),
        supports_shipping:   !supportsPickup(d.warehouse_code),
        source_type:         'website_scrape',
        sync_status:         'ok',
        last_synced_at:      now,
        total_available:     total,
      }))
    : [];

  return { rows, supplierId, total };
}
