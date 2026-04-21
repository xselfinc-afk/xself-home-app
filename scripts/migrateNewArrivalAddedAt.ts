/**
 * Backfill new_arrival_added_at from supplier raw_payload.addedTime.
 *
 * PRE-REQUISITE — run this in Supabase SQL Editor first:
 *   ALTER TABLE standardized_products
 *     ADD COLUMN IF NOT EXISTS new_arrival_added_at timestamptz;
 *
 * Then run: npx tsx scripts/migrateNewArrivalAddedAt.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { normalizeProduct } from '../src/services/normalizationPipeline';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function run() {
  // ── 0. Guard: verify column exists ─────────────────────────────────────────
  const { error: colErr } = await supabase
    .from('standardized_products')
    .select('new_arrival_added_at')
    .limit(1);

  if (colErr) {
    console.error('\n❌  Column new_arrival_added_at does not exist yet.');
    console.error('    Run this in Supabase SQL Editor, then re-run this script:\n');
    console.error('    ALTER TABLE standardized_products');
    console.error('      ADD COLUMN IF NOT EXISTS new_arrival_added_at timestamptz;\n');
    process.exit(1);
  }
  console.log('✓  Column new_arrival_added_at exists\n');

  // ── 1. Fetch all supplier_products ─────────────────────────────────────────
  console.log('=== Fetching supplier_products ===');
  const { data: spRows, error: spErr } = await supabase
    .from('supplier_products')
    .select('supplier_product_id, title, description, price, images, raw_payload');

  if (spErr || !spRows) { console.error('Error:', spErr?.message); return; }

  const withAddedTime = (spRows as any[]).filter((r: any) => {
    const raw = (r.raw_payload ?? {}) as Record<string, unknown>;
    return !!raw.addedTime;
  });
  console.log(`  ${withAddedTime.length} / ${spRows.length} rows have addedTime`);

  // ── 2. Re-normalize and upsert full standardized row ───────────────────────
  console.log('\n=== Normalizing and upserting ===');
  let upserted = 0;
  let skipped = 0;
  let errors = 0;
  const BATCH = 20;

  for (let i = 0; i < withAddedTime.length; i += BATCH) {
    const batch = withAddedTime.slice(i, i + BATCH);
    const inserts = batch.flatMap((r: any) => {
      try {
        const insert = normalizeProduct({
          id: r.supplier_product_id,
          supplier_product_id: r.supplier_product_id,
          title: r.title,
          description: r.description,
          price: r.price,
          images: r.images,
          raw_payload: r.raw_payload,
        });
        if (!insert.new_arrival_added_at) { skipped++; return []; }
        return [insert];
      } catch (e: any) {
        errors++;
        return [];
      }
    });

    if (inserts.length === 0) continue;

    const { error } = await supabase
      .from('standardized_products')
      .upsert(inserts, { onConflict: 'supplier_product_id' });

    if (error) { console.error('Upsert error:', error.message); errors++; }
    else upserted += inserts.length;

    process.stdout.write(`  progress: ${upserted + skipped + errors}/${withAddedTime.length}\r`);
  }

  console.log(`\n  upserted: ${upserted} | skipped (no addedTime): ${skipped} | errors: ${errors}`);

  // ── 3. Verify ────────────────────────────────────────────────────────────────
  console.log('\n=== Verification ===');
  const { data: samples } = await supabase
    .from('standardized_products')
    .select('supplier_product_id, product_title, is_new_arrival, new_arrival_added_at')
    .eq('is_new_arrival', true)
    .not('new_arrival_added_at', 'is', null)
    .order('new_arrival_added_at', { ascending: false })
    .limit(10);

  console.log('\nTop 10 by new_arrival_added_at DESC:');
  (samples ?? []).forEach((r: any, i: number) => {
    console.log(`  [${i}] ${r.supplier_product_id} | ${String(r.product_title).slice(0, 40)} | ${r.new_arrival_added_at}`);
  });

  const { count: nullCount } = await supabase
    .from('standardized_products')
    .select('*', { count: 'exact', head: true })
    .eq('is_new_arrival', true)
    .is('new_arrival_added_at', null);

  const { count: totalNA } = await supabase
    .from('standardized_products')
    .select('*', { count: 'exact', head: true })
    .eq('is_new_arrival', true);

  console.log(`\n  is_new_arrival=true: ${totalNA}`);
  console.log(`  with new_arrival_added_at populated: ${(totalNA ?? 0) - (nullCount ?? 0)}`);
  console.log(`  still null: ${nullCount}`);
}

run().catch(console.error);
