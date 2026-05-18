/**
 * Fetch GIGA per-warehouse inventory directly from the authenticated XHR
 * discovered by scripts/discoverGigaWarehouseXhr.ts.
 *
 * Endpoint (GET, JSON):
 *   https://www.gigab2b.com/index.php?route=/product/info/price/warehouse&product_id=<numeric>
 *
 * Response shape (only the fields we read):
 *   {
 *     "code": 200,
 *     "data": {
 *       "stock_distributions": [
 *         { "qty": 16, "wh_id": 1480, "warehouse_code": "AT4" }, ...
 *       ],
 *       "out_cloud": { ... }   // CLOUD-FEE branch — NOT inventory, ignored
 *     }
 *   }
 *
 * For each product we also call baseInfos to recover the supplier_product_id
 * (the SKU like "W409P327406"), since the warehouse XHR alone identifies the
 * product only by numeric id.
 *
 * Run:
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromXhr.ts --product-id 1064421
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromXhr.ts --sku W409P327406
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromXhr.ts --products 1064421,670347,W331P242454
 *
 * Env:
 *   GIGA_SESSION_FILE — Playwright storageState path (default: scripts/.giga-session.json)
 *   GIGA_USER_AGENT   — UA override
 *   INTER_REQ_DELAY   — ms between products (default: 600)
 *
 * Exports (used by syncGigaInventoryHttp.ts):
 *   - resolveProductId(idOrSku): Promise<{ productId, sku }>
 *   - fetchWarehouseRows(productId, sku?): Promise<NormalizedRow[]>
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');

const USER_AGENT = process.env.GIGA_USER_AGENT
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const INTER_REQ_DELAY = Number(process.env.INTER_REQ_DELAY ?? 600);

// ── Warehouse helpers (same shape as the existing scraper) ──────────────────
function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}
function supportsPickup(code: string): boolean { return warehouseState(code) === 'CA'; }

// ── Session cookies → Cookie header ─────────────────────────────────────────
interface SessionCookie { name: string; value: string; domain: string; path?: string; }

interface SessionContext {
  cookieHeader: string;
  deviceId: string | null;
}

function loadSession(): SessionContext {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Session file not found: ${SESSION_FILE} — run: npm run inventory:save-session`);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { cookies?: SessionCookie[] };
  const all = raw.cookies ?? [];
  const cookies = all.filter(c => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (cookies.length === 0) throw new Error('No gigab2b.com cookies in session file.');
  const device = all.find(c => c.name === 'gmd_device_id');
  return {
    cookieHeader: cookies.map(c => `${c.name}=${c.value}`).join('; '),
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

// ── Types ───────────────────────────────────────────────────────────────────

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
    // out_cloud is the cloud-fee fulfillment branch. We intentionally do NOT
    // read inventory from it — that's "shipping option" data, not stock.
    out_cloud?: unknown;
  };
}

interface BaseInfosResponse {
  code: number;
  msg?: string;
  data?: {
    product_info?: {
      sku?: string;
      product_name?: string;
    };
  };
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

// ── Endpoint calls ──────────────────────────────────────────────────────────

async function callJson<T>(url: string, productIdForReferer: string, session: SessionContext): Promise<{ status: number; json: T | null; text: string }> {
  const res = await fetch(url, {
    method: 'GET',
    headers: xhrHeaders(productIdForReferer, session),
    redirect: 'follow',
  });
  const text = await res.text();
  let json: T | null = null;
  try { json = JSON.parse(text) as T; } catch { /* leave null */ }
  return { status: res.status, json, text };
}

async function fetchBaseInfos(productId: string, session: SessionContext): Promise<BaseInfosResponse | null> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/info/baseInfos&product_id=${productId}`;
  const { json } = await callJson<BaseInfosResponse>(url, productId, session);
  return json;
}

async function fetchPriceWarehouse(productId: string, session: SessionContext): Promise<PriceWarehouseResponse | null> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/price/warehouse&product_id=${productId}`;
  const { json } = await callJson<PriceWarehouseResponse>(url, productId, session);
  return json;
}

/**
 * Resolve a SKU (W409P327406) → numeric product_id via the JSON XHR the
 * seller-portal search box uses internally:
 *
 *   POST /product/list/search
 *   body: {"page":1,"limit":50,"dimension_type":1,"scene":1,"search":"<sku>","sort":"","order":""}
 *   → data.product_list = [<numeric_pid>]
 *
 * We previously used the HTML /product/search page, but that returns SPA-only
 * markup with no usable links. The XHR returns the numeric id directly.
 */
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

  const res = await fetch(url, { method: 'POST', headers, body, redirect: 'follow' });
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { code?: number; data?: { product_list?: unknown } };
    const arr = j?.data?.product_list;
    if (Array.isArray(arr) && arr.length > 0) return String(arr[0]);
  } catch { /* fall through */ }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

let _sharedSession: SessionContext | null = null;
function session(): SessionContext {
  if (!_sharedSession) _sharedSession = loadSession();
  return _sharedSession;
}

export async function resolveProductId(
  idOrSku: string,
  _cookieHeader?: string,
): Promise<{ productId: string; sku: string | null }> {
  const s = session();
  if (/^\d+$/.test(idOrSku)) {
    return { productId: idOrSku, sku: null };
  }
  const numeric = await searchForProductId(idOrSku, s);
  if (!numeric) throw new Error(`Could not resolve SKU "${idOrSku}" to numeric product_id via search`);
  return { productId: numeric, sku: idOrSku };
}

export async function fetchWarehouseRows(
  productId: string,
  knownSku?: string | null,
  _cookieHeader?: string,
): Promise<{ rows: NormalizedRow[]; supplierId: string | null; total: number }> {
  const s = session();

  let supplierId = knownSku ?? null;
  if (!supplierId) {
    const base = await fetchBaseInfos(productId, s);
    supplierId = base?.data?.product_info?.sku ?? null;
  }

  const wh = await fetchPriceWarehouse(productId, s);
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
        quantity_exact:      true, // XHR returns exact counts, not "+" floors
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

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--product-id' || a === '--sku' || a === '--id') { out.push(argv[++i]); continue; }
    if (a === '--products') { (argv[++i] ?? '').split(',').forEach(t => t && out.push(t.trim())); continue; }
    if (!a.startsWith('--')) { out.push(a); continue; }
  }
  if (process.env.PRODUCT_IDS) process.env.PRODUCT_IDS.split(',').forEach(t => t && out.push(t.trim()));
  return out;
}

async function runCli() {
  const targets = parseArgs(process.argv.slice(2));
  const list = targets.length ? targets : ['1064421'];

  // Ensure the session loads once up front so we fail fast with a clear error.
  session();

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA WAREHOUSE INVENTORY (XHR)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Session : ${SESSION_FILE}`);
  console.log(` Targets : ${list.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const t of list) {
    console.log(`──── ${t} ────────────────────────────────────────────────`);
    try {
      const { productId, sku } = await resolveProductId(t);
      console.log(`  product_id=${productId}${sku ? `  sku=${sku}` : ''}`);
      const { rows, supplierId, total } = await fetchWarehouseRows(productId, sku);

      if (!supplierId) {
        console.error('  ✗ Could not resolve supplier_product_id (SKU) for this product.');
        continue;
      }
      console.log(`  ${supplierId}`);
      for (const r of rows) {
        console.log(
          `  ${r.warehouse_code.padEnd(8)} state=${(r.warehouse_state ?? '?').padEnd(3)} ` +
          `qty=${String(r.quantity).padStart(4)} exact=${r.quantity_exact ? 'y' : 'n'}`,
        );
      }
      console.log(`  Total ${total}`);
    } catch (err) {
      console.error('  ✗', err instanceof Error ? err.message : err);
    }
    if (INTER_REQ_DELAY > 0) await new Promise(r => setTimeout(r, INTER_REQ_DELAY));
  }
}

if (require.main === module) {
  runCli().catch(err => {
    console.error('[fetchXhr] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
