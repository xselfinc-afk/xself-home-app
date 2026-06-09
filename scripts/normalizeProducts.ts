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

import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { normalizeProduct } from '../src/services/normalizationPipeline';

// Load .env.local first (canonical home for SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
// for scripts) then .env as fallback — matches the safe GIGA scripts so the runner
// doesn't need to source env files manually. dotenv does not override already-set
// vars, so .env.local wins. (normalizationPipeline is a pure transform and reads no
// env at module load, so simple top-level loading is safe here.)
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

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

// ── Scope controls ───────────────────────────────────────────────────────────
// ONLY_SKUS="sku1,sku2" → normalize only those published supplier_product_ids.
//                          When absent, DEFAULT processes ALL published rows.
// DRY_RUN=1            → read + normalizeProduct() in memory, print a preview,
//                          write NOTHING to standardized_products.
const ONLY_SKUS = (process.env.ONLY_SKUS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN ?? '');

async function run() {
  const mode = DRY_RUN ? 'DRY_RUN (no writes)' : ONLY_SKUS.length ? 'ONLY_SKUS' : 'DEFAULT (all published)';
  console.log(`[normalizeProducts] Starting normalization run — mode: ${mode}`);
  if (ONLY_SKUS.length) {
    console.log(`[normalizeProducts] ONLY_SKUS: ${ONLY_SKUS.length} SKU(s) requested`);
  } else {
    console.warn('[normalizeProducts] ⚠ No ONLY_SKUS provided — DEFAULT mode processes ALL published supplier_products (re-normalizes existing live products).');
  }

  // Fetch published supplier products, optionally scoped to ONLY_SKUS.
  let query = supabase
    .from('supplier_products')
    .select('id, supplier_product_id, title, images, price, description, raw_payload')
    .eq('published', true)
    .order('created_at', { ascending: true });
  if (ONLY_SKUS.length) query = query.in('supplier_product_id', ONLY_SKUS);

  const { data, error } = await query;

  if (error) {
    console.error('[normalizeProducts] Failed to fetch supplier_products:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('[normalizeProducts] No matching published products found — nothing to do');
    return;
  }

  // Warn if some requested SKUs were not found among published rows.
  if (ONLY_SKUS.length) {
    const found = new Set(data.map(r => String(r.supplier_product_id)));
    const missing = ONLY_SKUS.filter(s => !found.has(s));
    if (missing.length) {
      console.warn(`[normalizeProducts] ⚠ ${missing.length} requested SKU(s) not found among published rows: ${missing.join(', ')}`);
    }
  }

  console.log(`[normalizeProducts] Selected ${data.length} published product(s)${ONLY_SKUS.length ? ' (scoped to ONLY_SKUS)' : ''}; batches of ${BATCH_SIZE}`);

  let upserted = 0;
  let failed = 0;
  let previewed = 0;
  const samples: Array<{ sku: string; title: string; category: string; price: number; img: string }> = [];

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

    // DRY_RUN: collect a preview, never write.
    if (DRY_RUN) {
      previewed += upsertRows.length;
      for (const n of normalized) {
        if (samples.length < 10) {
          samples.push({
            sku: n.supplier_product_id,
            title: n.product_title_display || n.product_title,
            category: n.category_label,
            price: n.price,
            img: n.primary_image ? 'Y' : 'N',
          });
        }
      }
      continue;
    }

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

  if (DRY_RUN) {
    console.log('[normalizeProducts] ── DRY_RUN preview (no database writes) ──');
    console.log(`[normalizeProducts]   supplier_products selected            : ${data.length}`);
    console.log(`[normalizeProducts]   normalized rows that WOULD be written : ${previewed}`);
    console.log(`[normalizeProducts]   transform failures                    : ${failed}`);
    console.log('[normalizeProducts]   sample rows (up to 10): sku | product_title_display | category_label | $price | img?');
    samples.forEach((s, i) => console.log(`[normalizeProducts]     ${i + 1}. ${s.sku} | ${String(s.title).slice(0, 45)} | ${s.category} | $${s.price} | img:${s.img}`));
    console.log('[normalizeProducts]   NO DB WRITES OCCURRED.');
    return;
  }

  console.log(`[normalizeProducts] Done — upserted: ${upserted}, failed: ${failed}`);
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[normalizeProducts] Unexpected error:', err);
    process.exit(1);
  });
