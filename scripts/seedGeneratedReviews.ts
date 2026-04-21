/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 *
 * Seed generated reviews into product_reviews for cold-start coverage.
 *
 * Reads all rows from standardized_products, generates a deterministic
 * 5-review set per product, and upserts into product_reviews.
 *
 * Generated reviews are tagged:
 *   review_source = 'generated'  |  is_generated = true  |  display_priority >= 500
 *
 * Phase-out path: filter WHERE is_generated = false once real reviews arrive.
 *
 * Usage:
 *   npx tsx scripts/seedGeneratedReviews.ts
 *
 * Flags:
 *   --dry-run    Print what would be upserted, no writes
 *   --limit N    Process only the first N products
 *
 * Required env vars (in .env at project root):
 *   SUPABASE_URL              — https://<id>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  generateReviewSet,
  type ReviewableProduct,
  type GeneratedReview,
} from '../src/services/reviewGenerator';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[seedReviews] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : undefined;

const BATCH_SIZE = 50;

// ── product_reviews row shape ─────────────────────────────────────────────────

type ReviewRow = GeneratedReview & {
  created_at?: string;
};

function toRow(r: GeneratedReview): ReviewRow {
  return { ...r, created_at: new Date().toISOString() };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`[seedReviews] Starting${DRY_RUN ? ' (dry run)' : ''}...`);

  let query = supabase
    .from('standardized_products')
    .select(
      'supplier_product_id, product_title, product_title_display, ' +
      'category_code, key_features_json, short_description, ' +
      'material, dimensions, color, product_family_key, specifications_json',
    )
    .order('supplier_product_id', { ascending: true });

  if (LIMIT) query = query.limit(LIMIT);

  const { data, error } = await query;

  if (error) {
    console.error('[seedReviews] Failed to fetch standardized_products:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('[seedReviews] No products found — nothing to do');
    return;
  }

  console.log(`[seedReviews] Generating reviews for ${data.length} products`);

  let seeded = 0;
  let failed = 0;

  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE) as unknown as ReviewableProduct[];

    const rows: ReviewRow[] = batch.flatMap(product => {
      try {
        return generateReviewSet(product).map(toRow);
      } catch (err) {
        console.warn(
          `[seedReviews] Skipped ${product.supplier_product_id}: ${(err as Error).message}`,
        );
        failed++;
        return [];
      }
    });

    if (DRY_RUN) {
      rows.forEach(r =>
        console.log(
          `  [dry] ${r.supplier_product_id}  ${r.rating}★  "${r.title}"`,
        ),
      );
      seeded += rows.length;
      continue;
    }

    const { error: upsertError } = await supabase
      .from('product_reviews')
      .upsert(rows, {
        onConflict: 'supplier_product_id,reviewer_name',
        ignoreDuplicates: false,
      });

    if (upsertError) {
      console.error(`[seedReviews] Upsert error on batch ${i / BATCH_SIZE + 1}:`, upsertError.message);
      failed += batch.length * 5;
    } else {
      seeded += rows.length;
    }

    if ((i / BATCH_SIZE + 1) % 5 === 0) {
      console.log(`[seedReviews]  ... ${i + batch.length} / ${data.length} products processed`);
    }
  }

  console.log(
    `[seedReviews] Done. ${seeded} reviews ${DRY_RUN ? 'would be ' : ''}seeded` +
    (failed > 0 ? `, ${failed} skipped due to errors` : ''),
  );
}

run().catch(err => {
  console.error('[seedReviews] Unexpected error:', err);
  process.exit(1);
});
