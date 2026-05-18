/**
 * Fetch a GIGA seller-portal product detail page using the saved
 * authenticated session and parse the visible warehouse-quantity rows
 * directly from the rendered HTML — no need to identify an XHR endpoint.
 *
 * Why HTML instead of an XHR:
 *   The actual "warehouse stock" XHR in the seller portal is hard to find
 *   reliably (DevTools Copy-as-cURL workflow). But the product detail page
 *   itself already contains the warehouse quantities once authenticated:
 *
 *     Item Code: W1445P146389
 *     24 Available
 *     Warehouse Quantity
 *       AT4  4
 *       NJ2  10+
 *
 *   We just fetch that page with the saved cookies and parse the lines.
 *
 * Run:
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromHtml.ts --product-id 670347
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromHtml.ts --sku W1445P146389
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromHtml.ts --products 670347,W331P242454
 *
 * Env:
 *   GIGA_SESSION_FILE — path to storageState (default: scripts/.giga-session.json)
 *   GIGA_USER_AGENT   — UA string for the fetch (default: a realistic Chrome UA)
 *   GIGA_DEBUG_HTML=1 — dump fetched HTML to tmp/giga-page-<id>.html for inspection
 *
 * Exports (used by syncGigaInventoryHtml.ts):
 *   - parsePage(html: string): ParsedPage
 *   - fetchProductPage(idOrSku: string): Promise<{ url, html, status }>
 *   - normalizeRows(parsed: ParsedPage): NormalizedRow[]
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');

const PROFILE_DIR = process.env.GIGA_PROFILE_DIR
  ?? path.join(process.cwd(), 'scripts', '.giga-chrome-profile');

const USER_AGENT = process.env.GIGA_USER_AGENT
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const DEBUG_HTML = process.env.GIGA_DEBUG_HTML === '1';
const RENDER_MODE = (process.env.GIGA_RENDER ?? 'auto') as 'auto' | 'always' | 'never';

// ── Warehouse helpers (verbatim from scrapeGigaInventory.ts) ─────────────────
const WH_CODE_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/g;
const WH_CODE_RE_S = /^(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)$/;

function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}

function supportsPickup(code: string): boolean {
  return warehouseState(code) === 'CA';
}

function parseQty(raw: string): { floor: number | null; exact: boolean } {
  const hasPlus = raw.includes('+');
  const digits = raw.replace(/,/g, '').replace(/[^\d]/g, '');
  const n = digits ? parseInt(digits, 10) : NaN;
  const floor = isNaN(n) ? null : n;
  return { floor, exact: floor !== null && !hasPlus };
}

// ── Cookie / session loading ──────────────────────────────────────────────────

interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

function loadCookieHeader(): string {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Session file not found: ${SESSION_FILE}. Run: npm run inventory:save-session`);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { cookies?: SessionCookie[] };
  const cookies = (raw.cookies ?? []).filter(c => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (cookies.length === 0) {
    throw new Error('No gigab2b.com cookies in session file.');
  }
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

export interface FetchedPage {
  url: string;
  html: string;
  status: number;
  redirected: boolean;
  contentType: string;
}

/** True when the response is Aliyun Cloud WAF's anti-bot challenge page. */
function isAliyunSafeChecker(html: string): boolean {
  return /<title>\s*Safe Checker\s*<\/title>/i.test(html)
    || /acw_tc/i.test(html) && /<title>[^<]*(?:Checker|Cloud[\s_-]?WAF|盾)[^<]*<\/title>/i.test(html);
}

async function fetchPlainHttp(idOrSku: string): Promise<FetchedPage> {
  const cookieHeader = loadCookieHeader();

  const baseHeaders: Record<string, string> = {
    'cookie':                      cookieHeader,
    'user-agent':                  USER_AGENT,
    'accept':                      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language':             'en-US,en;q=0.9',
    'upgrade-insecure-requests':   '1',
    'sec-ch-ua':                   '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':            '?0',
    'sec-ch-ua-platform':          '"macOS"',
    'sec-fetch-dest':              'document',
    'sec-fetch-mode':              'navigate',
    'sec-fetch-site':              'same-origin',
    'sec-fetch-user':              '?1',
  };

  let productUrl: string;
  if (/^\d+$/.test(idOrSku)) {
    productUrl = `https://www.gigab2b.com/index.php?route=product/product&product_id=${idOrSku}`;
  } else {
    const searchUrl = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(idOrSku)}`;
    const sRes = await fetch(searchUrl, { headers: baseHeaders, redirect: 'follow' });
    const sHtml = await sRes.text();
    const pidMatch = sHtml.match(/[?&]product_id=(\d+)/);
    if (!pidMatch) {
      throw new Error(`Search for SKU "${idOrSku}" returned no product_id link.`);
    }
    productUrl = `https://www.gigab2b.com/index.php?route=product/product&product_id=${pidMatch[1]}`;
  }

  const res = await fetch(productUrl, { headers: baseHeaders, redirect: 'follow' });
  const html = await res.text();

  return {
    url: productUrl,
    html,
    status: res.status,
    redirected: res.redirected,
    contentType: res.headers.get('content-type') ?? '',
  };
}

/**
 * Render the product page in a real Chrome instance (persistent profile so
 * Aliyun's "Safe Checker" JS challenge stays passed across runs). Returns
 * the post-JS DOM HTML.
 *
 * Lazily-imports Playwright so plain-HTTP callers don't pay the require cost.
 */
async function fetchViaRender(idOrSku: string): Promise<FetchedPage> {
  const { chromium } = await import('playwright');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  // Use real Chrome when available (Aliyun fingerprints Chromium-for-Testing)
  // and fall back to Playwright's bundled Chromium otherwise.
  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false, // visible — JS challenge needs a real-feeling browser
      channel: 'chrome',
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }

  // Seed cookies from the saved storageState the first time the persistent
  // profile is used — afterwards the profile keeps its own cookies. Failing
  // to seed is non-fatal (existing profile may already be logged in).
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      const cookies = (state.cookies ?? []).filter((c: SessionCookie) =>
        /(^|\.)gigab2b\.com$/.test(c.domain),
      );
      if (cookies.length > 0) {
        await context.addCookies(cookies as Parameters<typeof context.addCookies>[0]);
      }
    } catch {
      /* ignore */
    }
  }

  try {
    const page = context.pages()[0] ?? await context.newPage();

    let productUrl: string;
    if (/^\d+$/.test(idOrSku)) {
      productUrl = `https://www.gigab2b.com/index.php?route=product/product&product_id=${idOrSku}`;
    } else {
      const searchUrl = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(idOrSku)}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45_000 });
      const hrefs = await page.$$eval('a[href*="product_id"]', as => as.map(a => (a as HTMLAnchorElement).href));
      if (hrefs.length === 0) throw new Error(`Search for "${idOrSku}" returned no product_id link.`);
      productUrl = hrefs[0];
    }

    await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 60_000 });

    // Try to wait for the warehouse section. If the new portal layout shows
    // the rows by default we'll see them immediately. If a "Specified
    // Warehouse" radio is in the page, click it once so the table renders.
    try {
      const radio = page.locator('label:has-text("Specified Warehouse")').first();
      if (await radio.count() > 0) await radio.click({ trial: false });
    } catch { /* ok if it's not there */ }

    try {
      await page.waitForFunction(
        () => {
          const t = document.body.innerText;
          return /Warehouse\s+Quantity|仓库库存/i.test(t)
            || /\b(?:CA|NJ|AT|TX)[A-Z]*\d+\b/.test(t);
        },
        { timeout: 15_000 },
      );
    } catch {
      // continue; we'll let the parser decide if anything was extracted
    }

    await page.waitForTimeout(1_200);

    const html = await page.content();
    const finalUrl = page.url();
    return {
      url: finalUrl,
      html,
      status: 200,
      redirected: finalUrl !== productUrl,
      contentType: 'text/html (rendered)',
    };
  } finally {
    await context.close();
  }
}

export async function fetchProductPage(idOrSku: string): Promise<FetchedPage> {
  let fetched: FetchedPage | null = null;
  let mode: 'http' | 'render' = 'http';

  if (RENDER_MODE !== 'always') {
    try {
      fetched = await fetchPlainHttp(idOrSku);
    } catch (err) {
      console.warn(`[fetchHtml]   plain-http failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const needsRender =
    RENDER_MODE === 'always' ||
    (RENDER_MODE !== 'never' && (
      !fetched ||
      isAliyunSafeChecker(fetched.html) ||
      fetched.html.length < 5_000 ||
      !/Warehouse|Item\s+Code|product/i.test(fetched.html)
    ));

  if (needsRender) {
    if (fetched) {
      console.log(
        `[fetchHtml]   plain-http returned ${fetched.html.length}B (${isAliyunSafeChecker(fetched.html) ? 'Aliyun Safe Checker' : 'no product markers'}) — falling back to render mode`,
      );
    }
    fetched = await fetchViaRender(idOrSku);
    mode = 'render';
  }

  if (DEBUG_HTML && fetched) {
    const safe = idOrSku.replace(/[^A-Za-z0-9_-]/g, '_');
    const debugPath = path.join(process.cwd(), 'tmp', `giga-page-${safe}.${mode}.html`);
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, fetched.html);
    console.log(`[fetchHtml]   debug HTML dumped to: ${debugPath}`);
  }

  if (!fetched) throw new Error('Unable to fetch product page (both plain-http and render paths failed).');
  return fetched;
}

// ── HTML → text + parse ───────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    // strip scripts and styles entirely
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // turn structural tags into line breaks before stripping
    .replace(/<\/(?:tr|p|div|li|h\d|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // strip remaining tags
    .replace(/<[^>]+>/g, ' ')
    // decode the most common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export interface WarehouseRow {
  warehouse_code: string;
  warehouse_state: string | null;
  available_qty: number | null;
  quantity_raw: string;
  quantity_exact: boolean;
  supports_pickup: boolean;
  supports_shipping: boolean;
}

export interface ParsedPage {
  supplier_product_id: string | null;
  product_id_numeric: string | null;
  total_available_qty: number | null;
  warehouseRows: WarehouseRow[];
  looksLoggedOut: boolean;
}

export function parsePage(html: string): ParsedPage {
  // Several positive markers must exist before we trust this as a product page.
  // GIGA's login redirect renders the homepage with a sign-in modal — it has
  // none of these markers.
  const hasItemCode      = /Item\s+Code/i.test(html);
  const hasWarehouseSect = /Warehouse\s+Quantity|仓库库存|Specified\s+Warehouse/i.test(html);
  const hasAddToCart     = /Add\s*to\s*Cart|加入购物车/i.test(html);
  const hasSignInModal   = /sign[\s-]*in|log[\s-]*in/i.test(html);

  const looksLoggedOut = !hasItemCode && !hasWarehouseSect && !hasAddToCart && hasSignInModal;

  const text = htmlToText(html);
  const lines = text.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

  // ── Item Code ──────────────────────────────────────────────────────────────
  let supplier_product_id: string | null = null;
  const itemCodeMatch = text.match(/Item\s*Code\s*[:\-]?\s*([A-Z][A-Z0-9]+)/i);
  if (itemCodeMatch) supplier_product_id = itemCodeMatch[1].toUpperCase();

  // ── product_id (numeric, from URL or page) ─────────────────────────────────
  let product_id_numeric: string | null = null;
  const pidMatch = html.match(/product_id=(\d{4,8})/);
  if (pidMatch) product_id_numeric = pidMatch[1];

  // ── Total Available ────────────────────────────────────────────────────────
  let total_available_qty: number | null = null;
  const totalMatch = text.match(/\b(\d[\d,]*)\s+Available\b/i);
  if (totalMatch) total_available_qty = parseInt(totalMatch[1].replace(/,/g, ''), 10);

  // ── Warehouse Quantity rows ────────────────────────────────────────────────
  // Strategy A: find the "Warehouse Quantity" / "仓库库存" heading and walk
  // the next ~80 lines, pairing each WH code line with a qty on same or next
  // line. Skip the global "N Available" total when it shows up inside that
  // window so it isn't mis-attributed to the first warehouse.
  const headingIdx = lines.findIndex(l => /^(warehouse\s+quantity|仓库库存)/i.test(l));
  const QTY_RE = /(?<![A-Z])(\d[\d,]*\+?)\s*(?:pcs|units|件|套)?(?!\w)/i;
  const TOTAL_RE = /^\d[\d,]*\s+Available$/i;

  const rowsByCode = new Map<string, WarehouseRow>();

  const scanStart = headingIdx >= 0 ? headingIdx + 1 : 0;
  const scanEnd = headingIdx >= 0 ? Math.min(scanStart + 80, lines.length) : lines.length;

  for (let i = scanStart; i < scanEnd; i++) {
    const line = lines[i];
    WH_CODE_RE.lastIndex = 0;
    const codes = line.match(WH_CODE_RE);
    if (!codes) continue;

    for (const codeRaw of codes) {
      const code = codeRaw.toUpperCase();
      if (rowsByCode.has(code)) continue;

      // Find a qty in this line OR the next 2 lines.
      // Strip the warehouse code itself first so "AT3" is not parsed as qty 3.
      // Also skip lines that look like the global "N Available" total.
      let qtyRaw = '';
      const scope: string[] = [];
      const sameLineStripped = line.replace(WH_CODE_RE, ' ');
      scope.push(sameLineStripped);
      for (let j = 1; j <= 2 && i + j < scanEnd; j++) {
        const nxt = lines[i + j];
        if (TOTAL_RE.test(nxt)) continue; // ignore "24 Available"
        scope.push(nxt);
      }
      for (const t of scope) {
        const m = t.match(QTY_RE);
        if (m) { qtyRaw = m[1].trim(); break; }
      }

      const { floor, exact } = parseQty(qtyRaw);
      if (floor === null) continue;

      rowsByCode.set(code, {
        warehouse_code:    code,
        warehouse_state:   warehouseState(code),
        available_qty:     floor,
        quantity_raw:      qtyRaw,
        quantity_exact:    exact,
        supports_pickup:   supportsPickup(code),
        supports_shipping: !supportsPickup(code),
      });
    }
  }

  // Single-warehouse override (mirror scrapeGigaInventory.ts): if exactly one
  // warehouse and we know the total, the total IS the exact qty for that WH.
  const warehouseRows = Array.from(rowsByCode.values());
  if (warehouseRows.length === 1 && total_available_qty !== null) {
    warehouseRows[0].available_qty = total_available_qty;
    warehouseRows[0].quantity_exact = true;
    warehouseRows[0].quantity_raw = String(total_available_qty);
  }

  return {
    supplier_product_id,
    product_id_numeric,
    total_available_qty,
    warehouseRows,
    looksLoggedOut,
  };
}

// ── Normalized DB row shape (matches scripts/syncGigaFurnitureInventory.ts) ──

export interface NormalizedRow {
  product_id: string;
  supplier_product_id: string;
  warehouse_code: string;
  warehouse_state: string | null;
  quantity: number | null;
  quantity_raw: string;
  quantity_exact: boolean;
  is_available: boolean;
  supports_pickup: boolean;
  supports_shipping: boolean;
  source_type: 'website_scrape';
  sync_status: 'ok';
  last_synced_at: string;
  total_available: number | null;
}

export function normalizeRows(parsed: ParsedPage, supplierIdOverride?: string): NormalizedRow[] {
  const supplierId = supplierIdOverride ?? parsed.supplier_product_id;
  if (!supplierId) return [];
  const now = new Date().toISOString();
  return parsed.warehouseRows.map(r => ({
    product_id:          supplierId,
    supplier_product_id: supplierId,
    warehouse_code:      r.warehouse_code,
    warehouse_state:     r.warehouse_state,
    quantity:            r.available_qty,
    quantity_raw:        r.quantity_raw,
    quantity_exact:      r.quantity_exact,
    is_available:        (r.available_qty ?? 0) > 0,
    supports_pickup:     r.supports_pickup,
    supports_shipping:   r.supports_shipping,
    source_type:         'website_scrape',
    sync_status:         'ok',
    last_synced_at:      now,
    total_available:     parsed.total_available_qty,
  }));
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { targets: string[] } {
  const out: { targets: string[] } = { targets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--product-id' || a === '--sku' || a === '--id') {
      const v = argv[++i];
      if (v) out.targets.push(v);
    } else if (a === '--products') {
      const v = argv[++i] ?? '';
      v.split(',').map(s => s.trim()).filter(Boolean).forEach(t => out.targets.push(t));
    } else if (!a.startsWith('--')) {
      out.targets.push(a);
    }
  }
  if (process.env.PRODUCT_ID) out.targets.push(process.env.PRODUCT_ID);
  if (process.env.PRODUCT_SKU) out.targets.push(process.env.PRODUCT_SKU);
  return out;
}

async function runCli() {
  const { targets } = parseArgs(process.argv.slice(2));
  const list = targets.length ? targets : ['670347']; // default to the diagnostic test target

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA WAREHOUSE INVENTORY — HTML PARSER');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Session file : ${SESSION_FILE}`);
  console.log(` Targets      : ${list.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const target of list) {
    console.log(`──── ${target} ────────────────────────────────────────────`);
    let fetched: FetchedPage;
    try {
      fetched = await fetchProductPage(target);
    } catch (err) {
      console.error(`  ✗ fetch failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    console.log(`  url    : ${fetched.url}`);
    console.log(`  HTTP   : ${fetched.status}  redirected=${fetched.redirected}  ct=${fetched.contentType}`);

    const parsed = parsePage(fetched.html);

    if (parsed.looksLoggedOut) {
      console.error('  ✗ Page looks like a login page — session cookies expired.');
      console.error('    Run: npm run inventory:save-session');
      continue;
    }

    console.log(`  Item Code        : ${parsed.supplier_product_id ?? '(not found)'}`);
    console.log(`  product_id (num) : ${parsed.product_id_numeric ?? '(not found)'}`);
    console.log(`  Total Available  : ${parsed.total_available_qty ?? '(not found)'}`);
    console.log(`  Warehouse rows   : ${parsed.warehouseRows.length}`);
    for (const r of parsed.warehouseRows) {
      console.log(
        `     ${r.warehouse_code.padEnd(8)} state=${(r.warehouse_state ?? '?').padEnd(3)} ` +
        `qty=${String(r.available_qty).padStart(4)}  exact=${r.quantity_exact ? 'y' : 'n'}  raw="${r.quantity_raw}"`,
      );
    }

    const supplierFallback = /^[A-Z]/.test(target) ? target : undefined;
    const rows = normalizeRows(parsed, supplierFallback);
    console.log(`  Normalized rows  : ${rows.length}`);
    if (rows.length === 0 && parsed.warehouseRows.length === 0) {
      console.log('  (no warehouse rows extracted — set GIGA_DEBUG_HTML=1 to dump page HTML for inspection)');
    }
  }
}

if (require.main === module) {
  runCli().catch(err => {
    console.error('[fetchHtml] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
