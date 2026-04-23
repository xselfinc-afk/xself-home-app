/**
 * Phase 1 — single-product GIGA seller portal inventory scraper.
 *
 * Interaction flow:
 *   1. Open product page (logged-in session)
 *   2. Scroll to the Warehouse Option section
 *   3. Click "Specified Warehouse (additional fee applies)"
 *   4. Wait for the Warehouse Quantity inventory table to render
 *   5. Extract all visible warehouse rows + fee + raw block
 *
 * Run (after saveGigaSession.ts):
 *   PRODUCT_URL="https://www.gigab2b.com/index.php?route=product/product&product_id=1304302" \
 *     HEADED=1 SCREENSHOT=1 npx tsx scripts/scrapeGigaInventory.ts
 *
 * Required:
 *   PRODUCT_URL        — full product page URL (no default — must be set)
 *
 * Optional:
 *   GIGA_SESSION_FILE  — saved session JSON path (default: scripts/.giga-session.json)
 *   HEADED=1           — show the browser window
 *   SCREENSHOT=1       — save before/after screenshots to scripts/.last-scrape*.png
 */

import 'dotenv/config';
import { chromium, Page } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import * as path from 'path';
import * as fs from 'fs';

// ── Config ──────────────────────────────────────────────────────────────────
const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');

const PRODUCT_URL = process.env.PRODUCT_URL ?? '';
const HEADED      = process.env.HEADED === '1';
const SCREENSHOT  = process.env.SCREENSHOT === '1';

const SS_BEFORE = path.join(process.cwd(), 'scripts', '.last-scrape-before.png');
const SS_AFTER  = path.join(process.cwd(), 'scripts', '.last-scrape-after.png');

// ── Warehouse code helpers ────────────────────────────────────────────────────
// Pattern covers codes like CA2, CA10, CAN1, CAX8, NJX3, AT4, ATX6, TXX1, etc.
const WH_CODE_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/gi;

function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';  // NJX3 = Elkton, MD
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
  /** Final quantity to use: exact value, or totalAvailable override for single-warehouse case */
  quantity: number | null;
  quantityRaw: string;          // original cell text, e.g. "8", "10+", "100+"
  /** true when quantity is exact; false when it is a floor ("10+" → floor=10, exact=false) */
  quantityExact: boolean;
  /** The floor value parsed from the raw text (same as quantity when exact) */
  quantityFloor: number | null;
  supportsPickup: boolean;
  supportsShipping: boolean;
};

type ScrapeResult = {
  supplierProductId: string | null;
  productUrl: string;
  scrapedAt: string;
  loginRequired: boolean;
  specifiedWarehouseClicked: boolean;
  selectorUsed: string | null;
  clickedElementText: string | null;
  inventoryVisibleAfterClick: boolean;
  specifiedWarehouseFee: string | null;
  /** Total available from top-level text, e.g. "141 Available" → 141 */
  totalAvailable: number | null;
  warehouseRows: WarehouseRow[];
  rawInventoryBlock: string;
  warnings: string[];
};

// ── Quantity parser ───────────────────────────────────────────────────────────
// Rules:
//   "8"    → floor=8,   exact=true   (plain integer — actual count)
//   "10+"  → floor=10,  exact=false  (10–19, lower bound only)
//   "100+" → floor=100, exact=false  (≥ 100, lower bound only)
//   "-", "In Stock", "" → floor=null, exact=false
function parseQty(raw: string): { floor: number | null; exact: boolean } {
  const hasPlus = raw.includes('+');
  const digits = raw.replace(/,/g, '').replace(/[^\d]/g, '');
  const n = digits ? parseInt(digits, 10) : NaN;
  const floor = isNaN(n) ? null : n;
  // Exact only when we have a number AND no "+" suffix
  return { floor, exact: floor !== null && !hasPlus };
}

// ── Total-available extractor ─────────────────────────────────────────────────
// Finds top-level text like "141 Available" or "110 Available" on the product page.
// Returns the numeric value, or null if not found.
function extractTotalAvailable(pageText: string): number | null {
  // Pattern: a standalone integer followed by "Available" (case-insensitive)
  // e.g. "141 Available", "110 Available", "110\nAvailable"
  const m = pageText.match(/\b(\d[\d,]*)\s+Available\b/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return isNaN(n) ? null : n;
}

// ── Find and click the "Specified Warehouse" label ───────────────────────────
//
// The radio input is hidden — clicking it directly has no effect.
// The clickable element is the <label> that wraps or is adjacent to the radio.
// We use label:has-text() which matches only the label element itself, not
// large ancestor containers.
//
async function clickSpecifiedWarehouse(page: Page): Promise<{
  clicked: boolean;
  selectorUsed: string | null;
  elementText: string | null;
  inventoryVisible: boolean;
  fee: string | null;
}> {
  // Scroll so the Warehouse Option row is in view
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.waitForTimeout(600);

  // Find the label — :has-text() matches elements whose text CONTAINS the string,
  // but <label> is a tight element so it won't match large parent divs.
  const label = page.locator('label:has-text("Specified Warehouse")').first();
  const count = await label.count();

  if (count === 0) {
    console.log('[scrapeGigaInventory] ✗ label:has-text("Specified Warehouse") — not found.');
    return { clicked: false, selectorUsed: null, elementText: null, inventoryVisible: false, fee: null };
  }

  const elementText = (await label.innerText().catch(() => '')).trim().slice(0, 100);
  console.log(`[scrapeGigaInventory] Found label: "${elementText}"`);

  // Click the label (not the hidden radio input)
  await label.click();
  console.log('[scrapeGigaInventory] ✓ Clicked Specified Warehouse label');

  // Wait for inventory table to load dynamically after click
  let inventoryVisible = false;
  try {
    await page.waitForFunction(
      () =>
        document.body.innerText.includes('Warehouse Quantity') ||
        /CA\d+|NJ\d+|AT\d+|TX\d+/i.test(document.body.innerText),
      { timeout: 10_000 },
    );
    inventoryVisible = true;
    console.log('[scrapeGigaInventory] ✓ Waiting inventory load complete');
  } catch {
    console.log('[scrapeGigaInventory] ⚠ Inventory did not appear within 10 s — proceeding anyway.');
  }

  // Hard wait: site finishes rendering table rows after the DOM signal
  await page.waitForTimeout(1_500);

  // Capture fee
  const fee: string | null = await page.evaluate(() => {
    const m = document.body.innerText.match(/additional[^$\n]*\$[\d.]+|\$[\d.]+[^$\n]*additional/i);
    if (m) return m[0].trim().slice(0, 60);
    const m2 = document.body.innerText.match(/specified\s+warehouse[^$\n]*\$[\d.]+/i);
    return m2 ? m2[0].trim().slice(0, 60) : null;
  }).catch(() => null);

  return {
    clicked: true,
    selectorUsed: 'label:has-text("Specified Warehouse")',
    elementText,
    inventoryVisible,
    fee,
  };
}

// ── Extract warehouse rows from the rendered page ─────────────────────────────
//
// Two-strategy approach:
//   A. DOM structured: <tr> rows (real tables) + parent-of-code-cell (div tables)
//   B. Section text:   collect lines under "Warehouse Quantity" heading;
//                      when qty absent on code line, check next 1–2 lines
//
// Raw text of every candidate container is logged before parsing.
//
async function extractWarehouseRows(page: Page): Promise<{
  rows: WarehouseRow[];
  rawBlock: string;
}> {
  // ── A. DOM structured extraction ──────────────────────────────────────────
  type DomRow = { text: string; source: string };

  const domRows: DomRow[] = await page.evaluate((): { text: string; source: string }[] => {
    const WH_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/i;
    const CODE_ONLY_RE = /^(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)$/i;
    const results: { text: string; source: string }[] = [];

    // Strategy A1: real <tr> rows
    document.querySelectorAll('tr').forEach(el => {
      const t = (el as HTMLElement).innerText?.trim() ?? '';
      if (WH_RE.test(t) && t.length < 500) {
        results.push({ text: t, source: 'tr' });
      }
    });

    // Strategy A2: element whose text IS exactly a warehouse code —
    // grab its parent row text (for div/flex tables) and next sibling text
    document.querySelectorAll('td, span, div, p').forEach(el => {
      const own = (el as HTMLElement).innerText?.trim() ?? '';
      if (!CODE_ONLY_RE.test(own)) return;

      // Parent container text (bounded to avoid giant wrappers)
      const parent = el.parentElement;
      if (parent) {
        const pt = (parent as HTMLElement).innerText?.trim() ?? '';
        if (pt.length < 500 && WH_RE.test(pt)) {
          results.push({ text: pt, source: 'parent-of-code-cell' });
        }
      }

      // Concatenate code + every next-sibling text to form a synthetic row
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

  // ── B. Section text extraction ─────────────────────────────────────────────
  const pageText: string = await page.evaluate(() => document.body?.innerText ?? '');
  const allLines = pageText.split('\n').map(l => l.trim()).filter(Boolean);

  // Locate "Warehouse Quantity" section heading
  let sectionStart = -1;
  for (let i = 0; i < allLines.length; i++) {
    if (/warehouse\s+quantity|仓库库存/i.test(allLines[i])) { sectionStart = i + 1; break; }
  }

  const sectionLines = sectionStart >= 0
    ? allLines.slice(sectionStart, sectionStart + 60)
    : [];

  // Raw block for display — section lines if found, else all lines with WH codes
  WH_CODE_RE.lastIndex = 0;
  const rawBlock = sectionLines.length > 0
    ? sectionLines.join('\n')
    : allLines.filter(l => { WH_CODE_RE.lastIndex = 0; return WH_CODE_RE.test(l); }).join('\n');

  // ── Parse ─────────────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const rows: WarehouseRow[] = [];

  /**
   * Parse one row text (and optionally adjacent lines) into a WarehouseRow.
   * lineIdx + contextLines enables adjacent-line qty lookup when the quantity
   * is in the next cell/line rather than the same text node.
   */
  function parseCandidate(
    text: string,
    lineIdx: number,
    contextLines: string[],
    source: string,
  ): WarehouseRow | null {
    WH_CODE_RE.lastIndex = 0;
    const codeMatches = [...text.matchAll(WH_CODE_RE)].map(m => m[0].toUpperCase());
    if (codeMatches.length === 0) return null;

    const code = codeMatches.find(c => warehouseState(c) !== null) ?? codeMatches[0];
    if (seen.has(code)) return null;
    seen.add(code);

    // Log raw text before parsing — critical for debugging qty extraction
    console.log(`[scrapeGigaInventory] [${source}] raw row for ${code}: "${text.slice(0, 200)}"`);

    // Quantity search: same text first, then next 1–2 context lines
    // Guard: (?<![A-Z]) prevents matching digits inside warehouse codes (e.g. "3" in "AT3")
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
      quantity: floor,           // may be overridden after extraction if single-warehouse
      quantityRaw: qtyRaw || '(not detected)',
      quantityExact: exact,
      quantityFloor: floor,
      supportsPickup: supportsPickup(code) || pickupHint,
      supportsShipping: !supportsPickup(code) || shippingHint,
    };
  }

  // Priority: DOM rows first (most structured), then section-text lines
  for (const { text, source } of domRows) {
    const row = parseCandidate(text, 0, [], source);
    if (row) rows.push(row);
  }

  // Section text fallback — with adjacent-line qty lookup
  if (rows.length === 0) {
    for (let i = 0; i < sectionLines.length; i++) {
      WH_CODE_RE.lastIndex = 0;
      if (!WH_CODE_RE.test(sectionLines[i])) continue;
      const row = parseCandidate(sectionLines[i], i, sectionLines, 'section-text');
      if (row) rows.push(row);
    }
  }

  // Last resort: any WH-code line in the full page text
  if (rows.length === 0) {
    for (let i = 0; i < allLines.length; i++) {
      WH_CODE_RE.lastIndex = 0;
      if (!WH_CODE_RE.test(allLines[i])) continue;
      const row = parseCandidate(allLines[i], i, allLines, 'full-page-text');
      if (row) rows.push(row);
    }
  }

  return { rows, rawBlock };
}

// ── URL resolver ─────────────────────────────────────────────────────────────
// giga_products stores URLs like ?route=product/product&sku=N725S412541K,
// but the new GIGA portal requires the numeric ?product_id=1315793 format.
// When a sku= URL is detected, this function searches the portal to find the
// correct product_id URL before scraping.
async function resolveProductUrl(page: Page, rawUrl: string): Promise<string> {
  let parsed: URL;
  try { parsed = new URL(rawUrl); } catch { return rawUrl; }

  // Already correct format — nothing to resolve
  if (parsed.searchParams.has('product_id')) return rawUrl;

  const sku = parsed.searchParams.get('sku') ?? parsed.searchParams.get('itemNo');
  if (!sku) return rawUrl;

  const searchUrl = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(sku)}`;
  console.log(`[scrapeGigaInventory] Resolving SKU ${sku} via portal search...`);

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch {
    console.log(`[scrapeGigaInventory] Search page load timeout — using original URL`);
    return rawUrl;
  }

  const links: string[] = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href*="product_id"]'))
      .map(a => (a as HTMLAnchorElement).href)
  );

  if (links.length === 0) {
    console.log(`[scrapeGigaInventory] No product_id link found for SKU ${sku} — using original URL`);
    return rawUrl;
  }

  console.log(`[scrapeGigaInventory] Resolved: ${links[0]}`);
  return links[0];
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!PRODUCT_URL) {
    console.error(
      '[scrapeGigaInventory] ERROR: PRODUCT_URL is not set.\n' +
      '  Example:\n' +
      '    PRODUCT_URL="https://www.gigab2b.com/index.php?route=product/product&product_id=1304302" \\\n' +
      '      npx tsx scripts/scrapeGigaInventory.ts',
    );
    process.exit(1);
  }

  if (!fs.existsSync(SESSION_FILE)) {
    console.error(
      '[scrapeGigaInventory] ERROR: Session file not found:', SESSION_FILE, '\n' +
      '  Run: GIGA_LOGIN_URL="https://www.gigab2b.com/index.php?route=common/home" \\\n' +
      '         npx tsx scripts/saveGigaSession.ts',
    );
    process.exit(1);
  }

  console.log('\n[scrapeGigaInventory] Product URL  :', PRODUCT_URL);
  console.log('[scrapeGigaInventory] Session file :', SESSION_FILE);
  console.log('[scrapeGigaInventory] Headed:', HEADED, '| Screenshot:', SCREENSHOT);
  console.log('');

  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 0 });
  const context  = await browser.newContext({ storageState: SESSION_FILE });
  const page     = await context.newPage();

  // ── 0. Resolve product URL (sku= → product_id= if needed) ─────────────────
  const resolvedUrl = await resolveProductUrl(page, PRODUCT_URL);

  const result: ScrapeResult = {
    supplierProductId: null,
    productUrl: resolvedUrl,
    scrapedAt: new Date().toISOString(),
    loginRequired: false,
    specifiedWarehouseClicked: false,
    selectorUsed: null,
    clickedElementText: null,
    inventoryVisibleAfterClick: false,
    specifiedWarehouseFee: null,
    totalAvailable: null,
    warehouseRows: [],
    rawInventoryBlock: '',
    warnings: [],
  };

  // ── 1. Navigate ────────────────────────────────────────────────────────────
  try {
    await page.goto(resolvedUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } catch (e) {
    result.warnings.push(`Page load timeout — continuing with partial content: ${(e as Error).message.slice(0, 100)}`);
  }

  const finalUrl  = page.url();
  const earlyText = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? '');

  // ── 2. Session check ───────────────────────────────────────────────────────
  const isLoginPage = /log\s*in|sign\s*in|password/i.test(earlyText)
    && !/product|warehouse|shipping/i.test(earlyText);

  if (isLoginPage || /login|sign-in/i.test(finalUrl)) {
    result.loginRequired = true;
    result.warnings.push('Session expired — re-run saveGigaSession.ts');
    printResult(result);
    await browser.close();
    return;
  }

  // ── 3. Extract supplier_product_id ────────────────────────────────────────
  const urlParams = new URL(finalUrl).searchParams;
  result.supplierProductId =
    urlParams.get('product_id') ??
    urlParams.get('sku') ??
    urlParams.get('itemNo') ??
    urlParams.get('id') ??
    null;

  console.log('[scrapeGigaInventory] supplier_product_id (from URL):', result.supplierProductId);

  // ── 4. Screenshot before interaction ──────────────────────────────────────
  if (SCREENSHOT) {
    await page.screenshot({ path: SS_BEFORE, fullPage: false });
    console.log('[scrapeGigaInventory] Screenshot (before):', SS_BEFORE);
  }

  // ── 5. Click "Specified Warehouse" ────────────────────────────────────────
  console.log('[scrapeGigaInventory] Looking for "Specified Warehouse" radio...');
  const { clicked, selectorUsed, elementText, inventoryVisible, fee } =
    await clickSpecifiedWarehouse(page);

  result.specifiedWarehouseClicked  = clicked;
  result.selectorUsed               = selectorUsed;
  result.clickedElementText         = elementText;
  result.inventoryVisibleAfterClick = inventoryVisible;
  result.specifiedWarehouseFee      = fee;

  if (!clicked) {
    result.warnings.push(
      '"Specified Warehouse" radio not found. ' +
      'Try HEADED=1 SCREENSHOT=1 to inspect the page and share the DOM structure.',
    );
  } else if (!inventoryVisible) {
    result.warnings.push(
      'Radio was clicked but "Warehouse Quantity" did not appear. ' +
      'The click may have hit the wrong element — check clickedElementText above.',
    );
  }

  // ── 6. Screenshot after interaction ───────────────────────────────────────
  if (SCREENSHOT) {
    await page.screenshot({ path: SS_AFTER, fullPage: false });
    console.log('[scrapeGigaInventory] Screenshot (after click):', SS_AFTER);
  }

  // ── 7. Extract warehouse rows + total available ────────────────────────────
  console.log('[scrapeGigaInventory] Extracting warehouse rows...');
  const { rows, rawBlock } = await extractWarehouseRows(page);

  // Extract top-level total available (e.g. "141 Available")
  const fullPageText: string = await page.evaluate(() => document.body?.innerText ?? '');
  result.totalAvailable = extractTotalAvailable(fullPageText);
  if (result.totalAvailable !== null) {
    console.log(`[scrapeGigaInventory] Total available (top-level): ${result.totalAvailable}`);
  }

  // Single-warehouse override: when exactly one row exists and totalAvailable is known,
  // the total IS the exact quantity for that warehouse.
  if (rows.length === 1 && result.totalAvailable !== null) {
    const row = rows[0];
    console.log(
      `[scrapeGigaInventory] Single warehouse (${row.warehouseCode}): overriding quantity ` +
      `${row.quantityFloor}${row.quantityExact ? '' : '+'} → ${result.totalAvailable} (exact, from totalAvailable)`,
    );
    row.quantity      = result.totalAvailable;
    row.quantityExact = true;
    // quantityRaw and quantityFloor preserved for debugging
  }

  result.warehouseRows      = rows;
  result.rawInventoryBlock  = rawBlock;

  if (rows.length === 0) {
    result.warnings.push(
      'No warehouse rows found after clicking Specified Warehouse. ' +
      'The inventory table may use a structure the parser does not yet recognise. ' +
      'Run with HEADED=1 SCREENSHOT=1 and inspect .last-scrape-after.png.',
    );
  }

  // Write to Supabase inventory_cache (skips gracefully if creds not set)
  await writeToSupabase(result);

  printResult(result);
  await browser.close();
}

// ── Supabase write ────────────────────────────────────────────────────────────
async function writeToSupabase(result: ScrapeResult): Promise<void> {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('[Supabase] Skipping write — set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to enable');
    return;
  }
  if (!result.supplierProductId) {
    console.log('[Supabase] Skipping write — supplierProductId not detected');
    return;
  }
  if (result.warehouseRows.length === 0) {
    console.log('[Supabase] Skipping write — no warehouse rows to upsert');
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date().toISOString();
  const rows = result.warehouseRows.map(row => ({
    product_id:          result.supplierProductId!,
    supplier_product_id: result.supplierProductId!,
    warehouse_code:      row.warehouseCode,
    warehouse_state:     row.state,
    warehouse_city:      null,                   // city lookup not needed for inventory logic
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
    raw_payload:         result as unknown as Record<string, unknown>,
  }));

  const { error } = await supabase
    .from('inventory_cache')
    .upsert(rows, { onConflict: 'product_id,warehouse_code' });

  if (error) {
    console.log('[Supabase] ✗ Write error:', error.message);
  } else {
    console.log(`[Supabase] ✓ Upserted ${rows.length} row(s) for product_id=${result.supplierProductId}`);
  }
}

// ── Pretty-print ──────────────────────────────────────────────────────────────
function printResult(r: ScrapeResult) {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(' GIGA INVENTORY SCRAPE RESULT');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' supplier_product_id         :', r.supplierProductId ?? '(not detected)');
  console.log(' url                         :', r.productUrl);
  console.log(' scraped_at                  :', r.scrapedAt);
  console.log(' login_required              :', r.loginRequired);
  console.log(' specified_warehouse_clicked :', r.specifiedWarehouseClicked);
  console.log(' selector_used               :', r.selectorUsed ?? '(none)');
  console.log(' clicked_element_text        :', r.clickedElementText?.slice(0, 80) ?? '(none)');
  console.log(' inventory_visible_after_click:', r.inventoryVisibleAfterClick);
  console.log(' specified_warehouse_fee     :', r.specifiedWarehouseFee ?? '(not detected)');
  console.log(' total_available             :', r.totalAvailable ?? '(not found)');
  console.log(' warehouse_rows_found        :', r.warehouseRows.length);
  console.log('');

  if (r.loginRequired) {
    console.log(' ⚠  Session expired.');
    console.log('     Re-run: GIGA_LOGIN_URL="..." npx tsx scripts/saveGigaSession.ts');
    console.log('');
    return;
  }

  if (r.warehouseRows.length > 0) {
    console.log(' WAREHOUSE STOCK TABLE');
    console.log(
      ' ' +
      'CODE'.padEnd(10) +
      'STATE'.padEnd(8) +
      'QTY'.padEnd(8) +
      'EXACT?'.padEnd(8) +
      'FLOOR'.padEnd(8) +
      'RAW'.padEnd(12) +
      'PICKUP'.padEnd(8) +
      'SHIP',
    );
    console.log(' ' + '─'.repeat(72));
    for (const row of r.warehouseRows) {
      console.log(
        ' ' +
        row.warehouseCode.padEnd(10) +
        (row.state ?? '?').padEnd(8) +
        String(row.quantity ?? '-').padEnd(8) +
        (row.quantityExact ? 'yes' : 'no').padEnd(8) +
        String(row.quantityFloor ?? '-').padEnd(8) +
        row.quantityRaw.padEnd(12) +
        (row.supportsPickup ? 'yes' : 'no').padEnd(8) +
        (row.supportsShipping ? 'yes' : 'no'),
      );
    }
    console.log('');
  }

  if (r.rawInventoryBlock) {
    console.log(' RAW INVENTORY TEXT BLOCK');
    console.log(' ─────────────────────────────────────────────────────────');
    r.rawInventoryBlock.split('\n').slice(0, 40).forEach(l => console.log(' ' + l));
    if (r.rawInventoryBlock.split('\n').length > 40) console.log(' ... (truncated)');
    console.log('');
  } else {
    console.log(' (no inventory text block detected)');
    console.log('');
  }

  if (r.warnings.length > 0) {
    console.log(' WARNINGS');
    r.warnings.forEach(w => console.log('  ⚠  ' + w));
    console.log('');
  }

  console.log(' JSON (machine-readable):');
  console.log(JSON.stringify(r, null, 2));
  console.log('══════════════════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('[scrapeGigaInventory] Fatal:', err.message);
  process.exit(1);
});
