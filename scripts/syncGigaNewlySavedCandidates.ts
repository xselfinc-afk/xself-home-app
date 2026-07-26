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
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const SUMMARY = argv.includes('--summary');
const FORCE = argv.includes('--force');
// Hard per-SKU scope: --only=SKU[,SKU2] restricts processing to EXACTLY these SKUs (intersected with
// ready_for_sync). Used for controlled single-SKU publishes so other newly-saved SKUs are untouched.
const onlyArg = argv.find(a => a.startsWith('--only='));
const ONLY_SKUS = onlyArg ? onlyArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : null;
// --candidates: source the eligible SKU set from reports/giga-auto-publish/candidates.csv
// (headline_bucket=ready) instead of the newly-saved-delta ready_for_sync report. Additive + flag-gated;
// the entire downstream re-verify + fetch + upsertPickupProducts path is reused unchanged.
const CANDIDATES = argv.includes('--candidates');
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

// ── Candidate-source helpers (PURE; exported for offline tests) ───────────────
/** Minimal RFC-4180 parser: handles quoted commas, escaped "" quotes, embedded newlines, empty cells. */
export function parseCsvRfc4180(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export interface CandidateSelection {
  eligible: { sku: string; title: string }[];
  rejections: { sku: string; reason: string }[];
  readyCount: number;
}
/**
 * Determine which SKUs are eligible for import from candidates.csv. A SKU is eligible only when its
 * row is headline_bucket=ready AND not duplicate AND not needs-review AND absent from all 3 tables
 * (per the report) AND not explicitly unavailable. When onlySkus is given, evaluate EXACTLY those and
 * return a rejection (never a silent skip) for any that fail; otherwise return all ready rows.
 */
export function selectApprovedCandidates(csvText: string, onlySkus: string[] | null): CandidateSelection {
  const rows = parseCsvRfc4180(csvText);
  if (rows.length === 0) return { eligible: [], rejections: [], readyCount: 0 };
  const header = rows[0];
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[h] = i; });
  for (const col of ['supplier_product_id', 'title', 'headline_bucket', 'duplicate_of', 'needs_review_reason', 'product_type_id', 'in_supplier_products', 'in_standardized_products', 'in_sellable_products', 'sku_available']) {
    if (!(col in idx)) throw new Error(`candidates.csv missing required column: ${col}`);
  }
  const bySku = new Map<string, string[]>();
  let readyCount = 0;
  for (const r of rows.slice(1)) {
    if (r.length <= idx.supplier_product_id) continue;
    const sku = r[idx.supplier_product_id];
    if (!sku) continue;
    if (!bySku.has(sku)) bySku.set(sku, r);
    if (r[idx.headline_bucket] === 'ready') readyCount++;
  }
  const evaluate = (sku: string): { ok: boolean; reason?: string; title?: string } => {
    const r = bySku.get(sku);
    if (!r) return { ok: false, reason: 'not_in_candidates' };
    const g = (c: string) => (r[idx[c]] ?? '').trim();
    if (g('headline_bucket') !== 'ready') return { ok: false, reason: `not_ready(headline=${g('headline_bucket') || '?'})` };
    if (g('duplicate_of')) return { ok: false, reason: `duplicate_of=${g('duplicate_of')}` };
    if (g('needs_review_reason') || g('product_type_id') === 'needs-review') return { ok: false, reason: 'needs_review' };
    if (g('in_supplier_products') === 'true' || g('in_standardized_products') === 'true' || g('in_sellable_products') === 'true') return { ok: false, reason: 'already_imported_or_published_per_report' };
    if (g('sku_available') === 'unavailable') return { ok: false, reason: 'unavailable' };
    return { ok: true, title: g('title') };
  };
  const targets = (onlySkus && onlySkus.length)
    ? onlySkus
    : [...bySku.keys()].filter(s => (bySku.get(s)![idx.headline_bucket] ?? '') === 'ready');
  const eligible: { sku: string; title: string }[] = [];
  const rejections: { sku: string; reason: string }[] = [];
  for (const sku of targets) {
    const e = evaluate(sku);
    if (e.ok) eligible.push({ sku, title: e.title ?? '' });
    else rejections.push({ sku, reason: e.reason! });
  }
  return { eligible, rejections, readyCount };
}

export async function main(): Promise<void> {
  const RUN_ID = crypto.randomUUID();
  const TIMESTAMP = new Date().toISOString();
  let sourceFileRel = rel(INPUT_FILE);
  let candidatesRunId: string | null = null;

  // ── 1. Determine the eligible SKU set ──────────────────────────────────────
  // Default: newly-saved-delta ready_for_sync (Phase 2A report). --candidates: approved rows from the
  // candidate scan (candidates.csv, headline_bucket=ready). BOTH feed the SAME downstream re-verify +
  // fetch + upsertPickupProducts path below — only the SKU source differs.
  const readyMap = new Map<string, string>();
  let readySkus: string[];
  if (CANDIDATES) {
    const CSV_FILE = path.join(REPORT_DIR, 'candidates.csv');
    sourceFileRel = rel(CSV_FILE);
    if (!fs.existsSync(CSV_FILE)) die('candidates report not found; run `npm run giga:saved:candidate-scan` first', { candidates_file: sourceFileRel });
    let sel;
    try { sel = selectApprovedCandidates(fs.readFileSync(CSV_FILE, 'utf8'), ONLY_SKUS); }
    catch (e) { die(`candidates.csv could not be read: ${e instanceof Error ? e.message : String(e)}`, { candidates_file: sourceFileRel }); }
    // Every requested SKU must be eligible; NEVER silently skip an invalid requested SKU.
    if (ONLY_SKUS && sel.rejections.length) {
      die(`--candidates: requested SKU(s) not eligible: ${sel.rejections.map(r => `${r.sku}(${r.reason})`).join('; ')}`, { rejections: sel.rejections, ready_available: sel.readyCount });
    }
    for (const c of sel.eligible) readyMap.set(c.sku, c.title);
    readySkus = [...readyMap.keys()];
    if (readySkus.length === 0) die('--candidates: no eligible ready SKUs selected', { ready_available: sel.readyCount, only: ONLY_SKUS ?? '(none)' });
  } else {
    if (!fs.existsSync(INPUT_FILE)) die('newly-saved candidates report not found; run `npm run giga:newly-saved:plan` first', { input_file: rel(INPUT_FILE) });
    let report: any;
    try { report = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8')); }
    catch (e) { die(`candidates report is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { input_file: rel(INPUT_FILE) }); }
    if (!Array.isArray(report?.candidates)) die('candidates report missing candidates[] (corrupt/wrong shape)', { input_file: rel(INPUT_FILE), keys: report ? Object.keys(report) : 'null' });
    candidatesRunId = report.run_id ?? null;
    for (const c of report.candidates) {
      if (c?.classification === 'ready_for_sync') {
        const sku = String(c?.sku ?? '').trim();
        if (sku && !readyMap.has(sku)) readyMap.set(sku, String(c?.title ?? '').trim());
      }
    }
    readySkus = [...readyMap.keys()];
    // Apply hard --only scope (intersect with ready_for_sync). Report any requested SKU that is NOT
    // ready_for_sync rather than silently proceeding.
    if (ONLY_SKUS) {
      const readySet = new Set(readySkus);
      const notReady = ONLY_SKUS.filter(s => !readySet.has(s));
      if (notReady.length) die(`--only includes SKU(s) not in ready_for_sync: ${notReady.join(',')}`, { ready_for_sync: readySkus });
      readySkus = readySkus.filter(s => ONLY_SKUS.includes(s));
    }
  }

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
      input_file: sourceFileRel,
      candidates_run_id: candidatesRunId,
      source_mode: CANDIDATES ? 'candidates.csv' : 'newly-saved-delta',
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
    md.push(`- input_file: ${sourceFileRel} (source_mode: ${CANDIDATES ? 'candidates.csv' : 'newly-saved-delta'})`);
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
    console.log(`input_file=${sourceFileRel}`);
    console.log(`source_mode=${CANDIDATES ? 'candidates.csv' : 'newly-saved-delta'}`);
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

  // Candidate mode is ALL-OR-NOTHING: any missing detail aborts the whole approved batch before any
  // write (never partially import an approved set). Default mode keeps its existing tolerant behavior.
  if (CANDIDATES && missingDetail.length > 0) {
    die(`--candidates: all-or-nothing — GIGA detail missing at sync time for ${missingDetail.length} approved SKU(s); wrote nothing: ${missingDetail.join(',')}`, { missing_detail: missingDetail });
  }

  const mergedPreview = mergedItems.map((m: any) => ({
    supplier_product_id: String(m.sku),
    title: String(m.title ?? m.productName ?? ''),
    price: Number(m.price ?? m.discountedPrice ?? m.exclusivePrice ?? m.salePrice ?? 0) || 0,
    images_count: Array.isArray(m.imageUrls ?? m.images ?? m.imageList) ? (m.imageUrls ?? m.images ?? m.imageList).length : 0,
    inventory: Number(m.stock ?? m.inventory ?? (m.skuAvailable ? 1 : 0)) || 0,
  }));

  // Candidate mode: validate EVERY mapped row before the single write (all-or-nothing). A stale
  // price/image at sync time aborts the whole batch rather than importing a degraded row.
  if (CANDIDATES) {
    const notFetched = toProcess.filter(s => !detailBySku.has(s));
    const invalidRows = mergedPreview.filter(r => !(r.price > 0) || r.images_count === 0);
    if (notFetched.length || invalidRows.length) {
      die('--candidates: all-or-nothing pre-write validation failed; wrote nothing', {
        not_fetched: notFetched,
        invalid_rows: invalidRows.map(r => ({ sku: r.supplier_product_id, price: r.price, images: r.images_count })),
      });
    }
  }

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
}

// Run only when invoked directly (so tests can import the pure helpers without executing the CLI).
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(e => { console.error('GIGA_NEWLY_SAVED_SYNC_ERROR'); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
