/**
 * gigaSavedToLiveOrchestrator.ts — low-risk, anti-blocking saved→live lifecycle orchestrator.
 *
 * ONE controlled command for the future product lifecycle:
 *   pickup saved/favorite SKU → detect newly saved → import → publish → refresh delivery fee → report
 *
 * DEFAULT MODE IS PLAN (read-only). APPLY requires an explicit --apply flag. This is a THIN
 * orchestrator: it composes the EXISTING, already-reviewed scripts (delta, candidate plan, newly-saved
 * import, auto-publish planner+runner, hybrid fee refresh) via sequential spawnSync — it introduces no
 * new import/publish/fee logic of its own.
 *
 * ── PLAN (default) — read-only, ZERO writes ─────────────────────────────────────────────────────────
 *   1. Read pickup saved list via the official-API helper only (scripts/lib/gigaSavedItems.ts → skus/v1).
 *   2. Compare to the saved baseline (reports/giga-auto-publish/saved-items-baseline.json).
 *   3. Detect newly saved SKUs (set diff vs baseline).
 *   4. Cap to MAX_SKUS (default 15).
 *   5. Read-only Supabase membership/readiness: supplier_products, standardized_products,
 *      sellable_products, inventory_cache, giga_delivery_fee_cache (scoped .in() over the capped SKUs).
 *   6. Classify each SKU and write reports/giga-auto-publish/latest-saved-to-live-plan.{json,md}.
 *   PLAN does NOT write the DB, does NOT advance the baseline, does NOT publish, does NOT refresh fees.
 *
 * ── APPLY (--apply only) — drives the existing pipeline, scoped to the capped SKUs ──────────────────
 *   1. giga-saved-delta.ts                       (refresh delta vs baseline)
 *   2. planGigaNewlySavedCandidates.ts           (Phase 2A candidate report)
 *   3. syncGigaNewlySavedCandidates.ts --sync --only=<capped> --limit=MAX   (import → supplier_products)
 *   4. planGigaAutoPublish.ts --only=<capped> --max-skus=MAX                 (scoped publish plan)
 *   5. runGigaAutoPublish.ts --plan … --dry-run  (safety simulate) → --apply (publish) — apply only if dry clean
 *   6. Collect published SKUs from latest-apply.json / latest-plan.json (intersect with capped set).
 *   7. refreshGigaDeliveryFeesHybrid.ts --skus <published in scope>   — SOFT-FAIL (log, never rollback).
 *   8. Write reports/giga-auto-publish/latest-saved-to-live-apply.{json,md}.
 *   APPLY never advances the baseline (recommends it in the report), never scrapes the portal for
 *   inventory, never calls order/write/favorite APIs.
 *
 * ── Low-risk controls ───────────────────────────────────────────────────────────────────────────────
 *   • MAX_SKUS=15 default. • Strictly sequential (spawnSync) — NO parallel GIGA calls. • No retry loops.
 *   • Hard safety STOP (abort the chain, write the report, exit non-zero) on: captcha/login challenge,
 *     HTTP 401/403, B20003 permission, rate limit, unexpected/unknown response shape, or too many
 *     failures. • Pickup creds (SUPPLIER_CLIENT_* via .env.giga-alt.local cascade) and dropship creds
 *     (SUPPLIER_DELIVERY_*) live in separate child processes and are never mixed.
 *   • Official API first; the portal is touched ONLY inside the existing hybrid fee refresh, ONLY in
 *     APPLY, ONLY after publish.
 *   • No secrets/cookies/tokens/signs/nonces/headers are ever printed or persisted (only step status).
 *
 * Usage:
 *   npm run giga:saved-to-live:plan      # PLAN (read-only, default)
 *   npm run giga:saved-to-live:apply     # APPLY (gated; runs the existing pipeline)
 *   npx tsx scripts/gigaSavedToLiveOrchestrator.ts [--apply] [--max-skus=N] [--summary] [--default-creds] [--max-pages=N]
 */
import { config as loadEnv } from 'dotenv';
// GIGA creds must be loaded BEFORE any child / Supabase read. Alt-default cascade, identical to every
// other saved-items script: .env.giga-alt.local (pickup SUPPLIER_* win) → .env.local (Supabase key) → .env.
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
import { spawnSync } from 'node:child_process';
import { fetchAllSavedItems, GigaSavedItemsError, ENDPOINT_PATH, SKU_FIELD } from './lib/gigaSavedItems';

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const SUMMARY = argv.includes('--summary');
const FORCE_DEFAULT_CREDS = argv.includes('--default-creds') || process.env.GIGA_SAVED_USE_ALT_CREDS === '0';
const maxPagesArg = argv.find(a => a.startsWith('--max-pages='));
const MAX_PAGES = maxPagesArg ? Math.max(1, parseInt(maxPagesArg.split('=')[1], 10) || 0) : Infinity;
const maxSkusArg = argv.find(a => a.startsWith('--max-skus='));
const MAX_SKUS = maxSkusArg ? Math.max(1, parseInt(maxSkusArg.split('=')[1], 10) || 15) : 15;
const MAX_STEP_FAILURES = 1; // first hard failure aborts the chain (no aggressive retry)

const REPORT_DIR = path.join(process.cwd(), 'reports', 'giga-auto-publish');
const BASELINE_FILE = path.join(REPORT_DIR, 'saved-items-baseline.json');
const PLAN_FILE_AUTOPUB = path.join('reports', 'giga-auto-publish', 'latest-plan.json');
const APPLY_FILE_AUTOPUB = path.join(REPORT_DIR, 'latest-apply.json');
const PLAN_JSON = path.join(REPORT_DIR, 'latest-saved-to-live-plan.json');
const PLAN_MD = path.join(REPORT_DIR, 'latest-saved-to-live-plan.md');
const STL_APPLY_JSON = path.join(REPORT_DIR, 'latest-saved-to-live-apply.json');
const STL_APPLY_MD = path.join(REPORT_DIR, 'latest-saved-to-live-apply.md');
const rel = (p: string) => path.relative(process.cwd(), p);
const PREFIX = 'GIGA_SAVED_TO_LIVE';

// Hard-stop signal tokens scanned in each child's combined output (case-insensitive).
const STOP_PATTERNS: { code: string; re: RegExp }[] = [
  { code: 'captcha_or_login', re: /captcha|verification code|login required|sign[- ]?in challenge|please log\s?in|session expired|not logged in/i },
  { code: 'http_401_403', re: /\b(401|403)\b|unauthorized|forbidden/i },
  { code: 'permission_b20003', re: /B20003|permission (denied|invalid)|no permission|account or service/i },
  { code: 'rate_limited', re: /\b429\b|rate.?limit|too many requests|request throttled/i },
  { code: 'unknown_response_shape', re: /unexpected .*response shape|unknown response|response shape/i },
];

function die(msg: string, extra?: Record<string, unknown>): never {
  console.error(`${PREFIX}_ERROR`);
  console.error(`error=${msg}`);
  if (extra) for (const [k, v] of Object.entries(extra)) console.error(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  process.exit(1);
}

function detectStop(output: string): string | null {
  for (const { code, re } of STOP_PATTERNS) if (re.test(output)) return code;
  return null;
}

type StepResult = {
  step: string;
  script: string;
  args: string[];
  exit_code: number | null;
  ok: boolean;
  stop_reason: string | null; // hard-stop token detected in output, if any
  summary_line: string | null; // the child's *_SUMMARY marker line, if present (no secrets)
};

/**
 * Run a child script sequentially via `npx tsx`. Captures combined output and scans it for hard-stop
 * tokens. Returns a structured StepResult. NEVER prints/persists raw child output (could be verbose) —
 * only the SUMMARY marker line + exit code + detected stop reason, so no secrets/headers leak.
 */
function runChild(step: string, script: string, args: string[]): StepResult {
  const full = ['tsx', script, ...args];
  const r = spawnSync('npx', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
  const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const stop = detectStop(combined);
  const summaryLine = combined.split('\n').find(l => /_SUMMARY$/.test(l.trim())) ?? null;
  const exit = r.status;
  return { step, script, args, exit_code: exit, ok: exit === 0 && !stop, stop_reason: stop, summary_line: summaryLine };
}

// ── Readiness types ───────────────────────────────────────────────────────────────────────────────
type Status =
  | 'new'               // not imported → would be imported
  | 'already_imported'  // imported (supplier/standardized) but not live in app
  | 'missing_inventory' // imported/eligible but inventory_status != in_stock or qty <= 0
  | 'missing_fee'       // live in app (sellable) but no delivery fee cached → delivery checkout blocked
  | 'ready'             // live in app (sellable); delivery fee cached (already_published is the in_sellable_products flag)
  | 'blocked';          // invalid (empty sku / normalization error)

type SkuRow = {
  sku: string;
  title: string;
  status: Status;
  in_supplier_products: boolean;
  in_standardized_products: boolean;
  in_sellable_products: boolean;
  published: boolean | null;            // standardized_products.published
  normalization_status: string | null;
  inventory_status: string | null;
  total_available_qty: number | null;
  inventory_cache_present: boolean;     // a website_scrape inventory_cache row exists
  fee_present: boolean;                 // giga_delivery_fee_cache.charged_fee_cents IS NOT NULL
  fee_consecutive_failures: number | null;
  would_import: boolean;
  would_publish: boolean;
  would_need_fee_refresh_after_publish: boolean;
  reason: string;
  suggested_next_action: string;
};

// ── Read-only Supabase readiness over the capped SKU set ────────────────────────────────────────────
async function readReadiness(skus: string[]): Promise<{
  rows: SkuRow[];
  titleBySku: Map<string, string>;
}> {
  const { createClient } = await import('@supabase/supabase-js');
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env (.env.local)');
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Helper: read a table scoped to the capped SKUs. Returns null only on hard read error.
  async function readTable(table: string, columns: string): Promise<any[]> {
    if (skus.length === 0) return [];
    const { data, error } = await sb.from(table).select(columns).in('supplier_product_id', skus);
    if (error) die(`supabase read failed on ${table}: ${error.message}`, { table });
    return (data ?? []) as any[];
  }

  const supplierRows = await readTable('supplier_products', 'supplier_product_id, published');
  const stdRows = await readTable('standardized_products',
    'supplier_product_id, normalization_status, published, inventory_status, total_available_qty, primary_image, product_title, price, selling_price');
  const sellRows = await readTable('sellable_products', 'supplier_product_id');
  const invRows = await readTable('inventory_cache', 'supplier_product_id, source_type');
  const feeRows = await readTable('giga_delivery_fee_cache', 'supplier_product_id, charged_fee_cents, consecutive_failures');

  const supplierSet = new Set(supplierRows.map(r => String(r.supplier_product_id)));
  const stdBySku = new Map(stdRows.map(r => [String(r.supplier_product_id), r]));
  const sellSet = new Set(sellRows.map(r => String(r.supplier_product_id)));
  const invWebsiteSet = new Set(invRows.filter(r => r.source_type === 'website_scrape').map(r => String(r.supplier_product_id)));
  const feeBySku = new Map(feeRows.map(r => [String(r.supplier_product_id), r]));
  const titleBySku = new Map<string, string>();

  const rows: SkuRow[] = skus.map(sku => {
    const inSupplier = supplierSet.has(sku);
    const std = stdBySku.get(sku);
    const inStd = !!std;
    const inSell = sellSet.has(sku);
    const normStatus: string | null = std?.normalization_status ?? null;
    const published: boolean | null = std?.published ?? null;
    const invStatus: string | null = std?.inventory_status ?? null;
    const qty: number | null = std?.total_available_qty ?? null;
    const invCachePresent = invWebsiteSet.has(sku);
    const fee = feeBySku.get(sku);
    const feePresent = fee != null && fee.charged_fee_cents != null;
    const feeFailures: number | null = fee?.consecutive_failures ?? null;
    const inventoryOk = invStatus === 'in_stock' && (qty ?? 0) > 0;

    // Status precedence (single most-actionable label; booleans below carry the full picture).
    let status: Status;
    if (normStatus === 'error') {
      status = 'blocked';
    } else if (!inSupplier && !inStd) {
      status = 'new';
    } else if (inSell) {
      status = feePresent ? 'ready' : 'missing_fee';
    } else if (inStd && !inventoryOk) {
      status = 'missing_inventory';
    } else {
      status = 'already_imported';
    }

    const isNew = status === 'new';
    const wouldImport = isNew;
    // Eligible to publish: imported/new and not yet live, with inventory not known-bad.
    const wouldPublish = !inSell && (isNew || inStd || inSupplier) && status !== 'blocked' && invStatus !== 'out_of_stock';
    // Any SKU that will be (or is) live but lacks a cached fee needs a post-publish fee refresh.
    const wouldNeedFee = !feePresent && (inSell || wouldPublish || isNew) && status !== 'blocked';

    const reasons: string[] = [];
    if (status === 'blocked') reasons.push('normalization_status=error');
    if (isNew) reasons.push('not in supplier_products/standardized_products');
    if (inStd && !inventoryOk && !inSell) reasons.push(`inventory not sellable (status=${invStatus ?? 'null'} qty=${qty ?? 'null'})`);
    if (inSell && !feePresent) reasons.push('in sellable_products but giga_delivery_fee_cache has no charged_fee_cents (delivery checkout would fail-closed)');
    if (inSell && feePresent) reasons.push('live and delivery-fee cached');
    if (status === 'already_imported') reasons.push('imported, not yet live in app');

    let action: string;
    if (status === 'new') action = 'APPLY would import (syncGigaNewlySavedCandidates --sync --only=…) then auto-publish';
    else if (status === 'already_imported') action = 'APPLY would run auto-publish (planGigaAutoPublish --only=… → runGigaAutoPublish --apply)';
    else if (status === 'missing_inventory') action = 'out of stock / hidden by inventory — downlisting stays owned by inventory sync; APPLY auto-publish uses the official quantity probe (no Playwright) to decide in_stock';
    else if (status === 'missing_fee') action = 'refresh delivery fee: npm run fees:refresh -- --sku ' + sku;
    else if (status === 'ready') action = 'none — live and checkout-safe';
    else action = 'review: normalization error — fix upstream before publishing';

    titleBySku.set(sku, std?.product_title ?? '');
    return {
      sku,
      title: std?.product_title ?? '',
      status,
      in_supplier_products: inSupplier,
      in_standardized_products: inStd,
      in_sellable_products: inSell,
      published,
      normalization_status: normStatus,
      inventory_status: invStatus,
      total_available_qty: qty,
      inventory_cache_present: invCachePresent,
      fee_present: feePresent,
      fee_consecutive_failures: feeFailures,
      would_import: wouldImport,
      would_publish: wouldPublish,
      would_need_fee_refresh_after_publish: wouldNeedFee,
      reason: reasons.join('; ') || '(none)',
      suggested_next_action: action,
    };
  });

  return { rows, titleBySku };
}

// ── PLAN: detect newly saved (capped) + readiness, write the plan report, return capped rows ────────
async function computePlan(): Promise<{
  runId: string;
  timestamp: string;
  credsSource: string;
  baselineMissing: boolean;
  credsDrift: boolean;
  totalSaved: number;
  newlySavedCount: number;
  processed: string[];
  deferredDueToCap: number;
  rows: SkuRow[];
}> {
  const runId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // 1. Read pickup saved list (the ONLY GIGA call in PLAN; paginated + 400ms/page inside the helper).
  let fetched;
  try {
    fetched = await fetchAllSavedItems({ maxPages: MAX_PAGES, forceDefaultCreds: FORCE_DEFAULT_CREDS });
  } catch (e) {
    if (e instanceof GigaSavedItemsError) die(e.message, e.details);
    die(`saved-items fetch failed: ${e instanceof Error ? e.message : String(e)}`, { endpoint_path: ENDPOINT_PATH });
  }
  const savedItems = fetched.items;
  const savedTitle = new Map<string, string>(savedItems.map(i => [i.sku, i.title]));

  // 2/3. Baseline compare → newly saved.
  let baselineMissing = false;
  let credsDrift = false;
  let baselineSkus = new Set<string>();
  if (!fs.existsSync(BASELINE_FILE)) {
    baselineMissing = true; // no baseline → treat all saved as "newly saved" (still capped); recommend capture.
  } else {
    let baseline: any;
    try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); }
    catch (e) { die(`baseline is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { baseline_file: rel(BASELINE_FILE) }); }
    if (!Array.isArray(baseline?.skus)) die('baseline missing skus[] (corrupt/wrong shape)', { baseline_file: rel(BASELINE_FILE) });
    baselineSkus = new Set<string>(baseline.skus.map((s: any) => String(s)));
    credsDrift = baseline.creds_source != null && baseline.creds_source !== fetched.credsSource;
  }

  const newly = baselineMissing ? savedItems.map(i => i.sku) : savedItems.filter(i => !baselineSkus.has(i.sku)).map(i => i.sku);
  // 4. Cap (preserve saved-list order = "Added time").
  const processed = newly.slice(0, MAX_SKUS);
  const deferredDueToCap = Math.max(0, newly.length - processed.length);

  // 5. Read-only readiness (scoped to capped SKUs). Skip Supabase entirely if creds drifted (account
  // switch ⇒ "newly saved" is meaningless) or nothing to process.
  let rows: SkuRow[] = [];
  if (!credsDrift && processed.length > 0) {
    const r = await readReadiness(processed);
    rows = r.rows;
  } else {
    rows = processed.map(sku => ({
      sku, title: savedTitle.get(sku) ?? '', status: 'new' as Status,
      in_supplier_products: false, in_standardized_products: false, in_sellable_products: false,
      published: null, normalization_status: null, inventory_status: null, total_available_qty: null,
      inventory_cache_present: false, fee_present: false, fee_consecutive_failures: null,
      would_import: false, would_publish: false, would_need_fee_refresh_after_publish: false,
      reason: credsDrift ? 'creds drift vs baseline — classification suppressed' : '(none)',
      suggested_next_action: credsDrift ? 're-baseline under the correct account first' : '(none)',
    }));
  }
  // Backfill titles from the saved list where the DB had none.
  for (const row of rows) if (!row.title) row.title = savedTitle.get(row.sku) ?? '';

  return {
    runId, timestamp, credsSource: fetched.credsSource, baselineMissing, credsDrift,
    totalSaved: savedItems.length, newlySavedCount: newly.length, processed, deferredDueToCap, rows,
  };
}

function tally(rows: SkuRow[]) {
  const c = (s: Status) => rows.filter(r => r.status === s).length;
  return {
    already_imported: c('already_imported'),
    already_published: rows.filter(r => r.in_sellable_products).length,
    missing_inventory: c('missing_inventory'),
    missing_delivery_fee: rows.filter(r => !r.fee_present && (r.in_sellable_products || r.would_publish || r.status === 'new')).length,
    ready: c('ready'),
    ready_to_publish_candidate: rows.filter(r => r.would_publish || r.status === 'new').length,
    blocked: c('blocked'),
    would_import: rows.filter(r => r.would_import).length,
  };
}

function writePlanReport(p: Awaited<ReturnType<typeof computePlan>>): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const totals = tally(p.rows);
  const json = {
    mode: 'plan',
    run_id: p.runId,
    timestamp: p.timestamp,
    creds_source: p.credsSource,
    endpoint_path: ENDPOINT_PATH,
    sku_field: SKU_FIELD,
    baseline_missing: p.baselineMissing,
    creds_drift_vs_baseline: p.credsDrift,
    max_skus: MAX_SKUS,
    total_pickup_saved: p.totalSaved,
    newly_saved: p.newlySavedCount,
    processed_this_run: p.processed.length,
    deferred_due_to_cap: p.deferredDueToCap,
    recommend_baseline_advance: !p.credsDrift && p.processed.length > 0,
    totals,
    items: p.rows,
  };
  fs.writeFileSync(PLAN_JSON, JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# GIGA Saved-to-Live PLAN (read-only)', '');
  md.push(`- run_id: ${p.runId}`, `- timestamp: ${p.timestamp}`, `- creds_source: ${p.credsSource}`);
  if (p.baselineMissing) md.push('- ⚠️ baseline_missing: true — all saved treated as newly-saved; run `npm run giga:saved:baseline` first');
  if (p.credsDrift) md.push('- ⚠️ creds_drift_vs_baseline: true — account switch, classification suppressed; re-baseline');
  md.push(`- max_skus: ${MAX_SKUS}`, '');
  md.push('## Totals',
    `- total_pickup_saved: ${p.totalSaved}`,
    `- newly_saved: ${p.newlySavedCount}`,
    `- processed_this_run: ${p.processed.length}`,
    `- deferred_due_to_cap: ${p.deferredDueToCap}`,
    `- already_imported: ${totals.already_imported}`,
    `- already_published: ${totals.already_published}`,
    `- missing_inventory: ${totals.missing_inventory}`,
    `- missing_delivery_fee: ${totals.missing_delivery_fee}`,
    `- ready_to_publish_candidate: ${totals.ready_to_publish_candidate}`,
    `- ready: ${totals.ready}`,
    `- blocked: ${totals.blocked}`, '');
  md.push('## Processed SKUs (capped)', '',
    '| SKU | status | import? | publish? | fee-refresh? | inv | fee | reason |',
    '|---|---|---|---|---|---|---|---|');
  const yn = (v: boolean | null) => v === null ? '?' : v ? 'Y' : 'N';
  for (const r of p.rows) {
    md.push(`| ${r.sku} | ${r.status} | ${yn(r.would_import)} | ${yn(r.would_publish)} | ${yn(r.would_need_fee_refresh_after_publish)} | ${r.inventory_status ?? '-'}/${r.total_available_qty ?? '-'} | ${yn(r.fee_present)} | ${r.reason.replace(/\|/g, '/').slice(0, 70)} |`);
  }
  fs.writeFileSync(PLAN_MD, md.join('\n'));
}

function printPlanSummary(p: Awaited<ReturnType<typeof computePlan>>): void {
  const totals = tally(p.rows);
  console.log(`${PREFIX}_PLAN_SUMMARY`);
  console.log(`run_id=${p.runId}`);
  console.log(`creds_source=${p.credsSource}`);
  console.log(`baseline_missing=${p.baselineMissing}`);
  console.log(`creds_drift_vs_baseline=${p.credsDrift}`);
  console.log(`max_skus=${MAX_SKUS}`);
  console.log(`total_pickup_saved=${p.totalSaved}`);
  console.log(`newly_saved=${p.newlySavedCount}`);
  console.log(`processed_this_run=${p.processed.length}`);
  console.log(`deferred_due_to_cap=${p.deferredDueToCap}`);
  console.log(`would_import=${totals.would_import}`);
  console.log(`ready_to_publish_candidate=${totals.ready_to_publish_candidate}`);
  console.log(`already_published=${totals.already_published}`);
  console.log(`missing_inventory=${totals.missing_inventory}`);
  console.log(`missing_delivery_fee=${totals.missing_delivery_fee}`);
  console.log(`ready=${totals.ready}`);
  console.log(`blocked=${totals.blocked}`);
  console.log(`report_json=${rel(PLAN_JSON)}`);
  console.log(`report_md=${rel(PLAN_MD)}`);
  console.log(`recommend_baseline_advance=${!p.credsDrift && p.processed.length > 0}`);
}

// ── APPLY: drive the existing pipeline, scoped to the capped SKUs ────────────────────────────────────
async function runApply(p: Awaited<ReturnType<typeof computePlan>>): Promise<void> {
  const runId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const steps: StepResult[] = [];
  let stopReason: string | null = null;
  let aborted = false;

  // Hard safety gate before touching anything.
  if (p.credsDrift) { stopReason = 'creds_drift_vs_baseline'; aborted = true; }
  if (p.baselineMissing && !aborted) { stopReason = 'baseline_missing'; aborted = true; }
  const capped = p.processed;
  if (capped.length === 0 && !aborted) { stopReason = 'no_newly_saved_skus'; aborted = true; }

  // SKUs we would import/publish (the existing child scripts re-verify with their own gates + --only).
  const scopeSkus = p.rows
    .filter(r => r.would_import || r.would_publish)
    .map(r => r.sku);
  if (scopeSkus.length === 0 && !aborted) { stopReason = 'nothing_eligible_to_import_or_publish'; aborted = true; }

  const onlyArg = scopeSkus.join(',');
  let publishedInScope: string[] = [];
  let feeRefresh: StepResult | null = null;

  if (!aborted) {
    // Sequential chain. Abort on the first hard failure (exit!=0 or a hard-stop token).
    const chain: { step: string; script: string; args: string[] }[] = [
      { step: 'delta', script: 'scripts/giga-saved-delta.ts', args: ['--summary'] },
      { step: 'candidates_plan', script: 'scripts/planGigaNewlySavedCandidates.ts', args: ['--summary'] },
      { step: 'import', script: 'scripts/syncGigaNewlySavedCandidates.ts', args: ['--sync', `--only=${onlyArg}`, `--limit=${MAX_SKUS}`, '--summary'] },
      { step: 'publish_plan', script: 'scripts/planGigaAutoPublish.ts', args: [`--only=${onlyArg}`, `--max-skus=${MAX_SKUS}`, '--summary'] },
      { step: 'publish_dry_run', script: 'scripts/runGigaAutoPublish.ts', args: ['--plan', PLAN_FILE_AUTOPUB, '--dry-run', '--summary'] },
      { step: 'publish_apply', script: 'scripts/runGigaAutoPublish.ts', args: ['--plan', PLAN_FILE_AUTOPUB, '--apply', '--summary'] },
    ];
    let failures = 0;
    for (const c of chain) {
      const res = runChild(c.step, c.script, c.args);
      steps.push(res);
      if (!res.ok) {
        failures++;
        stopReason = res.stop_reason ?? `step_failed:${c.step}(exit=${res.exit_code})`;
        if (failures >= MAX_STEP_FAILURES) { aborted = true; break; }
      }
    }

    // Collect published SKUs (only if the publish chain completed without abort).
    if (!aborted) {
      try {
        const planned: string[] = fs.existsSync(PLAN_FILE_AUTOPUB)
          ? (JSON.parse(fs.readFileSync(PLAN_FILE_AUTOPUB, 'utf8'))?.proposed_batch?.skus ?? [])
          : [];
        const applyRep = fs.existsSync(APPLY_FILE_AUTOPUB) ? JSON.parse(fs.readFileSync(APPLY_FILE_AUTOPUB, 'utf8')) : null;
        const publishedCount = applyRep?.results?.published ?? 0;
        // The runner publishes all planned at the publish stage; treat planned (scoped by --only) as
        // published when the apply reports a non-zero publish count. Intersect with the capped set.
        const cappedSet = new Set(capped);
        if (publishedCount > 0) publishedInScope = (planned as string[]).filter(s => cappedSet.has(s));
      } catch (e) {
        stopReason = stopReason ?? `apply_report_parse_failed:${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // SOFT-FAIL delivery-fee refresh — only for published-in-scope SKUs, ONLY after publish.
    // A fee failure is logged and recorded but NEVER rolls back the publish or fails the run.
    if (publishedInScope.length > 0) {
      feeRefresh = runChild('fee_refresh', 'scripts/refreshGigaDeliveryFeesHybrid.ts', ['--skus', publishedInScope.join(',')]);
      steps.push(feeRefresh);
      // Note: intentionally NOT setting aborted/stopReason from feeRefresh — soft-fail by design.
    }
  }

  // Write the APPLY report.
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const json = {
    mode: 'apply',
    run_id: runId,
    timestamp,
    plan_run_id: p.runId,
    creds_source: p.credsSource,
    max_skus: MAX_SKUS,
    aborted,
    stop_reason: stopReason,
    scope_skus: scopeSkus,
    steps,
    published_in_scope: publishedInScope,
    fee_refresh: feeRefresh
      ? { ran: true, ok: feeRefresh.ok, exit_code: feeRefresh.exit_code, stop_reason: feeRefresh.stop_reason, soft_fail: true }
      : { ran: false, reason: publishedInScope.length === 0 ? 'no published-in-scope SKUs' : 'not reached' },
    baseline_advanced: false,
    recommend_baseline_advance: !aborted,
  };
  fs.writeFileSync(STL_APPLY_JSON, JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# GIGA Saved-to-Live APPLY', '');
  md.push(`- run_id: ${runId}`, `- timestamp: ${timestamp}`, `- creds_source: ${p.credsSource}`, `- max_skus: ${MAX_SKUS}`);
  md.push(`- aborted: ${aborted}${stopReason ? ` (stop_reason=${stopReason})` : ''}`);
  md.push(`- scope_skus (${scopeSkus.length}): ${scopeSkus.join(', ') || '(none)'}`);
  md.push(`- published_in_scope (${publishedInScope.length}): ${publishedInScope.join(', ') || '(none)'}`, '');
  md.push('## Steps', '', '| step | exit | ok | stop_reason | summary |', '|---|---|---|---|---|');
  for (const s of steps) md.push(`| ${s.step} | ${s.exit_code ?? '?'} | ${s.ok ? 'Y' : 'N'} | ${s.stop_reason ?? '-'} | ${(s.summary_line ?? '').slice(0, 50)} |`);
  md.push('', '## Delivery-fee refresh (soft-fail)',
    feeRefresh
      ? `- ran=true ok=${feeRefresh.ok} exit=${feeRefresh.exit_code} stop_reason=${feeRefresh.stop_reason ?? '-'} (failures never roll back publish)`
      : `- not run (${publishedInScope.length === 0 ? 'no published-in-scope SKUs' : 'chain aborted before publish'})`);
  md.push('', '## Baseline', '- NOT advanced by this run. To advance after verifying: `npm run giga:saved:baseline -- --force`');
  fs.writeFileSync(STL_APPLY_MD, md.join('\n'));

  console.log(`${PREFIX}_APPLY_SUMMARY`);
  console.log(`run_id=${runId}`);
  console.log(`aborted=${aborted}`);
  console.log(`stop_reason=${stopReason ?? '-'}`);
  console.log(`scope_skus=${scopeSkus.length}`);
  console.log(`published_in_scope=${publishedInScope.length}`);
  console.log(`fee_refresh_ran=${feeRefresh ? true : false}`);
  console.log(`fee_refresh_ok=${feeRefresh ? feeRefresh.ok : '-'}`);
  console.log(`report_json=${rel(STL_APPLY_JSON)}`);
  console.log(`report_md=${rel(STL_APPLY_MD)}`);
  console.log(`baseline_advanced=false`);

  if (aborted) process.exit(1);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  const plan = await computePlan();
  writePlanReport(plan);
  printPlanSummary(plan);
  if (APPLY) {
    console.log(`${PREFIX}_MODE=apply`);
    await runApply(plan);
  } else {
    console.log(`${PREFIX}_MODE=plan (read-only; pass --apply to run the gated pipeline)`);
  }
})().catch(e => { console.error(`${PREFIX}_ERROR`); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
