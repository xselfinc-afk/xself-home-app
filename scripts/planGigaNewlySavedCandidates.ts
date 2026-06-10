/**
 * planGigaNewlySavedCandidates.ts — Phase 2A: report-only checker for NEWLY-SAVED GIGA SKUs.
 *
 * Consumes ONLY newly_saved_skus from the delta report (reports/.../latest-saved-delta.json). It does
 * NOT touch the 268 historical imported SKUs, unchanged_saved_skus, all-saved-items, or any backlog.
 * The delta report is the gate; this script never re-fetches the full saved list.
 *
 * For each newly-saved SKU it makes read-only GIGA detail + price calls, checks read-only DB
 * membership (supplier_products / standardized_products / sellable_products), evaluates basic
 * validity, and classifies:
 *   already_exists       — already in our DB (sellable, or supplier/standardized). Not a new target.
 *   ready_for_sync       — not in DB AND product exists + title + image + price>0 (and not sellable).
 *   blocked_or_invalid   — not in DB but fails a basic-validity check.
 *
 * Writes ONLY: reports/giga-auto-publish/latest-newly-saved-candidates.{json,md} (local files).
 * Performs NO Supabase writes, NO import, NO normalization, NO image upload, NO blurhash,
 * NO review/inventory seed, NO apply, NO deploy. A saved item is a CANDIDATE ONLY — this script
 * decides nothing, it only reports.
 *
 * Usage:
 *   npm run giga:newly-saved:plan
 *   npx tsx scripts/planGigaNewlySavedCandidates.ts [--summary] [--default-creds]
 */
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadSavedItemsCreds } from './lib/gigaSavedItems';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const FORCE_DEFAULT_CREDS = argv.includes('--default-creds') || process.env.GIGA_SAVED_USE_ALT_CREDS === '0';

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const DELTA_FILE = path.join(REPORT_DIR, 'latest-saved-delta.json');
const OUT_JSON = path.join(REPORT_DIR, 'latest-newly-saved-candidates.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-newly-saved-candidates.md');
const rel = (p: string) => path.relative(process.cwd(), p);

const DETAIL_BATCH = 200;       // detailInfo/price accept up to 200 SKUs per call

type Classification = 'ready_for_sync' | 'already_exists' | 'blocked_or_invalid';

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error('GIGA_NEWLY_SAVED_ERROR');
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

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
function titleOf(d: any): string {
  return String(d?.productName ?? d?.title ?? d?.name ?? '').trim();
}

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();

  // ── 1. Read the delta report and extract ONLY newly_saved_skus ────────────
  if (!fs.existsSync(DELTA_FILE)) {
    die('delta report not found; run `npm run giga:saved:delta` first', { delta_file: rel(DELTA_FILE) });
  }
  let delta: any;
  try { delta = JSON.parse(fs.readFileSync(DELTA_FILE, 'utf8')); }
  catch (e) { die(`delta report is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { delta_file: rel(DELTA_FILE) }); }
  if (!Array.isArray(delta?.newly_saved_skus)) {
    die('delta report missing newly_saved_skus[] (corrupt or wrong shape)', { delta_file: rel(DELTA_FILE), keys: delta ? Object.keys(delta) : 'null' });
  }

  // newly_saved_skus entries are { sku, title }. Dedupe defensively; keep delta title as fallback.
  const newlyMap = new Map<string, string>();
  for (const e of delta.newly_saved_skus) {
    const sku = String(e?.sku ?? '').trim();
    if (sku && !newlyMap.has(sku)) newlyMap.set(sku, String(e?.title ?? '').trim());
  }
  const newlySkus = [...newlyMap.keys()];

  if (newlySkus.length === 0) {
    // Nothing newly saved — write an empty (but valid) report and exit cleanly.
    const empty = {
      run_id: RUN_ID, timestamp: TIMESTAMP, input_file: rel(DELTA_FILE),
      delta_run_id: delta.run_id ?? null,
      newly_saved_skus: [], processed_skus: [],
      totals: { processed: 0, ready_for_sync: 0, already_exists: 0, blocked_or_invalid: 0 },
      candidates: [],
    };
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(empty, null, 2));
    fs.writeFileSync(OUT_MD, '# GIGA Newly-Saved Candidates (read-only, Phase 2A)\n\n- newly_saved_skus: 0 (nothing to process)\n');
    console.log('GIGA_NEWLY_SAVED_SUMMARY');
    console.log(`run_id=${RUN_ID}`);
    console.log(`input_file=${rel(DELTA_FILE)}`);
    console.log('newly_saved_skus=0');
    console.log('processed=0 ready_for_sync=0 already_exists=0 blocked_or_invalid=0');
    console.log(`report_json=${rel(OUT_JSON)}`);
    console.log(`report_md=${rel(OUT_MD)}`);
    return;
  }

  // ── 2. Read-only GIGA detail + price for the newly-saved SKUs ──────────────
  const credsSource = loadSavedItemsCreds({ forceDefault: FORCE_DEFAULT_CREDS });
  const giga = await import('../src/services/gigaApiClient');
  const fetchProductDetails = (giga as any).fetchProductDetails as (s: string[]) => Promise<any>;
  const fetchProductPrices = (giga as any).fetchProductPrices as (s: string[]) => Promise<any>;

  const detailBySku = new Map<string, any>();
  const priceBySku = new Map<string, any>();
  let detailFailures = 0;
  let priceFailures = 0;
  {
    const silent = console.log; console.log = () => {};
    try {
      for (let i = 0; i < newlySkus.length; i += DETAIL_BATCH) {
        const batch = newlySkus.slice(i, i + DETAIL_BATCH);
        try {
          const d = await fetchProductDetails(batch);
          const arr: any[] = Array.isArray(d?.data) ? d.data : [];
          for (const it of arr) if (it?.sku) detailBySku.set(String(it.sku), it);
        } catch { detailFailures++; }
        try {
          const p = await fetchProductPrices(batch);
          const arr: any[] = Array.isArray(p?.data) ? p.data : [];
          for (const it of arr) if (it?.sku) priceBySku.set(String(it.sku), it);
        } catch { priceFailures++; }
      }
    } finally {
      console.log = silent;
    }
  }

  // ── 3. Read-only DB membership for ONLY these SKUs ────────────────────────
  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  async function membershipSet(table: string): Promise<Set<string> | null> {
    const { data, error } = await sb.from(table).select('supplier_product_id').in('supplier_product_id', newlySkus);
    if (error) { console.error(`[newly-saved] ${table} read note: ${error.message}`); return null; }
    return new Set((data ?? []).map((r: any) => String(r.supplier_product_id)));
  }
  const supplierSet = await membershipSet('supplier_products');
  const stdSet = await membershipSet('standardized_products');
  const sellSet = await membershipSet('sellable_products');
  if (!supplierSet) die('supplier_products is not readable (required for classification)');
  if (!stdSet) die('standardized_products is not readable (required for classification)');
  const sellableQueryable = sellSet != null;

  // ── 4. Classify each newly-saved SKU ──────────────────────────────────────
  const candidates = newlySkus.map(sku => {
    const detail = detailBySku.get(sku);
    const price = priceBySku.get(sku);
    const inSupplier = supplierSet!.has(sku);
    const inStd = stdSet!.has(sku);
    const inSell = sellableQueryable ? sellSet!.has(sku) : null;

    const productExists = detail != null;
    const title = titleOf(detail) || (newlyMap.get(sku) ?? '');
    const hasTitle = title.length > 0;
    const hasImage = imageOf(detail);
    const { has: hasPrice, positive: pricePositive } = priceOf(price);

    const invalid_reasons: string[] = [];
    if (!productExists) invalid_reasons.push('product_not_found');
    if (!hasTitle) invalid_reasons.push('missing_title');
    if (hasImage === false) invalid_reasons.push('no_image');
    if (hasImage === null) invalid_reasons.push('image_unknown');
    if (hasPrice === false) invalid_reasons.push('no_price');
    if (hasPrice === null) invalid_reasons.push('price_unknown');
    if (hasPrice === true && !pricePositive) invalid_reasons.push('price_not_positive');

    let classification: Classification;
    if (inSell === true || inSupplier || inStd) {
      // Already in our system (published or imported) → not a new sync target.
      classification = 'already_exists';
    } else {
      const valid =
        productExists && hasTitle &&
        hasImage === true &&
        hasPrice === true && pricePositive;
      classification = valid ? 'ready_for_sync' : 'blocked_or_invalid';
    }

    return {
      sku, classification, title,
      in_supplier_products: inSupplier,
      in_standardized_products: inStd,
      in_sellable_products: inSell,
      product_exists: productExists,
      has_title: hasTitle,
      has_image: hasImage,
      has_price: hasPrice,
      price_positive: pricePositive,
      invalid_reasons,
    };
  });

  // ── 5. Tally + write reports ──────────────────────────────────────────────
  const count = (c: Classification) => candidates.filter(x => x.classification === c).length;
  const totals = {
    processed: candidates.length,
    ready_for_sync: count('ready_for_sync'),
    already_exists: count('already_exists'),
    blocked_or_invalid: count('blocked_or_invalid'),
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const fullJson = {
    run_id: RUN_ID,
    timestamp: TIMESTAMP,
    input_file: rel(DELTA_FILE),
    delta_run_id: delta.run_id ?? null,
    creds_source: credsSource,
    sellable_products_queryable: sellableQueryable,
    fetch: { detail_batch_failures: detailFailures, price_batch_failures: priceFailures },
    newly_saved_skus: newlySkus,
    processed_skus: newlySkus,
    totals,
    candidates,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(fullJson, null, 2));

  const yn = (v: boolean | null) => v === null ? '?' : v ? 'Y' : 'N';
  const md: string[] = [];
  md.push('# GIGA Newly-Saved Candidates (read-only, Phase 2A)', '');
  md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- input_file: ${rel(DELTA_FILE)}`);
  md.push(`- creds_source: ${credsSource}`, `- sellable_products_queryable: ${sellableQueryable}`);
  md.push(`- processed (newly_saved only): ${totals.processed}`, '');
  md.push('## Totals',
    `- ready_for_sync: ${totals.ready_for_sync}`,
    `- already_exists: ${totals.already_exists}`,
    `- blocked_or_invalid: ${totals.blocked_or_invalid}`, '');
  md.push('## Candidates', '',
    '| SKU | classification | supplier | std | sellable | exists | title | img | price>0 | reasons | name |',
    '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const c of candidates) {
    md.push(`| ${c.sku} | ${c.classification} | ${yn(c.in_supplier_products)} | ${yn(c.in_standardized_products)} | ${yn(c.in_sellable_products)} | ${yn(c.product_exists)} | ${yn(c.has_title)} | ${yn(c.has_image)} | ${c.price_positive ? 'Y' : 'N'} | ${c.invalid_reasons.join(';')} | ${c.title.replace(/\|/g, '/').slice(0, 60)} |`);
  }
  fs.writeFileSync(OUT_MD, md.join('\n'));

  // ── 6. Output ──────────────────────────────────────────────────────────────
  console.log('GIGA_NEWLY_SAVED_SUMMARY');
  console.log(`run_id=${RUN_ID}`);
  console.log(`input_file=${rel(DELTA_FILE)}`);
  console.log(`creds_source=${credsSource}`);
  console.log(`newly_saved_skus=${newlySkus.length}`);
  console.log(`processed_skus=${newlySkus.join(',')}`);
  console.log(`ready_for_sync=${totals.ready_for_sync}`);
  console.log(`already_exists=${totals.already_exists}`);
  console.log(`blocked_or_invalid=${totals.blocked_or_invalid}`);
  console.log(`detail_batch_failures=${detailFailures}`);
  console.log(`price_batch_failures=${priceFailures}`);
  console.log(`report_json=${rel(OUT_JSON)}`);
  console.log(`report_md=${rel(OUT_MD)}`);
  if (!SUMMARY) {
    for (const c of candidates) console.log(`candidate=${c.sku} class=${c.classification} reasons=${c.invalid_reasons.join(';') || 'none'}`);
  }
})().catch(e => { console.error('GIGA_NEWLY_SAVED_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
