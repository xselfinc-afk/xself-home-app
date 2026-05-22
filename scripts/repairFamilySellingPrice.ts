/**
 * Phase 4 — Catalog-wide pricing audit + repair.
 *
 * Scans every row in `standardized_products` where `selling_price IS NULL`
 * or `<= 0` (the app would fall back to supplier `price` = wholesale cost
 * for these). For each row, looks up siblings via `product_family_key`,
 * runs `selectFamilySellingPrice` to pick a family value (mode, ties →
 * higher), and either inherits or marks as unresolved.
 *
 * No new pricing formula is introduced. dynamic-pricing
 * (`supabase/functions/dynamic-pricing/index.ts`) remains the canonical
 * producer per PRODUCT_DISPLAY_RULES.md §1.2. This script only propagates
 * already-existing family values onto siblings that lack them.
 *
 * Usage
 *   # Dry-run (default — no writes):
 *   npx dotenv -e .env.local -- npx tsx scripts/repairFamilySellingPrice.ts
 *
 *   # Apply repairs:
 *   APPLY=1 npx dotenv -e .env.local -- npx tsx scripts/repairFamilySellingPrice.ts
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { selectFamilySellingPrice } from '../src/services/productResolvers';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const APPLY = process.env.APPLY === '1';
const DRY_RUN = !APPLY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[repairFamilySellingPrice] FATAL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required.');
  console.error('  Hint: invoke via `npx dotenv -e .env.local -- npx tsx scripts/repairFamilySellingPrice.ts`');
  process.exit(1);
}

type Row = {
  supplier_product_id: string;
  sku_custom: string;
  color: string | null;
  price: number;
  selling_price: number | null;
  product_family_key: string | null;
  inventory_status: string;
  published: boolean;
};

type Plan = {
  sku: string;
  sku_custom: string;
  color: string;
  price: number;
  selling_price_before: number | null;
  selling_price_after: number | null;
  family_key: string;
  sibling_skus: string[];
  action: 'INHERIT' | 'UNRESOLVED' | 'NO_FAMILY_KEY';
};

async function fetchAllDoneRows(supabase: SupabaseClient): Promise<Row[]> {
  // PostgREST default limit is 1000; paginate in 1000-row pages to cover
  // catalogs larger than that.
  const PAGE = 1000;
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('standardized_products')
      .select(
        'supplier_product_id, sku_custom, color, price, selling_price, product_family_key, inventory_status, published',
      )
      .eq('normalization_status', 'done')
      .order('product_family_key', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('Fetch failed:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    out.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }
  return out;
}

async function run() {
  console.log('═════════════════════════════════════════════════');
  console.log(' repairFamilySellingPrice — catalog-wide audit');
  console.log('═════════════════════════════════════════════════');
  console.log(`  Mode: ${APPLY ? 'APPLY (writes)' : 'DRY_RUN (no writes)'}`);
  console.log('─────────────────────────────────────────────────\n');

  const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Fetch every normalized row
  const rows = await fetchAllDoneRows(supabase);
  console.log(`Rows scanned: ${rows.length}`);

  // 2. Identify unpriced rows
  const unpriced = rows.filter(r => r.selling_price == null || Number(r.selling_price) <= 0);
  console.log(`Rows with missing or non-positive selling_price: ${unpriced.length}`);

  // 3. Index family → list of valid sibling rows
  const familyRows = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.product_family_key) continue;
    const list = familyRows.get(r.product_family_key) ?? [];
    list.push(r);
    familyRows.set(r.product_family_key, list);
  }

  // 4. Build per-row plan
  const plans: Plan[] = [];
  for (const r of unpriced) {
    if (!r.product_family_key) {
      plans.push({
        sku: r.supplier_product_id,
        sku_custom: r.sku_custom,
        color: r.color ?? '',
        price: Number(r.price),
        selling_price_before: r.selling_price == null ? null : Number(r.selling_price),
        selling_price_after: null,
        family_key: '',
        sibling_skus: [],
        action: 'NO_FAMILY_KEY',
      });
      continue;
    }
    const family = familyRows.get(r.product_family_key) ?? [];
    const validSiblings = family.filter(
      x =>
        x.supplier_product_id !== r.supplier_product_id &&
        x.selling_price != null &&
        Number(x.selling_price) > 0,
    );
    const prices = validSiblings.map(x => Number(x.selling_price));
    const familyPrice = selectFamilySellingPrice(prices);
    plans.push({
      sku: r.supplier_product_id,
      sku_custom: r.sku_custom,
      color: r.color ?? '',
      price: Number(r.price),
      selling_price_before: r.selling_price == null ? null : Number(r.selling_price),
      selling_price_after: familyPrice,
      family_key: r.product_family_key,
      sibling_skus: validSiblings.map(x => x.supplier_product_id),
      action: familyPrice != null ? 'INHERIT' : 'UNRESOLVED',
    });
  }

  // 5. Per-row audit table
  console.log('\n─── Per-row audit ───');
  console.log(
    [
      'supplier_product_id'.padEnd(22),
      'sku_custom'.padEnd(22),
      'color'.padEnd(10),
      'price'.padStart(7),
      'before'.padStart(8),
      'after'.padStart(8),
      'action'.padEnd(12),
      'family_key',
    ].join(' '),
  );
  for (const p of plans) {
    console.log(
      [
        p.sku.padEnd(22),
        (p.sku_custom || '—').padEnd(22),
        (p.color || '—').padEnd(10),
        String(p.price).padStart(7),
        (p.selling_price_before == null ? 'null' : String(p.selling_price_before)).padStart(8),
        (p.selling_price_after == null ? 'null' : String(p.selling_price_after)).padStart(8),
        p.action.padEnd(12),
        p.family_key || '(none)',
      ].join(' '),
    );
    if (p.action === 'INHERIT' && p.sibling_skus.length > 0) {
      console.log(`    siblings (priced): ${p.sibling_skus.slice(0, 8).join(', ')}${p.sibling_skus.length > 8 ? `, +${p.sibling_skus.length - 8} more` : ''}`);
    }
  }

  // 6. Summary
  const repairable = plans.filter(p => p.action === 'INHERIT').length;
  const noFamily   = plans.filter(p => p.action === 'NO_FAMILY_KEY').length;
  const unresolved = plans.filter(p => p.action === 'UNRESOLVED').length;
  console.log('\n─── Summary ───');
  console.log(`  Rows scanned                  : ${rows.length}`);
  console.log(`  Rows missing/≤0 selling_price : ${unpriced.length}`);
  console.log(`  Repairable via family inherit : ${repairable}`);
  console.log(`  Unresolved (family has no priced sibling): ${unresolved}`);
  console.log(`  No product_family_key at all  : ${noFamily}`);

  // 7. Apply gate
  if (DRY_RUN) {
    console.log('\nDRY_RUN — no writes. Re-run with APPLY=1 to update.');
    return;
  }

  // 8. APPLY — one UPDATE per repairable row (small enough at typical
  //    catalog scale that batching isn't required; this also gives a
  //    per-row audit log).
  console.log('\nApplying family selling_price to repairable rows...');
  let applied = 0;
  let appliedErrors = 0;
  for (const p of plans) {
    if (p.action !== 'INHERIT' || p.selling_price_after == null) continue;
    const { error: updErr } = await supabase
      .from('standardized_products')
      .update({ selling_price: p.selling_price_after })
      .eq('supplier_product_id', p.sku);
    if (updErr) {
      appliedErrors++;
      console.warn(`  ✗ ${p.sku}  →  ${updErr.message}`);
      continue;
    }
    console.log(`  ✓ ${p.sku}  selling_price ← $${p.selling_price_after}  (family ${p.family_key})`);
    applied++;
  }
  console.log(`\nApplied: ${applied} / ${repairable}  (errors: ${appliedErrors})`);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[repairFamilySellingPrice] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
