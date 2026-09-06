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
import { classifyCommerce } from '../src/utils/commerceTaxonomy';
import { resolveProductTitle } from '../src/services/productResolvers';
import { resolveUniqueSkuCustom } from '../src/services/specFormatter';

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

  // ── 人工对外色名（product_variant_color_names）────────────────────────────────
  // 同一型号里供应商粗色名相同、实际是不同颜色的变体，由运营起不同的名字。这里读到的名字
  // 通过 row.variant_color_name 交给 normalizeProduct，最终落进 standardized_products.color /
  // specifications.Color / color_options_json。表不存在或读失败 → 当作没有人工色名，只打日志。
  const variantColorNames = new Map<string, string>();
  {
    let q = supabase.from('product_variant_color_names').select('supplier_product_id, color_name').is('revoked_at', null);
    if (ONLY_SKUS.length) q = q.in('supplier_product_id', ONLY_SKUS);
    const { data: nameRows, error: nameErr } = await q;
    if (nameErr) console.warn(`[normalizeProducts] variant color names unavailable (${nameErr.message}) — proceeding without manual colour names`);
    for (const r of nameRows ?? []) if (r.supplier_product_id && r.color_name) variantColorNames.set(String(r.supplier_product_id), String(r.color_name));
    if (variantColorNames.size) console.log(`[normalizeProducts] manual variant colour names: ${variantColorNames.size}`);
  }

  let upserted = 0;
  let failed = 0;
  let previewed = 0;
  const samples: Array<{ sku: string; title: string; category: string; price: number; img: string }> = [];

  // ── sku_custom identity resolution (SKU Identity Foundation) ────────────────
  // 1. Rerun stability: a supplier_product_id that already has a stored sku_custom
  //    KEEPS it verbatim — normalization reruns must never change a published code.
  // 2. Uniqueness: new codes walk resolveUniqueSkuCustom's deterministic candidate
  //    sequence against every code already taken; the DB UNIQUE constraint backstops.
  const { data: skuRows, error: skuErr } = await supabase
    .from('standardized_products')
    .select('supplier_product_id, sku_custom');
  if (skuErr) {
    console.error('[normalizeProducts] sku_custom preload failed — aborting to avoid collisions:', skuErr.message);
    process.exit(1);
  }
  const existingSkuById = new Map<string, string>();
  const takenSku = new Map<string, string>(); // sku_custom -> owner supplier_product_id
  for (const r of skuRows ?? []) {
    if (r.sku_custom) {
      existingSkuById.set(r.supplier_product_id, r.sku_custom);
      takenSku.set(r.sku_custom, r.supplier_product_id);
    }
  }
  const finalizeSkuIdentity = <T extends { supplier_product_id: string; sku_custom: string; sku_search: string }>(row: T): T => {
    const id = row.supplier_product_id;
    const kept = existingSkuById.get(id);
    const finalSku = kept ?? resolveUniqueSkuCustom(
      row.sku_custom.split('-').slice(0, 4).join('-'), // XH-CC-SC-LAST6 base
      id,
      takenSku,
    );
    takenSku.set(finalSku, id);
    row.sku_custom = finalSku;
    row.sku_search = finalSku.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return row;
  };

  for (let i = 0; i < data.length; i += BATCH_SIZE) {
    const batch = data.slice(i, i + BATCH_SIZE);

    const normalized = batch.flatMap(row => {
      try {
        return [normalizeProduct({ ...(row as any), variant_color_name: variantColorNames.get(String(row.supplier_product_id)) ?? null })];
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
    //
    // The commerce classification is attached in the same upsert as the row it
    // describes, so a standardized product cannot exist unclassified. That
    // matters because the website browses on these columns: a product written
    // here without them is invisible on the web until a sweep catches up.
    //
    // Inputs mirror `adaptStandardizedRow` exactly — see scripts/syncCommerceTaxonomy.ts,
    // which is the batch equivalent of this and the backstop for rows written by
    // any other path.
    const classifiedAt = new Date().toISOString();
    const upsertRows = normalized.map(({ new_arrival_added_at: _dropped, ...rest }) => {
      const commerce = classifyCommerce({
        name: resolveProductTitle(rest),
        category: rest.specifications_json?.['Category'] || rest.category_code || undefined,
        categoryLabel: rest.category_label || undefined,
      });
      return finalizeSkuIdentity({
        ...rest,
        commerce_department: commerce.department,
        commerce_category: commerce.category,
        commerce_product_type: commerce.productType,
        commerce_rooms: commerce.rooms,
        commerce_classified_at: classifiedAt,
      });
    });

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
