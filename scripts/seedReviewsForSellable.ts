/**
 * Scoped post-sellable review bootstrap (ADDITIVE orchestration — reuses the existing seeder).
 *
 * Purpose: the review-seed stage of scoped onboarding. For a SKU allowlist (ONLY_SKUS), seed the
 * existing generated reviews ONLY for SKUs that have actually entered public.sellable_products.
 * A SKU still blocked by inventory / Pickup / Delivery / pricing / normalization / taxonomy is NOT
 * sellable, so it is excluded and reported — it receives no reviews in this attempt.
 *
 * This does NOT create a second review system, generator, or table, and does NOT insert ad hoc
 * review rows. It invokes the existing scripts/seedGeneratedReviews.ts (idempotent upsert on
 * (supplier_product_id, reviewer_name)), preserving its templates, rating distribution, reviewer
 * names, source fields, moderation status, and conflict key. Running twice does not duplicate rows.
 *
 * Usage:
 *   ONLY_SKUS="sku1,sku2" npx tsx scripts/seedReviewsForSellable.ts [--dry-run]
 *
 * Fail-closed exit(1) when: ONLY_SKUS is missing/malformed, or none of the requested SKUs are
 * sellable. After seeding it verifies review coverage (>=1 active review per eligible SKU).
 */
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** PURE: parse ONLY_SKUS into a deduped, trimmed allowlist. */
export function parseOnlySkus(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))];
}

/** PURE: split the requested allowlist into sellable-eligible vs excluded (not currently sellable).
 *  Only requested ∩ sellable is eligible, so unrelated SKUs are never processed. */
export function partitionSellable(
  requested: string[],
  sellableIds: Set<string>,
): { eligible: string[]; excluded: string[] } {
  const eligible = requested.filter(s => sellableIds.has(s));
  const excluded = requested.filter(s => !sellableIds.has(s));
  return { eligible, excluded };
}

async function main(): Promise<void> {
  const DRY = process.argv.includes('--dry-run');
  const requested = parseOnlySkus(process.env.ONLY_SKUS);

  if (requested.length === 0) {
    console.error('[seedReviewsForSellable] FAIL-CLOSED: ONLY_SKUS missing or malformed (no SKUs). Nothing seeded.');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[seedReviewsForSellable] ERROR: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (.env.local).');
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Sellable-only filter: reviews are seeded ONLY for SKUs already in sellable_products.
  const { data: sellRows, error: sellErr } = await sb
    .from('sellable_products')
    .select('supplier_product_id')
    .in('supplier_product_id', requested);
  if (sellErr) {
    console.error(`[seedReviewsForSellable] sellable_products query failed: ${sellErr.message}`);
    process.exit(1);
  }
  const sellableIds = new Set((sellRows ?? []).map((r: { supplier_product_id: string }) => r.supplier_product_id));
  const { eligible, excluded } = partitionSellable(requested, sellableIds);

  console.log(`[seedReviewsForSellable] requested=${requested.length} sellable-eligible=${eligible.length} excluded=${excluded.length}${DRY ? '  (dry run)' : ''}`);
  if (excluded.length) {
    console.warn(`[seedReviewsForSellable] EXCLUDED (not in sellable_products — NOT seeded): ${excluded.join(', ')}`);
  }
  if (eligible.length === 0) {
    console.error('[seedReviewsForSellable] FAIL-CLOSED: none of the requested SKUs are currently sellable. Nothing seeded.');
    process.exit(1);
  }
  console.log(`[seedReviewsForSellable] eligible sellable SKUs: ${eligible.join(', ')}`);

  // Reuse the EXISTING seeder (no ad hoc inserts, no second generator). Scoped via ONLY_SKUS.
  const args = ['tsx', 'scripts/seedGeneratedReviews.ts'];
  if (DRY) args.push('--dry-run');
  const seed = spawnSync('npx', args, {
    env: { ...process.env, ONLY_SKUS: eligible.join(',') },
    stdio: 'inherit',
  });
  if (seed.status !== 0) {
    console.error(`[seedReviewsForSellable] seedGeneratedReviews exited ${seed.status}`);
    process.exit(seed.status ?? 1);
  }

  if (DRY) {
    console.log('[seedReviewsForSellable] DRY_RUN — coverage check skipped (no writes).');
    return;
  }

  // Coverage gate: every eligible SKU must now have >=1 ACTIVE review.
  const { data: revRows, error: revErr } = await sb
    .from('product_reviews')
    .select('supplier_product_id')
    .eq('status', 'active')
    .in('supplier_product_id', eligible);
  if (revErr) {
    console.error(`[seedReviewsForSellable] coverage query failed: ${revErr.message}`);
    process.exit(1);
  }
  const covered = new Set((revRows ?? []).map((r: { supplier_product_id: string }) => r.supplier_product_id));
  const missing = eligible.filter(s => !covered.has(s));
  if (missing.length) {
    console.error(`[seedReviewsForSellable] COVERAGE FAIL — no active reviews for: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`[seedReviewsForSellable] ✓ review coverage OK — ${eligible.length}/${eligible.length} eligible SKU(s) have active reviews.`);
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(err => {
    console.error('[seedReviewsForSellable] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
