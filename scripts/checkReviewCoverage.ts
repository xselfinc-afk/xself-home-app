/**
 * READ-ONLY review-coverage guard checker.
 *
 * Asserts every sellable product has >=1 ACTIVE product_reviews row, so the
 * "published product with no reviews" regression can never silently recur.
 *
 * This script is SELECT-only: it never writes to the DB and never generates
 * reviews. It does not touch checkout / pricing / inventory / order / AdMob.
 *
 * Exit codes (consumed by scripts/productionGuardrails.ts "Review coverage"):
 *   0  every sellable product has >=1 active review
 *   1  >=1 sellable product missing an active review (prints the offending list)
 *   2  could not verify — no DB creds, or DB unreachable (SOFT-SKIP; not a fail)
 *
 * Usage:
 *   npx tsx scripts/checkReviewCoverage.ts
 *
 * Env (loaded from .env.local then .env, matching the other pipeline scripts):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   EXCLUDE_REVIEWED  (test-only) comma list of supplier_product_ids to treat
 *                     as un-reviewed in memory — simulates a miss WITHOUT any
 *                     DB mutation. Unset in normal use.
 */

import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

export type CoverageRow = { supplier_product_id: string; category_code?: string | null };

/**
 * Pure core: sellable rows whose supplier_product_id is NOT in the reviewed set.
 * Rows with an empty/falsy supplier_product_id are ignored (cannot be keyed).
 * Exported for unit testing without any DB access.
 */
export function computeMissing(sellable: CoverageRow[], reviewed: Set<string>): CoverageRow[] {
  return sellable.filter(r => !!r.supplier_product_id && !reviewed.has(r.supplier_product_id));
}

function chunk<T>(a: T[], n: number): T[][] {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
}

async function fetchAllSellable(sb: SupabaseClient): Promise<CoverageRow[]> {
  const out: CoverageRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('sellable_products')
      .select('supplier_product_id, category_code')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`sellable_products: ${error.message}`);
    const rows = (data ?? []) as CoverageRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function fetchActiveReviewedIds(sb: SupabaseClient, ids: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const c of chunk(ids, 150)) {
    const { data, error } = await sb
      .from('product_reviews')
      .select('supplier_product_id')
      .eq('status', 'active')
      .in('supplier_product_id', c);
    if (error) throw new Error(`product_reviews: ${error.message}`);
    (data ?? []).forEach((r: { supplier_product_id: string }) => set.add(r.supplier_product_id));
  }
  return set;
}

async function main(): Promise<number> {
  loadEnv({ path: '.env.local' });
  loadEnv({ path: '.env' });

  const url = process.env.SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    console.log('SKIP: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — cannot verify review coverage');
    return 2; // soft-skip
  }

  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  let sellable: CoverageRow[];
  let reviewed: Set<string>;
  try {
    sellable = await fetchAllSellable(sb);
    reviewed = await fetchActiveReviewedIds(sb, sellable.map(r => r.supplier_product_id).filter(Boolean));
  } catch (e) {
    console.log(`SKIP: review-coverage query failed (${(e as Error).message}) — treating as unverifiable`);
    return 2; // soft-skip on DB unreachable / query error
  }

  // Test-only: simulate a missing SKU without mutating the DB.
  const exclude = (process.env.EXCLUDE_REVIEWED ?? '').split(',').map(s => s.trim()).filter(Boolean);
  exclude.forEach(s => reviewed.delete(s));

  const missing = computeMissing(sellable, reviewed);
  if (missing.length === 0) {
    console.log(`OK: ${sellable.length}/${sellable.length} sellable products have >=1 active review`);
    return 0;
  }

  // Best-effort enrichment for the report (sku_custom + title). Failure here
  // must not change the verdict — we still report the supplier_product_ids.
  const meta = new Map<string, { sku_custom?: string; title?: string; category_code?: string }>();
  try {
    for (const c of chunk(missing.map(m => m.supplier_product_id), 150)) {
      const { data } = await sb
        .from('standardized_products')
        .select('supplier_product_id, sku_custom, product_title_display, category_code')
        .in('supplier_product_id', c);
      (data ?? []).forEach((r: { supplier_product_id: string; sku_custom?: string; product_title_display?: string; category_code?: string }) =>
        meta.set(r.supplier_product_id, { sku_custom: r.sku_custom, title: r.product_title_display, category_code: r.category_code }));
    }
  } catch {
    /* enrichment is best-effort */
  }

  for (const m of missing) {
    const info = meta.get(m.supplier_product_id) ?? {};
    console.log(`  · ${m.supplier_product_id} (${info.sku_custom ?? '?'}) [${info.category_code ?? m.category_code ?? '?'}] "${info.title ?? '?'}": 0 active reviews`);
  }
  console.log(`FAIL: ${missing.length} sellable product(s) missing an active review`);
  return 1;
}

// Run only when invoked directly (so importing computeMissing in tests has no side effects).
const isDirectRun = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then(code => process.exit(code))
    .catch(e => {
      console.log(`SKIP: unexpected error (${(e as Error)?.message ?? e}) — treating as unverifiable`);
      process.exit(2);
    });
}
