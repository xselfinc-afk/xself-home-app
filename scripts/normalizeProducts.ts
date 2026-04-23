/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Normalization batch runner
 *
 * Reads all published supplier_products, runs normalizeProduct() on each,
 * and upserts the result into standardized_products.
 *
 * Usage:
 *   npx tsx scripts/normalizeProducts.ts
 *
 * Required env vars (in .env at project root):
 *   SUPABASE_URL              — https://<id>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (bypasses RLS)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeProduct } from '../src/services/normalizationPipeline';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[normalizeProducts] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Service-role client — bypasses RLS, server-side only
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const BATCH_SIZE = 50;

async function run() {
  console.log('[normalizeProducts] Starting normalization run');

  // Fetch all published supplier products
  const { data, error } = await supabase
    .from('supplier_products')
    .select('id, supplier_product_id, title, images, price, description, raw_payload')
    .eq('published', true)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[normalizeProducts] Failed to fetch supplier_products:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('[normalizeProducts] No published products found — nothing to do');
    return;
  }

  console.log(`[normalizeProducts] Processing ${data.length} products in batches of ${BATCH_SIZE}`);

  let upserted = 0;
  let failed = 0;

  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);

    const normalized = batch.flatMap(row => {
      try {
        return [normalizeProduct(row as any)];
      } catch (err) {
        console.warn(
          `[normalizeProducts] Skipping row ${row.id}: ${err instanceof Error ? err.message : err}`,
        );
        failed++;
        return [];
      }
    });

    if (normalized.length === 0) continue;

    // Strip columns that may not exist in older DB deployments.
    // Run: ALTER TABLE standardized_products ADD COLUMN IF NOT EXISTS new_arrival_added_at timestamptz;
    // to enable this field, then remove this strip.
    const upsertRows = normalized.map(({ new_arrival_added_at: _dropped, ...rest }) => rest);

    const { error: upsertError } = await supabase
      .from('standardized_products')
      .upsert(upsertRows, { onConflict: 'supplier_product_id' });

    if (upsertError) {
      console.error(`[normalizeProducts] Upsert failed for batch starting at ${i}:`, upsertError.message);
      failed += normalized.length;
    } else {
      upserted += normalized.length;
      console.log(`[normalizeProducts] Batch ${Math.floor(i / BATCH_SIZE) + 1}: upserted ${normalized.length}`);
    }
  }

  console.log(`[normalizeProducts] Done — upserted: ${upserted}, failed: ${failed}`);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[normalizeProducts] Unexpected error:', err);
    process.exit(1);
  });
