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
const BATCH_SIZE = Math.max(1, Math.min(100, parseInt(val('batch') ?? '50', 10) || 50));
const CHECKPOINT_PATH = path.join(process.cwd(), 'reports', 'favorite-cleanup', 'checkpoint.json');

// Rate guard — same posture as the portal resolver.
const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS = 3500;
const MAX_CONSECUTIVE_FAILURES = 5;
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

  const extraSkus = extraSkuSet(target, favorites);

  // ── Resolve mappings for the EXTRA set only ────────────────────────────────
  const storedMappings = await readAll<StoredPortalMapping>('supplier_portal_product_mappings',
    'supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at');

  // Portal resolution reuses the existing XHR client. Loaded lazily so a dry run with everything
  // already mapped never even touches the portal module.
  let portalDeps: { session: unknown; search: (sku: string, s: unknown) => Promise<string[]>; base: (id: string, s: unknown) => Promise<{ data?: { product_info?: { sku?: string } } } | null> } | null = null;
  const now = () => new Date().toISOString();
  const portalResolve = async (sku: string): Promise<ProductIdMapping> => {
    // A dry run never scrapes the portal (that would be ~2 calls × every unmapped extra SKU). It
    // reports unmapped SKUs as "needs resolution" instead. Live probing belongs to execution.
    if (!EXECUTE) return { product_id: null, verified_sku: null, status: 'not_mapped' };
    if (!portalDeps) {
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

  const resolved = await resolveExtraMappings(extraSkus, { storedMappings, portalResolve, now: now() });
  const plan = planFavoriteCleanup(target, favorites, (sku) =>
    resolved.usable.get(sku) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });

  const totalRemovals = plan.removals.pickup.length + plan.removals.dropship.length;
  const unmapped = extraSkus.length - resolved.usable.size;
  console.log('─── favorite cleanup ───');
  console.log(`  mode                : ${EXECUTE && process.env.SUPPLIER_FAVORITE_REMOVAL_ENABLED === 'true' ? 'EXECUTE' : 'DRY RUN'}`);
  console.log(`  TARGET (published)  : ${plan.target_count}`);
  console.log(`  Pickup favorites    : ${favorites.pickup.length}  extra ${plan.removals.pickup.length + plan.exceptions.pickup.length}`);
  console.log(`  Dropship favorites  : ${favorites.dropship.length}  extra ${plan.removals.dropship.length + plan.exceptions.dropship.length}`);
  console.log(`  distinct extra      : ${extraSkus.length}`);
  console.log(`  reused mappings     : ${resolved.usable.size} / stored ${storedMappings.length}`);
  console.log(`  ${EXECUTE ? 'portal-probed' : 'needs resolution'}    : ${EXECUTE ? resolved.probed.length : unmapped}${EXECUTE ? '' : '（dry-run 不实际抓取门户）'}`);
  console.log(`  executable removes  : ${totalRemovals}   distinct unmapped: ${unmapped}`);

  // ── Execute (gated) ────────────────────────────────────────────────────────
  const runId = `favclean-${now()}`;
  const checkpoint = loadCheckpoint(runId);

  const fetcherFor = (account: SyncAccount): RemovalFetcher => async (targetUrl, init) => {
    // Real per-account website session send. Never reached in dry run.
    const sessionFile = account === 'pickup'
      ? (process.env.GIGA_PICKUP_SESSION_FILE ?? 'scripts/.giga-session.pickup.json')
      : (process.env.GIGA_DROPSHIP_SESSION_FILE ?? 'scripts/.giga-session.dropship.json');
    const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { cookies?: Array<{ name: string; value: string }> };
    const cookie = (state.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(targetUrl, {
      method: init.method,
      body: init.body,
      headers: {
        ...init.headers,
        cookie,
        'user-agent': 'Mozilla/5.0',
        'x-requested-with': 'XMLHttpRequest',
        origin: 'https://www.gigab2b.com',
        referer: endpointFor('remove'),
      },
    });
    return { status: res.status, json: async () => { try { return JSON.parse(await res.text()); } catch { return { code: res.status }; } } };
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
    pace: async () => { await sleep(MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS))); },
    now,
    env: process.env,
  }, { execute: EXECUTE, batchSize: BATCH_SIZE, maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES, runId }, checkpoint);

  console.log('\n─── result ───');
  console.log(`  dry_run           : ${result.dry_run}`);
  console.log(`  xhr_sends         : ${result.xhr_sends}`);
  console.log(`  planned (dry)     : ${result.planned}`);
  console.log(`  verified_removed  : ${result.verified_removed}`);
  console.log(`  verification_fail : ${result.verification_failed}`);
  console.log(`  send_failed       : ${result.send_failed}`);
  console.log(`  skipped (resume)  : ${result.skipped}`);
  console.log(`  exceptions        : ${result.exceptions}`);
  console.log(`  global_stop       : ${result.global_stop ?? 'no'}`);
  if (result.dry_run) console.log('\n  DRY RUN — no wishlist request was sent. inventory chain untouched.');
}

void main();
