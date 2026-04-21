/**
 * Sync supplier "New Arrivals" → supplier_products → standardized_products
 *
 * Usage:
 *   npx tsx scripts/syncNewArrivals.ts
 *
 * Flow:
 *   1. Fetch all pages of GIGA new arrivals (isNewArrival=true)
 *   2. Enrich with detail + price data
 *   3. Upsert into supplier_products (raw_payload includes isNewArrival=true)
 *   4. Normalize into standardized_products (assignNewArrival Tier 1 fires)
 *   5. Verify and log results
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { syncNewArrivalProducts } from '../src/services/supplierPickupService';
import { normalizeProduct } from '../src/services/normalizationPipeline';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[syncNewArrivals] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

if (!process.env.SUPPLIER_CLIENT_ID || !process.env.SUPPLIER_CLIENT_SECRET || !process.env.SUPPLIER_API_BASE_URL) {
  console.error('[syncNewArrivals] Missing supplier API credentials');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function run() {
  // ── Step 1-3: Sync new arrivals into supplier_products ─────────────────────
  console.log('\n=== STEP 1: Sync supplier new arrivals → supplier_products ===');
  const syncResult = await syncNewArrivalProducts(supabase);
  console.log(`Fetched: ${syncResult.fetched} | Upserted: ${syncResult.upserted}`);

  // ── Step 4: Normalize into standardized_products ───────────────────────────
  console.log('\n=== STEP 2: Normalize new arrivals → standardized_products ===');

  const { data: rawRows, error: fetchErr } = await supabase
    .from('supplier_products')
    .select('id, supplier_product_id, title, description, price, images, raw_payload')
    .order('updated_at', { ascending: false });

  if (fetchErr || !rawRows) {
    console.error('Failed to fetch supplier_products:', fetchErr?.message);
    process.exit(1);
  }

  // Only normalize rows that have isNewArrival=true in raw_payload
  const newArrivalRows = rawRows.filter((r: any) => {
    const raw = (r.raw_payload ?? {}) as Record<string, unknown>;
    return raw.isNewArrival === true;
  });

  console.log(`New arrival rows to normalize: ${newArrivalRows.length} / ${rawRows.length} total`);

  let normalizedCount = 0;
  let errorCount = 0;
  const BATCH = 20;

  for (let i = 0; i < newArrivalRows.length; i += BATCH) {
    const batch = newArrivalRows.slice(i, i + BATCH);
    const inserts = batch.flatMap((r: any) => {
      try {
        const insert = normalizeProduct({
          id: r.supplier_product_id ?? r.id,
          supplier_product_id: r.supplier_product_id,
          title: r.title,
          description: r.description,
          price: r.price,
          images: r.images,
          raw_payload: r.raw_payload,
        });
        return [insert];
      } catch (e: any) {
        console.warn(`Normalize failed for ${r.supplier_product_id}:`, e.message);
        errorCount += 1;
        return [];
      }
    });

    if (inserts.length === 0) continue;

    const { error } = await supabase
      .from('standardized_products')
      .upsert(inserts, { onConflict: 'supplier_product_id' });

    if (error) {
      console.error(`Batch ${i / BATCH + 1} upsert error:`, error.message);
    } else {
      normalizedCount += inserts.length;
      process.stdout.write(`  normalized ${normalizedCount}/${newArrivalRows.length}\r`);
    }
  }

  console.log(`\nNormalized: ${normalizedCount} | Errors: ${errorCount}`);

  // ── Step 5: Verification ───────────────────────────────────────────────────
  console.log('\n=== STEP 3: Verification ===');

  const { count: trueCount } = await supabase
    .from('standardized_products')
    .select('*', { count: 'exact', head: true })
    .eq('normalization_status', 'done')
    .eq('is_new_arrival', true);

  const { count: total } = await supabase
    .from('standardized_products')
    .select('*', { count: 'exact', head: true })
    .eq('normalization_status', 'done');

  console.log(`is_new_arrival=true: ${trueCount} / ${total} total`);

  const { data: samples } = await supabase
    .from('standardized_products')
    .select('supplier_product_id, product_title, is_new_arrival, new_arrival_source')
    .eq('is_new_arrival', true)
    .limit(10);

  console.log('\nSample new arrival products:');
  (samples ?? []).forEach((r: any, i: number) => {
    console.log(`  [${i}]`, {
      id: r.supplier_product_id,
      title: String(r.product_title).slice(0, 45),
      is_new_arrival: r.is_new_arrival,
      source: r.new_arrival_source,
    });
  });
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[syncNewArrivals] Failed:', err);
    process.exit(1);
  });
