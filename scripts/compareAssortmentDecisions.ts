/**
 * Assortment decision comparison — READ-ONLY validation run.
 *
 * Runs the current production assortment gate and the new taxonomy-first classifier side by side
 * over every current saved asset, and writes a report. It changes nothing: no table is written, no
 * supplier endpoint is called, no session is read, and the live plan path is not modified.
 *
 * The comparison logic itself lives in `src/services/assortmentComparison.ts` (pure and unit-tested);
 * this script only loads evidence and renders. Every Supabase call here is `.select(...)`.
 *
 * Run: npx dotenv -e .env.local -- npx tsx scripts/compareAssortmentDecisions.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  changedRows,
  compareOne,
  summarise,
  type ComparisonInput,
  type ComparisonRow,
} from '../src/services/assortmentComparison';

const OUT_DIR = path.join(process.cwd(), 'reports', 'saved-assets');
const OUT_JSON = path.join(OUT_DIR, 'assortment-decision-comparison.json');

const chunk = <T,>(a: T[], n: number): T[][] => {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
};

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required (scripts only; never app code).');
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  /** Fail loudly on any read error — a silent empty result must never look like "no rows". */
  function must<T>(tag: string, r: { data: T | null; error: { message: string } | null }): T {
    if (r.error) { console.error(`FATAL [${tag}] ${r.error.message}`); process.exit(1); }
    return r.data as T;
  }

  // ── Load every current saved asset ──────────────────────────────────────────
  const assets: Array<{ supplier_product_id: string; asset_state: string }> = [];
  for (let from = 0; ; from += 1000) {
    const data = must('saved_assets', await sb.from('saved_assets')
      .select('supplier_product_id,asset_state').range(from, from + 999));
    assets.push(...data);
    if (data.length < 1000) break;
  }
  const skus = assets.map(a => a.supplier_product_id);
  console.log(`saved assets: ${skus.length}`);

  // ── Load the last real production plan (titles + recorded production decisions) ──
  // Saved-but-never-imported SKUs have no title in our database — their titles exist only in the
  // supplier feed. The last plan run already captured them, so this artifact is used instead of
  // calling the supplier. It also records what production actually decided, which lets the replica
  // be cross-validated against real output rather than assumed correct.
  const PLAN_PATH = path.join(process.cwd(), 'reports', 'giga-auto-publish', 'latest-saved-plan.json');
  if (!fs.existsSync(PLAN_PATH)) {
    console.error(`FATAL missing ${path.relative(process.cwd(), PLAN_PATH)} — run the saved-items plan first.`);
    process.exit(1);
  }
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')) as {
    run_id: string; timestamp: string;
    items: Array<{
      sku: string; title: string; classification: string; invalid_reasons?: string[];
      in_supplier_products: boolean; in_standardized_products: boolean; in_sellable_products: boolean;
    }>;
  };
  console.log(`plan artifact: run ${plan.run_id} @ ${plan.timestamp} — ${plan.items.length} items`);

  const planBySku = new Map(plan.items.map(i => [i.sku, i]));
  const missingFromPlan = skus.filter(s => !planBySku.has(s));
  if (missingFromPlan.length) {
    console.log(`WARNING ${missingFromPlan.length} saved assets absent from the plan artifact (skipped).`);
  }

  // Membership is read LIVE, not taken from the artifact. The artifact is a point-in-time snapshot,
  // and SKUs imported or published since then would otherwise be scored against stale flags —
  // overstating the impact of the change. Titles still come from the artifact, because saved-but-
  // never-imported SKUs have no title anywhere in our database.
  const stdCategory = new Map<string, string>();
  const inSupplierLive = new Set<string>();
  const inStdLive = new Set<string>();
  const inSellLive = new Set<string>();
  for (const c of chunk(skus, 120)) {
    for (const r of must('supplier_products', await sb.from('supplier_products')
      .select('supplier_product_id').in('supplier_product_id', c))) {
      inSupplierLive.add(r.supplier_product_id);
    }
    for (const r of must('standardized_products', await sb.from('standardized_products')
      .select('supplier_product_id,category_label').in('supplier_product_id', c))) {
      inStdLive.add(r.supplier_product_id);
      stdCategory.set(r.supplier_product_id, r.category_label ?? '');
    }
    for (const r of must('sellable_products', await sb.from('sellable_products')
      .select('supplier_product_id').in('supplier_product_id', c))) {
      inSellLive.add(r.supplier_product_id);
    }
  }
  const membershipDrift = plan.items.filter(i => {
    const then = !(i.in_sellable_products || i.in_supplier_products || i.in_standardized_products);
    const now = !(inSellLive.has(i.sku) || inSupplierLive.has(i.sku) || inStdLive.has(i.sku));
    return then !== now;
  }).length;
  console.log(`membership drift since the artifact: ${membershipDrift} SKUs (live membership used)`);

  // ── Compare ─────────────────────────────────────────────────────────────────
  const rows: ComparisonRow[] = [];
  let replicaMismatches = 0;
  for (const sku of skus) {
    const p = planBySku.get(sku);
    if (!p) continue;
    const input: ComparisonInput = {
      sku,
      title: p.title ?? '',
      category: stdCategory.get(sku) ?? '',
      inSupplier: inSupplierLive.has(sku),
      inStd: inStdLive.has(sku),
      inSell: inSellLive.has(sku),
    };
    const row = compareOne(input);
    rows.push(row);

    // Cross-validate the legacy replica against what production actually recorded. This check uses
    // the ARTIFACT's own membership flags so it compares like with like against that same run.
    const gateAppliedThen = !(p.in_sellable_products || p.in_supplier_products || p.in_standardized_products);
    if (gateAppliedThen) {
      const productionExcluded =
        p.classification === 'blocked_or_invalid' && (p.invalid_reasons ?? []).includes('junk_category');
      const replicaExcluded = row.legacyDecision === 'excluded';
      if (productionExcluded !== replicaExcluded) {
        replicaMismatches++;
        console.log(`  MISMATCH ${sku}: production=${productionExcluded ? 'excluded' : 'accepted'} replica=${row.legacyDecision}`);
      }
    }
  }
  console.log(
    replicaMismatches === 0
      ? '\n✓ legacy replica reproduces production decisions exactly (0 mismatches)'
      : `\n✗ ${replicaMismatches} replica mismatches`,
  );

  const summary = summarise(rows);
  const changed = changedRows(rows);

  console.log('\n=== change type ===');
  for (const [k, v] of Object.entries(summary.byChangeType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.log('\n=== assortment class ===');
  for (const [k, v] of Object.entries(summary.byAssortmentClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`);
  }
  console.log(
    `\ncandidates added: ${summary.candidatesAdded}  removed: ${summary.candidatesRemoved}  ` +
    `policy review: ${summary.routedToPolicyReview}  published affected: ${summary.publishedAffected}`,
  );
  console.log(`gate applies to ${summary.gateApplies} / ${summary.total} saved assets`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({
    generated_from: 'scripts/compareAssortmentDecisions.ts',
    read_only: true,
    database_rows_written: 0,
    wired_into_production: false,
    summary,
    changed_rows: changed,
    all_rows: rows,
  }, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), OUT_JSON)} — changed rows: ${changed.length}`);
}

main().catch(e => { console.error('FATAL', e?.message ?? e); process.exit(1); });
