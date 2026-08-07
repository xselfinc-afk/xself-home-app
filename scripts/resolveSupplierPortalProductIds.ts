/**
 * Resolve supplier SKUs → website numeric product_id against the supplier portal.
 *
 * DRY RUN BY DEFAULT. `--apply` is required to write, and the ONLY table it may ever write is
 * `supplier_portal_product_mappings`.
 *
 * REUSE, NOT REBUILD: the portal calls come from the EXISTING XHR client
 * (`fetchGigaWarehouseInventoryFromXhr.ts`) — its saved Playwright session, its search endpoint and
 * its detail endpoint. No browser is launched and no second scraping framework is introduced.
 *
 * SCOPE: only the SKUs the current sync plan actually needs —
 *   Pickup missing ∪ Pickup extra ∪ Dropship missing ∪ Dropship extra, deduplicated.
 * The whole catalogue is never swept.
 *
 * WHAT IT NEVER DOES: add or remove a Favorite. It imports no wishlist executor and names no
 * wishlist mutation endpoint anywhere. This script only reads identities.
 *
 * Usage:
 *   npx tsx scripts/resolveSupplierPortalProductIds.ts                    # dry run, 20 SKUs
 *   npx tsx scripts/resolveSupplierPortalProductIds.ts --limit=50         # dry run, wider
 *   npx tsx scripts/resolveSupplierPortalProductIds.ts --limit=50 --apply # write
 */
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  PORTAL_MAPPING_CONFIDENCE,
  PORTAL_MAPPING_SOURCE,
  isStale,
  isUsableMapping,
  resolvePortalMapping,
  type PortalResolution,
  type StoredPortalMapping,
} from '../src/services/supplierPortalMapping';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const WRITE_TABLE = 'supplier_portal_product_mappings';

const argv = process.argv.slice(2);
const has = (n: string) => argv.some((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const val = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const APPLY = has('apply');
const LIMIT = Math.max(1, parseInt(val('limit') ?? '20', 10) || 20);

// ── Rate guard ──────────────────────────────────────────────────────────────
// The portal is a human-facing site behind a login. Two requests per SKU, spaced and jittered,
// with a hard request ceiling and an immediate stop on any sign of auth trouble.
const MIN_DELAY_MS = 2500;
const MAX_DELAY_MS = 3500;
const MAX_REQUESTS = LIMIT * 2 + 10;
const MAX_CONSECUTIVE_FAILURES = 5;

let requestsUsed = 0;
let consecutiveFailures = 0;
let aborted: string | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Jittered pause between portal calls. Never fires before the first request. */
async function pace(): Promise<void> {
  const span = MAX_DELAY_MS - MIN_DELAY_MS;
  await sleep(MIN_DELAY_MS + Math.floor(Math.random() * span));
}

function spend(n = 1): boolean {
  if (requestsUsed + n > MAX_REQUESTS) {
    aborted = `request ceiling reached (${MAX_REQUESTS})`;
    return false;
  }
  requestsUsed += n;
  return true;
}

/** CAPTCHA or an auth failure means stop the run, not retry it. */
function classifyFatal(message: string): string | null {
  if (/CAPTCHA_REQUIRED/i.test(message)) return 'captcha_required';
  if (/AUTH_FAILED|401|403|login/i.test(message)) return 'auth_failed';
  return null;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    console.error('[portalMap] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (.env.local)');
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const readAll = async <T>(table: string, columns: string): Promise<T[]> => {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
      if (error) { console.error(`[portalMap] ${table} read failed: ${error.message}`); process.exit(1); }
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) break;
    }
    return out;
  };

  // ── Scope: exactly the SKUs the sync plan needs ───────────────────────────
  const products = await readAll<{ supplier_product_id: string; published: boolean }>(
    'standardized_products', 'supplier_product_id,published');
  const memberships = await readAll<{ supplier_product_id: string; supplier_account: string; is_saved: boolean | null; sync_status: string }>(
    'supplier_favorite_memberships', 'supplier_product_id,supplier_account,is_saved,sync_status');

  const target = new Set(products.filter((p) => p.published === true).map((p) => p.supplier_product_id));
  const needed = new Set<string>();
  for (const account of ['pickup', 'dropship']) {
    const saved = new Set(memberships
      .filter((r) => r.supplier_account === account && r.sync_status === 'ok' && r.is_saved === true)
      .map((r) => r.supplier_product_id));
    for (const sku of target) if (!saved.has(sku)) needed.add(sku);   // missing
    for (const sku of saved) if (!target.has(sku)) needed.add(sku);   // extra
  }

  const existing = new Map(
    (await readAll<StoredPortalMapping>(WRITE_TABLE, 'supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at'))
      .map((r) => [r.supplier_product_id, r]),
  );
  const now = new Date().toISOString();
  const alreadyUsable = [...needed].filter((sku) => {
    const row = existing.get(sku);
    return isUsableMapping(row) && !isStale(row, now);
  });
  const queue = [...needed].filter((sku) => !alreadyUsable.includes(sku)).sort().slice(0, LIMIT);

  console.log(`[portalMap] mode        : ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`[portalMap] write table : ${WRITE_TABLE} (the only permitted target)`);
  console.log(`[portalMap] TARGET      : ${target.size} published`);
  console.log(`[portalMap] sync needs  : ${needed.size} distinct SKUs`);
  console.log(`[portalMap] already ok  : ${alreadyUsable.length}`);
  console.log(`[portalMap] this run    : ${queue.length} (limit ${LIMIT}, ceiling ${MAX_REQUESTS} requests)\n`);

  if (queue.length === 0) { console.log('[portalMap] nothing to resolve.'); return; }

  const { loadSession, searchProductCandidates, fetchBaseInfos } =
    await import('./fetchGigaWarehouseInventoryFromXhr');
  const session = loadSession();

  const results: PortalResolution[] = [];
  for (const [index, sku] of queue.entries()) {
    if (aborted) break;
    if (index > 0) await pace();
    if (!spend(2)) break;

    try {
      const candidates = await searchProductCandidates(sku, session);
      let portalSku: string | null = null;
      // Only worth a detail call when the search was unambiguous.
      if (candidates.length === 1 && /^\d+$/.test(candidates[0])) {
        await pace();
        const base = await fetchBaseInfos(candidates[0], session);
        portalSku = base?.data?.product_info?.sku ?? null;
      }
      const resolution = resolvePortalMapping({ supplier_product_id: sku, candidates, portal_sku: portalSku });
      results.push(resolution);
      consecutiveFailures = resolution.status === 'resolved' ? 0 : consecutiveFailures + 1;
      console.log(`  ${String(index + 1).padStart(3)}. ${sku.padEnd(18)} ${resolution.status}${resolution.website_product_id ? ` → ${resolution.website_product_id}` : ''}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = classifyFatal(message);
      if (fatal) { aborted = fatal; console.error(`\n[portalMap] ABORT: ${fatal}`); break; }
      consecutiveFailures += 1;
      results.push({
        supplier_product_id: sku, status: 'detail_unavailable', website_product_id: null,
        portal_sku: null, source: PORTAL_MAPPING_SOURCE, confidence: null, detail: message.slice(0, 120),
      });
      console.log(`  ${String(index + 1).padStart(3)}. ${sku.padEnd(18)} error: ${message.slice(0, 60)}`);
    }

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      aborted = `${MAX_CONSECUTIVE_FAILURES} consecutive failures`;
      console.error(`\n[portalMap] ABORT: ${aborted}`);
      break;
    }
  }

  const resolved = results.filter((r) => r.status === 'resolved');
  const byStatus: Record<string, number> = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  console.log('\n─── summary ───');
  console.log(`  attempted : ${results.length}`);
  console.log(`  resolved  : ${resolved.length}`);
  console.log(`  by status : ${JSON.stringify(byStatus)}`);
  console.log(`  requests  : ${requestsUsed}/${MAX_REQUESTS}`);
  console.log(`  aborted   : ${aborted ?? 'no'}`);

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing was written.');
    console.log('  Untouched: inventory_cache, standardized_products, supplier_products, favorites, inventory.');
    return;
  }
  if (resolved.length === 0) { console.log('\n  Nothing resolved — no write.'); return; }

  const payload = resolved.map((r) => ({
    supplier_product_id: r.supplier_product_id,
    website_product_id: r.website_product_id,
    portal_sku: r.portal_sku,
    source: PORTAL_MAPPING_SOURCE,
    confidence: PORTAL_MAPPING_CONFIDENCE,
    resolved_at: now,
    last_verified_at: now,
    updated_at: now,
  }));
  const { data, error } = await sb.from(WRITE_TABLE)
    .upsert(payload, { onConflict: 'supplier_product_id' })
    .select('supplier_product_id');
  if (error) { console.error(`[portalMap] write failed: ${error.message}`); process.exit(1); }
  console.log(`\n  ✓ wrote ${(data ?? []).length} row(s) to ${WRITE_TABLE}`);
}

void main();
