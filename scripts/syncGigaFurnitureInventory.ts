/**
 * Batch warehouse-inventory scraper for all Furniture products in giga_products.
 *
 * Reads product URLs from the giga_products table, opens each product detail page
 * in a logged-in Playwright session, clicks "Specified Warehouse", extracts all
 * warehouse quantity rows, and upserts the results into inventory_cache.
 *
 * Scraping logic (clickSpecifiedWarehouse, extractWarehouseRows, parseQty, etc.)
 * is copied verbatim from scrapeGigaInventory.ts — that file is not modified.
 *
 * Run:
 *   # Dry run — first 5 products, no DB writes:
 *   DRY_RUN=1 INVENTORY_LIMIT=5 npx tsx scripts/syncGigaFurnitureInventory.ts
 *
 *   # Real run — first 20 products:
 *   INVENTORY_LIMIT=20 npx tsx scripts/syncGigaFurnitureInventory.ts
 *
 *   # Full run — all Furniture products:
 *   npx tsx scripts/syncGigaFurnitureInventory.ts
 *
 * Required:
 *   SUPABASE_URL              — https://<id>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS)
 *   GIGA_SESSION_FILE         — saved session (default: scripts/.giga-session.json)
 *
 * Optional:
 *   INVENTORY_LIMIT   — max products to scrape (default: all)
 *   DRY_RUN=1         — print parsed inventory but skip DB write
 *   HEADED=1          — show browser window
 *   PAGE_DELAY_MS     — ms to wait between products (default: 1200)
 */

import 'dotenv/config';
import { chromium, Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import * as path from 'path';
import * as fs from 'fs';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const SESSION_FILE =
  process.env.GIGA_SESSION_FILE ??
  path.join(process.cwd(), 'scripts', '.giga-session-pickup.json'); // pickup account (Buyer 76938981) for per-warehouse stock; override with GIGA_SESSION_FILE

const DRY_RUN        = process.env.DRY_RUN === '1';
const HEADED         = process.env.HEADED === '1';
const INVENTORY_LIMIT = process.env.INVENTORY_LIMIT
  ? parseInt(process.env.INVENTORY_LIMIT, 10)
  : Infinity;
const PAGE_DELAY_MS = process.env.PAGE_DELAY_MS
  ? parseInt(process.env.PAGE_DELAY_MS, 10)
  : 1200;

// ── Incremental / priority-batching config ────────────────────────────────────
// Default mode is incremental: each run selects a bounded slice of products
// chosen by priority + freshness so we don't re-scrape everything every day.
// Set INVENTORY_FULL_SYNC=1 to fall back to the legacy "scrape every product"
// behavior (used by `npm run inventory:sync:full`).
const FULL_SYNC = process.env.INVENTORY_FULL_SYNC === '1';
const BATCH_SIZE = process.env.INVENTORY_BATCH_SIZE
  ? parseInt(process.env.INVENTORY_BATCH_SIZE, 10)
  : 30;

// SLA windows per priority tier (hours). A product is "due" when its newest
// inventory_cache row is older than this — or it has never been synced.
const TIER_0_MAX_HOURS = 24;  // hot:  recently ordered → ~daily refresh
const TIER_1_MAX_HOURS = 48;  // warm: in_stock         → ~every 2 days
const TIER_2_MAX_HOURS = 72;  // cold: everything else  → ~every 3 days
                              //       (well inside the 3–7 day SLA target)

// Look-back window for "recently ordered" classification (tier 0).
const RECENT_ORDER_DAYS = 30;

// ── Warehouse helpers — copied from scrapeGigaInventory.ts (do not modify that file) ──

const WH_CODE_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/gi;

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

// ── Types ─────────────────────────────────────────────────────────────────────

type WarehouseRow = {
  warehouseCode: string;
  state: string | null;
  quantity: number | null;
  quantityRaw: string;
  quantityExact: boolean;
  quantityFloor: number | null;
  supportsPickup: boolean;
  supportsShipping: boolean;
};

type ProductScrapeResult = {
  productId: string;
  productUrl: string;
  title: string;
  loginRequired: boolean;
  specifiedWarehouseClicked: boolean;
  inventoryVisibleAfterClick: boolean;
  totalAvailable: number | null;
  warehouseRows: WarehouseRow[];
  warnings: string[];
};

// ── Quantity parser — copied verbatim from scrapeGigaInventory.ts ──────────────

function parseQty(raw: string): { floor: number | null; exact: boolean } {
  const hasPlus = raw.includes('+');
  const digits = raw.replace(/,/g, '').replace(/[^\d]/g, '');
  const n = digits ? parseInt(digits, 10) : NaN;
  const floor = isNaN(n) ? null : n;
  return { floor, exact: floor !== null && !hasPlus };
}

// ── Total-available extractor — copied verbatim from scrapeGigaInventory.ts ───

function extractTotalAvailable(pageText: string): number | null {
  const m = pageText.match(/\b(\d[\d,]*)\s+Available\b/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ── Click "Specified Warehouse" — copied verbatim from scrapeGigaInventory.ts ─

async function clickSpecifiedWarehouse(page: Page): Promise<{
  clicked: boolean;
  inventoryVisible: boolean;
}> {
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(600);

  const label = page.locator('label:has-text("Specified Warehouse")').first();
  const count = await label.count();

  if (count === 0) return { clicked: false, inventoryVisible: false };

  await label.click();

  let inventoryVisible = false;
  try {
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Warehouse Quantity') ||
        /CA\d+|NJ\d+|AT\d+|TX\d+/i.test(document.body.innerText),
      { timeout: 10_000 },
    );
    inventoryVisible = true;
  } catch {
    // Inventory did not appear — proceed anyway
  }

  await page.waitForTimeout(1_500);
  return { clicked: true, inventoryVisible };
}

// ── Extract warehouse rows — copied verbatim from scrapeGigaInventory.ts ──────

async function extractWarehouseRows(page: Page): Promise<{
  rows: WarehouseRow[];
}> {
  type DomRow = { text: string; source: string };

  const domRows: DomRow[] = await page.evaluate((): { text: string; source: string }[] => {
    const WH_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/i;
    const CODE_ONLY_RE = /^(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)$/i;
    const results: { text: string; source: string }[] = [];

    document.querySelectorAll('tr').forEach(el => {
      const t = (el as HTMLElement).innerText?.trim() ?? '';
      if (WH_RE.test(t) && t.length < 500) results.push({ text: t, source: 'tr' });
    });

    document.querySelectorAll('td, span, div, p').forEach(el => {
      const own = (el as HTMLElement).innerText?.trim() ?? '';
      if (!CODE_ONLY_RE.test(own)) return;
      const parent = el.parentElement;
      if (parent) {
        const pt = (parent as HTMLElement).innerText?.trim() ?? '';
        if (pt.length < 500 && WH_RE.test(pt)) {
          results.push({ text: pt, source: 'parent-of-code-cell' });
        }
      }
      const sibTexts: string[] = [own];
      let sib = el.nextElementSibling;
      while (sib) {
        const st = (sib as HTMLElement).innerText?.trim() ?? '';
        if (st) sibTexts.push(st);
        sib = sib.nextElementSibling;
      }
      if (sibTexts.length > 1) {
        results.push({ text: sibTexts.join('\t'), source: 'code+siblings' });
      }
    });

    return results;
  });

  const pageText: string = await page.evaluate(() => document.body?.innerText ?? '');
  const allLines = pageText.split('\n').map(l => l.trim()).filter(Boolean);

  let sectionStart = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (/warehouse\s+quantity|仓库库存/i.test(allLines[i])) { sectionStart = i + 1; break; }
  }
  const sectionLines = sectionStart >= 0 ? allLines.slice(sectionStart, sectionStart + 60) : [];

  const seen = new Set<string>();
  const rows: WarehouseRow[] = [];

  function parseCandidate(
    text: string,
    lineIdx: number,
    contextLines: string[],
  ): WarehouseRow | null {
    WH_CODE_RE.lastIndex = 0;
    const codeMatches = [...text.matchAll(WH_CODE_RE)].map(m => m[0].toUpperCase());
    if (codeMatches.length === 0) return null;
    const code = codeMatches.find(c => warehouseState(c) !== null) ?? codeMatches[0];
    if (seen.has(code)) return null;
    seen.add(code);

    const QTY_RE = /(?<![A-Z])(\d[\d,]*\+?)\s*(?:pcs|units|件|套)?(?!\w)/i;
    let qtyRaw = '';
    const searchScope = [text, ...contextLines.slice(lineIdx + 1, lineIdx + 3)];
    for (const t of searchScope) {
      const m = t.match(QTY_RE);
      if (m) { qtyRaw = m[1].trim(); break; }
    }

    const { floor, exact } = parseQty(qtyRaw);
    const pickupHint   = /pickup|self.?pick|可自提/i.test(text);
    const shippingHint = /ship|delivery|快递/i.test(text);

    return {
      warehouseCode: code,
      state: warehouseState(code),
      quantity: floor,
      quantityRaw: qtyRaw || '(not detected)',
      quantityExact: exact,
      quantityFloor: floor,
      supportsPickup: supportsPickup(code) || pickupHint,
      supportsShipping: !supportsPickup(code) || shippingHint,
    };
  }

  for (const { text } of domRows) {
    const row = parseCandidate(text, 0, []);
    if (row) rows.push(row);
  }

  if (rows.length === 0) {
    for (let i = 0; i < sectionLines.length; i++) {
      WH_CODE_RE.lastIndex = 0;
      if (!WH_CODE_RE.test(sectionLines[i])) continue;
      const row = parseCandidate(sectionLines[i], i, sectionLines);
      if (row) rows.push(row);
    }
  }

  if (rows.length === 0) {
    for (let i = 0; i < allLines.length; i++) {
      WH_CODE_RE.lastIndex = 0;
      if (!WH_CODE_RE.test(allLines[i])) continue;
      const row = parseCandidate(allLines[i], i, allLines);
      if (row) rows.push(row);
    }
  }

  return { rows };
}

// ── URL resolver ──────────────────────────────────────────────────────────────
// giga_products stores URLs like ?route=product/product&sku=N725S412541K, but
// the GIGA portal serves warehouse data only from ?product_id=1315793 (numeric).
// This resolver does the SKU → product_id hop and surfaces a precise failure
// reason so the caller can distinguish anti-bot blocks from HTML drift from a
// legitimately-missing product.
//
// Failure reasons (consumed by scrapeProductOnce as the outcome.reason):
//   no_sku                  — input URL has neither ?sku= nor ?itemNo=
//   navigation_failed       — search page never finished loading
//   captcha_blocked         — Aliyun "Safe Checker" interstitial intercepted us
//   product_url_unresolved  — search succeeded but no product_id appears anywhere
type ResolveResult =
  | { ok: true; url: string; productId: string }
  | { ok: false; reason: 'no_sku' | 'navigation_failed' | 'captcha_blocked' | 'product_url_unresolved' };

async function resolveProductUrl(
  page: Page,
  rawUrl: string,
  opts: { titleHint?: string | null } = {},
): Promise<ResolveResult> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch {
    return { ok: false, reason: 'navigation_failed' };
  }

  // Fast path — caller already has the canonical product_id URL.
  const existingPid = parsed.searchParams.get('product_id');
  if (existingPid) return { ok: true, url: rawUrl, productId: existingPid };

  const sku = parsed.searchParams.get('sku') ?? parsed.searchParams.get('itemNo');
  if (!sku) return { ok: false, reason: 'no_sku' };

  const searchUrl = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(sku)}`;
  console.log(`  [resolve] SKU ${sku} → ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch {
    console.log(`  [resolve] search navigation failed (timeout/network)`);
    return { ok: false, reason: 'navigation_failed' };
  }

  const currentUrl = page.url();
  console.log(`  [resolve] current URL: ${currentUrl}`);

  // (A) Search may have redirected directly to a product page.
  try {
    const directPid = new URL(currentUrl).searchParams.get('product_id');
    if (directPid) {
      console.log(`  [resolve] direct redirect → product_id=${directPid}`);
      return { ok: true, url: currentUrl, productId: directPid };
    }
  } catch { /* ignore */ }

  // (B) Aliyun anti-bot wall. GIGA serves this as <title>Safe Checker</title>
  //     with /captcha-frontend/ and aliyun-{captcha,puzzle,zoom} signals. If we
  //     hit it, no product anchors will exist — surface a precise reason so
  //     the operator doesn't go chasing HTML-drift ghosts.
  const interstitial = await page.evaluate(() => {
    const title = (document.querySelector('title')?.textContent ?? '').trim();
    const html  = document.documentElement?.outerHTML ?? '';
    const captchaHit =
      /Safe\s*Checker/i.test(title) ||
      /aliyun-(?:captcha|puzzle|zoom)/i.test(html) ||
      /\/captcha-frontend\//i.test(html) ||
      /safe\/captcha\.css/i.test(html);
    return { title, captchaHit };
  });
  if (interstitial.captchaHit) {
    console.log(`  [resolve] captcha interstitial detected (title="${interstitial.title}")`);
    return { ok: false, reason: 'captcha_blocked' };
  }

  // (C) Look for product_id everywhere it might live: anchor href, onclick,
  //     data-href/data-url, and (last-resort) the raw HTML. The old resolver
  //     only matched a[href*="product_id"], which silently misses links that
  //     stash the id in onclick handlers or JSON blobs.
  // IMPORTANT: this callback runs inside the browser. Do NOT declare named
  // function expressions (`const fn = (...) => {...}` or `const fn = function`)
  // — tsx/esbuild's keepNames pass wraps them with `__name(fn, "fn")`, and the
  // `__name` helper does not exist in the page context (it lives in the Node
  // module preamble). All helper logic is inlined below for that reason. No
  // closed-over Node-side helpers, regex objects, or imports either.
  const candidates: Array<{ pid: string; href: string; title: string }> = await page.evaluate(() => {
    const seen: Record<string, true> = {};
    const out: Array<{ pid: string; href: string; title: string }> = [];

    const anchors = document.querySelectorAll('a');
    for (let i = 0; i < anchors.length; i++) {
      const el = anchors[i] as HTMLAnchorElement;
      const sources = [
        el.href || '',
        el.getAttribute('href') || '',
        el.getAttribute('onclick') || '',
        el.getAttribute('data-href') || '',
        el.getAttribute('data-url') || '',
      ];
      for (let j = 0; j < sources.length; j++) {
        const m = sources[j].match(/product_id=(\d+)/);
        if (m) {
          const pid = m[1];
          if (pid && !seen[pid]) {
            seen[pid] = true;
            const label = (el.innerText || el.textContent || '').trim().slice(0, 240);
            out.push({ pid, href: el.href || sources[j], title: label });
          }
          break;
        }
      }
    }

    // Last-resort: pull from raw HTML (covers JSON blobs / inline scripts).
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    const re = /product_id=(\d+)/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(html)) !== null) {
      const pid = mm[1];
      if (pid && !seen[pid]) {
        seen[pid] = true;
        out.push({
          pid,
          href: 'https://www.gigab2b.com/index.php?route=product/product&product_id=' + pid,
          title: '',
        });
      }
    }
    return out;
  });

  console.log(`  [resolve] candidate product_id links found: ${candidates.length}`);

  if (candidates.length === 0) {
    return { ok: false, reason: 'product_url_unresolved' };
  }

  // (D) Prefer a candidate whose visible label matches the SKU exactly, then
  //     one that matches the first ~24 chars of the supplier title, then the
  //     first candidate. Numeric product_id alone doesn't disambiguate when a
  //     search returns multiple SKUs.
  const skuLower  = sku.toLowerCase();
  const hintLower = (opts.titleHint ?? '').toLowerCase();
  const titleHead = hintLower.slice(0, 24);
  const chosen =
    candidates.find(c => c.title.toLowerCase().includes(skuLower)) ??
    (titleHead ? candidates.find(c => c.title.toLowerCase().includes(titleHead)) : undefined) ??
    candidates[0];

  console.log(`  [resolve] selected product_id: ${chosen.pid} (of ${candidates.length} candidate(s))`);
  return { ok: true, url: chosen.href, productId: chosen.pid };
}

// ── Supabase write ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function writeToSupabase(
  result: ProductScrapeResult,
  supabase: any,
): Promise<{ rowsWritten: number; error: string | null }> {
  if (result.warehouseRows.length === 0) {
    return { rowsWritten: 0, error: 'no warehouse rows' };
  }

  const now = new Date().toISOString();
  const rows = result.warehouseRows.map(row => ({
    product_id:          result.productId,
    supplier_product_id: result.productId,
    warehouse_code:      row.warehouseCode,
    warehouse_state:     row.state,
    warehouse_city:      null,
    quantity:            row.quantity,
    quantity_floor:      row.quantityFloor,
    quantity_raw:        row.quantityRaw,
    quantity_exact:      row.quantityExact,
    total_available:     result.totalAvailable,
    is_available:        (row.quantity ?? 0) > 0,
    supports_pickup:     row.supportsPickup,
    supports_shipping:   row.supportsShipping,
    last_synced_at:      now,
    sync_status:         'ok',
    source_type:         'website_scrape',
    raw_payload:         {
      productUrl: result.productUrl,
      totalAvailable: result.totalAvailable,
      warnings: result.warnings,
    },
  }));

  const { error } = await supabase
    .from('inventory_cache')
    .upsert(rows as any, { onConflict: 'product_id,warehouse_code' });

  if (error) return { rowsWritten: 0, error: error.message };
  return { rowsWritten: rows.length, error: null };
}

// ── Per-product scrape (extracted so we can retry on transient failures) ──────

type ScrapeOutcome =
  | { kind: 'session_expired' }
  | { kind: 'out_of_stock'; signals: string[] }
  | { kind: 'success'; rows: WarehouseRow[]; totalAvailable: number | null; resolvedUrl: string }
  | { kind: 'retriable_failure'; reason: string; resolvedUrl: string };

async function detectOosSignals(page: Page): Promise<{ score: number; details: string[] }> {
  return page.evaluate(() => {
    const text = (document.body?.innerText ?? '');
    const details: string[] = [];
    let score = 0;
    if (/(^|[^\d])0\s+Available\b/i.test(text)) { score++; details.push('"0 Available"'); }
    if (/Warehouse\s*Quantity[\s\S]{0,80}?No\s*data/i.test(text)) { score++; details.push('Warehouse Quantity: No data'); }
    if (/Total\s*Item\s*Cost[\s\S]{0,80}?N\/?A/i.test(text)) { score++; details.push('Total Item Cost: N/A'); }
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    const disabledBuy = btns.some(b => {
      const label = ((b as HTMLElement).innerText ?? b.textContent ?? '').trim();
      if (!/\b(buy\s*now|add\s*to\s*cart)\b/i.test(label)) return false;
      const cls = (b as HTMLElement).className?.toString() ?? '';
      return (
        (b as HTMLButtonElement).disabled === true ||
        b.getAttribute('disabled') !== null ||
        b.getAttribute('aria-disabled') === 'true' ||
        /\b(disabled|btn-disabled|is-disabled|opacity-50)\b/i.test(cls)
      );
    });
    if (disabledBuy) { score++; details.push('Buy/AddToCart disabled'); }
    return { score, details };
  });
}

async function scrapeProductOnce(
  page: Page,
  product: { product_id: string; product_url: string; title: string | null },
  warnings: string[],
): Promise<ScrapeOutcome> {
  let resolvedUrl = product.product_url;
  try {
    const resolved: ResolveResult = await resolveProductUrl(page, product.product_url, { titleHint: product.title });
    if (resolved.ok === false) {
      // Surface the precise resolver failure instead of letting flow continue
      // to the warehouse-radio probe (which would always report
      // 'no_warehouse_radio' for a captcha/empty page and obscure the cause).
      warnings.push(`resolveProductUrl: ${resolved.reason}`);
      return { kind: 'retriable_failure', reason: resolved.reason, resolvedUrl };
    }
    resolvedUrl = resolved.url;

    try {
      await page.goto(resolvedUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch (e) {
      warnings.push(`Page load timeout — continuing: ${(e as Error).message.slice(0, 80)}`);
    }

    const finalUrl = page.url();
    const earlyText: string = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? '');

    const isLoginPage =
      /log\s*in|sign\s*in|password/i.test(earlyText) &&
      !/product|warehouse|shipping/i.test(earlyText);
    if (isLoginPage || /login|sign-in/i.test(finalUrl)) {
      return { kind: 'session_expired' };
    }

    const { clicked, inventoryVisible } = await clickSpecifiedWarehouse(page);
    if (!clicked) {
      warnings.push('"Specified Warehouse" label not found on this page');
      return { kind: 'retriable_failure', reason: 'no_warehouse_radio', resolvedUrl };
    }
    if (!inventoryVisible) {
      warnings.push('Radio clicked but Warehouse Quantity table did not appear');
    }

    const { rows } = await extractWarehouseRows(page);
    const fullPageText: string = await page.evaluate(() => document.body?.innerText ?? '');
    const totalAvailable = extractTotalAvailable(fullPageText);

    // Single-warehouse override (same rule as scrapeGigaInventory.ts)
    if (rows.length === 1 && totalAvailable !== null) {
      rows[0].quantity = totalAvailable;
      rows[0].quantityExact = true;
    }

    if (rows.length === 0) {
      const oosSignals = await detectOosSignals(page);
      const isOutOfStock = oosSignals.score >= 2 || oosSignals.details.includes('"0 Available"');
      if (isOutOfStock) {
        return { kind: 'out_of_stock', signals: oosSignals.details };
      }
      return { kind: 'retriable_failure', reason: 'no_rows_extracted', resolvedUrl };
    }

    return { kind: 'success', rows, totalAvailable, resolvedUrl };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Unexpected error: ${msg.slice(0, 120)}`);
    return { kind: 'retriable_failure', reason: `error: ${msg.slice(0, 80)}`, resolvedUrl };
  }
}

async function saveDebugArtifacts(page: Page, productId: string): Promise<void> {
  try {
    const dir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeId = productId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const pngPath  = path.join(dir, `giga-debug-${safeId}-${ts}.png`);
    const htmlPath = path.join(dir, `giga-debug-${safeId}-${ts}.html`);
    await page.screenshot({ path: pngPath, fullPage: false });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log(`  📎 Debug artifacts saved: ${path.relative(process.cwd(), pngPath)}, ${path.relative(process.cwd(), htmlPath)}`);
  } catch (e) {
    console.log(`  ⚠ Could not save debug artifacts: ${(e as Error).message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  // ── Validate prerequisites ──────────────────────────────────────────────────
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('[FurnitureInventory] ERROR: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }

  if (!fs.existsSync(SESSION_FILE)) {
    console.error(
      '[FurnitureInventory] ERROR: Session file not found:', SESSION_FILE, '\n' +
      '  Run: GIGA_LOGIN_URL="https://www.gigab2b.com/index.php?route=common/home" \\\n' +
      '         npx tsx scripts/saveGigaSession.ts',
    );
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(' GIGA FURNITURE INVENTORY BATCH SYNC');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(` MODE            : ${FULL_SYNC ? 'FULL (all products)' : 'INCREMENTAL (priority + freshness)'}`);
  console.log(` DRY_RUN         : ${DRY_RUN}`);
  console.log(` HEADED          : ${HEADED}`);
  console.log(` BATCH_SIZE      : ${FULL_SYNC ? '(ignored)' : BATCH_SIZE}`);
  console.log(` INVENTORY_LIMIT : ${isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : '(unset)'}`);
  console.log(` PAGE_DELAY_MS   : ${PAGE_DELAY_MS}`);
  console.log(` SESSION_FILE    : ${SESSION_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Fetch product list from standardized_products ──────────────────────────
  // Source-of-truth: standardized_products. supplier_product_id is the GIGA
  // native SKU and matches inventory_cache.product_id, so the rest of the
  // pipeline (scrape → inventory_cache → refresh_product_inventory_status)
  // is unchanged. All rows in this project originate from GIGA — there is no
  // separate `supplier` column on standardized_products.
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: products, error: fetchError } = await supabase
    .from('standardized_products')
    .select('supplier_product_id, product_title, inventory_status')
    .eq('normalization_status', 'done')
    .not('supplier_product_id', 'is', null)
    .order('created_at', { ascending: false });

  if (fetchError) {
    console.error('[FurnitureInventory] Failed to fetch standardized_products:', fetchError.message);
    process.exit(1);
  }

  if (!products || products.length === 0) {
    console.log('[FurnitureInventory] No normalized products found in standardized_products — nothing to do.');
    return;
  }

  // Remap to the legacy { product_id, product_url, title } shape so the scrape
  // loop below is unchanged. A sku= URL is constructed from the GIGA SKU;
  // resolveProductUrl() follows it to the canonical product_id= portal page
  // on first navigation, exactly as it did for legacy giga_products rows.
  type CandidateProduct = {
    product_id: string;
    product_url: string;
    title: string | null;
    inventory_status: string | null;
  };
  const seen = new Set<string>();
  const allProducts: CandidateProduct[] = [];
  for (const row of products) {
    const sku = (row as { supplier_product_id?: string | null })?.supplier_product_id;
    if (typeof sku !== 'string' || sku.length === 0 || seen.has(sku)) continue;
    seen.add(sku);
    allProducts.push({
      product_id: sku,
      product_url: `https://www.gigab2b.com/index.php?route=product/product&sku=${encodeURIComponent(sku)}`,
      title: (row as { product_title?: string | null })?.product_title ?? null,
      inventory_status:
        (row as { inventory_status?: string | null })?.inventory_status ?? null,
    });
  }

  // ── Build the batch ────────────────────────────────────────────────────────
  // FULL_SYNC=1: legacy behavior — process every product (capped by
  //              INVENTORY_LIMIT if set). Used by `npm run inventory:sync:full`
  //              and ad-hoc backfills.
  // Otherwise:   priority + freshness selection.
  //              Tier 0 (hot)  : ordered in last RECENT_ORDER_DAYS → ≤24h SLA
  //              Tier 1 (warm) : inventory_status='in_stock'        → ≤48h SLA
  //              Tier 2 (cold) : everything else                    → ≤72h SLA
  //              "Due" products are those whose newest inventory_cache row is
  //              older than the tier's SLA (or null = never synced). The queue
  //              is then sorted by (tier ASC, lastSync ASC NULLS FIRST), which
  //              gives an implicit rotating cursor — products just synced
  //              today drift to the back tomorrow.
  let batch: CandidateProduct[];

  if (FULL_SYNC) {
    batch = allProducts.slice(
      0,
      isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : allProducts.length,
    );
    console.log(`[FurnitureInventory] FULL SYNC mode — scanning ${batch.length} product(s)\n`);
  } else {
    const allIds = allProducts.map(p => p.product_id);

    // Newest scrape-row timestamp per product (from inventory_cache).
    const lastSyncMap = new Map<string, number>();
    {
      const { data: invRows, error: invErr } = await supabase
        .from('inventory_cache')
        .select('product_id, last_synced_at')
        .in('product_id', allIds)
        .eq('source_type', 'website_scrape')
        .eq('sync_status', 'ok');
      if (invErr) {
        console.warn(`[FurnitureInventory] inventory_cache freshness lookup failed (treating all as due): ${invErr.message}`);
      } else {
        for (const r of invRows ?? []) {
          const pid = (r as { product_id?: string | null }).product_id;
          const ts  = (r as { last_synced_at?: string | null }).last_synced_at;
          if (!pid || !ts) continue;
          const t = Date.parse(ts);
          if (Number.isNaN(t)) continue;
          const prev = lastSyncMap.get(pid);
          if (prev === undefined || t > prev) lastSyncMap.set(pid, t);
        }
      }
    }

    // Tier-0 set: products ordered in the last RECENT_ORDER_DAYS days.
    const recentlyOrderedSet = new Set<string>();
    {
      const cutoff = new Date(Date.now() - RECENT_ORDER_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: orderedRows, error: ordErr } = await supabase
        .from('order_items')
        .select('product_id')
        .gte('created_at', cutoff);
      if (ordErr) {
        console.warn(`[FurnitureInventory] order_items lookup failed (no tier-0 boost this run): ${ordErr.message}`);
      } else {
        for (const r of orderedRows ?? []) {
          const pid = (r as { product_id?: string | null }).product_id;
          if (pid) recentlyOrderedSet.add(pid);
        }
      }
    }

    const now = Date.now();
    const maxAgeMs = [
      TIER_0_MAX_HOURS * 60 * 60 * 1000,
      TIER_1_MAX_HOURS * 60 * 60 * 1000,
      TIER_2_MAX_HOURS * 60 * 60 * 1000,
    ] as const;

    type Ranked = { p: CandidateProduct; tier: 0 | 1 | 2; lastSync: number };
    const ranked: Ranked[] = [];
    let dueByTier: [number, number, number] = [0, 0, 0];

    for (const p of allProducts) {
      const tier: 0 | 1 | 2 =
        recentlyOrderedSet.has(p.product_id) ? 0 :
        p.inventory_status === 'in_stock'    ? 1 : 2;
      const lastSync = lastSyncMap.get(p.product_id) ?? 0;
      const dueCutoff = now - maxAgeMs[tier];
      if (lastSync >= dueCutoff) continue; // already fresh enough for its tier
      ranked.push({ p, tier, lastSync });
      dueByTier[tier]++;
    }

    // Sort: tier ASC (hottest first), then lastSync ASC (oldest first).
    // never-synced (lastSync=0) naturally sorts before any real timestamp.
    ranked.sort((a, b) => a.tier - b.tier || a.lastSync - b.lastSync);

    const cap = isFinite(INVENTORY_LIMIT) ? Math.min(INVENTORY_LIMIT, BATCH_SIZE) : BATCH_SIZE;
    batch = ranked.slice(0, cap).map(r => r.p);

    console.log(`[FurnitureInventory] Eligible products total: ${allProducts.length}`);
    console.log(`[FurnitureInventory] Due this run            : ${ranked.length}` +
                `  (tier0=${dueByTier[0]} tier1=${dueByTier[1]} tier2=${dueByTier[2]})`);
    console.log(`[FurnitureInventory] Selected for this batch : ${batch.length} (cap=${cap})\n`);
  }

  if (batch.length === 0) {
    console.log('[FurnitureInventory] Nothing due to refresh — all products within their tier SLA. Exiting cleanly.');
    return;
  }

  // ── Launch browser ──────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 60 : 0 });
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page = await context.newPage();

  const runStartedAt = new Date().toISOString();

  // ── Stats ───────────────────────────────────────────────────────────────────
  let attempted     = 0;
  let succeeded     = 0;
  let failed        = 0;
  let outOfStock    = 0; // tracked separately — NOT a scraper failure
  let rowsWritten   = 0;
  let sessionExpired = false;
  const failedSkus: { productId: string; url: string; reason: string }[] = [];
  const outOfStockSkus: { productId: string; url: string }[] = [];

  // ── Batch loop ──────────────────────────────────────────────────────────────
  for (let i = 0; i < batch.length; i++) {
    const product = batch[i];
    attempted++;

    const logPrefix = `[${i + 1}/${batch.length}] ${product.product_id}`;
    const title = (product.title as string | null)?.slice(0, 60) ?? '(no title)';
    console.log(`\n${logPrefix} — ${title}`);
    console.log(`  URL: ${product.product_url}`);

    const warnings: string[] = [];

    // Attempt 1 (normal delay). Retry once with doubled delay on retriable
    // failures (no_warehouse_radio, no_rows_extracted, unexpected error).
    // Safety: max 1 retry per SKU. Session-expired and out_of_stock are not
    // retried — they have terminal meaning.
    let outcome = await scrapeProductOnce(page, product, warnings);
    if (outcome.kind === 'retriable_failure') {
      console.log(`  ↻ Attempt 1 failed (${outcome.reason}) — retrying once with longer delay`);
      await page.waitForTimeout(PAGE_DELAY_MS * 2);
      outcome = await scrapeProductOnce(page, product, warnings);
    }

    if (outcome.kind === 'session_expired') {
      console.log(`  ✗ Session expired — aborting batch`);
      failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: 'session_expired' });
      failed++;
      sessionExpired = true;
      break;
    }

    if (outcome.kind === 'out_of_stock') {
      console.log(`  ○ Out of stock — no warehouse rows  (signals: ${outcome.signals.join(', ')})`);
      outOfStock++;
      outOfStockSkus.push({ productId: product.product_id as string, url: product.product_url as string });

      if (DRY_RUN) {
        console.log(`  [DRY_RUN] Would zero existing inventory_cache rows + refresh inventory_status — skipping`);
      } else {
        const nowIso = new Date().toISOString();
        const { error: zeroErr } = await supabase
          .from('inventory_cache')
          .update({
            quantity:        0,
            quantity_floor:  0,
            quantity_raw:    '0',
            quantity_exact:  true,
            is_available:    false,
            total_available: 0,
            last_synced_at:  nowIso,
            sync_status:     'ok',
          })
          .eq('product_id', product.product_id as string)
          .eq('source_type', 'website_scrape');
        if (zeroErr) {
          console.log(`  ⚠ Could not zero existing inventory_cache rows (non-fatal): ${zeroErr.message}`);
        } else {
          console.log(`  ✓ Existing inventory_cache rows zeroed`);
        }
        const { error: rpcErr } = await supabase.rpc(
          'refresh_product_inventory_status',
          { p_supplier_product_id: product.product_id as string },
        );
        if (rpcErr) {
          console.log(`  ⚠ refresh_product_inventory_status failed (non-fatal): ${rpcErr.message}`);
        } else {
          console.log(`  ✓ inventory_status refreshed (expect out_of_stock)`);
        }
      }
    } else if (outcome.kind === 'retriable_failure') {
      // Still failed after the retry — save debug artifacts and record.
      console.log(`  ⚠ Both attempts failed: ${outcome.reason}`);
      await saveDebugArtifacts(page, product.product_id as string);
      failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: outcome.reason });
      failed++;
    } else {
      // outcome.kind === 'success'
      const rows = outcome.rows;
      if (rows.length === 1 && outcome.totalAvailable !== null) {
        console.log(
          `  ↳ Single warehouse (${rows[0].warehouseCode}): quantity overridden to ${outcome.totalAvailable} (from totalAvailable)`,
        );
      }
      console.log(`  totalAvailable: ${outcome.totalAvailable ?? '(not found)'}`);
      for (const row of rows) {
        console.log(
          `  ${row.warehouseCode.padEnd(10)} state=${row.state ?? '?'}  ` +
          `qty=${row.quantity ?? '-'}  exact=${row.quantityExact}  raw="${row.quantityRaw}"`,
        );
      }

      if (DRY_RUN) {
        console.log(`  [DRY_RUN] Would upsert ${rows.length} row(s) — skipping DB write`);
        succeeded++;
        rowsWritten += rows.length;
      } else {
        const result: ProductScrapeResult = {
          productId: product.product_id as string,
          productUrl: outcome.resolvedUrl,
          title,
          loginRequired: false,
          specifiedWarehouseClicked: true,
          inventoryVisibleAfterClick: true,
          totalAvailable: outcome.totalAvailable,
          warehouseRows: rows,
          warnings,
        };
        const { rowsWritten: written, error: writeErr } = await writeToSupabase(result, supabase);
        if (writeErr) {
          console.log(`  ✗ DB write failed: ${writeErr}`);
          failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: `db_write: ${writeErr}` });
          failed++;
        } else {
          console.log(`  ✓ Upserted ${written} inventory row(s)`);
          succeeded++;
          rowsWritten += written;
          const { error: rpcErr } = await supabase.rpc(
            'refresh_product_inventory_status',
            { p_supplier_product_id: product.product_id as string },
          );
          if (rpcErr) {
            console.log(`  ⚠ refresh_product_inventory_status failed (non-fatal): ${rpcErr.message}`);
          } else {
            console.log(`  ✓ inventory_status refreshed`);
          }
        }
      }
    }

    if (PAGE_DELAY_MS > 0 && i < batch.length - 1) {
      await page.waitForTimeout(PAGE_DELAY_MS);
    }
  }

  await browser.close();

  const runFinishedAt = new Date().toISOString();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log(' SYNC COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(` Run started          : ${runStartedAt}`);
  console.log(` Run finished         : ${runFinishedAt}`);
  console.log(` Products attempted   : ${attempted}`);
  console.log(` Products succeeded   : ${succeeded}`);
  console.log(` Products out of stock: ${outOfStock}`);
  console.log(` Products failed      : ${failed}`);
  console.log(` Inventory rows ${DRY_RUN ? '(dry)' : 'written'}: ${rowsWritten}`);
  if (DRY_RUN) console.log(` [DRY_RUN mode — no DB writes performed]`);

  if (outOfStockSkus.length > 0) {
    console.log('\n Out of stock (zeroed, not failures):');
    for (const o of outOfStockSkus) {
      console.log(`   ${o.productId}`);
      console.log(`   ${o.url}`);
    }
  }

  if (failedSkus.length > 0) {
    console.log('\n Failed products:');
    for (const f of failedSkus) {
      console.log(`   ${f.productId}  reason=${f.reason}`);
      console.log(`   ${f.url}`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // Exit non-zero so GitHub Actions marks the run as failed and sends a
  // failure notification email. Never expose secrets in this message.
  if (sessionExpired) {
    console.error('[FurnitureInventory] FAILED: GIGA session expired. No inventory was overwritten.');
    console.error('[FurnitureInventory] ACTION REQUIRED: Re-run saveGigaSession.ts, update GIGA_SESSION_B64 secret, then re-trigger the workflow.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[FurnitureInventory] Fatal:', err.message);
  process.exit(1);
});
