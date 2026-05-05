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
  path.join(process.cwd(), 'scripts', '.giga-session.json');

const DRY_RUN        = process.env.DRY_RUN === '1';
const HEADED         = process.env.HEADED === '1';
const INVENTORY_LIMIT = process.env.INVENTORY_LIMIT
  ? parseInt(process.env.INVENTORY_LIMIT, 10)
  : Infinity;
const PAGE_DELAY_MS = process.env.PAGE_DELAY_MS
  ? parseInt(process.env.PAGE_DELAY_MS, 10)
  : 1200;

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

// ── URL resolver — same logic as scrapeGigaInventory.ts ──────────────────────
// giga_products stores URLs like ?route=product/product&sku=N725S412541K,
// but the new GIGA portal requires ?product_id=1315793 (numeric).
async function resolveProductUrl(page: Page, rawUrl: string): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }

  if (parsed.searchParams.has('product_id')) return rawUrl;

  const sku = parsed.searchParams.get('sku') ?? parsed.searchParams.get('itemNo');
  if (!sku) return rawUrl;

  const searchUrl = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(sku)}`;
  console.log(`  [resolve] SKU ${sku} → searching portal...`);

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch {
    console.log(`  [resolve] Search page timeout — using original URL`);
    return rawUrl;
  }

  const links: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="product_id"]'))
      .map(a => (a as HTMLAnchorElement).href)
  );

  if (links.length === 0) {
    console.log(`  [resolve] No product_id link found for SKU ${sku} — using original URL`);
    return rawUrl;
  }

  console.log(`  [resolve] → ${links[0]}`);
  return links[0];
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
  console.log(` DRY_RUN         : ${DRY_RUN}`);
  console.log(` HEADED          : ${HEADED}`);
  console.log(` INVENTORY_LIMIT : ${isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : 'all'}`);
  console.log(` PAGE_DELAY_MS   : ${PAGE_DELAY_MS}`);
  console.log(` SESSION_FILE    : ${SESSION_FILE}`);
  console.log('═══════════════════════════════════════════════════════════════════\n');

  // ── Fetch product list from giga_products ───────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: products, error: fetchError } = await supabase
    .from('giga_products')
    .select('product_id, product_url, title')
    .eq('top_category', 'Furniture')
    .neq('product_url', '')
    .order('last_synced_at', { ascending: false });

  if (fetchError) {
    console.error('[FurnitureInventory] Failed to fetch giga_products:', fetchError.message);
    process.exit(1);
  }

  if (!products || products.length === 0) {
    console.log('[FurnitureInventory] No Furniture products found in giga_products — nothing to do.');
    return;
  }

  const allProducts = products.filter(p => p.product_url?.startsWith('http'));
  const batch = allProducts.slice(0, isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : allProducts.length);

  console.log(`[FurnitureInventory] Products in giga_products (Furniture): ${allProducts.length}`);
  console.log(`[FurnitureInventory] Batch size this run               : ${batch.length}\n`);

  // ── Launch browser ──────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 60 : 0 });
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page = await context.newPage();

  const runStartedAt = new Date().toISOString();

  // ── Stats ───────────────────────────────────────────────────────────────────
  let attempted     = 0;
  let succeeded     = 0;
  let failed        = 0;
  let rowsWritten   = 0;
  let sessionExpired = false;
  const failedSkus: { productId: string; url: string; reason: string }[] = [];

  // ── Batch loop ──────────────────────────────────────────────────────────────
  for (let i = 0; i < batch.length; i++) {
    const product = batch[i];
    attempted++;

    const logPrefix = `[${i + 1}/${batch.length}] ${product.product_id}`;
    const title = (product.title as string | null)?.slice(0, 60) ?? '(no title)';
    console.log(`\n${logPrefix} — ${title}`);
    console.log(`  URL: ${product.product_url}`);

    const result: ProductScrapeResult = {
      productId: product.product_id as string,
      productUrl: product.product_url as string,
      title,
      loginRequired: false,
      specifiedWarehouseClicked: false,
      inventoryVisibleAfterClick: false,
      totalAvailable: null,
      warehouseRows: [],
      warnings: [],
    };

    try {
      // ── 0. Resolve URL (sku= → product_id= if needed) ───────────────────────
      const resolvedUrl = await resolveProductUrl(page, product.product_url as string);
      if (resolvedUrl !== product.product_url) {
        result.productUrl = resolvedUrl;
      }

      // ── 1. Navigate ─────────────────────────────────────────────────────────
      try {
        await page.goto(resolvedUrl, { waitUntil: 'networkidle', timeout: 30_000 });
      } catch (e) {
        result.warnings.push(`Page load timeout — continuing: ${(e as Error).message.slice(0, 80)}`);
      }

      const finalUrl = page.url();
      const earlyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? '');

      // ── 2. Session check ────────────────────────────────────────────────────
      const isLoginPage =
        /log\s*in|sign\s*in|password/i.test(earlyText) &&
        !/product|warehouse|shipping/i.test(earlyText);

      if (isLoginPage || /login|sign-in/i.test(finalUrl)) {
        result.loginRequired = true;
        result.warnings.push('Session expired — re-run saveGigaSession.ts then restart batch');
        console.log(`  ✗ Session expired — aborting batch`);
        failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: 'session_expired' });
        failed++;
        sessionExpired = true;
        // Session expired: abort entire batch (all remaining would also fail)
        break;
      }

      // ── 3. Click "Specified Warehouse" ──────────────────────────────────────
      const { clicked, inventoryVisible } = await clickSpecifiedWarehouse(page);
      result.specifiedWarehouseClicked  = clicked;
      result.inventoryVisibleAfterClick = inventoryVisible;

      if (!clicked) {
        result.warnings.push('"Specified Warehouse" label not found on this page');
        console.log(`  ⚠ "Specified Warehouse" not found — skipping`);
        failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: 'no_warehouse_radio' });
        failed++;
        if (PAGE_DELAY_MS > 0) await page.waitForTimeout(PAGE_DELAY_MS);
        continue;
      }

      if (!inventoryVisible) {
        result.warnings.push('Radio clicked but Warehouse Quantity table did not appear');
        console.log(`  ⚠ Inventory table did not appear after click`);
      }

      // ── 4. Extract warehouse rows + total available ─────────────────────────
      const { rows } = await extractWarehouseRows(page);
      const fullPageText: string = await page.evaluate(() => document.body?.innerText ?? '');
      result.totalAvailable = extractTotalAvailable(fullPageText);

      // Single-warehouse override (same rule as scrapeGigaInventory.ts)
      if (rows.length === 1 && result.totalAvailable !== null) {
        rows[0].quantity      = result.totalAvailable;
        rows[0].quantityExact = true;
        console.log(
          `  ↳ Single warehouse (${rows[0].warehouseCode}): quantity overridden to ${result.totalAvailable} (from totalAvailable)`,
        );
      }

      result.warehouseRows = rows;

      if (rows.length === 0) {
        result.warnings.push('No warehouse rows extracted — page may have different DOM structure');
        console.log(`  ⚠ No warehouse rows found`);
        failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: 'no_rows_extracted' });
        failed++;
        if (PAGE_DELAY_MS > 0) await page.waitForTimeout(PAGE_DELAY_MS);
        continue;
      }

      // ── 5. Log extracted data ───────────────────────────────────────────────
      console.log(`  totalAvailable: ${result.totalAvailable ?? '(not found)'}`);
      for (const row of rows) {
        console.log(
          `  ${row.warehouseCode.padEnd(10)} state=${row.state ?? '?'}  ` +
          `qty=${row.quantity ?? '-'}  exact=${row.quantityExact}  raw="${row.quantityRaw}"`,
        );
      }

      // ── 6. Write to Supabase (skip in DRY_RUN) ──────────────────────────────
      if (DRY_RUN) {
        console.log(`  [DRY_RUN] Would upsert ${rows.length} row(s) — skipping DB write`);
        succeeded++;
        rowsWritten += rows.length; // count for dry-run summary
      } else {
        const { rowsWritten: written, error: writeErr } = await writeToSupabase(result, supabase);
        if (writeErr) {
          console.log(`  ✗ DB write failed: ${writeErr}`);
          result.warnings.push(`DB write failed: ${writeErr}`);
          failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: `db_write: ${writeErr}` });
          failed++;
        } else {
          console.log(`  ✓ Upserted ${written} inventory row(s)`);
          succeeded++;
          rowsWritten += written;

          // Refresh aggregated inventory status on standardized_products immediately
          // so sellable_products view reflects this product's real stock.
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

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ Unexpected error: ${msg.slice(0, 120)}`);
      result.warnings.push(`Unexpected error: ${msg.slice(0, 120)}`);
      failedSkus.push({ productId: product.product_id as string, url: product.product_url as string, reason: `error: ${msg.slice(0, 80)}` });
      failed++;
    }

    // ── Inter-product delay ────────────────────────────────────────────────────
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
  console.log(` Products failed      : ${failed}`);
  console.log(` Inventory rows ${DRY_RUN ? '(dry)' : 'written'}: ${rowsWritten}`);
  if (DRY_RUN) console.log(` [DRY_RUN mode — no DB writes performed]`);

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
