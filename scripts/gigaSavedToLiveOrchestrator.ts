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
  if (!forceDefault && fsForEnv.existsSync('.env.giga-alt.local')) loadEnv({ path: '.env.giga-alt.local' });   // pickup/saved-list creds (SUPPLIER_CLIENT_*)
  if (fsForEnv.existsSync('.env.giga-delivery.local')) loadEnv({ path: '.env.giga-delivery.local' });          // dropship delivery-fee creds (SUPPLIER_DELIVERY_*) for the inherited-env fee subprocess path; never overrides exported env
  loadEnv({ path: '.env.local' });
  loadEnv({ path: '.env' });
}
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fetchAllSavedItems, GigaSavedItemsError, ENDPOINT_PATH, SKU_FIELD } from './lib/gigaSavedItems';
import { deliveryCredsStatus } from './lib/deliveryCreds';

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
function runChild(step: string, script: string, args: string[]): { result: StepResult; output: string } {
  const full = ['tsx', script, ...args];
  const r = spawnSync('npx', full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
  const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const stop = detectStop(combined);
  const summaryLine = combined.split('\n').find(l => /_SUMMARY$/.test(l.trim())) ?? null;
  const exit = r.status;
  // `output` is returned ONLY for in-process classification (e.g. fee tokens). It is NEVER persisted
  // in the report — only step/exit/stop_reason/summary_line are. Child scripts never print secrets.
  return { result: { step, script, args, exit_code: exit, ok: exit === 0 && !stop, stop_reason: stop, summary_line: summaryLine }, output: combined };
}

// ── PURE: publish_apply classification (B) ──────────────────────────────────────────────────────────
export interface PublishApplyClass { hardStop: boolean; stopReason: string | null; partialSuccess: boolean; fullSuccess: boolean; }
/** A non-zero publish_apply exit is NOT automatically a total failure. Hard-stop tokens abort; otherwise
 *  any meaningful progress in the auto-publish report = partial success (continue to read-only verify). */
export function classifyPublishApply(
  step: { ok: boolean; exit_code: number | null; stop_reason: string | null },
  autoApply: { results?: Record<string, number> | null; reached_stage?: string | null } | null,
): PublishApplyClass {
  if (step.stop_reason) return { hardStop: true, stopReason: step.stop_reason, partialSuccess: false, fullSuccess: false };
  if (step.ok) return { hardStop: false, stopReason: null, partialSuccess: false, fullSuccess: true };
  const r = autoApply?.results ?? {};
  const PROGRESS_STAGES = ['publish', 'normalize', 'title', 'pricing', 'mirror', 'blurhash', 'inventory', 'reviews'];
  const progressed =
    (r.published ?? 0) > 0 || (r.normalized ?? 0) > 0 || (r.titled ?? 0) > 0 || (r.priced ?? 0) > 0 ||
    (r.inventory_in_stock ?? 0) > 0 ||
    (autoApply?.reached_stage != null && PROGRESS_STAGES.includes(String(autoApply.reached_stage)));
  return { hardStop: false, stopReason: `publish_apply_exit_${step.exit_code ?? '?'}`, partialSuccess: progressed, fullSuccess: false };
}

// ── PURE: actual live vs held collection with reasons (C) ─────────────────────────────────────────────
export interface HeldSku { sku: string; reason: string; }
export interface StdLike {
  normalization_status?: string | null; published?: boolean | null;
  inventory_status?: string | null; total_available_qty?: number | null;
  product_title?: string | null; primary_image?: string | null;
  price?: number | null; selling_price?: number | null;
}
/** liveSet = sellable_products membership (authoritative). Held SKUs get a best-available reason. */
export function collectLiveAndHeld(
  scopeSkus: string[], liveSet: Set<string>, stdBySku: Map<string, StdLike>,
): { actualLiveSkus: string[]; heldSkus: HeldSku[] } {
  const actualLiveSkus: string[] = [];
  const heldSkus: HeldSku[] = [];
  for (const sku of scopeSkus) {
    if (liveSet.has(sku)) { actualLiveSkus.push(sku); continue; }
    const d = stdBySku.get(sku);
    let reason: string;
    if (!d) reason = 'not in standardized_products (unpublished / not imported)';
    else if (d.normalization_status !== 'done') reason = `normalization_status=${d.normalization_status ?? 'null'}`;
    else if (d.inventory_status !== 'in_stock' || (d.total_available_qty ?? 0) <= 0) reason = `inventory ${d.inventory_status ?? 'null'} qty=${d.total_available_qty ?? 0}`;
    else if (d.published === false) reason = 'published=false';
    else if (d.product_title !== undefined && !d.product_title) reason = 'missing title';
    else if (d.primary_image !== undefined && (d.primary_image == null || d.primary_image === '')) reason = 'missing image';
    else if ((d.price !== undefined || d.selling_price !== undefined) && (!((d.price ?? 0) > 0) || !((d.selling_price ?? 0) > 0))) reason = `price/selling not >0 (price=${d.price ?? 'null'} selling=${d.selling_price ?? 'null'})`;
    else reason = 'not in sellable_products (data-quality gate)';
    heldSkus.push({ sku, reason });
  }
  return { actualLiveSkus, heldSkus };
}

// ── PURE: split the eligible scope into import (new) vs publish (eligible MINUS missing_inventory) (A/B)
export function computeApplyScopes(
  rows: { sku: string; status: string; would_import: boolean; would_publish: boolean; inventory_status?: string | null; total_available_qty?: number | null }[],
): { importSkus: string[]; publishSkus: string[]; preHeldSkus: HeldSku[] } {
  const importSkus: string[] = [];
  const publishSkus: string[] = [];
  const preHeldSkus: HeldSku[] = [];
  for (const r of rows) {
    if (!(r.would_import || r.would_publish)) continue;   // not in eligible scope
    if (r.would_import) importSkus.push(r.sku);            // genuinely new → import target
    if (r.status === 'missing_inventory') {
      // known unknown/0 stock → held up front, never sent to publish (auto-publish would hold it anyway).
      preHeldSkus.push({ sku: r.sku, reason: `missing_inventory (inventory_status=${r.inventory_status ?? 'null'} qty=${r.total_available_qty ?? 0})` });
    } else {
      publishSkus.push(r.sku);                             // publishable (new-after-import or already-imported)
    }
  }
  return { importSkus, publishSkus, preHeldSkus };
}

// ── PURE: classify fee-refresh output text (D) ────────────────────────────────────────────────────────
export interface FeeTextClass { credsMissing: boolean; noMapping: boolean; officialNoRow: boolean; hardStop: string | null; }
export function classifyFeeText(output: string): FeeTextClass {
  return {
    credsMissing: /official_creds_missing|NO creds/i.test(output),
    noMapping: /no portal mapping|no_mapping/i.test(output),
    officialNoRow: /no_row|official=unavailable/i.test(output),
    hardStop: detectStop(output),
  };
}

function readJson(file: string): any | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// ── DB reads used by APPLY (scoped, read-only) ───────────────────────────────────────────────────────
async function readPostPublishState(skus: string[]): Promise<{ liveSet: Set<string>; stdBySku: Map<string, StdLike> }> {
  if (skus.length === 0) return { liveSet: new Set(), stdBySku: new Map() };
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) die('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env (.env.local)');
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const std = await sb.from('standardized_products')
    .select('supplier_product_id,normalization_status,published,inventory_status,total_available_qty,product_title,primary_image,price,selling_price')
    .in('supplier_product_id', skus);
  if (std.error) die(`supabase read failed on standardized_products: ${std.error.message}`);
  const sell = await sb.from('sellable_products').select('supplier_product_id').in('supplier_product_id', skus);
  if (sell.error) die(`supabase read failed on sellable_products: ${sell.error.message}`);
  const stdBySku = new Map<string, StdLike>((std.data ?? []).map((r: any) => [String(r.supplier_product_id), r]));
  const liveSet = new Set<string>((sell.data ?? []).map((r: any) => String(r.supplier_product_id)));
  return { liveSet, stdBySku };
}

async function readFeePresence(skus: string[]): Promise<Set<string>> {
  if (skus.length === 0) return new Set();
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return new Set();
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await sb.from('giga_delivery_fee_cache').select('supplier_product_id,charged_fee_cents').in('supplier_product_id', skus);
  if (error) return new Set();
  return new Set((data ?? []).filter((r: any) => r.charged_fee_cents != null).map((r: any) => String(r.supplier_product_id)));
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

// ── APPLY: drive the existing pipeline; collect ACTUAL live SKUs; fee-refresh them (soft-fail) ────────
async function runApply(p: Awaited<ReturnType<typeof computePlan>>): Promise<void> {
  const runId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const steps: StepResult[] = [];
  let stopReason: string | null = null;
  let aborted = false;
  let partialSuccess = false;
  let fullSuccess = false;

  // Hard safety gate before touching anything.
  if (p.credsDrift) { stopReason = 'creds_drift_vs_baseline'; aborted = true; }
  if (p.baselineMissing && !aborted) { stopReason = 'baseline_missing'; aborted = true; }
  const capped = p.processed;
  if (capped.length === 0 && !aborted) { stopReason = 'no_newly_saved_skus'; aborted = true; }

  // Scope split: IMPORT = genuinely-new SKUs only (would_import); PUBLISH = eligible MINUS missing_inventory.
  // Already-imported publish candidates must NOT be sent to the import script (it fatally rejects
  // non-ready_for_sync --only SKUs), and known unknown/0-stock SKUs must NOT be sent to publish.
  const scopeSkus = p.rows.filter(r => r.would_import || r.would_publish).map(r => r.sku);
  const { importSkus, publishSkus, preHeldSkus } = computeApplyScopes(p.rows);
  if (scopeSkus.length === 0 && !aborted) { stopReason = 'nothing_eligible_to_import_or_publish'; aborted = true; }

  // Delivery-creds status (masked; never the secret).
  const creds = deliveryCredsStatus();
  console.log(`${PREFIX}_DELIVERY_CREDS: ${creds.line}`);

  let actualLiveSkus: string[] = [];
  let heldSkus: HeldSku[] = [...preHeldSkus];   // missing_inventory SKUs are held up front, never published
  let feeRefresh: StepResult | null = null;
  let feeText: FeeTextClass | null = null;
  let feeSuccessSkus: string[] = [];
  let feeFailedSkus: string[] = [];
  let importSkipped: string | false = false;

  if (!aborted) {
    // 1) IMPORT — only genuinely-new SKUs (would_import). Skip = soft success when nothing is new
    //    (do NOT send already-imported SKUs to the import script — it fatally rejects non-ready_for_sync).
    if (importSkus.length > 0) {
      const importChain: { step: string; script: string; args: string[] }[] = [
        { step: 'delta', script: 'scripts/giga-saved-delta.ts', args: ['--summary'] },
        { step: 'candidates_plan', script: 'scripts/planGigaNewlySavedCandidates.ts', args: ['--summary'] },
        { step: 'import', script: 'scripts/syncGigaNewlySavedCandidates.ts', args: ['--sync', `--only=${importSkus.join(',')}`, `--limit=${MAX_SKUS}`, '--summary'] },
      ];
      for (const c of importChain) {
        const { result } = runChild(c.step, c.script, c.args);
        steps.push(result);
        if (!result.ok) { stopReason = result.stop_reason ?? `step_failed:${c.step}(exit=${result.exit_code})`; aborted = true; break; }
      }
    } else {
      importSkipped = 'nothing_new_to_import';
      steps.push({ step: 'import', script: '(skipped)', args: [], exit_code: 0, ok: true, stop_reason: null, summary_line: 'skipped: nothing_new_to_import' });
    }

    // 2) PUBLISH — scoped to publishable SKUs (eligible MINUS missing_inventory). Skip if none publishable.
    if (!aborted && publishSkus.length > 0) {
      const onlyPublish = publishSkus.join(',');
      const publishChain: { step: string; script: string; args: string[] }[] = [
        { step: 'publish_plan', script: 'scripts/planGigaAutoPublish.ts', args: [`--only=${onlyPublish}`, `--max-skus=${MAX_SKUS}`, '--summary'] },
        { step: 'publish_dry_run', script: 'scripts/runGigaAutoPublish.ts', args: ['--plan', PLAN_FILE_AUTOPUB, '--dry-run', '--summary'] },
      ];
      for (const c of publishChain) {
        const { result } = runChild(c.step, c.script, c.args);
        steps.push(result);
        if (!result.ok) { stopReason = result.stop_reason ?? `step_failed:${c.step}(exit=${result.exit_code})`; aborted = true; break; }
      }
      // publish_apply — do NOT auto-abort on non-zero exit. Classify hard-stop vs partial success.
      if (!aborted) {
        const { result: applyStep } = runChild('publish_apply', 'scripts/runGigaAutoPublish.ts', ['--plan', PLAN_FILE_AUTOPUB, '--apply', '--summary']);
        steps.push(applyStep);
        const cls = classifyPublishApply(applyStep, readJson(APPLY_FILE_AUTOPUB));
        partialSuccess = cls.partialSuccess;
        fullSuccess = cls.fullSuccess;
        if (cls.hardStop) { aborted = true; stopReason = cls.stopReason; }
        else if (!applyStep.ok) stopReason = cls.stopReason; // recorded, but we continue to read ACTUAL DB state
      }
    } else if (!aborted && publishSkus.length === 0) {
      stopReason = stopReason ?? 'nothing_publishable_after_scope';
      steps.push({ step: 'publish', script: '(skipped)', args: [], exit_code: 0, ok: true, stop_reason: null, summary_line: 'skipped: nothing_publishable (all eligible were missing_inventory)' });
    }

    // 3) Collect ACTUAL live/held over the PUBLISH scope (authoritative — never trust the exit code alone).
    if (!aborted) {
      const { liveSet, stdBySku } = await readPostPublishState(publishSkus);
      const r = collectLiveAndHeld(publishSkus, liveSet, stdBySku);
      actualLiveSkus = r.actualLiveSkus;
      heldSkus = [...preHeldSkus, ...r.heldSkus];   // pre-held missing_inventory + any publish-scope holds

      // 4) Fee refresh for ACTUAL live SKUs only (soft-fail; never rolls back publish).
      if (actualLiveSkus.length > 0) {
        const fr = runChild('fee_refresh', 'scripts/refreshGigaDeliveryFeesHybrid.ts', ['--skus', actualLiveSkus.join(',')]);
        feeRefresh = fr.result;
        steps.push(fr.result);
        feeText = classifyFeeText(fr.output);
        // DB-authoritative success/failure (do not trust stdout alone). A hard stop inside the fee step
        // is recorded but remains SOFT for the overall run — publish already happened and is never rolled back.
        const feePresent = await readFeePresence(actualLiveSkus);
        feeSuccessSkus = actualLiveSkus.filter(s => feePresent.has(s));
        feeFailedSkus = actualLiveSkus.filter(s => !feePresent.has(s));
      }
    }
  }

  // ── Operator-action buckets ──
  const needsFavoriteOrMapping = feeFailedSkus;
  const needsFavorite = (feeText?.officialNoRow || feeText?.credsMissing) ? feeFailedSkus : [];
  const needsMapping = feeText?.noMapping ? feeFailedSkus : [];
  const deliveryReady = feeSuccessSkus; // live AND fee cached
  // Conservative baseline (F): only when nothing is unresolved.
  const recommendBaselineAdvance = !aborted && actualLiveSkus.length > 0 && heldSkus.length === 0 && feeFailedSkus.length === 0;
  const recovery = feeFailedSkus.length
    ? { dry_run: `DRY_RUN=1 npm run fees:refresh -- --skus ${feeFailedSkus.join(',')}`,
        live: `npm run fees:refresh -- --skus ${feeFailedSkus.join(',')}   (run only after the dry-run shows official_ok)` }
    : null;
  const NOTE = 'Dropship official price/v1 returns a fee only for SKUs saved/favorited/accessible in the DROPSHIP account. Newly added pickup SKUs may need a dropship favorite (then official) or a seed-CSV portal mapping. Missing fee never hides the product; delivery checkout fails-closed while pickup still works.';

  // ── Write the APPLY report ──
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const json = {
    mode: 'apply', run_id: runId, timestamp, plan_run_id: p.runId, creds_source: p.credsSource, max_skus: MAX_SKUS,
    delivery_creds_present: creds.present,
    aborted, stop_reason: stopReason, partial_success: partialSuccess, full_success: fullSuccess,
    scope_skus: scopeSkus,
    import_skus: importSkus,
    import_skipped: importSkipped,
    publish_skus: publishSkus,
    actual_live_skus: actualLiveSkus,
    held_skus: heldSkus,
    published_in_scope: actualLiveSkus,            // reflects ACTUAL live results — never 0 when live SKUs exist
    fee_refresh_attempted: feeRefresh != null,
    fee_refresh_success_skus: feeSuccessSkus,
    fee_refresh_failed_skus: feeFailedSkus,
    needs_dropship_favorite_skus: needsFavorite,
    needs_fee_mapping_skus: needsMapping,
    needs_dropship_favorite_or_mapping_skus: needsFavoriteOrMapping,
    delivery_checkout_ready_skus: deliveryReady,
    sellable_missing_fee_skus: feeFailedSkus,
    baseline_advanced: false,
    recommend_baseline_advance: recommendBaselineAdvance,
    recovery_commands: recovery,
    note: NOTE,
    steps,
  };
  fs.writeFileSync(STL_APPLY_JSON, JSON.stringify(json, null, 2));

  const md: string[] = [];
  md.push('# GIGA Saved-to-Live APPLY', '');
  md.push(`- run_id: ${runId}`, `- timestamp: ${timestamp}`, `- creds_source: ${p.credsSource}`, `- max_skus: ${MAX_SKUS}`);
  md.push(`- delivery_creds_present: ${creds.present}`);
  md.push(`- aborted: ${aborted}${stopReason ? ` (stop_reason=${stopReason})` : ''}`);
  md.push(`- partial_success: ${partialSuccess}   full_success: ${fullSuccess}`);
  md.push(`- scope_skus (${scopeSkus.length}): ${scopeSkus.join(', ') || '(none)'}`);
  md.push(`- import_skus (${importSkus.length}): ${importSkus.join(', ') || '(none)'}${importSkipped ? `  — import ${importSkipped}` : ''}`);
  md.push(`- publish_skus (${publishSkus.length}, excludes missing_inventory): ${publishSkus.join(', ') || '(none)'}`);
  md.push(`- actual_live_skus / published_in_scope (${actualLiveSkus.length}): ${actualLiveSkus.join(', ') || '(none)'}`);
  md.push(`- delivery_checkout_ready_skus (${deliveryReady.length}): ${deliveryReady.join(', ') || '(none)'}`);
  md.push(`- sellable_missing_fee_skus (${feeFailedSkus.length}): ${feeFailedSkus.join(', ') || '(none)'}`, '');
  md.push('## Held SKUs (not live — owned by inventory/quality gates, NOT downlisted here)', '');
  if (heldSkus.length) { md.push('| SKU | reason |', '|---|---|'); for (const h of heldSkus) md.push(`| ${h.sku} | ${h.reason} |`); }
  else md.push('_(none)_');
  md.push('', '## Delivery-fee refresh (soft-fail)',
    feeRefresh ? `- ran=true ok=${feeRefresh.ok} exit=${feeRefresh.exit_code} stop_reason=${feeRefresh.stop_reason ?? '-'} (failures never roll back publish)`
               : `- not run (${actualLiveSkus.length === 0 ? 'no live SKUs' : 'chain aborted before publish'})`,
    `- success (${feeSuccessSkus.length}): ${feeSuccessSkus.join(', ') || '(none)'}`,
    `- failed/missing (${feeFailedSkus.length}): ${feeFailedSkus.join(', ') || '(none)'}`);
  if (needsFavoriteOrMapping.length) md.push('', '## Needs dropship favorite OR fee mapping', `- ${needsFavoriteOrMapping.join(', ')}`);
  if (recovery) md.push('', '## Recovery commands', '```bash', recovery.dry_run, recovery.live, '```');
  md.push('', '## Baseline', `- baseline_advanced=false`, `- recommend_baseline_advance=${recommendBaselineAdvance}${recommendBaselineAdvance ? ' — `npm run giga:saved:baseline -- --force`' : ' (unresolved held / missing-fee items remain)'}`);
  md.push('', `> ${NOTE}`);
  md.push('', '## Steps', '', '| step | exit | ok | stop_reason | summary |', '|---|---|---|---|---|');
  for (const s of steps) md.push(`| ${s.step} | ${s.exit_code ?? '?'} | ${s.ok ? 'Y' : 'N'} | ${s.stop_reason ?? '-'} | ${(s.summary_line ?? '').slice(0, 50)} |`);
  fs.writeFileSync(STL_APPLY_MD, md.join('\n'));

  console.log(`${PREFIX}_APPLY_SUMMARY`);
  console.log(`run_id=${runId}`);
  console.log(`aborted=${aborted}`);
  console.log(`stop_reason=${stopReason ?? '-'}`);
  console.log(`partial_success=${partialSuccess}`);
  console.log(`full_success=${fullSuccess}`);
  console.log(`scope_skus=${scopeSkus.length}`);
  console.log(`import_skus=${importSkus.length}`);
  console.log(`import_skipped=${importSkipped || false}`);
  console.log(`publish_skus=${publishSkus.length}`);
  console.log(`actual_live_skus=${actualLiveSkus.length}`);
  console.log(`published_in_scope=${actualLiveSkus.length}`);
  console.log(`held_skus=${heldSkus.length}`);
  console.log(`fee_refresh_attempted=${feeRefresh != null}`);
  console.log(`fee_refresh_success=${feeSuccessSkus.length}`);
  console.log(`fee_refresh_failed=${feeFailedSkus.length}`);
  console.log(`delivery_checkout_ready=${deliveryReady.length}`);
  console.log(`needs_dropship_favorite_or_mapping=${needsFavoriteOrMapping.length}`);
  console.log(`baseline_advanced=false`);
  console.log(`recommend_baseline_advance=${recommendBaselineAdvance}`);
  console.log(`report_json=${rel(STL_APPLY_JSON)}`);
  console.log(`report_md=${rel(STL_APPLY_MD)}`);
  if (recovery) console.log(`recovery_dry_run=${recovery.dry_run}`);

  // Exit non-zero ONLY on a hard abort. Partial success / held / missing-fee are reported as warnings.
  if (aborted) process.exit(1);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const plan = await computePlan();
  writePlanReport(plan);
  printPlanSummary(plan);
  if (APPLY) {
    console.log(`${PREFIX}_MODE=apply`);
    await runApply(plan);
  } else {
    console.log(`${PREFIX}_MODE=plan (read-only; pass --apply to run the gated pipeline)`);
  }
}

// Import-safe: only run the pipeline when invoked directly, so tests can import the pure helpers above
// without triggering a GIGA call. (Matches refreshGigaDeliveryFeesHybrid.ts.)
if (require.main === module) {
  main().catch(e => { console.error(`${PREFIX}_ERROR`); console.error(`error=${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
