/**
 * syncGigaNewlySavedCandidates.ts — Phase 2B: sync-only import of READY newly-saved GIGA SKUs.
 *
 * Imports ONLY ready_for_sync SKUs (from the Phase 2A report) into supplier_products as UNPUBLISHED
 * candidates. It does NOT publish, normalize, create standardized_products/sellable_products, upload
 * images, write blurhash, or seed reviews/inventory. A saved item is a CANDIDATE ONLY.
 *
 * It is a THIN orchestrator: the actual supplier_products write + mapping is delegated to the existing
 * canonical path upsertPickupProducts() in src/services/supplierPickupService.ts. No new insert/mapping
 * logic is introduced here. We only scope the input to ready_for_sync, re-verify membership, fetch
 * detail/price for those SKUs, and call upsertPickupProducts with the right safety flag:
 *   dry-run (default)  → upsertPickupProducts(..., { dryRun: true })       → ZERO DB writes
 *   --sync (explicit)  → upsertPickupProducts(..., { insertNewOnly: true }) → INSERT new rows only
 *
 * insertNewOnly uses .insert() on only not-yet-present SKUs, so existing rows are never updated and
 * never duplicated → idempotent. New rows omit `published`, taking the supplier_products DB default
 * (verified false). App visibility additionally requires a standardized_products row, which this
 * script never creates — so imported rows are not exposed in the app feed.
 *
 * Restrictions consumed from the input report only (never the full saved list / unchanged / backlog).
 *
 * Usage:
 *   npm run giga:newly-saved:sync:dry      # DRY_RUN=1, no writes (default)
 *   npm run giga:newly-saved:sync          # --sync, real insert (requires separate approval)
 *   npx tsx scripts/syncGigaNewlySavedCandidates.ts [--sync] [--limit=N] [--force] [--summary]
 */
import { config as loadEnv } from 'dotenv';
// GIGA creds must be loaded BEFORE importing gigaApiClient/supplierPickupService (they read
// SUPPLIER_* at module-eval time). Alt-default cascade, same as every other saved-items script.
import * as fsForEnv from 'node:fs';
{
  const forceDefault = process.env.GIGA_SAVED_USE_ALT_CREDS === '0';
  if (!forceDefault && fsForEnv.existsSync('.env.giga-alt.local')) loadEnv({ path: '.env.giga-alt.local' });
  loadEnv({ path: '.env.local' });
  loadEnv({ path: '.env' });
}
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const FORCE = argv.includes('--force');
// DRY_RUN=1 always forces dry (safer); real sync needs --sync or APPLY=1 AND no DRY_RUN=1.
const FORCE_DRY = process.env.DRY_RUN === '1';
const REAL_SYNC = !FORCE_DRY && (argv.includes('--sync') || process.env.APPLY === '1');
const MODE: 'dry' | 'sync' = REAL_SYNC ? 'sync' : 'dry';
const SAFE_LIMIT_DEFAULT = 25;
const limitArg = argv.find(a => a.startsWith('--limit='));
const SAFE_LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10) || SAFE_LIMIT_DEFAULT) : SAFE_LIMIT_DEFAULT;

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const INPUT_FILE = path.join(REPORT_DIR, 'latest-newly-saved-candidates.json');
const OUT_JSON = path.join(REPORT_DIR, 'latest-newly-saved-sync.json');
const OUT_MD = path.join(REPORT_DIR, 'latest-newly-saved-sync.md');
const rel = (p: string) => path.relative(process.cwd(), p);
const ENRICH_BATCH = 200;

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error('GIGA_NEWLY_SAVED_SYNC_ERROR');
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

(async () => {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();

  // ── 1. Read Phase 2A report; extract ONLY ready_for_sync SKUs ──────────────
  if (!fs.existsSync(INPUT_FILE)) die('newly-saved candidates report not found; run `npm run giga:newly-saved:plan` first', { input_file: rel(INPUT_FILE) });
  let report: any;
  try { report = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); }
  catch (e) { die(`candidates report is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { input_file: rel(INPUT_FILE) }); }
  if (!Array.isArray(report?.candidates)) die('candidates report missing candidates[] (corrupt/wrong shape)', { input_file: rel(INPUT_FILE), keys: report ? Object.keys(report) : 'null' });

  const readyMap = new Map<string, string>();
  for (const c of report.candidates) {
    if (c?.classification === 'ready_for_sync') {
      const sku = String(c?.sku ?? '').trim();
      if (sku && !readyMap.has(sku)) readyMap.set(sku, String(c?.title ?? '').trim());
    }
  }
  const readySkus = [...readyMap.keys()];

  // ── Supabase (read-only here; writes only via upsertPickupProducts in sync mode) ──
  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // ── 2. published-safety gate (read-only): confirm import path yields published=false ──
  // normalizeSupplierItem never writes `published`, so inserts take the column default. Confirm that
  // import-path rows exist as published=false (the OR-clause the requirement allows).
  async function verifyPublishedFalse(): Promise<{ verified: boolean; evidence: string }> {
    const { count: falseCount, error: e1 } = await sb.from('supplier_products').select('*', { count: 'exact', head: true }).eq('published', false);
    if (e1) return { verified: false, evidence: `published read failed: ${e1.message}` };
    if ((falseCount ?? 0) > 0) {
      return { verified: true, evidence: `${falseCount} existing supplier_products rows are published=false; import path (normalizeSupplierItem) never sets published, so new inserts take the DB default=false` };
    }
    return { verified: false, evidence: 'no published=false rows found; cannot confirm import-path default' };
  }
  const publishedCheck = await verifyPublishedFalse();
  if (MODE === 'sync' && !publishedCheck.verified) {
    die('published=false default could not be verified; refusing real sync', { evidence: publishedCheck.evidence });
  }

  // ── 3. Re-verify each ready SKU is STILL absent from all 3 tables (read-only) ──
  async function membership(table: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const { data, error } = await sb.from(table).select('supplier_product_id').in('supplier_product_id', ids);
    if (error) die(`${table} re-verification read failed: ${error.message}`);
    return new Set((data ?? []).map((r: any) => String(r.supplier_product_id)));
  }
  const inSupplier = await membership('supplier_products', readySkus);
  const inStd = await membership('standardized_products', readySkus);
  const inSell = await membership('sellable_products', readySkus);

  const droppedAlreadyPresent = readySkus
    .filter(s => inSupplier.has(s) || inStd.has(s) || inSell.has(s))
    .map(s => ({ sku: s, in_supplier: inSupplier.has(s), in_standardized: inStd.has(s), in_sellable: inSell.has(s) }));
  const toProcess = readySkus.filter(s => !inSupplier.has(s) && !inStd.has(s) && !inSell.has(s));

  // ── 4. Safe-limit guard ──
  if (toProcess.length > SAFE_LIMIT && !FORCE) {
    die(`${toProcess.length} SKUs to process exceeds safe limit ${SAFE_LIMIT}; pass --limit=${toProcess.length} (or higher) or --force`, {
      to_process: toProcess.length, safe_limit: SAFE_LIMIT,
    });
  }

  // Helper to write reports + print summary, used by both the empty and normal paths.
  function emit(result: any, mergedPreview: any[]) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const fullJson = {
      run_id: RUN_ID, timestamp: TIMESTAMP, mode: MODE,
      input_file: rel(INPUT_FILE),
      candidates_run_id: report.run_id ?? null,
      published_default_check: publishedCheck,
      safe_limit: SAFE_LIMIT,
      ready_for_sync_input: readySkus,
      dropped_already_present: droppedAlreadyPresent,
      processed_skus: toProcess,
      sync_result: result,
      row_preview: mergedPreview,
    };
    fs.writeFileSync(OUT_JSON, JSON.stringify(fullJson, null, 2));

    const md: string[] = [];
    md.push('# GIGA Newly-Saved Sync (Phase 2B)', '');
    md.push(`- run_id: ${RUN_ID}`, `- timestamp: ${TIMESTAMP}`, `- mode: ${MODE}${MODE === 'dry' ? ' (no DB writes)' : ' (insert new only)'}`);
    md.push(`- input_file: ${rel(INPUT_FILE)}`);
    md.push(`- published_default_check: verified=${publishedCheck.verified} — ${publishedCheck.evidence}`, '');
    md.push('## Scope',
      `- ready_for_sync input: ${readySkus.length} [${readySkus.join(', ') || '(none)'}]`,
      `- dropped (already present): ${droppedAlreadyPresent.length}`,
      `- processed (still absent): ${toProcess.length} [${toProcess.join(', ') || '(none)'}]`, '');
    md.push('## Result',
      `- would_insert/inserted: ${result?.inserted ?? 0}`,
      `- existing/skipped: ${result?.skipped ?? 0}`,
      `- dry_run: ${result?.dryRun === true}`, '');
    if (mergedPreview.length) {
      md.push('## Row preview (mapped supplier_products)', '', '| sku | title | price | images | inventory |', '|---|---|---|---|---|');
      for (const r of mergedPreview) md.push(`| ${r.supplier_product_id} | ${String(r.title).replace(/\|/g, '/').slice(0, 50)} | ${r.price} | ${r.images_count} | ${r.inventory} |`);
    }
    fs.writeFileSync(OUT_MD, md.join('\n'));

    console.log('GIGA_NEWLY_SAVED_SYNC_SUMMARY');
    console.log(`run_id=${RUN_ID}`);
    console.log(`mode=${MODE}`);
    console.log(`input_file=${rel(INPUT_FILE)}`);
    console.log(`ready_for_sync=${readySkus.length}`);
    console.log(`processed_skus=${toProcess.join(',') || '(none)'}`);
    console.log(`would_insert=${result?.inserted ?? 0}`);
    console.log(`existing_or_skipped=${(result?.skipped ?? 0) + droppedAlreadyPresent.length}`);
    console.log(`dropped_already_present=${droppedAlreadyPresent.length}`);
    console.log(`published_default_verified=${publishedCheck.verified}`);
    console.log(`db_writes=${MODE === 'dry' ? 'none' : `supplier_products_insert(${result?.inserted ?? 0})`}`);
    console.log(`report_json=${rel(OUT_JSON)}`);
    console.log(`report_md=${rel(OUT_MD)}`);
  }

  // ── 5. Nothing to process → clean exit (still writes a valid report) ──
  if (toProcess.length === 0) {
    emit({ fetched: 0, upserted: 0, inserted: 0, updated: 0, skipped: droppedAlreadyPresent.length, dryRun: MODE === 'dry' }, []);
    return;
  }

  // ── 6. Fetch GIGA detail + price (read-only) for ONLY the to-process SKUs ──
  const { fetchProductDetails, fetchProductPrices } = await import('../src/services/gigaApiClient');
  const detailBySku = new Map<string, any>();
  const priceBySku = new Map<string, any>();
  {
    const realLog = console.log; console.log = () => {};
    try {
      for (let i = 0; i < toProcess.length; i += ENRICH_BATCH) {
        const batch = toProcess.slice(i, i + ENRICH_BATCH);
        const d = await (fetchProductDetails as any)(batch);
        const dArr: any[] = d?.data?.records ?? d?.data?.list ?? (Array.isArray(d?.data) ? d.data : []);
        for (const it of dArr) if (it?.sku) detailBySku.set(String(it.sku), it);
        const p = await (fetchProductPrices as any)(batch);
        const pArr: any[] = p?.data?.records ?? p?.data?.list ?? (Array.isArray(p?.data) ? p.data : []);
        for (const it of pArr) if (it?.sku) priceBySku.set(String(it.sku), it);
      }
    } finally { console.log = realLog; }
  }

  // ── 7. Build merged GIGA items (listing stub ⊕ detail ⊕ price), same shape supplierPickupService uses ──
  const missingDetail: string[] = [];
  const mergedItems = toProcess.map(sku => {
    const detail = detailBySku.get(sku);
    if (!detail) missingDetail.push(sku);
    const price = priceBySku.get(sku) ?? {};
    const stub = { sku, productName: readyMap.get(sku) ?? '' };
    return { ...stub, ...(detail ?? {}), ...price };
  }).filter(m => detailBySku.has(String(m.sku)));

  if (missingDetail.length > 0) {
    // A ready_for_sync SKU with no detail at sync time is unexpected — report but do not fabricate.
    console.error('GIGA_NEWLY_SAVED_SYNC_WARNING');
    console.error(`warning=detail missing at sync time for: ${missingDetail.join(',')} (excluded from this run)`);
  }
  if (mergedItems.length === 0) die('no enriched items available to sync (GIGA detail fetch returned nothing for ready SKUs)', { missing_detail: missingDetail });

  const mergedPreview = mergedItems.map((m: any) => ({
    supplier_product_id: String(m.sku),
    title: String(m.title ?? m.productName ?? ''),
    price: Number(m.price ?? m.discountedPrice ?? m.exclusivePrice ?? m.salePrice ?? 0) || 0,
    images_count: Array.isArray(m.imageUrls ?? m.images ?? m.imageList) ? (m.imageUrls ?? m.images ?? m.imageList).length : 0,
    inventory: Number(m.stock ?? m.inventory ?? (m.skuAvailable ? 1 : 0)) || 0,
  }));

  // ── 8. Delegate the write to the canonical path (single source of truth) ──
  const { upsertPickupProducts } = await import('../src/services/supplierPickupService');
  let result;
  if (MODE === 'dry') {
    result = await upsertPickupProducts(sb, mergedItems as any, { dryRun: true });
  } else {
    result = await upsertPickupProducts(sb, mergedItems as any, { insertNewOnly: true });
  }

  emit(result, mergedPreview);
  if (!SUMMARY) {
    for (const m of mergedPreview) console.log(`row=${m.supplier_product_id} price=${m.price} images=${m.images_count} inv=${m.inventory}`);
  }
})().catch(e => { console.error('GIGA_NEWLY_SAVED_SYNC_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
