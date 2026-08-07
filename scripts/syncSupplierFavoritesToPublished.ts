/**
 * Cancel every Favorite that is no longer published — production executor.
 *
 * DRY RUN BY DEFAULT. A real wishlist removal is sent only when BOTH
 *   SUPPLIER_FAVORITE_REMOVAL_ENABLED=true   AND   --execute
 * are present. Without both, `xhr_sends` is 0 by construction.
 *
 * TARGET = standardized_products WHERE published = true. It removes only
 *   (Pickup Favorites ∪ Dropship Favorites) − TARGET
 * and adds nothing.
 *
 * REUSE, NOT REBUILD:
 *   supplierFavoriteCleanupExecutor — plan / resolve / execute orchestration
 *   supplierFavoriteSync / Removal / PortalMapping — set math, single-item send, identity rules
 *   fetchGigaWarehouseInventoryFromXhr — portal search + baseInfos + saved website session
 *   gigaAccountReadClient.listAccountFavorites — per-account official Favorites read (verification)
 *
 * Usage:
 *   npx tsx scripts/syncSupplierFavoritesToPublished.ts               # dry run
 *   SUPPLIER_FAVORITE_REMOVAL_ENABLED=true \
 *     npx tsx scripts/syncSupplierFavoritesToPublished.ts --execute   # real removals
 */
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  executeCleanup,
  extraSkuSet,
  planFavoriteCleanup,
  resolveExtraMappings,
  type CleanupProgressEvent,
  type CleanupCheckpoint,
} from '../src/services/supplierFavoriteCleanupExecutor';
import { resolvePortalMapping, PORTAL_MAPPING_CONFIDENCE, PORTAL_MAPPING_SOURCE, type StoredPortalMapping } from '../src/services/supplierPortalMapping';
import { type ProductIdMapping } from '../src/services/supplierFavoriteProductId';
import { endpointFor, type RemovalFetcher } from '../src/services/supplierFavoriteRemoval';
import type { SyncAccount } from '../src/services/supplierFavoriteSync';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const argv = process.argv.slice(2);
const has = (n: string) => argv.some((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const val = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const EXECUTE = has('execute');
const RESUME = has('resume');
// Machine-readable mode: emit exactly one `SYNC_RESULT {json}` line for the Tauri caller to parse.
const JSON_OUT = has('json');
const BATCH_SIZE = Math.max(1, Math.min(100, parseInt(val('batch') ?? '50', 10) || 50));
const CHECKPOINT_PATH = path.join(process.cwd(), 'reports', 'favorite-cleanup', 'checkpoint.json');

// Single-item targeting. When --sku is given, ONLY that SKU on ONE account is processed — no
// scanning, no second item. --account bounds which side's session is used and verified.
const ONLY_SKU = (val('sku') ?? '').trim() || null;
const ONLY_ACCOUNT: 'pickup' | 'dropship' | null = (() => {
  const raw = (val('account') ?? '').trim();
  if (!raw) return null;
  if (raw !== 'pickup' && raw !== 'dropship') {
    console.error(`[favCleanup] --account 必须是 pickup 或 dropship（收到 ${raw}）`);
    process.exit(1);
  }
  return raw;
})();
if (ONLY_SKU && !ONLY_ACCOUNT) { console.error('[favCleanup] --sku 必须配合 --account 使用'); process.exit(1); }

const log = (line: string) => { if (!JSON_OUT) console.log(line); };

// Rate guard — same posture as the portal resolver.
const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS = 3500;
const MAX_CONSECUTIVE_FAILURES = 5;
// Watchdogs: every fetch is already bounded; these guarantee no single item stalls the run.
const PER_ITEM_TIMEOUT_MS = 90_000;
// Portal probe = search + baseInfos, each bounded at 25s; 70s covers both plus retry slack.
const PER_SKU_RESOLVE_TIMEOUT_MS = 70_000;
const VERIFY_TIMEOUT_MS = 90_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadCheckpoint(runId: string): CleanupCheckpoint {
  try {
    const raw = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8')) as CleanupCheckpoint;
    if (raw && typeof raw === 'object' && raw.items) return raw;
  } catch { /* fresh run */ }
  return { run_id: runId, items: {} };
}

function saveCheckpoint(cp: CleanupCheckpoint): void {
  try {
    fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
  } catch (error) {
    console.error(`[favCleanup] checkpoint save failed: ${error instanceof Error ? error.message : error}`);
  }
}


// ── 机器可读进度 ─────────────────────────────────────────────────────────────
// XOne 的后台任务读这一行来渲染阶段/进度，不解析人类日志。永远输出，与 --json 无关。
let currentRunId = '';
const progress = { processed: 0, total: 0, success: 0, exceptions: 0, timeouts: 0, verification_failed: 0 };

function phaseLabel(ev: CleanupProgressEvent): string {
  if (ev.phase === 'resolve') return 'resolving_identity';
  if (ev.phase === 'verify') return 'verifying';
  return ev.account === 'dropship' ? 'cleaning_dropship' : 'cleaning_pickup';
}

function emitProgress(line: string, ev: CleanupProgressEvent): void {
  log(`  ${line}`);
  if (ev.outcome === 'exception') progress.exceptions += 1;
  else if (ev.outcome === 'timeout') progress.timeouts += 1;
  else if (ev.outcome === 'verified_removed') progress.success += 1;
  else if (ev.outcome === 'verification_failed') progress.verification_failed += 1;
  if (ev.phase !== 'verify') { progress.processed = ev.index; progress.total = ev.total; }
  process.stdout.write(`SYNC_PROGRESS ${JSON.stringify({
    schema_version: '1.0',
    run_id: currentRunId,
    phase: phaseLabel(ev),
    account: ev.account ?? null,
    sku: ev.supplier_product_id ?? null,
    outcome: ev.outcome,
    processed: progress.processed,
    total: progress.total,
    success: progress.success,
    exceptions: progress.exceptions,
    timeouts: progress.timeouts,
    verification_failed: progress.verification_failed,
  })}\n`);
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) { console.error('[favCleanup] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }
  const sb: SupabaseClient = createClient(url, key, { auth: { persistSession: false } });

  const readAll = async <T>(table: string, columns: string): Promise<T[]> => {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
      if (error) { console.error(`[favCleanup] ${table} read failed: ${error.message}`); process.exit(1); }
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  };

  // ── TARGET + both accounts' favorites (from the last synced facts) ─────────
  const products = await readAll<{ supplier_product_id: string; published: boolean }>('standardized_products', 'supplier_product_id,published');
  const target = products.filter((p) => p.published === true).map((p) => p.supplier_product_id);
  const memberships = await readAll<{ supplier_product_id: string; supplier_account: string; is_saved: boolean | null; sync_status: string }>(
    'supplier_favorite_memberships', 'supplier_product_id,supplier_account,is_saved,sync_status');
  const savedOf = (account: string) => memberships
    .filter((r) => r.supplier_account === account && r.sync_status === 'ok' && r.is_saved === true)
    .map((r) => r.supplier_product_id);
  const favorites = { pickup: savedOf('pickup'), dropship: savedOf('dropship') };

  const allExtraSkus = extraSkuSet(target, favorites);

  // Single-item mode: narrow to exactly one SKU on one account, but keep every gate. The SKU must
  // still be genuinely extra (it is, only if it survives extraSkuSet) and still be favourited on
  // the account we were told to act on — otherwise there is nothing legitimate to do.
  if (ONLY_SKU) {
    if (!allExtraSkus.includes(ONLY_SKU)) {
      console.error(`[favCleanup] ${ONLY_SKU} 不属于 extra（可能是 published=true 或不在收藏中），拒绝处理`);
      process.exit(1);
    }
    if (!favorites[ONLY_ACCOUNT!].includes(ONLY_SKU)) {
      console.error(`[favCleanup] ${ONLY_SKU} 不在 ${ONLY_ACCOUNT} 收藏中，拒绝处理`);
      process.exit(1);
    }
    // Blank the other account entirely so no plan, no mapping probe and no fetcher can touch it.
    const other: SyncAccount = ONLY_ACCOUNT === 'pickup' ? 'dropship' : 'pickup';
    favorites[other] = [];
    favorites[ONLY_ACCOUNT!] = [ONLY_SKU];
  }
  const extraSkus = ONLY_SKU ? [ONLY_SKU] : allExtraSkus;

  // ── Resolve mappings for the EXTRA set only ────────────────────────────────
  const storedMappings = await readAll<StoredPortalMapping>('supplier_portal_product_mappings',
    'supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at');

  // Load one account's website session: full cookie header + the gmd_device_id needed for the
  // x-gmd-device-id header. Pickup and Dropship read their OWN files — device ids never cross.
  const sessionFileFor = (account: SyncAccount): string => account === 'pickup'
    ? (process.env.GIGA_PICKUP_SESSION_FILE ?? 'scripts/.giga-session-pickup.json')
    : (process.env.GIGA_DROPSHIP_SESSION_FILE ?? 'scripts/.giga-session-dropship.json');

  const loadAccountSession = (account: SyncAccount): { cookieHeader: string; deviceId: string | null } => {
    const state = JSON.parse(fs.readFileSync(sessionFileFor(account), 'utf8')) as { cookies?: Array<{ name: string; value: string }> };
    const cookies = state.cookies ?? [];
    return {
      cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      // The site's own HTTP client injects x-gmd-device-id from this cookie; without it the backend
      // returns 200 but no-ops the wishlist mutation. Same extraction the proven warehouse XHR uses.
      deviceId: cookies.find((c) => c.name === 'gmd_device_id')?.value ?? null,
    };
  };

  // Portal resolution reuses the existing XHR client. Loaded lazily so a dry run with everything
  // already mapped never even touches the portal module.
  let portalDeps: { session: unknown; search: (sku: string, s: unknown) => Promise<string[]>; base: (id: string, s: unknown) => Promise<{ data?: { product_info?: { sku?: string } } } | null> } | null = null;
  const now = () => new Date().toISOString();
  const portalResolve = async (sku: string): Promise<ProductIdMapping> => {
    // A full dry run never scrapes the portal (that would be ~2 calls × every unmapped extra SKU);
    // unmapped SKUs are reported as "needs resolution" instead. Single-item mode is the exception:
    // two read-only calls, and resolving the identity is the whole point of the dry run there.
    if (!EXECUTE && !ONLY_SKU) return { product_id: null, verified_sku: null, status: 'not_mapped' };
    if (!portalDeps) {
      // In single-item mode the probe must run under the SAME account we will act on, so point the
      // reader at that account's session file rather than the default one.
      if (ONLY_ACCOUNT) process.env.GIGA_SESSION_FILE = sessionFileFor(ONLY_ACCOUNT);
      const mod = await import('./fetchGigaWarehouseInventoryFromXhr');
      portalDeps = { session: mod.loadSession(), search: mod.searchProductCandidates as never, base: mod.fetchBaseInfos as never };
    }
    try {
      const candidates = await portalDeps.search(sku, portalDeps.session);
      let portalSku: string | null = null;
      if (candidates.length === 1 && /^\d+$/.test(candidates[0])) {
        await sleep(MIN_DELAY_MS + Math.floor((MAX_DELAY_MS - MIN_DELAY_MS) * 0.5));
        const detail = await portalDeps.base(candidates[0], portalDeps.session);
        portalSku = detail?.data?.product_info?.sku ?? null;
      }
      const resolution = resolvePortalMapping({ supplier_product_id: sku, candidates, portal_sku: portalSku });
      if (resolution.status === 'resolved' && resolution.website_product_id !== null) {
        // Persist the freshly proven mapping (the one production write this round permits — but this
        // round is Production Write=No, so writes are skipped unless executing).
        if (EXECUTE) {
          await sb.from('supplier_portal_product_mappings').upsert({
            supplier_product_id: sku,
            website_product_id: resolution.website_product_id,
            portal_sku: resolution.portal_sku,
            source: PORTAL_MAPPING_SOURCE,
            confidence: PORTAL_MAPPING_CONFIDENCE,
            resolved_at: now(),
            last_verified_at: now(),
            updated_at: now(),
          }, { onConflict: 'supplier_product_id' });
        }
        return { product_id: resolution.website_product_id, verified_sku: resolution.portal_sku!, status: 'unique' };
      }
      return { product_id: null, verified_sku: null, status: resolution.status === 'multiple_candidates' ? 'multiple_product_ids' : 'not_mapped' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/CAPTCHA|AUTH_FAILED|401|403/i.test(msg)) throw error;   // fatal — let it bubble to a global stop
      return { product_id: null, verified_sku: null, status: 'not_mapped' };
    }
  };

  const resolved = await resolveExtraMappings(extraSkus, {
    storedMappings,
    portalResolve,
    now: now(),
    onProgress: emitProgress,
    perSkuTimeoutMs: PER_SKU_RESOLVE_TIMEOUT_MS,
  });
  const plan = planFavoriteCleanup(target, favorites, (sku) =>
    resolved.usable.get(sku) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });

  const totalRemovals = plan.removals.pickup.length + plan.removals.dropship.length;
  const unmapped = extraSkus.length - resolved.usable.size;
  log('─── favorite cleanup ───');
  log(`  mode                : ${EXECUTE && process.env.SUPPLIER_FAVORITE_REMOVAL_ENABLED === 'true' ? 'EXECUTE' : 'DRY RUN'}`);
  log(`  TARGET (published)  : ${plan.target_count}`);
  log(`  Pickup favorites    : ${favorites.pickup.length}  extra ${plan.removals.pickup.length + plan.exceptions.pickup.length}`);
  log(`  Dropship favorites  : ${favorites.dropship.length}  extra ${plan.removals.dropship.length + plan.exceptions.dropship.length}`);
  log(`  distinct extra      : ${extraSkus.length}`);
  log(`  usable mappings     : ${resolved.usable.size} / stored ${storedMappings.length}`);
  const probesRan = EXECUTE || !!ONLY_SKU;   // single-item dry runs do probe (2 read-only calls)
  log(`  ${probesRan ? 'portal-probed' : 'needs resolution'}    : ${probesRan ? resolved.probed.length : unmapped}${probesRan ? '' : '（dry-run 不抓取门户）'}`);
  log(`  executable removes  : ${totalRemovals}   distinct unmapped: ${unmapped}`);
  if (ONLY_SKU) {
    // Single-item mode reports exactly what the L4 run will act on, including whether the device
    // binding header can actually be produced from that account's session.
    const mapped = resolved.usable.get(ONLY_SKU);
    let deviceOk = false;
    try { deviceOk = loadAccountSession(ONLY_ACCOUNT!).deviceId !== null; } catch { deviceOk = false; }
    log(`  ── 单件模式 ──`);
    log(`  target SKU          : ${ONLY_SKU}`);
    log(`  target account      : ${ONLY_ACCOUNT}`);
    log(`  website product_id  : ${mapped?.product_id ?? '未解析'}  (portal_sku 反查: ${mapped?.verified_sku ?? 'n/a'})`);
    log(`  x-gmd-device-id     : ${deviceOk ? '可从 session 解析 ✓' : '无法解析 ✗（会导致 200 假成功）'}`);
  }

  // ── Execute (gated) ────────────────────────────────────────────────────────
  const runId = `favclean-${now()}`;
  currentRunId = runId;
  // Only --resume reuses a prior checkpoint. A fresh run starts empty so it never inherits stale
  // state, but still re-verifies rather than re-sending anything already verified_removed.
  const priorCheckpoint = loadCheckpoint(runId);
  const resumableItems = Object.values(priorCheckpoint.items).filter(
    (i) => i.status === 'send_failed' || i.status === 'verification_failed' || i.status === 'global_stop',
  ).length;
  const checkpoint = RESUME ? priorCheckpoint : { run_id: runId, items: {} };

  const fetcherFor = (account: SyncAccount): RemovalFetcher => async (targetUrl, init) => {
    // Real per-account website session send. Never reached in dry run.
    const session = loadAccountSession(account);
    const headers: Record<string, string> = {
      ...init.headers,
      cookie: session.cookieHeader,
      accept: 'application/json, text/javascript, */*; q=0.01',
      'content-type': 'application/json;charset=UTF-8',
      'user-agent': 'Mozilla/5.0',
      'x-requested-with': 'XMLHttpRequest',
      'ori-status-in-response': 'code',
      origin: 'https://www.gigab2b.com',
      referer: 'https://www.gigab2b.com/index.php?route=account/wishlist',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
    };
    // Device binding — the header that was missing when a 200 did nothing.
    if (session.deviceId) headers['x-gmd-device-id'] = session.deviceId;

    // Bounded: a stalled wishlist POST must never hang the whole run.
    const res = await fetch(targetUrl, { method: init.method, body: init.body, headers, signal: AbortSignal.timeout(25_000) });
    const text = await res.text();
    // Return the parsed body untouched (no code←status fallback); the caller decides success from
    // the real business code + data.totalNum.
    return { status: res.status, json: async () => { try { return JSON.parse(text); } catch { return null; } } };
  };

  const readFavorites = async (account: SyncAccount): Promise<Set<string>> => {
    const { listAccountFavorites } = await import('./lib/gigaAccountReadClient');
    const listing = await listAccountFavorites(account);
    return new Set(listing.skus);
  };

  const result = await executeCleanup(plan, resolved.usable, {
    fetcherFor,
    readFavorites,
    sessionPresent: () => EXECUTE,   // in dry run this is never consulted for a send
    saveCheckpoint,
    onProgress: emitProgress,
    pace: async () => { await sleep(MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS))); },
    now,
    env: process.env,
  }, { execute: EXECUTE, batchSize: BATCH_SIZE, maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES, runId, perItemTimeoutMs: PER_ITEM_TIMEOUT_MS, verifyTimeoutMs: VERIFY_TIMEOUT_MS }, checkpoint);

  log('\n─── result ───');
  log(`  dry_run           : ${result.dry_run}`);
  log(`  xhr_sends         : ${result.xhr_sends}`);
  log(`  planned (dry)     : ${result.planned}`);
  log(`  verified_removed  : ${result.verified_removed}`);
  log(`  verification_fail : ${result.verification_failed}`);
  log(`  send_failed       : ${result.send_failed}`);
  log(`  skipped (resume)  : ${result.skipped}`);
  log(`  exceptions        : ${result.exceptions}`);
  log(`  global_stop       : ${result.global_stop ?? 'no'}`);
  if (result.dry_run) log('\n  DRY RUN — no wishlist request was sent. inventory chain untouched.');

  // Final extra after the run. In dry run nothing was removed, so it equals the current extra;
  // in a real run, verified_removed items have left the account's favorites.
  const removedByAccount = { pickup: 0, dropship: 0 };
  for (const item of result.items) if (item.status === 'verified_removed') removedByAccount[item.account] += 1;
  const pickupExtra = plan.removals.pickup.length + plan.exceptions.pickup.length;
  const dropshipExtra = plan.removals.dropship.length + plan.exceptions.dropship.length;

  // One machine-readable line for the Tauri caller. Everything else above is gated off in JSON mode.
  const envelope = {
    schema_version: '1.0',
    run_id: result.run_id,
    dry_run: result.dry_run,
    // A terminal status the UI maps to its state labels.
    status: result.global_stop ? 'stopped'
      : result.dry_run ? 'planned'
      : (result.verification_failed > 0 || result.send_failed > 0 || result.exceptions > 0) ? 'partial'
      : 'completed',
    global_stop: result.global_stop,
    target_count: plan.target_count,
    pickup_extra: pickupExtra,
    dropship_extra: dropshipExtra,
    distinct_extra: extraSkus.length,
    reused_mappings: resolved.usable.size,
    needs_resolution: unmapped,
    executable_removes: totalRemovals,
    planned: result.planned,
    verified_removed: result.verified_removed,
    verification_failed: result.verification_failed,
    send_failed: result.send_failed,
    mapping_exception: result.exceptions,
    skipped: result.skipped,
    xhr_sends: result.xhr_sends,
    pickup_extra_final: pickupExtra - removedByAccount.pickup,
    dropship_extra_final: dropshipExtra - removedByAccount.dropship,
    resumable: resumableItems > 0,
    resumable_count: resumableItems,
    production_write_attempted: !result.dry_run && result.xhr_sends > 0,
  };
  process.stdout.write(`SYNC_RESULT ${JSON.stringify(envelope)}\n`);
}

void main();
