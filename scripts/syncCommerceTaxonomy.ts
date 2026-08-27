/**
 * Write the commerce taxonomy onto standardized_products.
 *
 * `classifyCommerce` is the single reference implementation of the
 * Department → Category → Product Type → Rooms[] hierarchy. Until now its output
 * lived only in App memory, so the Website could not read it and grew a second,
 * incompatible taxonomy off `category_label`. This job persists the classifier's
 * output so both surfaces read one fact instead of each deriving their own.
 *
 * The classifier is imported, never reimplemented — if the two ever disagree it
 * is because this job has not run, which `commerce_classified_at` makes visible.
 *
 * Classification inputs mirror `adaptStandardizedRow` exactly:
 *   • name         — resolveProductTitle(optimized_title, product_title_display, product_title)
 *   • categoryLabel— category_label
 *   • category     — specifications_json['Category'] || category_code, the same
 *                    expression the adapter uses. This feeds the classifier's
 *                    AUTHORITATIVE_SPEC and SPEC_FALLBACK branches, which outrank
 *                    title keywords; omitting it silently reclassifies every product
 *                    whose supplier spec category disagrees with its title.
 *
 * Every published row is classified, not just the sellable ones: a product that is
 * temporarily out of stock drops out of `sellable_products` and must not come back
 * unclassified.
 *
 * Run:
 *   npx tsx scripts/syncCommerceTaxonomy.ts            # write
 *   DRY_RUN=1 npx tsx scripts/syncCommerceTaxonomy.ts  # report only, no writes
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — required
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { classifyCommerce, NEEDS_REVIEW } from '../src/utils/commerceTaxonomy';
import { resolveProductTitle } from '../src/services/productResolvers';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[syncCommerceTaxonomy] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const PAGE = 500;

interface Row {
  supplier_product_id: string;
  category_label: string | null;
  category_code: string | null;
  specifications_json: Record<string, string> | null;
  optimized_title: string | null;
  product_title_display: string | null;
  product_title: string | null;
  commerce_product_type: string | null;
}

/** The adapter's own expression for Product.category — kept identical on purpose. */
function specCategory(r: Row): string | undefined {
  const specs = r.specifications_json && typeof r.specifications_json === 'object'
    ? (r.specifications_json as Record<string, string>)
    : {};
  return specs['Category'] || r.category_code || undefined;
}

async function run(): Promise<void> {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('standardized_products')
      .select('supplier_product_id, category_label, category_code, specifications_json, optimized_title, product_title_display, product_title, commerce_product_type')
      .eq('published', true)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[syncCommerceTaxonomy] read failed: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  console.log(`[syncCommerceTaxonomy] published rows: ${rows.length}`);

  const classifiedAt = new Date().toISOString();
  let needsReview = 0;
  let changed = 0;

  const updates = rows.map((r) => {
    const name = resolveProductTitle(r);
    const c = classifyCommerce({ name, category: specCategory(r), categoryLabel: r.category_label ?? undefined });
    if (c.productType === NEEDS_REVIEW) needsReview++;
    if (r.commerce_product_type !== c.productType) changed++;
    return {
      supplier_product_id: r.supplier_product_id,
      commerce_department: c.department,
      commerce_category: c.category,
      commerce_product_type: c.productType,
      commerce_rooms: c.rooms,
      commerce_classified_at: classifiedAt,
    };
  });

  const pct = updates.length > 0 ? ((needsReview / updates.length) * 100).toFixed(1) : '0.0';
  console.log(`[syncCommerceTaxonomy] needs-review: ${needsReview} (${pct}%)  changed: ${changed}`);

  if (DRY_RUN) {
    console.log('[syncCommerceTaxonomy] DRY_RUN — no writes performed.');
    return;
  }

  // One statement per row rather than a bulk upsert: upsert on this table would
  // need every NOT NULL column present and would rewrite unrelated fields. These
  // are narrow updates that touch only the five taxonomy columns.
  let written = 0;
  for (const u of updates) {
    const { supplier_product_id, ...patch } = u;
    const { error } = await supabase
      .from('standardized_products')
      .update(patch)
      .eq('supplier_product_id', supplier_product_id);
    if (error) {
      console.error(`[syncCommerceTaxonomy] write failed for ${supplier_product_id}: ${error.message}`);
      process.exit(1);
    }
    written++;
    if (written % 100 === 0) console.log(`[syncCommerceTaxonomy]   ${written}/${updates.length}`);
  }

  console.log(`[syncCommerceTaxonomy] wrote ${written} row(s) at ${classifiedAt}`);
}

void run();
