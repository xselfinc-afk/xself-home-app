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
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAllSavedItems, GigaSavedItemsError, ENDPOINT_PATH, SKU_FIELD } from './lib/gigaSavedItems';
// Existing production classifier + validated crosswalk (reused as-is; NO parallel implementation).
import { classifyCommerce, NEEDS_REVIEW } from '../src/utils/commerceTaxonomy';

// ── CLI ───────────────────────────────────────────────────────────────────────
// Saved-items fetch (creds, pagination, SKU extraction, dedupe, loud-fail) lives in the shared
// helper scripts/lib/gigaSavedItems.ts — the single source of truth reused by baseline/delta.
const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const NO_ENRICH = argv.includes('--no-enrich');
const FORCE_DEFAULT_CREDS = argv.includes('--default-creds') || process.env.GIGA_SAVED_USE_ALT_CREDS === '0';
const maxPagesArg = argv.find(a => a.startsWith('--max-pages='));
const MAX_PAGES = maxPagesArg ? Math.max(1, parseInt(maxPagesArg.split('=')[1], 10) || 0) : Infinity;
// Additive candidate-pipeline mode: emit candidate-focused reports IN ADDITION to the existing
// latest-saved-plan.{json,md}. Without this flag, behavior is byte-for-byte the legacy behavior.
const CANDIDATE_SCAN = argv.includes('--candidate-scan');

const ENRICH_BATCH = 200;       // detailInfo/price accept up to 200 SKUs per call
const PAGE_DELAY_MS = 400;      // be polite to the supplier API

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const REPORT_JSON = path.join(REPORT_DIR, 'latest-saved-plan.json');
const REPORT_MD = path.join(REPORT_DIR, 'latest-saved-plan.md');

// Hard-junk categories that cannot onboard as commercial indoor furniture (mirrors planner).
const HARD_JUNK = /\b(pet|dog|cat|kitten|puppy|fish\s*tank|aquarium|litter|kennel|crate|kid|kids|toy|toddler|nursery|bunk|murphy|crib|playpen|patio|outdoor|garden|gazebo|pergola|trampoline|trash|garbage|luggage|suitcase|bean\s?bag)\b/i;

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const rel = (p: string) => path.relative(process.cwd(), p);

// ── Candidate-scan helpers (pure; exported for focused tests) ──────────────────
export const TAXONOMY_VERSION = '56438dda'; // git short-sha of the validated crosswalk commit
const AUTH_RE = /\b(401|403|B20003|captcha|forbidden|unauthor(?:ized|ised)|anti-?bot|not\s+authorized|permission)\b/i;
export const redactMsg = (e: unknown): string =>
  String((e as any)?.message ?? e).replace(/[A-Za-z0-9_+/=-]{20,}/g, '[REDACTED]').slice(0, 200);
export const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export const toCsv = (header: string[], rows: unknown[][]): string =>
  [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
export const normTitle = (t: string): string => (t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
export const imageCountOf = (d: any): number => {
  if (!d) return 0;
  for (const c of [d.imageUrls, d.images, d.imageList, d.detailImages, d.skuImageList]) if (Array.isArray(c)) return c.length;
  if (typeof d.mainImageUrl === 'string' && d.mainImageUrl.trim()) return 1;
  if (typeof d.mainImage === 'string' && d.mainImage.trim()) return 1;
  return 0;
};
export const primaryImageOf = (d: any): string => {
  if (!d) return '';
  for (const c of [d.imageUrls, d.images, d.imageList]) if (Array.isArray(c) && c.length && typeof c[0] === 'string') return c[0];
  if (typeof d.mainImageUrl === 'string') return d.mainImageUrl;
  if (typeof d.mainImage === 'string') return d.mainImage;
  return '';
};
export const priceValueOf = (x: any): number | null => {
  if (!x) return null;
  const raw = x.price ?? x.salePrice ?? x.unitPrice ?? x.amount ?? x.wholesalePrice;
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) ? n : null;
};
export const skuAvailabilityOf = (d: any, p?: any): 'available' | 'unavailable' | 'unknown' => {
  const v = d?.skuAvailable ?? p?.skuAvailable;
  if (v === true || v === 'true' || v === 1) return 'available';
  if (v === false || v === 'false' || v === 0) return 'unavailable';
  return 'unknown';
};
export interface CandidateShape {
  in_sell: boolean | null; in_supplier: boolean; in_std: boolean;
  title: string; image_count: number; price: number | null; api_failed: boolean;
  duplicate_of: string; product_type_id: string; sku_available: 'available' | 'unavailable' | 'unknown';
}
/** Mutually-exclusive headline bucket with the approved precedence (pure; exported for tests). */
export function computeHeadline(c: CandidateShape): string {
  const priceOk = typeof c.price === 'number' && c.price > 0;
  const blocked = !c.title || c.image_count === 0 || !priceOk || c.api_failed;
  if (c.in_sell === true) return 'already_published';       // 1
  if (c.in_supplier || c.in_std) return 'already_imported'; // 2
  if (blocked) return 'blocked_or_invalid';                 // 3
  if (c.duplicate_of) return 'duplicate';                   // 4
  if (c.product_type_id === NEEDS_REVIEW) return 'needs_review'; // 5
  if (c.sku_available === 'unavailable') return 'unavailable';   // 6 (only when explicitly unavailable)
  return 'ready';                                           // 7
}

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

export async function main(): Promise<void> {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();
  if (CANDIDATE_SCAN && NO_ENRICH) die('--candidate-scan requires detail/price enrichment; do not combine with --no-enrich');

  // ── 1. Read saved items from GIGA via the shared helper (paginated, deduped, loud-fail) ──
  let fetched;
  try {
    fetched = await fetchAllSavedItems({ maxPages: MAX_PAGES, forceDefaultCreds: FORCE_DEFAULT_CREDS });
  } catch (e) {
    if (e instanceof GigaSavedItemsError) die(e.message, e.details);
    die(`saved-items fetch failed: ${e instanceof Error ? e.message : String(e)}`, { endpoint_path: ENDPOINT_PATH });
  }
  const CREDS_SOURCE = fetched.credsSource;
  const reportedTotal = fetched.reportedTotal;
  const pagesFetched = fetched.pagesFetched;
  const items = fetched.items.map(i => ({ sku: i.sku, title: i.title }));
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
  const enrichErrors: { stage: string; reason: string; skus: string[] }[] = []; // batch-level; used by --candidate-scan only
  if (!NO_ENRICH) {
    enrichAttempted = true;
    // Creds were already loaded by fetchAllSavedItems(); this import is module-cached.
    const giga = await import('../src/services/gigaApiClient');
    const fetchProductDetails = (giga as any).fetchProductDetails as (s: string[]) => Promise<any>;
    const fetchProductPrices = (giga as any).fetchProductPrices as (s: string[]) => Promise<any>;
    const silent = console.log; console.log = () => {};
    for (let i = 0; i < skuList.length; i += ENRICH_BATCH) {
      const batch = skuList.slice(i, i + ENRICH_BATCH);
      try {
        const d = await fetchProductDetails(batch);
        const arr: any[] = Array.isArray(d?.data) ? d.data : [];
        for (const it of arr) if (it?.sku) detailBySku.set(String(it.sku), it);
      } catch (e) { enrichFailures++; enrichErrors.push({ stage: 'detailInfo', reason: redactMsg(e), skus: batch }); }
      try {
        const p = await fetchProductPrices(batch);
        const arr: any[] = Array.isArray(p?.data) ? p.data : [];
        for (const it of arr) if (it?.sku) priceBySku.set(String(it.sku), it);
      } catch (e) { enrichFailures++; enrichErrors.push({ stage: 'price', reason: redactMsg(e), skus: batch }); }
      if (i + ENRICH_BATCH < skuList.length) await delay(PAGE_DELAY_MS);
    }
    console.log = silent;
    // Candidate mode must NEVER silently continue past an auth/anti-bot signal seen during enrichment.
    if (CANDIDATE_SCAN) {
      const authHit = enrichErrors.find(e => AUTH_RE.test(e.reason));
      if (authHit) die('enrichment hit an auth/anti-bot signal — stopping loudly (no silent continue)', { stage: authHit.stage, reason: authHit.reason });
    }
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
    pages_fetched: pagesFetched,
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

  // ── 7. Candidate Pipeline reports (ADDITIVE; only with --candidate-scan) ──────
  // Read-only: computed from already-fetched in-memory data (detailBySku/priceBySku) + the
  // production classifier. NO new API calls, NO Supabase writes, NO import/publish.
  if (CANDIDATE_SCAN) {
    type Cand = {
      sku: string; title: string;
      supplier_category: string; supplier_category_code: string;
      price: number | null; sku_available: 'available' | 'unavailable' | 'unknown'; image_count: number;
      department_id: string; category_id: string; product_type_id: string;
      classification_source: string; spec_overrode_title: boolean;
      in_supplier: boolean; in_std: boolean; in_sell: boolean | null;
      norm_title: string; primary_image: string;
      duplicate_of: string; duplicate_reason: string;
      headline: string; needs_review_reason: string; api_failed: boolean;
    };

    const cands: Cand[] = reports.map((r): Cand => {
      const d = detailBySku.get(r.sku);
      const p = priceBySku.get(r.sku);
      const supplier_category = String(d?.category ?? '');
      // classifyCommerce is the SINGLE classification authority (same input mapping as production:
      // name=title, category=specifications_json['Category'] equivalent = GIGA `category`).
      const full = classifyCommerce({ name: r.title, category: supplier_category, categoryLabel: '' });
      const tOnly = classifyCommerce({ name: r.title, category: '', categoryLabel: '' }).productType;
      const sOnly = classifyCommerce({ name: '', category: supplier_category, categoryLabel: '' }).productType;
      let classification_source = 'combined';
      let spec_overrode_title = false;
      if (full.productType === NEEDS_REVIEW) classification_source = 'needs_review';
      else if (tOnly === full.productType) classification_source = 'title_only';
      else if (sOnly === full.productType) { classification_source = 'spec_crosswalk'; spec_overrode_title = tOnly !== NEEDS_REVIEW; }
      return {
        sku: r.sku, title: r.title,
        supplier_category, supplier_category_code: String(d?.categoryCode ?? ''),
        price: priceValueOf(p) ?? priceValueOf(d), sku_available: skuAvailabilityOf(d, p), image_count: imageCountOf(d),
        department_id: full.department, category_id: full.category, product_type_id: full.productType,
        classification_source, spec_overrode_title,
        in_supplier: r.in_supplier_products, in_std: r.in_standardized_products, in_sell: r.in_sellable_products,
        norm_title: normTitle(r.title), primary_image: primaryImageOf(d),
        duplicate_of: '', duplicate_reason: '', headline: '', needs_review_reason: '',
        api_failed: enrichAttempted && !d,
      };
    });

    // Conservative in-memory duplicate detection: exact normalized title, then identical primary image.
    // Deterministic primary = lexicographically-smallest SKU in the group. No merges, no Supabase writes.
    const dupPasses: Array<[(c: Cand) => string, string]> = [
      [(c) => (c.norm_title ? 'T:' + c.norm_title : ''), 'same_title'],
      [(c) => (c.primary_image ? 'I:' + c.primary_image : ''), 'same_image'],
    ];
    for (const [keyFn, reason] of dupPasses) {
      const groups = new Map<string, Cand[]>();
      for (const c of cands) { const k = keyFn(c); if (!k) continue; const g = groups.get(k) ?? []; g.push(c); groups.set(k, g); }
      for (const g of groups.values()) {
        if (g.length < 2) continue;
        const sorted = [...g].sort((a, b) => a.sku.localeCompare(b.sku));
        for (const c of sorted.slice(1)) if (!c.duplicate_of) { c.duplicate_of = sorted[0].sku; c.duplicate_reason = reason; }
      }
    }

    // Headline bucket (mutually exclusive; approved precedence) + needs-review reason.
    for (const c of cands) {
      c.headline = computeHeadline(c);
      const priceOk = typeof c.price === 'number' && c.price > 0;
      c.needs_review_reason =
        c.product_type_id === NEEDS_REVIEW ? 'classifier_needs_review'
        : c.headline === 'blocked_or_invalid'
          ? [!c.title && 'missing_title', c.image_count === 0 && 'no_image', !priceOk && 'no_price', c.api_failed && 'detail_fetch_failed'].filter(Boolean).join(';')
          : '';
    }

    // Aggregations
    const HEADLINES = ['already_published', 'already_imported', 'blocked_or_invalid', 'duplicate', 'needs_review', 'unavailable', 'ready'] as const;
    const byHeadline: Record<string, number> = {}; for (const h of HEADLINES) byHeadline[h] = 0;
    const byDept: Record<string, number> = {}, byCat: Record<string, number> = {}, byType: Record<string, number> = {};
    for (const c of cands) {
      byHeadline[c.headline] = (byHeadline[c.headline] ?? 0) + 1;
      byDept[c.department_id] = (byDept[c.department_id] ?? 0) + 1;
      byCat[c.category_id] = (byCat[c.category_id] ?? 0) + 1;
      byType[c.product_type_id] = (byType[c.product_type_id] ?? 0) + 1;
    }

    const distMap = new Map<string, { d: string; c: string; t: string; n: number; ready: number; nr: number; imp: number; pub: number }>();
    for (const c of cands) {
      const key = `${c.department_id}|${c.category_id}|${c.product_type_id}`;
      const row = distMap.get(key) ?? { d: c.department_id, c: c.category_id, t: c.product_type_id, n: 0, ready: 0, nr: 0, imp: 0, pub: 0 };
      row.n++;
      if (c.headline === 'ready') row.ready++;
      if (c.headline === 'needs_review') row.nr++;
      if (c.headline === 'already_imported') row.imp++;
      if (c.headline === 'already_published') row.pub++;
      distMap.set(key, row);
    }

    const catMap = new Map<string, { code: string; items: Cand[] }>();
    for (const c of cands) {
      const key = c.supplier_category || '(none)';
      const e = catMap.get(key) ?? { code: c.supplier_category_code, items: [] };
      e.items.push(c); catMap.set(key, e);
    }
    const behaviorOf = (items: Cand[]): string => {
      if (items.every(i => i.product_type_id === NEEDS_REVIEW)) return 'unresolved';
      if (items.some(i => i.classification_source === 'spec_crosswalk' && i.spec_overrode_title)) return 'authoritative_spec';
      if (items.some(i => i.classification_source === 'spec_crosswalk')) return 'spec_fallback';
      if (items.some(i => i.classification_source === 'title_only')) return 'title_only';
      return 'unresolved';
    };

    const apiFailures = cands.filter(c => c.api_failed).map(c => {
      const be = enrichErrors.find(e => e.skus.includes(c.sku));
      return { sku: c.sku, stage: be?.stage ?? 'detailInfo', reason: be?.reason ?? 'missing_detail' };
    });

    // ── Write reports (all under the existing gitignored reports/giga-auto-publish/) ──
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const w = (name: string, content: string) => fs.writeFileSync(path.join(REPORT_DIR, name), content);

    w('candidates.csv', toCsv(
      ['supplier_product_id', 'supplier_sku', 'title', 'supplier_category', 'supplier_category_code', 'price', 'sku_available', 'image_count', 'department_id', 'category_id', 'product_type_id', 'headline_bucket', 'needs_review_reason', 'duplicate_of', 'duplicate_reason', 'in_supplier_products', 'in_standardized_products', 'in_sellable_products', 'classification_source', 'taxonomy_version'],
      cands.map(c => [c.sku, c.sku, c.title, c.supplier_category, c.supplier_category_code, c.price ?? '', c.sku_available, c.image_count, c.department_id, c.category_id, c.product_type_id, c.headline, c.needs_review_reason, c.duplicate_of, c.duplicate_reason, c.in_supplier, c.in_std, c.in_sell === null ? '?' : c.in_sell, c.classification_source, TAXONOMY_VERSION]),
    ));

    const nr = cands.filter(c => c.product_type_id === NEEDS_REVIEW || c.headline === 'needs_review');
    w('needs-review.csv', toCsv(
      ['supplier_product_id', 'title', 'supplier_category', 'department_id', 'category_id', 'product_type_id', 'headline_bucket', 'needs_review_reason', 'classification_source', 'taxonomy_version'],
      nr.map(c => [c.sku, c.title, c.supplier_category, c.department_id, c.category_id, c.product_type_id, c.headline, c.needs_review_reason, c.classification_source, TAXONOMY_VERSION]),
    ));

    w('taxonomy-distribution.csv', toCsv(
      ['department_id', 'category_id', 'product_type_id', 'candidate_count', 'ready_count', 'needs_review_count', 'already_imported_count', 'already_published_count'],
      [...distMap.values()].sort((a, b) => b.n - a.n).map(r => [r.d, r.c, r.t, r.n, r.ready, r.nr, r.imp, r.pub]),
    ));

    w('supplier-category-audit.csv', toCsv(
      ['supplier_category', 'supplier_category_code', 'item_count', 'canonical_types_observed', 'needs_review_count', 'crosswalk_behavior', 'sample_skus'],
      [...catMap.entries()].sort((a, b) => b[1].items.length - a[1].items.length).map(([cat, e]) => {
        const types = [...new Set(e.items.map(i => i.product_type_id).filter(t => t !== NEEDS_REVIEW))];
        const nrc = e.items.filter(i => i.product_type_id === NEEDS_REVIEW).length;
        return [cat, e.code, e.items.length, types.join('|'), nrc, behaviorOf(e.items), e.items.slice(0, 5).map(i => i.sku).join('|')];
      }),
    ));

    const dups = cands.filter(c => c.duplicate_of);
    w('duplicate-report.csv', toCsv(
      ['primary_supplier_product_id', 'duplicate_supplier_product_id', 'duplicate_reason', 'normalized_title', 'primary_image_url', 'headline_bucket'],
      dups.map(c => [c.duplicate_of, c.sku, c.duplicate_reason, c.norm_title, c.primary_image, c.headline]),
    ));

    w('api-failures.csv', toCsv(
      ['supplier_product_id', 'stage', 'redacted_reason'],
      apiFailures.map(f => [f.sku, f.stage, f.reason]),
    ));

    const unmappedCats = [...catMap.entries()]
      .filter(([, e]) => behaviorOf(e.items) === 'unresolved' || e.items.some(i => i.product_type_id === NEEDS_REVIEW))
      .map(([cat, e]) => ({ supplier_category: cat, item_count: e.items.length, needs_review_count: e.items.filter(i => i.product_type_id === NEEDS_REVIEW).length, crosswalk_behavior: behaviorOf(e.items) }));

    const summary = {
      run_id: RUN_ID, generated_at: TIMESTAMP, taxonomy_version: TAXONOMY_VERSION, creds_source: CREDS_SOURCE,
      total_saved: cands.length, pages_read: pagesFetched, reported_total_num: reportedTotal,
      totals_by_headline: byHeadline, totals_by_department: byDept, totals_by_category: byCat, totals_by_product_type: byType,
      total_needs_review: byHeadline['needs_review'], total_duplicate: byHeadline['duplicate'], total_unavailable: byHeadline['unavailable'],
      total_blocked_or_invalid: byHeadline['blocked_or_invalid'], total_ready: byHeadline['ready'],
      total_already_imported: byHeadline['already_imported'], total_already_published: byHeadline['already_published'],
      total_api_failures: apiFailures.length, distinct_supplier_category_count: catMap.size,
      unmapped_or_needs_review_supplier_categories: unmappedCats,
    };
    w('candidate-summary.json', JSON.stringify(summary, null, 2));

    const cm: string[] = [];
    cm.push('# GIGA Candidate Pipeline — Read-Only Scan', '');
    cm.push(`- run_id: ${RUN_ID}`, `- generated_at: ${TIMESTAMP}`, `- taxonomy_version: ${TAXONOMY_VERSION}`, `- creds_source: ${CREDS_SOURCE}`);
    cm.push(`- total_saved: ${cands.length} (pages_read: ${pagesFetched}${reportedTotal != null ? `, api totalNum: ${reportedTotal}` : ''})`, '');
    cm.push('## Headline buckets');
    for (const h of HEADLINES) cm.push(`- ${h}: ${byHeadline[h]}`);
    cm.push(`- api_failures: ${apiFailures.length}`, '');
    cm.push('## Department distribution');
    for (const [d, n] of Object.entries(byDept).sort((a, b) => b[1] - a[1])) cm.push(`- ${d}: ${n}`);
    cm.push('', '## Top product types');
    for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 15)) cm.push(`- ${t}: ${n}`);
    cm.push('', '## Supplier categories needing review (unmapped or needs-review present)');
    if (unmappedCats.length === 0) cm.push('- (none)');
    for (const u of unmappedCats.sort((a, b) => b.item_count - a.item_count)) cm.push(`- ${u.supplier_category} — ${u.item_count} items, ${u.needs_review_count} needs-review, behavior=${u.crosswalk_behavior}`);
    cm.push('', `## Duplicates: ${dups.length} · Needs-review: ${nr.length} · API failures: ${apiFailures.length}`);
    w('candidate-summary.md', cm.join('\n'));

    console.log('GIGA_CANDIDATE_SCAN_SUMMARY');
    console.log(`total_saved=${cands.length}`);
    for (const h of HEADLINES) console.log(`headline_${h}=${byHeadline[h]}`);
    console.log(`api_failures=${apiFailures.length}`);
    console.log(`distinct_supplier_categories=${catMap.size}`);
    console.log(`candidate_reports_dir=${rel(REPORT_DIR)}`);
  }
}

// Run only when invoked directly (so tests can import the pure helpers without side effects).
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(e => { console.error('GIGA_SAVED_PLAN_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
