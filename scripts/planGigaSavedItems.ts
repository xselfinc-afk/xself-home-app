/**
 * planGigaSavedItems.ts — READ-ONLY GIGA saved-items candidate planner (Phase 1).
 *
 * Reads the buyer's "My Saved Items" list from the GIGA Open API, compares each saved SKU
 * against our Supabase tables (read-only SELECTs), classifies it, optionally enriches basic
 * validity via read-only GIGA detail/price calls, and writes JSON + Markdown reports.
 *
 * Business rule: a saved/favorited GIGA product is a CANDIDATE ONLY. Being saved does NOT make
 * it safe to publish. This script makes NO decision to publish — it only reports membership +
 * basic validity so a human can decide.
 *
 * Saved-items source: /b2b-overseas-api/v1/buyer/product/skus/v1 ("Product List Query"). Per the
 * GIGA Open API 2.0 docs this endpoint IS the account-scoped saved list (queryTimeType=2 ==
 * "Added time: the latest time when a product was added to My Saved Items"); there is no separate
 * favorites endpoint. Canonical SKU field per record: `sku` (verified against a real 200 capture).
 *
 * Writes: ONLY reports/giga-auto-publish/latest-saved-plan.{json,md}.
 * Performs NO database writes, NO imports, NO normalization, NO image upload, NO blurhash,
 * NO review/inventory seed, NO apply, NO deploy.
 *
 * Usage:
 *   npm run giga:saved:plan
 *   npx tsx scripts/planGigaSavedItems.ts [--summary] [--max-pages=N] [--no-enrich]
 *
 * Flags:
 *   --summary       print only the compact GIGA_SAVED_PLAN_SUMMARY block to chat
 *   --max-pages=N   cap saved-list pages fetched (safety; default: all pages)
 *   --no-enrich     skip GIGA detail/price validity enrichment (membership-only classification)
 *
 * Fails loudly (exit 1) and writes no report if: the saved-items endpoint errors, the response
 * shape is unexpected, or the canonical SKU field is ambiguous/missing.
 */
import { config as loadEnv } from 'dotenv';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const NO_ENRICH = argv.includes('--no-enrich');
// Credential source. The "My Saved Items" list is GIGA-account-scoped, so the SUPPLIER_*
// credentials decide WHOSE saved list is read. The saved-items endpoint only works for the alt
// account (.env.giga-alt.local); the default .env.local account returns a GIGA server error here.
// So this script DEFAULTS to the alt credentials: it loads .env.giga-alt.local FIRST so its
// SUPPLIER_* values win (dotenv never overrides already-set vars), while .env.local still supplies
// the Supabase service-role key. Pass --default-creds (or GIGA_SAVED_USE_ALT_CREDS=0) to force the
// plain .env.local → .env cascade instead.
const ALT_CREDS_FILE = '.env.giga-alt.local';
const FORCE_DEFAULT_CREDS = argv.includes('--default-creds') || process.env.GIGA_SAVED_USE_ALT_CREDS === '0';
const USE_ALT_CREDS = !FORCE_DEFAULT_CREDS && fs.existsSync(ALT_CREDS_FILE);
if (USE_ALT_CREDS) loadEnv({ path: ALT_CREDS_FILE });
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });
const CREDS_SOURCE = USE_ALT_CREDS ? ALT_CREDS_FILE : '.env.local';
const maxPagesArg = argv.find(a => a.startsWith('--max-pages='));
const MAX_PAGES = maxPagesArg ? Math.max(1, parseInt(maxPagesArg.split('=')[1], 10) || 0) : Infinity;

const ENDPOINT_PATH = '/b2b-overseas-api/v1/buyer/product/skus/v1';
const SKU_FIELD = 'sku';
const TITLE_FIELD = 'productName';
const PAGE_SIZE = 100;          // skus/v1 requires pageSize=100 (see syncGigaFurnitureCatalog.ts)
const ENRICH_BATCH = 200;       // detailInfo/price accept up to 200 SKUs per call
const PAGE_DELAY_MS = 400;      // be polite to the supplier API

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const REPORT_JSON = path.join(REPORT_DIR, 'latest-saved-plan.json');
const REPORT_MD = path.join(REPORT_DIR, 'latest-saved-plan.md');

// Hard-junk categories that cannot onboard as commercial indoor furniture (mirrors planner).
const HARD_JUNK = /\b(pet|dog|cat|kitten|puppy|fish\s*tank|aquarium|litter|kennel|crate|kid|kids|toy|toddler|nursery|bunk|murphy|crib|playpen|patio|outdoor|garden|gazebo|pergola|trampoline|trash|garbage|luggage|suitcase|bean\s?bag)\b/i;

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const rel = (p: string) => path.relative(process.cwd(), p);

type Classification = 'already_published' | 'already_imported' | 'new_candidate' | 'blocked_or_invalid';

type SkuReport = {
  sku: string;
  classification: Classification;
  in_supplier_products: boolean;
  in_standardized_products: boolean;
  in_sellable_products: boolean | null; // null = table not queryable
  title: string;
  has_image: boolean | null;            // null = enrichment unavailable / skipped
  has_price: boolean | null;            // null = enrichment unavailable / skipped
  invalid_reasons: string[];
};

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error(`GIGA_SAVED_PLAN_ERROR`);
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();

  // ── 1. Read saved items from GIGA (paginated) ─────────────────────────────
  const giga = await import('../src/services/gigaApiClient');
  const fetchSavedSkuList = (giga as any).fetchSavedSkuList as (p: number, ps: number) => Promise<any>;
  if (typeof fetchSavedSkuList !== 'function') die('fetchSavedSkuList not exported from gigaApiClient');

  // gigaApiClient logs verbosely (headers/body/raw) — silence it while paging.
  const realLog = console.log; console.log = () => {};

  type SavedRecord = { sku: string; title: string };
  const saved: SavedRecord[] = [];
  let totalPage = 1;
  let reportedTotal: number | null = null;
  try {
    for (let page = 1; page <= totalPage && page <= MAX_PAGES; page++) {
      const res = await fetchSavedSkuList(page, PAGE_SIZE);
      const data = res?.data;
      const records = data?.records;
      if (!data || !Array.isArray(records)) {
        console.log = realLog;
        die('unexpected saved-items response shape (data.records[] missing)', {
          endpoint_path: ENDPOINT_PATH, creds_source: CREDS_SOURCE, page,
          api_success: res?.success, api_code: res?.code,
          api_msg: res?.msg ?? res?.error ?? '', api_subMsg: res?.subMsg ?? '',
          response_keys: res ? Object.keys(res) : 'null',
          data_keys: data ? Object.keys(data) : 'null',
        });
      }
      if (page === 1) {
        reportedTotal = Number(data?.pageInfo?.totalNum ?? NaN);
        totalPage = Number(data?.pageInfo?.totalPage ?? 1) || 1;
        // SKU-field ambiguity guard: confirm the canonical field exists on the first record.
        const first = records[0];
        if (first && (first[SKU_FIELD] == null || first[SKU_FIELD] === '')) {
          console.log = realLog;
          die('canonical SKU field ambiguous on saved-items records', {
            expected_sku_field: SKU_FIELD, candidate_fields: Object.keys(first),
          });
        }
      }
      for (const r of records) {
        const sku = String(r?.[SKU_FIELD] ?? '').trim();
        if (!sku) continue;
        saved.push({ sku, title: String(r?.[TITLE_FIELD] ?? '').trim() });
      }
      if (page < totalPage && page < MAX_PAGES) await delay(PAGE_DELAY_MS);
    }
  } catch (e) {
    console.log = realLog;
    die(`saved-items fetch failed: ${e instanceof Error ? e.message : String(e)}`, { endpoint_path: ENDPOINT_PATH });
  }
  console.log = realLog;

  if (saved.length === 0) die('saved-items list returned zero records', { endpoint_path: ENDPOINT_PATH });

  // Dedupe by SKU (keep first title seen).
  const bySku = new Map<string, SavedRecord>();
  for (const r of saved) if (!bySku.has(r.sku)) bySku.set(r.sku, r);
  const items = [...bySku.values()];
  const skuList = items.map(i => i.sku);

  // ── 2. Read-only membership SELECTs against Supabase ──────────────────────
  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Pull full id sets (small columns) and intersect in-memory. Read-only.
  async function loadIdSet(table: string): Promise<Set<string> | null> {
    const out = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select('supplier_product_id').range(from, from + 999);
      if (error) {
        // sellable_products may be absent in some environments — treat as "not queryable".
        console.error(`[saved-plan] ${table} read note: ${error.message}`);
        return null;
      }
      const rows = data ?? [];
      for (const r of rows as any[]) if (r?.supplier_product_id != null) out.add(String(r.supplier_product_id));
      if (rows.length < 1000) break;
    }
    return out;
  }

  const supplierSet = await loadIdSet('supplier_products');
  const stdSet = await loadIdSet('standardized_products');
  const sellSet = await loadIdSet('sellable_products');
  if (!supplierSet) die('supplier_products is not readable (required for classification)');
  if (!stdSet) die('standardized_products is not readable (required for classification)');
  const sellableQueryable = sellSet != null;

  // ── 3. Optional read-only validity enrichment (detail + price) ────────────
  const detailBySku = new Map<string, any>();
  const priceBySku = new Map<string, any>();
  let enrichAttempted = false;
  let enrichFailures = 0;
  if (!NO_ENRICH) {
    enrichAttempted = true;
    const fetchProductDetails = (giga as any).fetchProductDetails as (s: string[]) => Promise<any>;
    const fetchProductPrices = (giga as any).fetchProductPrices as (s: string[]) => Promise<any>;
    const silent = console.log; console.log = () => {};
    for (let i = 0; i < skuList.length; i += ENRICH_BATCH) {
      const batch = skuList.slice(i, i + ENRICH_BATCH);
      try {
        const d = await fetchProductDetails(batch);
        const arr: any[] = Array.isArray(d?.data) ? d.data : [];
        for (const it of arr) if (it?.sku) detailBySku.set(String(it.sku), it);
      } catch { enrichFailures++; }
      try {
        const p = await fetchProductPrices(batch);
        const arr: any[] = Array.isArray(p?.data) ? p.data : [];
        for (const it of arr) if (it?.sku) priceBySku.set(String(it.sku), it);
      } catch { enrichFailures++; }
      if (i + ENRICH_BATCH < skuList.length) await delay(PAGE_DELAY_MS);
    }
    console.log = silent;
  }

  // Derive has_image / has_price from enrichment (best-effort, read-only).
  function imageOf(d: any): boolean | null {
    if (!d) return null;
    const candidates = [d.imageUrls, d.images, d.imageList, d.mainImage, d.image, d.primaryImage].filter(v => v != null);
    if (candidates.length === 0) return null;
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) return true;
      if (typeof c === 'string' && c.trim()) return true;
    }
    return false;
  }
  function priceOf(p: any): { has: boolean | null; positive: boolean } {
    if (!p) return { has: null, positive: false };
    const raw = p.price ?? p.salePrice ?? p.unitPrice ?? p.amount;
    if (raw == null || raw === '') return { has: false, positive: false };
    const n = Number(raw);
    return { has: Number.isFinite(n), positive: Number.isFinite(n) && n > 0 };
  }

  // ── 4. Classify each saved SKU ────────────────────────────────────────────
  const reports: SkuReport[] = items.map(({ sku, title }) => {
    const inSupplier = supplierSet!.has(sku);
    const inStd = stdSet!.has(sku);
    const inSell = sellableQueryable ? sellSet!.has(sku) : null;

    const detail = detailBySku.get(sku);
    const price = priceBySku.get(sku);
    const hasImage = enrichAttempted ? imageOf(detail) : null;
    const { has: hasPriceRaw, positive: pricePositive } = enrichAttempted ? priceOf(price) : { has: null, positive: false };
    const hasPrice = enrichAttempted ? hasPriceRaw : null;
    const hasTitle = title.length > 0;

    const invalid_reasons: string[] = [];
    if (!hasTitle) invalid_reasons.push('missing_title');
    if (HARD_JUNK.test(title)) invalid_reasons.push('junk_category');
    if (enrichAttempted) {
      if (hasImage === false) invalid_reasons.push('no_image');
      if (hasImage === null) invalid_reasons.push('image_unknown');
      if (hasPrice === false) invalid_reasons.push('no_price');
      if (hasPrice === true && !pricePositive) invalid_reasons.push('price_not_positive');
      if (hasPrice === null) invalid_reasons.push('price_unknown');
    } else {
      invalid_reasons.push('enrichment_skipped');
    }

    // Membership precedence: published > imported. Validity only gates not-yet-in-DB items.
    let classification: Classification;
    if (inSell === true) {
      classification = 'already_published';
    } else if (inSupplier || inStd) {
      classification = 'already_imported';
    } else {
      // Not in our DB → candidate. A saved item is candidate-only; block if it fails basic validity.
      const hardInvalid =
        !hasTitle ||
        HARD_JUNK.test(title) ||
        hasImage === false ||
        hasPrice === false ||
        (hasPrice === true && !pricePositive) ||
        // conservative: if we tried to enrich but couldn't confirm image/price, do not call it safe
        (enrichAttempted && (hasImage === null || hasPrice === null));
      classification = hardInvalid ? 'blocked_or_invalid' : 'new_candidate';
    }

    return {
      sku, classification,
      in_supplier_products: inSupplier,
      in_standardized_products: inStd,
      in_sellable_products: inSell,
      title,
      has_image: hasImage,
      has_price: hasPrice,
      invalid_reasons,
    };
  });

  // ── 5. Tally + write reports ──────────────────────────────────────────────
  const count = (c: Classification) => reports.filter(r => r.classification === c).length;
  const totals = {
    saved_items_total: reports.length,
    already_published: count('already_published'),
    already_imported: count('already_imported'),
    new_candidate: count('new_candidate'),
    blocked_or_invalid: count('blocked_or_invalid'),
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fullJson = {
    run_id: RUN_ID,
    timestamp: TIMESTAMP,
    creds_source: CREDS_SOURCE,
    endpoint_path: ENDPOINT_PATH,
    sku_field: SKU_FIELD,
    items_returned: reports.length,
    reported_total_num: reportedTotal,
    pages_fetched: Math.min(totalPage, MAX_PAGES),
    sellable_products_queryable: sellableQueryable,
    enrichment: { attempted: enrichAttempted, batch_failures: enrichFailures },
    totals,
    items: reports,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(fullJson, null, 2));

  const md: string[] = [];
  md.push('# GIGA Saved-Items Candidate Plan (read-only, Phase 1)', '');
  md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- endpoint_path: ${ENDPOINT_PATH}`, `- sku_field: ${SKU_FIELD}`);
  md.push(`- items_returned: ${reports.length}${reportedTotal != null ? ` (api totalNum: ${reportedTotal})` : ''}`);
  md.push(`- sellable_products_queryable: ${sellableQueryable}`);
  md.push(`- enrichment: attempted=${enrichAttempted} batch_failures=${enrichFailures}`, '');
  md.push('## Totals',
    `- saved_items_total: ${totals.saved_items_total}`,
    `- already_published: ${totals.already_published}`,
    `- already_imported: ${totals.already_imported}`,
    `- new_candidate: ${totals.new_candidate}`,
    `- blocked_or_invalid: ${totals.blocked_or_invalid}`, '');
  md.push('## All saved items', '',
    '| SKU | classification | supplier | std | sellable | img | price | reasons | title |',
    '|---|---|---|---|---|---|---|---|---|');
  const yn = (v: boolean | null) => v === null ? '?' : v ? 'Y' : 'N';
  for (const r of reports) {
    md.push(`| ${r.sku} | ${r.classification} | ${yn(r.in_supplier_products)} | ${yn(r.in_standardized_products)} | ${yn(r.in_sellable_products)} | ${yn(r.has_image)} | ${yn(r.has_price)} | ${r.invalid_reasons.join(';')} | ${r.title.replace(/\|/g, '/').slice(0, 60)} |`);
  }
  fs.writeFileSync(REPORT_MD, md.join('\n'));

  // ── 6. Output ──────────────────────────────────────────────────────────────
  console.log('GIGA_SAVED_PLAN_SUMMARY');
  console.log(`run_id=${RUN_ID}`);
  console.log(`timestamp=${TIMESTAMP}`);
  console.log(`creds_source=${CREDS_SOURCE}`);
  console.log(`endpoint_path=${ENDPOINT_PATH}`);
  console.log(`sku_field=${SKU_FIELD}`);
  console.log(`items_returned=${reports.length}`);
  console.log(`reported_total_num=${reportedTotal ?? 'unknown'}`);
  console.log(`sellable_products_queryable=${sellableQueryable}`);
  console.log(`enrichment_attempted=${enrichAttempted}`);
  console.log(`enrichment_batch_failures=${enrichFailures}`);
  console.log(`saved_items_total=${totals.saved_items_total}`);
  console.log(`already_published=${totals.already_published}`);
  console.log(`already_imported=${totals.already_imported}`);
  console.log(`new_candidate=${totals.new_candidate}`);
  console.log(`blocked_or_invalid=${totals.blocked_or_invalid}`);
  console.log(`report_json=${rel(REPORT_JSON)}`);
  console.log(`report_md=${rel(REPORT_MD)}`);
  if (!SUMMARY) {
    const sample = (c: Classification) => reports.filter(r => r.classification === c).slice(0, 5).map(r => r.sku).join(',') || '(none)';
    console.log(`sample_new_candidate=${sample('new_candidate')}`);
    console.log(`sample_already_published=${sample('already_published')}`);
    console.log(`sample_already_imported=${sample('already_imported')}`);
    console.log(`sample_blocked_or_invalid=${sample('blocked_or_invalid')}`);
  }
})().catch(e => { console.error('GIGA_SAVED_PLAN_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
