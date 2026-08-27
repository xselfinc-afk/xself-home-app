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
 * This is the batch backstop, not the primary path. `scripts/normalizeProducts.ts`
 * attaches the same classification in the same upsert that creates the row, so a
 * normally-onboarded product is classified the moment it exists. This job exists
 * to catch rows written by any other path (manual upload, direct edits) and to
 * re-run the whole catalogue after a classifier change.
 *
 * Run:
 *   npx tsx scripts/syncCommerceTaxonomy.ts            # incremental: unclassified rows only
 *   FULL=1 npx tsx scripts/syncCommerceTaxonomy.ts     # every published row (after a classifier change)
 *   DRY_RUN=1 npx tsx scripts/syncCommerceTaxonomy.ts  # report only, no writes
 *
 * Incremental is the default because this runs on every availability-scan cycle.
 * A full pass rewrites 385 rows one statement at a time; an incremental pass on a
 * caught-up catalogue writes nothing and costs one select.
 *
 * Exit codes: 0 = ok (including "nothing to do"), 1 = read/write failure.
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
const FULL = process.env.FULL === '1';

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
    let q = supabase
      .from('standardized_products')
      .select('supplier_product_id, category_label, category_code, specifications_json, optimized_title, product_title_display, product_title, commerce_product_type')
      .eq('published', true);
    // Incremental: only rows that have never been classified. A row whose title or
    // category later changes is re-classified by normalizeProducts on its next pass,
    // which rewrites the columns in the same upsert.
    if (!FULL) q = q.is('commerce_classified_at', null);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) {
      console.error(`[syncCommerceTaxonomy] read failed: ${error.message}`);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  console.log(`[syncCommerceTaxonomy] mode=${FULL ? 'full' : 'incremental'} rows: ${rows.length}`);
  if (rows.length === 0) {
    console.log('[syncCommerceTaxonomy] nothing to classify — catalogue is current.');
    return;
  }

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
