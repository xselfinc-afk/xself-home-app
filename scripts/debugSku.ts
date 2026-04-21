/**
 * Trace N725P188461K through family dedupe and slice position.
 * Run: npx tsx scripts/debugSku.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SKU = 'N725P188461K';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function run() {
  // Fetch all is_new_arrival=true products in the same order as the app
  const { data, error } = await supabase
    .from('standardized_products')
    .select('supplier_product_id, product_title, is_new_arrival, primary_image, gallery_images_json, product_family_key')
    .eq('normalization_status', 'done')
    .order('created_at', { ascending: false });

  if (error || !data) { console.error('Query error:', error?.message); return; }

  // Simulate the app's withImages + family dedupe + newArrivals slice
  type Row = { supplier_product_id: string; product_title: string; is_new_arrival: boolean; primary_image: string | null; gallery_images_json: string[]; product_family_key: string };

  const allRows = data as Row[];

  // withImages equivalent
  const withImages = allRows.filter(r => {
    const gallery = Array.isArray(r.gallery_images_json) ? r.gallery_images_json : [];
    const imgs = r.primary_image ? [r.primary_image, ...gallery] : gallery;
    return imgs.length > 0;
  });

  // family dedupe (same logic as app)
  const familySeen = new Map<string, string>();
  const deduped: Row[] = [];
  for (const r of withImages) {
    const key = r.product_family_key || r.supplier_product_id;
    if (!familySeen.has(key)) {
      familySeen.set(key, r.supplier_product_id);
      deduped.push(r);
    }
  }

  // newArrivals pool (before slice)
  const newArrivalsPool = deduped.filter(r => r.is_new_arrival);

  // Find target SKU
  const targetPos = newArrivalsPool.findIndex(r => r.supplier_product_id === SKU);
  const familyKey = allRows.find(r => r.supplier_product_id === SKU)?.product_family_key ?? 'N/A';

  console.log('\n=== FAMILY DEDUPE ANALYSIS ===');
  console.log('  product_family_key:', familyKey);
  // Check if another product claimed this family key before N725P188461K
  const familyWinner = familySeen.get(familyKey);
  if (familyWinner && familyWinner !== SKU) {
    console.log(`  DEDUPED OUT — family key "${familyKey}" already claimed by: ${familyWinner}`);
  } else if (!familyWinner) {
    console.log('  NOT IN withImages pool at all');
  } else {
    console.log('  Passed family dedupe — this SKU IS the family representative');
  }

  console.log('\n=== SLICE POSITION ANALYSIS ===');
  console.log('  newArrivalsPool size (before slice):', newArrivalsPool.length);
  console.log('  slice limit:', 15);
  if (targetPos === -1) {
    console.log(`  ${SKU}: NOT in newArrivalsPool (removed by family dedupe)`);
  } else {
    console.log(`  ${SKU}: position ${targetPos} in pool → ${targetPos < 15 ? 'WITHIN slice(0,15) — SHOULD RENDER' : 'CUT BY SLICE — position >= 15'}`);
  }

  console.log('\n=== FIRST 20 IN newArrivalsPool ===');
  newArrivalsPool.slice(0, 20).forEach((r, i) => {
    const marker = r.supplier_product_id === SKU ? ' ← TARGET' : '';
    console.log(`  [${i}] ${r.supplier_product_id}${marker} | ${String(r.product_title).slice(0, 40)}`);
  });
}

run().catch(console.error);
