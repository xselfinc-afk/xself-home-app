/**
 * Pickup Favorite membership sync → public.supplier_favorite_memberships
 *
 * DRY-RUN BY DEFAULT. `--apply` is required to write, and the ONLY table it may ever write is
 * `supplier_favorite_memberships`.
 *
 * Authoritative contract: docs/product-supply/SAVED_ASSET_XONE_CONTRACT.md
 *
 * REUSE, NOT REBUILD: the live path calls the EXISTING Pickup reader
 * `scripts/lib/gigaSavedItems.ts::fetchAllSavedItems()`, which owns the HMAC client, credential
 * cascade and pagination. No second supplier client is created here.
 *
 * WHAT IT NEVER WRITES: saved_assets, saved_asset_transitions, supplier_products,
 * standardized_products, inventory_cache, pricing, reviews, orders, publication state.
 * It also never modifies supplier Favorites — this is a read-then-record path only.
 *
 * Usage:
 *   npx tsx scripts/syncSupplierFavoriteFacts.ts --snapshot                      # dry run, on-disk snapshot
 *   npx tsx scripts/syncSupplierFavoriteFacts.ts --snapshot --only=W1,W2         # dry run, scoped
 *   npx tsx scripts/syncSupplierFavoriteFacts.ts --snapshot --only=W1,W2 --apply # scoped write
 *   npx tsx scripts/syncSupplierFavoriteFacts.ts --live                          # dry run, live reader
 *
 * Flags:
 *   --snapshot[=path]  read the on-disk Saved Items snapshot (default: latest-saved-plan.json)
 *   --live             read the supplier via the existing reader
 *   --only=A,B         exact SKU allowlist (absence within an allowlist NEVER implies removal)
 *   --apply            write. Omit for dry run.
 *   --allow-incomplete record UNKNOWN facts from a non-authoritative observation
 */
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import {
  WRITE_TABLE,
  buildFactRows,
  completenessReason,
  diffAgainstExisting,
  isAuthoritative,
  normaliseSkus,
  parseAllowlist,
  summarise,
  type FavoriteObservation,
  type FactRow,
} from '../src/services/supplierFavoriteFacts';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const hit = argv.find(a => a === `--${n}` || a.startsWith(`--${n}=`));
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(n.length + 3) : '';
};
const has = (n: string) => argv.some(a => a === `--${n}` || a.startsWith(`--${n}=`));

const DEFAULT_SNAPSHOT = 'reports/giga-auto-publish/latest-saved-plan.json';

function must<T extends { error: unknown }>(tag: string, res: T): T {
  const e = res.error as { code?: string; message?: string } | null;
  if (e) {
    console.error(`[favFacts] FATAL ${tag}: ${e.code ?? ''} ${e.message ?? String(e)}`);
    process.exit(1);
  }
  return res;
}

/** Read the existing on-disk Saved Items snapshot (pickup account). */
function observationFromSnapshot(file: string, runId: string): FavoriteObservation {
  if (!fs.existsSync(file)) {
    console.error(`[favFacts] FATAL: snapshot not found: ${file}`);
    process.exit(1);
  }
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items: Array<{ sku?: string }> = j.items ?? [];
  const reportedTotal =
    typeof j.reported_total_num === 'number' ? j.reported_total_num
    : typeof j.reportedTotal === 'number' ? j.reportedTotal
    : null;

  // The snapshot is a pickup-account artefact; refuse anything else rather than mislabel a fact.
  const creds = String(j.creds_source ?? '');
  if (creds && !creds.includes('giga-alt')) {
    console.error(`[favFacts] FATAL: snapshot creds_source=${creds} is not the pickup account.`);
    process.exit(1);
  }

  return {
    supplierAccount: 'pickup',
    sourceRunId: runId,
    observedAt: String(j.timestamp ?? new Date().toISOString()),
    syncStatus: 'ok',
    syncErrorCode: null,
    skus: normaliseSkus(items.map(i => String(i.sku ?? ''))),
    reportedTotal,
    pagesFetched: Number(j.pages_fetched ?? 0),
  };
}

/** Live read via the EXISTING pickup reader. Any failure fails closed to UNKNOWN. */
async function observationFromLive(runId: string): Promise<FavoriteObservation> {
  const { fetchAllSavedItems, GigaSavedItemsError } = await import('./lib/gigaSavedItems');
  const observedAt = new Date().toISOString();
  try {
    const res = await fetchAllSavedItems({ silenceClientLogs: true });
    console.log(`  reader: creds=${res.credsSource} pages=${res.pagesFetched} endpoint=${res.endpointPath}`);
    return {
      supplierAccount: 'pickup',
      sourceRunId: runId,
      observedAt,
      syncStatus: 'ok',
      syncErrorCode: null,
      skus: normaliseSkus(res.items.map(i => i.sku)),
      reportedTotal: res.reportedTotal,
      pagesFetched: res.pagesFetched,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isGiga = typeof GigaSavedItemsError === 'function' && err instanceof GigaSavedItemsError;
    const status =
      /auth|login|401|403|B20003|permission/i.test(msg) ? 'auth_failed'
      : /captcha|challenge/i.test(msg) ? 'captcha_required'
      : /network|timeout|ECONN|ENOTFOUND/i.test(msg) ? 'network_failed'
      : isGiga ? 'parse_failed'
      : 'supplier_unavailable';
    console.warn(`  reader FAILED → ${status}: ${msg.slice(0, 140)}`);
    // Fail closed: no SKUs observed, unknown total → nothing can be concluded removed.
    return {
      supplierAccount: 'pickup',
      sourceRunId: runId,
      observedAt,
      syncStatus: status as FavoriteObservation['syncStatus'],
      syncErrorCode: null,
      skus: new Set<string>(),
      reportedTotal: null,
      pagesFetched: 0,
    };
  }
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[favFacts] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (.env.local)');
    process.exit(1);
  }
  const useLive = has('live');
  const useSnapshot = has('snapshot') || !useLive;
  if (useLive && has('snapshot')) {
    console.error('[favFacts] choose one of --live or --snapshot');
    process.exit(1);
  }

  const apply = has('apply');
  const allowlist = parseAllowlist(arg('only'));
  const runId = crypto.randomUUID();
  const snapshotFile = arg('snapshot') || DEFAULT_SNAPSHOT;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` PICKUP FAVORITE FACT SYNC — ${apply ? '*** APPLY ***' : 'DRY RUN'}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` source      : ${useLive ? 'LIVE (existing pickup reader)' : `snapshot ${snapshotFile}`}`);
  console.log(` account     : pickup`);
  console.log(` run id      : ${runId}`);
  console.log(` allowlist   : ${allowlist ? allowlist.join(', ') : '(none — full account scope)'}`);
  console.log(` write table : ${WRITE_TABLE} (the only permitted target)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const obs = useLive ? await observationFromLive(runId) : observationFromSnapshot(snapshotFile, runId);
  const authoritative = isAuthoritative(obs);

  console.log('─── observation ───');
  console.log(`  observed count  : ${obs.skus.size}`);
  console.log(`  reported total  : ${obs.reportedTotal ?? '(none reported)'}`);
  console.log(`  pages fetched   : ${obs.pagesFetched}`);
  console.log(`  sync status     : ${obs.syncStatus}${obs.syncErrorCode ? ` (${obs.syncErrorCode})` : ''}`);
  console.log(`  completeness    : ${completenessReason(obs)}`);
  console.log(`  authoritative   : ${authoritative} — ${authoritative ? 'absence proves removal' : 'absence proves NOTHING (facts recorded as UNKNOWN)'}`);
  if (allowlist) {
    console.log('  NOTE: an allowlist is a partial view — absence within it NEVER implies removal (rule 10).');
  }

  if (!authoritative && !has('allow-incomplete')) {
    console.log('\n  ✗ FAIL-CLOSED: observation is not authoritative. No fact can conclude removal.');
    console.log('    Re-run with --allow-incomplete to record UNKNOWN facts, or supply a complete list.');
    process.exit(2);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Existing facts for THIS account only — a sibling account's rows are never read or written.
  let q = sb.from(WRITE_TABLE).select('supplier_product_id,is_saved,sync_status,version').eq('supplier_account', 'pickup');
  if (allowlist) q = q.in('supplier_product_id', allowlist);
  const existingRows = must('read existing', await q).data ?? [];
  const existing: Record<string, { is_saved?: boolean | null; sync_status?: string }> = {};
  for (const r of existingRows as any[]) existing[r.supplier_product_id] = r;

  const rows = buildFactRows(obs, Object.keys(existing), allowlist);
  const entries = diffAgainstExisting(rows, existing);
  const counts = summarise(entries);
  const changed = entries.filter(e => e.action !== 'unchanged');

  console.log('\n─── proposed ───');
  console.log(`  inserts   : ${counts.insert}`);
  console.log(`  updates   : ${counts.update}`);
  console.log(`  unchanged : ${counts.unchanged}`);
  for (const e of changed.slice(0, 40)) {
    console.log(`    ${e.action.padEnd(9)} ${e.sku.padEnd(16)} ${String(e.before).padEnd(9)} → ${String(e.after)}   ${e.reason}`);
  }
  if (changed.length > 40) console.log(`    … ${changed.length - 40} more`);

  if (!apply) {
    console.log('\n  DRY RUN — nothing was written.');
    console.log('  Untouched: saved_assets, saved_asset_transitions, products, inventory, pricing, reviews, orders.');
    return;
  }

  const byId = new Map<string, FactRow>(rows.map(r => [r.supplier_product_id, r]));
  const payload = changed.map(e => byId.get(e.sku)!).filter(Boolean);
  if (payload.length === 0) {
    console.log('\n  nothing to write — all observations already current.');
    return;
  }

  const res = must('upsert', await sb.from(WRITE_TABLE).upsert(payload, {
    onConflict: 'supplier_product_id,supplier_account',
  }).select('supplier_product_id'));
  console.log(`\n  ✓ wrote ${(res.data ?? []).length} row(s) to ${WRITE_TABLE}`);
  console.log('  No other table was written.');
}

main().catch(err => {
  console.error('[favFacts] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
