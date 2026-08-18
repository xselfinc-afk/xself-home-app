/**
 * Review coverage reconciliation — the standing answer to "reviews keep disappearing".
 *
 * Why a job and not a trigger
 * ---------------------------
 * public.sellable_products is a VIEW. A product "enters sellable" when its underlying columns
 * change — inventory freshness, selling_price, publication state — never by a write to the view
 * itself. So there is no event to hook: an INSTEAD OF trigger would simply never fire, and would
 * miss exactly the paths that matter (relist, RPC refresh, runGigaAutoPublish).
 *
 * Observing the derived state instead covers every publish entry point that exists today and every
 * one added later, because it asks "which sellable SKU has no active review right now?" rather than
 * trying to intercept how it got there.
 *
 * This creates no second review system: it computes the gap and hands it to the existing
 * scripts/seedReviewsForSellable.ts, which in turn calls the existing deterministic seeder. That
 * seeder upserts on (supplier_product_id, reviewer_name), so re-running is a no-op — idempotence
 * comes from the existing conflict key, not from anything invented here.
 *
 * Real user-submitted reviews are never touched: this only ever ADDS generated rows for SKUs that
 * have none, and a SKU with a real review is not in the gap set to begin with.
 *
 *   npx tsx scripts/reconcileReviewCoverage.ts [--dry-run]
 *
 * Exit codes: 0 = coverage complete (or nothing to do), 1 = coverage still incomplete after seeding.
 */
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** PostgREST caps a single request at 1000 rows; a partial read here would invent a phantom gap. */
async function readAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const client = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = client.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function findGap(): Promise<string[]> {
  const sellable = await readAll<{ supplier_product_id: string }>('sellable_products', 'supplier_product_id');
  const reviewed = await readAll<{ supplier_product_id: string }>(
    'product_reviews', 'supplier_product_id', q => q.eq('status', 'active'),
  );
  const covered = new Set(reviewed.map(r => r.supplier_product_id));
  return sellable.map(s => s.supplier_product_id).filter(id => !covered.has(id));
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry-run');
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.error('[reconcileReviews] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const gap = await findGap();
  console.log(`[reconcileReviews] sellable gap: ${gap.length} SKU(s)`);
  if (gap.length === 0) {
    console.log('[reconcileReviews] coverage already complete — nothing to do');
    return;
  }
  if (dry) {
    console.log(`[reconcileReviews] DRY_RUN — would seed: ${gap.slice(0, 10).join(',')}${gap.length > 10 ? ` …(+${gap.length - 10})` : ''}`);
    return;
  }

  // Hand off to the existing sellable-scoped bootstrap. It re-checks sellability itself, so a SKU
  // that dropped out between our read and now is excluded rather than wrongly seeded.
  const res = spawnSync('npx', ['tsx', 'scripts/seedReviewsForSellable.ts'], {
    stdio: 'inherit',
    env: { ...process.env, ONLY_SKUS: gap.join(',') },
  });
  if (res.status !== 0) {
    console.error('[reconcileReviews] seeder failed');
    process.exit(1);
  }

  const remaining = await findGap();
  if (remaining.length > 0) {
    console.error(`[reconcileReviews] STILL UNCOVERED after seeding: ${remaining.length} — ${remaining.slice(0, 5).join(',')}`);
    process.exit(1);
  }
  console.log('[reconcileReviews] ✓ coverage complete');
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch(err => { console.error('[reconcileReviews]', err); process.exit(1); });
