/**
 * Scoped onboarding orchestrator (ADDITIVE, thin delegator — NOT a second pipeline).
 *
 * Runs the existing scoped finalization stages for an ONLY_SKUS allowlist, in order, fail-fast,
 * and REFUSES to report success until every sellable-eligible SKU also has >=1 active review.
 * It delegates to the existing stage scripts / RPC / edge function (no logic duplication) and does
 * NOT run the full eight-stage runGigaAutoPublish.
 *
 * Preconditions (done before this wrapper): supplier_products.published=true (approval) and
 * inventory_cache populated (scoped warehouse scrape). This wrapper then finalizes:
 *
 *   normalize → inventory-status refresh → dynamic-pricing → verify sellable
 *   → seed generated reviews (sellable-only) → completion gate (sellable AND reviewed)
 *
 * Usage:  ONLY_SKUS="sku1,sku2" npx tsx scripts/onboardScopedSkus.ts [--dry-run]
 *
 * Exit non-zero on any stage failure, or if the completion gate is not satisfied. Blocked /
 * non-sellable SKUs are excluded (reported), not failures. Review seeding is idempotent.
 */
import { config as loadEnv } from 'dotenv';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseOnlySkus } from './seedReviewsForSellable';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

/** PURE + exported: onboarding completion gate. ok only when there is >=1 sellable-eligible SKU and
 *  every eligible SKU has >=1 active review. Blocked/non-sellable SKUs are excluded, not failures. */
export function evaluateCompletionGate(
  requested: string[],
  sellableIds: Set<string>,
  reviewedIds: Set<string>,
): { eligible: string[]; excluded: string[]; missingReviews: string[]; ok: boolean } {
  const eligible = requested.filter(s => sellableIds.has(s));
  const excluded = requested.filter(s => !sellableIds.has(s));
  const missingReviews = eligible.filter(s => !reviewedIds.has(s));
  const ok = eligible.length > 0 && missingReviews.length === 0;
  return { eligible, excluded, missingReviews, ok };
}

const H = (): Record<string, string> => ({
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});

function stage(name: string, script: string, extraEnv: Record<string, string>, extraArgs: string[] = []): void {
  console.log(`\n──────── STAGE: ${name} ────────`);
  const r = spawnSync('npx', ['tsx', script, ...extraArgs], {
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error(`[onboardScopedSkus] STAGE FAILED: ${name} (exit ${r.status}) — aborting.`);
    process.exit(r.status ?? 1);
  }
}

async function main(): Promise<void> {
  const DRY = process.argv.includes('--dry-run');
  const requested = parseOnlySkus(process.env.ONLY_SKUS);
  if (requested.length === 0) {
    console.error('[onboardScopedSkus] FAIL-CLOSED: ONLY_SKUS missing or malformed.');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[onboardScopedSkus] ERROR: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
    process.exit(1);
  }
  const only = requested.join(',');
  console.log(`[onboardScopedSkus] scoped onboarding for ${requested.length} SKU(s)${DRY ? '  (dry run)' : ''}: ${only}`);

  // 1. Normalize (existing script; scoped by ONLY_SKUS).
  stage('normalize', 'scripts/normalizeProducts.ts', { ONLY_SKUS: only, ...(DRY ? { DRY_RUN: '1' } : {}) });

  // 2. Inventory-status refresh (existing RPC; per SKU). Skipped in dry run (it writes).
  if (!DRY) {
    for (const sku of requested) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refresh_product_inventory_status`, {
        method: 'POST', headers: H(), body: JSON.stringify({ p_supplier_product_id: sku }),
      });
      if (!r.ok) { console.error(`[onboardScopedSkus] refresh_product_inventory_status(${sku}) HTTP ${r.status} — aborting.`); process.exit(1); }
    }
    console.log('──────── STAGE: inventory-status refresh ──────── done');
  } else {
    console.log('\n──────── STAGE: inventory-status refresh ──────── [dry] would refresh per SKU');
  }

  // 3. Dynamic pricing (existing edge function; only_skus).
  console.log('\n──────── STAGE: dynamic-pricing ────────');
  const pr = await fetch(`${SUPABASE_URL}/functions/v1/dynamic-pricing`, {
    method: 'POST', headers: H(), body: JSON.stringify({ only_skus: requested, dry_run: DRY }),
  });
  if (!pr.ok) { console.error(`[onboardScopedSkus] dynamic-pricing HTTP ${pr.status} — aborting.`); process.exit(1); }
  console.log(`dynamic-pricing: ${(await pr.text()).slice(0, 200)}`);

  // 4. Review bootstrap — the existing sellable-only helper (verify sellable + seed + coverage gate).
  stage('seed-reviews (sellable-only)', 'scripts/seedReviewsForSellable.ts', { ONLY_SKUS: only }, DRY ? ['--dry-run'] : []);

  // 5. Completion gate — refuse success unless every sellable-eligible SKU has >=1 active review.
  if (DRY) { console.log('\n[onboardScopedSkus] [dry] would run completion gate (sellable ∧ reviewed).'); return; }
  const sellRows = await (await fetch(`${SUPABASE_URL}/rest/v1/sellable_products?select=supplier_product_id&supplier_product_id=in.(${only})`, { headers: H() })).json();
  const revRows = await (await fetch(`${SUPABASE_URL}/rest/v1/product_reviews?select=supplier_product_id&status=eq.active&supplier_product_id=in.(${only})`, { headers: H() })).json();
  const sellable = new Set((Array.isArray(sellRows) ? sellRows : []).map((r: { supplier_product_id: string }) => r.supplier_product_id));
  const reviewed = new Set((Array.isArray(revRows) ? revRows : []).map((r: { supplier_product_id: string }) => r.supplier_product_id));
  const gate = evaluateCompletionGate(requested, sellable, reviewed);

  console.log('\n──────── COMPLETION GATE ────────');
  console.log(`  eligible (sellable): ${gate.eligible.join(', ') || 'none'}`);
  if (gate.excluded.length) console.log(`  excluded (blocked/non-sellable): ${gate.excluded.join(', ')}`);
  if (gate.missingReviews.length) console.error(`  MISSING REVIEWS (sellable but 0 active reviews): ${gate.missingReviews.join(', ')}`);
  if (!gate.ok) {
    console.error('[onboardScopedSkus] ONBOARDING INCOMPLETE — completion gate failed.');
    process.exit(1);
  }
  console.log(`[onboardScopedSkus] ✓ ONBOARDING COMPLETE — ${gate.eligible.length} sellable SKU(s), all with active reviews${gate.excluded.length ? `; ${gate.excluded.length} excluded` : ''}.`);
}

const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(err => { console.error('[onboardScopedSkus] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
