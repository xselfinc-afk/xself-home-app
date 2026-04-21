/**
 * Backfill: set is_new_arrival=true for products normalized within the 45-day window.
 * Run: npx tsx scripts/debugNewArrivals.ts
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://erbimgfbztkzmpamzwky.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVyYmltZ2ZienRrem1wYW16d2t5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NjM3NjYwMCwiZXhwIjoyMDkxOTUyNjAwfQ.ySPE2uXaArFEBMX2Ok2d8N1acGjsXYE4sgivuronD-c',
);

async function run() {
  const cutoff = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  console.log('Backfill cutoff (45d ago):', cutoff);

  const { data, error } = await supabase
    .from('standardized_products')
    .update({ is_new_arrival: true, new_arrival_source: 'created_at' })
    .eq('normalization_status', 'done')
    .gte('created_at', cutoff)
    .select('supplier_product_id, product_title, created_at');

  if (error) {
    console.error('Backfill error:', error.message);
    return;
  }

  console.log('\nBackfill updated:', data?.length ?? 0, 'rows');
  (data ?? []).slice(0, 5).forEach((r: any) =>
    console.log(' ', r.supplier_product_id, '|', String(r.product_title).slice(0, 40)),
  );

  // Verify final distribution
  const { count: trueCount } = await supabase
    .from('standardized_products')
    .select('*', { count: 'exact', head: true })
    .eq('is_new_arrival', true);

  const { count: total } = await supabase
    .from('standardized_products')
    .select('*', { count: 'exact', head: true })
    .eq('normalization_status', 'done');

  console.log(`\nFinal: is_new_arrival=true: ${trueCount} / ${total}`);
}

run().catch(console.error);
