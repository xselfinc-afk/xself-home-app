/**
 * Variant backfill from GIGA `raw_payload.associateProductList`.
 *
 * Phase 1 finding: every supplier_products.raw_payload carries an
 * `associateProductList` array naming every sibling SKU in the same family
 * (color variants) plus cross-sell SKUs. The normalization pipeline never
 * read this field, so most families landed in the app with only a subset of
 * their colors.
 *
 * Strategy:
 *   1. Walk existing supplier_products rows, classify each associate SKU as a
 *      true family variant (shared SKU prefix ≥ 8 chars) or a cross-sell.
 *   2. Skip variants already in supplier_products.
 *   3. Fetch detail + price for missing variants via the GIGA Open API.
 *   4. If the API returns no usable record for a SKU (e.g. GIGA's transient
 *      `code:0 / "Oops…"` envelope), fall back to a Playwright scrape of the
 *      seller-portal product page using the saved session file.
 *   5. Upsert into supplier_products via the shared helper.
 *   6. Run normalizeProduct → standardized_products.
 *
 * Safe by default — writes only when APPLY=1 is set. Idempotent on re-run.
 *
 * Usage
 *   # Single family, dry-run (no writes):
 *   ROOT_SKU=N710P206904 npx dotenv -e .env.local -- npx tsx scripts/syncGigaVariants.ts
 *
 *   # Whole catalog, dry-run:
 *   npx dotenv -e .env.local -- npx tsx scripts/syncGigaVariants.ts
 *
 *   # Cap how many missing SKUs to process this run:
 *   LIMIT=10 npx dotenv -e .env.local -- npx tsx scripts/syncGigaVariants.ts
 *
 *   # Real writes (requires SUPPLIER_* creds):
 *   APPLY=1 ROOT_SKU=N710P206904 npx dotenv -e .env.local -- npx tsx scripts/syncGigaVariants.ts
 *
 * Required env
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY                          (always)
 *   SUPPLIER_API_BASE_URL, SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET (API path)
 *
 * Optional env
 *   GIGA_SESSION_FILE   Playwright storageState path (default: scripts/.giga-session.json)
 *   HEADED=1            Show the Playwright browser window during fallback
 *   PAGE_DELAY_MS       ms between scraped pages (default 1200)
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { chromium, Page } from 'playwright';
import { fetchProductDetails, fetchProductPrices } from '../src/services/gigaApiClient';
import { upsertPickupProducts } from '../src/services/supplierPickupService';
import { normalizeProduct } from '../src/services/normalizationPipeline';
import { PRODUCT_IMAGE_DENY_RE } from '../src/utils/productImageRules';
import { selectFamilySellingPrice } from '../src/services/productResolvers';

// ── Config ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ROOT_SKU = (process.env.ROOT_SKU ?? '').trim() || null;
const LIMIT = process.env.LIMIT
  ? Math.max(1, parseInt(process.env.LIMIT, 10) || 0)
  : Infinity;
const APPLY = process.env.APPLY === '1';
const DRY_RUN = !APPLY;
const PREFIX_MIN_MATCH = 8;
const FETCH_BATCH = 10;
const API_DELAY_MS = 600;

const SESSION_FILE =
  process.env.GIGA_SESSION_FILE ??
  path.join(process.cwd(), 'scripts', '.giga-session.json');
const HEADED = process.env.HEADED === '1';
const PAGE_DELAY_MS = process.env.PAGE_DELAY_MS
  ? parseInt(process.env.PAGE_DELAY_MS, 10) || 1200
  : 1200;
const PAGE_TIMEOUT_MS = 30_000;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[syncGigaVariants] FATAL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
  console.error('  Hint: invoke via `npx dotenv -e .env.local -- npx tsx scripts/syncGigaVariants.ts`');
  process.exit(1);
}

const hasSupplierCreds = !!(
  process.env.SUPPLIER_API_BASE_URL &&
  process.env.SUPPLIER_CLIENT_ID &&
  process.env.SUPPLIER_CLIENT_SECRET
);

if (APPLY && !hasSupplierCreds) {
  console.error('[syncGigaVariants] FATAL: APPLY=1 requires SUPPLIER_API_BASE_URL, SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function longestCommonPrefix(a: string, b: string): string {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return a.slice(0, i);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractItems(res: unknown): Array<Record<string, unknown>> {
  const r = res as { data?: unknown };
  const d = r?.data as
    | { records?: unknown; list?: unknown; items?: unknown }
    | unknown[]
    | undefined;
  if (!d) return [];
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  const inner = d as { records?: unknown; list?: unknown; items?: unknown };
  const candidate = inner.records ?? inner.list ?? inner.items;
  return Array.isArray(candidate) ? (candidate as Array<Record<string, unknown>>) : [];
}

async function fetchInBatches(
  label: string,
  skus: string[],
  fn: (batch: string[]) => Promise<Array<Record<string, unknown>>>,
): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < skus.length; i += FETCH_BATCH) {
    const batch = skus.slice(i, i + FETCH_BATCH);
    const end = Math.min(i + FETCH_BATCH, skus.length);
    process.stdout.write(`  ${label} batch ${i + 1}-${end}/${skus.length} ... `);
    try {
      const items = await fn(batch);
      for (const item of items) {
        const sku = item.sku;
        if (typeof sku === 'string') map.set(sku, item);
      }
      process.stdout.write(`✓ ${items.length}\n`);
    } catch (e) {
      process.stdout.write(`✗ ${(e as Error).message.slice(0, 80)}\n`);
    }
    if (i + FETCH_BATCH < skus.length) await delay(API_DELAY_MS);
  }
  return map;
}

// ── Playwright fallback ───────────────────────────────────────────────────────

type PwResponse = import('playwright').Response;

/**
 * Scrape one GIGA seller-portal product page using the saved login session.
 *
 * Returns a raw_payload-shaped object whose field names mirror the normal
 * `detailInfo/v1` response (productName, mainColor, mainImageUrl, imageUrls,
 * price, mainMaterial, assembledLength/Width/Height/Weight, category,
 * description, associateProductList) so normalizeProduct can consume it
 * unchanged. Returns null when the session is expired or the page yields too
 * little usable data; the caller skips that SKU and continues.
 */
async function scrapeSkuViaPlaywright(
  page: Page,
  sku: string,
): Promise<Record<string, unknown> | null> {
  // Resolve sku=<X> → product_id=<numeric> via portal search. GIGA's SPA
  // serves a near-empty shell when given ?sku= directly; the search route
  // returns a product-card link that includes the numeric product_id, which
  // does render the full detail page. Same approach as resolveProductUrl in
  // scripts/syncGigaFurnitureInventory.ts.
  let resolvedUrl = `https://www.gigab2b.com/index.php?route=product/product&sku=${encodeURIComponent(sku)}`;
  try {
    const searchUrl = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(sku)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
    const links: string[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="product_id"]')).map(
        a => (a as HTMLAnchorElement).href,
      ),
    );
    if (links.length > 0) {
      resolvedUrl = links[0];
    }
  } catch {
    // Search failed — fall through with the sku= URL
  }

  // Opportunistically capture the baseInfos XHR (confirmed in
  // scripts/probeGigaProductXhr.ts). When present, its structured JSON is
  // preferred over DOM scraping for non-image fields.
  let baseInfos: Record<string, unknown> | null = null;
  const captureResponse = async (resp: PwResponse): Promise<void> => {
    if (baseInfos) return;
    if (!/\/product\/info\/info\/baseInfos/.test(resp.url())) return;
    try {
      const body = await resp.json();
      if (body && typeof body === 'object') {
        baseInfos = body as Record<string, unknown>;
      }
    } catch {
      // non-JSON or stream — ignore
    }
  };
  page.on('response', captureResponse);

  try {
    await page.goto(resolvedUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
  } catch {
    // Continue — partial DOM may still be usable
  }
  // Settle deferred XHRs + lazy image loads
  await page.waitForTimeout(1500);

  page.off('response', captureResponse);

  // Session validity check
  const earlyText = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? '');
  const finalUrl = page.url();
  const sessionExpired =
    (/log\s*in|sign\s*in|password/i.test(earlyText) && !/product|warehouse|category/i.test(earlyText)) ||
    /login|sign-in/i.test(finalUrl);
  if (sessionExpired) {
    console.warn(`    ${sku}: ✗ session expired — re-run scripts/saveGigaSession.ts`);
    return null;
  }

  // DOM extraction. The deny regex is constructed in Node from the shared
  // source (src/utils/productImageRules.ts) and passed in as args so the
  // browser context reconstructs the same pattern without duplicating its
  // keyword list. PRODUCT_HOST_RE (allowlist) stays inlined — it is
  // scrape-specific and has no normalize-time counterpart.
  const domData = await page.evaluate(({ denySource, denyFlags }) => {
    function abs(u: string): string {
      const v = u.trim();
      if (!v) return '';
      if (v.startsWith('//')) return 'https:' + v;
      if (v.startsWith('/')) return 'https://www.gigab2b.com' + v;
      if (/^https?:\/\//i.test(v)) return v;
      return '';
    }

    const PRODUCT_HOST_RE = /b2bfiles\d*\.gigab2b\.cn|cdn\.gigab2b|gigab2b\.com\/image|gigab2b\.cn\/image/i;
    const NON_PRODUCT_RE = new RegExp(denySource, denyFlags);

    const imgs = new Set<string>();
    document.querySelectorAll<HTMLImageElement>('img').forEach(img => {
      const candidates = [
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-lazy-src'),
        img.currentSrc,
      ];
      for (const c of candidates) {
        if (!c) continue;
        const u = abs(c);
        if (!u) continue;
        if (NON_PRODUCT_RE.test(u)) continue;
        if (!PRODUCT_HOST_RE.test(u)) continue;
        imgs.add(u);
      }
    });

    const titleSelectors = ['h1', '.product-title', '.product-name', '[class*="product"][class*="title"]'];
    let title = '';
    for (const s of titleSelectors) {
      const el = document.querySelector(s);
      const t = el?.textContent?.trim() ?? '';
      if (t && t.length > 5 && t.length < 400) {
        title = t;
        break;
      }
    }
    if (!title) {
      const docT = (document.title ?? '').trim();
      if (docT) title = docT.split('|')[0].trim();
    }

    const bodyText = (document.body?.innerText ?? '').replace(/[ \t]+/g, ' ');
    const pickAfter = (re: RegExp, maxLen = 80): string => {
      const m = bodyText.match(re);
      if (!m) return '';
      return m[1].trim().slice(0, maxLen);
    };

    const mainColor = pickAfter(/Main\s*Color[\s:：]+([^\n\r]{2,40})/i, 40);
    const mainMaterial = pickAfter(/Main\s*Material[\s:：]+([^\n\r]{2,80})/i, 80);

    let assembledLength = '';
    let assembledWidth = '';
    let assembledHeight = '';
    const dimMatch = bodyText.match(
      /(?:Assembled|Product)\s*Dimensions[\s:：]*([\d.]+)\s*[×x]\s*([\d.]+)\s*[×x]\s*([\d.]+)/i,
    );
    if (dimMatch) {
      assembledLength = dimMatch[1];
      assembledWidth = dimMatch[2];
      assembledHeight = dimMatch[3];
    }

    let assembledWeight = '';
    const wMatch = bodyText.match(/(?:Assembled\s*)?Weight[\s:：]*([\d.]+\s*(?:lbs?|kg))/i);
    if (wMatch) assembledWeight = wMatch[1];

    let price = 0;
    const pMatch = bodyText.match(/\$\s*(\d[\d,]*(?:\.\d{2})?)/);
    if (pMatch) price = parseFloat(pMatch[1].replace(/,/g, '')) || 0;

    let category = '';
    const breadcrumbEl = document.querySelector(
      '.breadcrumb, [class*="breadcrumb"], nav[aria-label*="breadcrumb" i]',
    );
    if (breadcrumbEl) {
      const parts = (breadcrumbEl.textContent ?? '')
        .split(/[›>\/|]/)
        .map(p => p.trim())
        .filter(Boolean);
      if (parts.length > 0) category = parts[parts.length - 1];
    }

    return {
      images: Array.from(imgs),
      title,
      price,
      mainColor,
      mainMaterial,
      assembledLength,
      assembledWidth,
      assembledHeight,
      assembledWeight,
      category,
    };
  }, { denySource: PRODUCT_IMAGE_DENY_RE.source, denyFlags: PRODUCT_IMAGE_DENY_RE.flags });

  // Field merger — baseInfos JSON wins where present, DOM is fallback.
  function fromJson(p: string): unknown {
    if (!baseInfos) return undefined;
    const root: unknown = (baseInfos as { data?: unknown }).data ?? baseInfos;
    const parts = p.split('.');
    let cur: unknown = root;
    for (const part of parts) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[part];
    }
    return cur;
  }

  const productName =
    (fromJson('productName') as string | undefined) ||
    (fromJson('productInfo.productName') as string | undefined) ||
    domData.title ||
    '';
  const mainColor =
    (fromJson('mainColor') as string | undefined) ||
    (fromJson('attributes.Main Color') as string | undefined) ||
    domData.mainColor ||
    '';

  const jsonPrice = Number(fromJson('price') ?? fromJson('discountedPrice') ?? 0);
  const price = jsonPrice > 0 ? jsonPrice : domData.price;

  const jsonImages = fromJson('imageUrls');
  const imageUrls: string[] =
    Array.isArray(jsonImages) && jsonImages.length > 0
      ? (jsonImages as unknown[]).filter((s): s is string => typeof s === 'string')
      : domData.images;
  const mainImageUrl =
    (fromJson('mainImageUrl') as string | undefined) || imageUrls[0] || '';
  const category =
    (fromJson('category') as string | undefined) ||
    (fromJson('categoryName') as string | undefined) ||
    domData.category ||
    '';
  const mainMaterial =
    (fromJson('mainMaterial') as string | undefined) || domData.mainMaterial || '';
  const assembledLength =
    (fromJson('assembledLength') as string | number | undefined) || domData.assembledLength || '';
  const assembledWidth =
    (fromJson('assembledWidth') as string | number | undefined) || domData.assembledWidth || '';
  const assembledHeight =
    (fromJson('assembledHeight') as string | number | undefined) || domData.assembledHeight || '';
  const assembledWeight =
    (fromJson('assembledWeight') as string | number | undefined) || domData.assembledWeight || '';
  const description = (fromJson('description') as string | undefined) || '';
  const associateProductList = fromJson('associateProductList');

  // Sanity gate
  if (!productName || imageUrls.length === 0) {
    console.warn(
      `    ${sku}: ✗ insufficient data (title=${productName ? 'y' : 'n'}, images=${imageUrls.length}) url=${page.url()}`,
    );
    return null;
  }

  // raw_payload shape — mirrors detailInfo/v1 so normalizeProduct accepts it
  // without schema changes
  const rawPayload: Record<string, unknown> = {
    sku,
    productName,
    mainColor,
    mainImageUrl,
    imageUrls,
    price,
    category,
    mainMaterial,
    assembledLength,
    assembledWidth,
    assembledHeight,
    assembledWeight,
    description,
  };
  if (Array.isArray(associateProductList)) {
    rawPayload.associateProductList = associateProductList;
  }
  return rawPayload;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log('═════════════════════════════════════════════════');
  console.log(' syncGigaVariants — associate-list backfill');
  console.log('═════════════════════════════════════════════════');
  console.log(`  Mode               : ${APPLY ? 'APPLY (writes)' : 'DRY_RUN (no writes)'}`);
  console.log(`  ROOT_SKU           : ${ROOT_SKU ?? '(all rows)'}`);
  console.log(`  LIMIT              : ${LIMIT === Infinity ? '(no cap)' : LIMIT}`);
  console.log(`  Supplier API creds : ${hasSupplierCreds ? 'present' : 'absent — API fetch skipped'}`);
  console.log(`  Playwright session : ${fs.existsSync(SESSION_FILE) ? SESSION_FILE : 'absent (fallback unavailable)'}`);
  console.log(`  Prefix min match   : ${PREFIX_MIN_MATCH} chars`);
  console.log('─────────────────────────────────────────────────\n');

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Source rows
  let query = supabase
    .from('supplier_products')
    .select('supplier_product_id, raw_payload');
  if (ROOT_SKU) {
    query = query.like('supplier_product_id', `${ROOT_SKU}%`);
  }
  const { data: sources, error: sourcesErr } = await query;
  if (sourcesErr) {
    console.error('[syncGigaVariants] Failed to fetch supplier_products:', sourcesErr.message);
    process.exit(1);
  }
  if (!sources || sources.length === 0) {
    console.log('[syncGigaVariants] No source rows matched. Nothing to do.');
    return;
  }
  console.log(`Source rows scanned: ${sources.length}\n`);

  // 2. Classify each associate SKU
  type Candidate = {
    sourceSku: string;
    candidateSku: string;
    keep: boolean;
    sharedPrefix: string;
  };
  const candidates: Candidate[] = [];

  for (const row of sources as Array<{ supplier_product_id: string; raw_payload: unknown }>) {
    const raw = (row.raw_payload as Record<string, unknown>) ?? {};
    const associates = Array.isArray(raw.associateProductList)
      ? (raw.associateProductList as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    for (const assoc of associates) {
      if (assoc === row.supplier_product_id) continue;
      const shared = longestCommonPrefix(row.supplier_product_id, assoc);
      candidates.push({
        sourceSku: row.supplier_product_id,
        candidateSku: assoc,
        keep: shared.length >= PREFIX_MIN_MATCH,
        sharedPrefix: shared,
      });
    }
  }

  // 3. Dedup and existence check
  const candidateSkus = Array.from(new Set(candidates.filter(c => c.keep).map(c => c.candidateSku)));
  const crossSellSkus = Array.from(new Set(candidates.filter(c => !c.keep).map(c => c.candidateSku)));

  let existingSet = new Set<string>();
  if (candidateSkus.length > 0) {
    const { data: existingRows, error: existingErr } = await supabase
      .from('supplier_products')
      .select('supplier_product_id')
      .in('supplier_product_id', candidateSkus);
    if (existingErr) {
      console.error('[syncGigaVariants] Failed to fetch existing supplier_products:', existingErr.message);
      process.exit(1);
    }
    existingSet = new Set(
      (existingRows ?? []).map(r => (r as { supplier_product_id: string }).supplier_product_id),
    );
  }

  const missingSkus = candidateSkus.filter(s => !existingSet.has(s));
  const cappedMissingSkus = isFinite(LIMIT) ? missingSkus.slice(0, LIMIT) : missingSkus;

  // 4. Per-source report
  console.log('─── Per-source breakdown ───');
  const grouped = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const arr = grouped.get(c.sourceSku) ?? [];
    arr.push(c);
    grouped.set(c.sourceSku, arr);
  }
  for (const [src, list] of grouped) {
    console.log(`Source ${src}`);
    console.log(`  associate SKUs found : ${list.length}`);
    for (const c of list) {
      if (c.keep) {
        const status = existingSet.has(c.candidateSku) ? 'EXISTS' : 'MISSING';
        console.log(`    KEEP   ${c.candidateSku.padEnd(20)}  [${status}]    prefix="${c.sharedPrefix}"`);
      } else {
        console.log(`    SKIP   ${c.candidateSku.padEnd(20)}  [CROSS-SELL]  prefix="${c.sharedPrefix}"`);
      }
    }
  }

  console.log('\n─── Plan summary ───');
  console.log(`  Sources scanned       : ${sources.length}`);
  console.log(`  Associate links seen  : ${candidates.length}`);
  console.log(`  True variant kept     : ${candidateSkus.length}`);
  console.log(`  Cross-sells skipped   : ${crossSellSkus.length}`);
  console.log(`  Already in DB         : ${candidateSkus.length - missingSkus.length}`);
  console.log(`  Missing total         : ${missingSkus.length}`);
  console.log(`  Will process (LIMIT)  : ${cappedMissingSkus.length}`);

  if (cappedMissingSkus.length === 0) {
    console.log('\nNothing to fetch. Done.');
    return;
  }

  // 5. API fetch (only if creds present). API is tried first; SKUs not
  //    returned by the API drop into the Playwright fallback below.
  const detailMap = new Map<string, Record<string, unknown>>();
  const priceMap = new Map<string, Record<string, unknown>>();

  if (hasSupplierCreds) {
    console.log('\nFetching detailInfo for missing SKUs (API)...');
    const apiDetails = await fetchInBatches('detail', cappedMissingSkus, async batch => {
      const res = await fetchProductDetails(batch);
      return extractItems(res);
    });
    apiDetails.forEach((v, k) => detailMap.set(k, v));

    console.log('Fetching price for missing SKUs (API)...');
    const apiPrices = await fetchInBatches('price ', cappedMissingSkus, async batch => {
      const res = await fetchProductPrices(batch);
      return extractItems(res);
    });
    apiPrices.forEach((v, k) => priceMap.set(k, v));
  } else {
    console.log('\nSkipping API fetch (supplier creds absent).');
  }

  // 6. Playwright fallback for any SKU the API did not return
  const unfetchedSkus = cappedMissingSkus.filter(s => !detailMap.has(s));
  if (unfetchedSkus.length > 0) {
    if (!fs.existsSync(SESSION_FILE)) {
      console.warn(`\n${unfetchedSkus.length} SKU(s) not returned by API, and no Playwright session at:`);
      console.warn(`  ${SESSION_FILE}`);
      console.warn(`  Run: npx tsx scripts/saveGigaSession.ts`);
    } else {
      console.log(`\nAPI returned no data for ${unfetchedSkus.length} SKU(s) — opening Playwright fallback`);
      console.log(`  Session : ${SESSION_FILE}`);
      console.log(`  Headed  : ${HEADED}`);
      try {
        const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 60 : 0 });
        const context = await browser.newContext({ storageState: SESSION_FILE });
        const playwrightPage = await context.newPage();
        // tsx/esbuild emits __name(fn, "fn") calls in compiled page.evaluate
        // callbacks to preserve Function.name. The browser context has no
        // such helper, so without this polyfill every evaluate throws
        // ReferenceError: __name is not defined.
        await playwrightPage.addInitScript(() => {
          (window as unknown as { __name?: (fn: unknown) => unknown }).__name = fn => fn;
        });
        try {
          for (let i = 0; i < unfetchedSkus.length; i++) {
            const sku = unfetchedSkus[i];
            process.stdout.write(`  [${i + 1}/${unfetchedSkus.length}] ${sku} ... `);
            try {
              const scraped = await scrapeSkuViaPlaywright(playwrightPage, sku);
              if (scraped) {
                detailMap.set(sku, scraped);
                const color = (scraped.mainColor as string) || '(unknown)';
                const imgs = Array.isArray(scraped.imageUrls)
                  ? (scraped.imageUrls as unknown[]).length
                  : 0;
                process.stdout.write(`✓ color=${color} images=${imgs}\n`);
              } else {
                process.stdout.write(`✗ (no usable data)\n`);
              }
            } catch (e) {
              process.stdout.write(`✗ ${(e as Error).message.slice(0, 80)}\n`);
            }
            if (PAGE_DELAY_MS > 0 && i < unfetchedSkus.length - 1) {
              await playwrightPage.waitForTimeout(PAGE_DELAY_MS);
            }
          }
        } finally {
          await browser.close();
        }
      } catch (e) {
        console.warn(`Playwright fallback failed: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }

  // 7. Merge + preview
  const mergedItems: Array<Record<string, unknown>> = [];
  console.log('\n─── Fetched detail preview ───');
  for (const sku of cappedMissingSkus) {
    const d = detailMap.get(sku);
    const p = priceMap.get(sku);
    if (!d) {
      console.log(`  ${sku}  ✗ no detail returned (API and Playwright both failed/skipped)`);
      continue;
    }
    const merged = { ...d, ...(p ?? {}), sku };
    mergedItems.push(merged);

    const color = (d.mainColor as string | undefined) ?? '(unknown)';
    const images = Array.isArray(d.imageUrls) ? (d.imageUrls as unknown[]).length : 0;
    const price = (p?.price as number | undefined) ?? (d.price as number | undefined) ?? '?';
    const productName = String((d.productName as string | undefined) ?? '').slice(0, 60);
    console.log(
      `  ${sku.padEnd(20)}  color=${String(color).padEnd(10)} images=${String(images).padStart(2)}  price=${price}  "${productName}"`,
    );
  }

  if (mergedItems.length === 0) {
    console.log('\nNo merged items — both API and Playwright returned nothing usable.');
    return;
  }

  // 7b. Family selling_price preview — runs in BOTH dry-run and apply.
  // New variants land with selling_price=NULL because neither this script nor
  // normalizeProduct produces it; the canonical producer is the dynamic-pricing
  // Edge Function (see PRODUCT_DISPLAY_RULES.md §1.2 and pricing/DYNAMIC_PRICING.md).
  // Until that engine runs, the app's price ladder falls back to supplier
  // `price`, which is wholesale cost — leaking cost as retail. This block
  // inherits an existing family selling_price (mode, ties → higher) so new
  // variants surface the family's existing retail rather than supplier cost.
  // No new pricing formula is introduced.
  type FamilyPricePlan = {
    siblingPrices: number[];
    familyPrice: number | null;
    newSkus: string[];
  };
  const familyPlan = new Map<string, FamilyPricePlan>();
  for (const c of candidates.filter(x => x.keep)) {
    if (!mergedItems.some(m => m.sku === c.candidateSku)) continue;
    const plan = familyPlan.get(c.sharedPrefix) ?? {
      siblingPrices: [],
      familyPrice: null,
      newSkus: [],
    };
    if (!plan.newSkus.includes(c.candidateSku)) plan.newSkus.push(c.candidateSku);
    familyPlan.set(c.sharedPrefix, plan);
  }

  console.log('\n─── Family selling_price preview ───');
  if (familyPlan.size === 0) {
    console.log('  (no families to inherit from)');
  }
  for (const [root, plan] of familyPlan) {
    const { data: siblings, error: sibErr } = await supabase
      .from('standardized_products')
      .select('supplier_product_id, selling_price')
      .like('supplier_product_id', `${root}%`)
      .gt('selling_price', 0);
    if (sibErr) {
      console.warn(`  ${root}: sibling lookup failed: ${sibErr.message}`);
      continue;
    }
    const newSkuSet = new Set(plan.newSkus);
    const siblingPrices: number[] = (siblings ?? [])
      .filter(s => !newSkuSet.has((s as { supplier_product_id: string }).supplier_product_id))
      .map(s => Number((s as { selling_price: number | string }).selling_price))
      .filter(n => Number.isFinite(n) && n > 0);
    plan.siblingPrices = siblingPrices;
    plan.familyPrice = selectFamilySellingPrice(siblingPrices);

    console.log(`  family root: ${root}`);
    console.log(`    sibling selling_prices : [${siblingPrices.join(', ')}]`);
    if (plan.familyPrice == null) {
      console.log(`    family selling_price   : (none) — variants will stay unpriced until dynamic-pricing runs`);
      plan.newSkus.forEach(s =>
        console.log(`      - ${s}  selling_price=null  (app falls back to supplier cost until repriced)`),
      );
    } else {
      console.log(`    family selling_price   : $${plan.familyPrice}`);
      plan.newSkus.forEach(s => console.log(`      ← ${s}  would inherit $${plan.familyPrice}`));
    }
  }

  // 8. Apply gate
  if (DRY_RUN) {
    console.log('\nDRY_RUN — skipping supplier_products + standardized_products writes.');
    console.log('Re-run with APPLY=1 to write.');
    return;
  }

  // 9. APPLY: supplier_products via shared helper
  console.log('\nWriting supplier_products via upsertPickupProducts...');
  const upsertResult = await upsertPickupProducts(
    supabase,
    mergedItems as Parameters<typeof upsertPickupProducts>[1],
  );
  console.log(`supplier_products: fetched=${upsertResult.fetched}, upserted=${upsertResult.upserted}`);

  // 10. APPLY: standardized_products
  console.log('\nNormalizing into standardized_products...');
  let normalized = 0;
  let normalizeErrors = 0;
  for (const item of mergedItems) {
    const sku = item.sku as string;
    try {
      const insertRow = normalizeProduct({
        id: sku,
        supplier_product_id: sku,
        title: (item.productName as string | undefined) ?? '',
        description: (item.description as string | undefined) ?? '',
        price: (item.price as number | undefined) ?? 0,
        images: Array.isArray(item.imageUrls) ? (item.imageUrls as string[]) : [],
        raw_payload: item,
      });
      // Stay compatible with deployments where new_arrival_added_at may not
      // exist yet (mirrors scripts/normalizeProducts.ts).
      const { new_arrival_added_at: _dropped, ...rest } = insertRow;
      const { error } = await supabase
        .from('standardized_products')
        .upsert(rest, { onConflict: 'supplier_product_id' });
      if (error) {
        normalizeErrors++;
        console.warn(`  ✗ standardized_products ${sku}: ${error.message}`);
      } else {
        normalized++;
        console.log(`  ✓ ${sku}`);
      }
    } catch (e) {
      normalizeErrors++;
      console.warn(`  ✗ normalize ${sku} failed: ${(e as Error).message}`);
    }
  }

  console.log(`\nstandardized_products: normalized=${normalized}, errors=${normalizeErrors}`);

  // 11. APPLY: inherit family selling_price where the dynamic-pricing engine
  // hasn't yet produced one. Stopgap only — dynamic-pricing remains the
  // canonical producer (supabase/functions/dynamic-pricing/index.ts) and will
  // overwrite on its next scheduled run.
  console.log('\nInheriting family selling_price (stopgap until dynamic-pricing runs)...');
  let inherited = 0;
  for (const [root, plan] of familyPlan) {
    if (plan.familyPrice == null || plan.newSkus.length === 0) continue;
    const { error } = await supabase
      .from('standardized_products')
      .update({ selling_price: plan.familyPrice })
      .in('supplier_product_id', plan.newSkus);
    if (error) {
      console.warn(`  ✗ family-price update for ${root} failed: ${error.message}`);
      continue;
    }
    plan.newSkus.forEach(s =>
      console.log(`  ✓ ${s}  selling_price ← $${plan.familyPrice}  (family ${root})`),
    );
    inherited += plan.newSkus.length;
  }
  console.log(`Family selling_price applied: ${inherited} row(s).`);

  console.log('Inventory will populate on next: npm run inventory:sync');
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[syncGigaVariants] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
