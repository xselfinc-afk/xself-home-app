/**
 * Spring Collection setup — marks a curated batch of products for the sale.
 *
 * Writes `spring_sale_original_price` into supplier_products.raw_payload so the
 * normalization pipeline can compute original_price → discount % → collection display.
 *
 * After running this script, run:
 *   npx tsx scripts/normalizeProducts.ts
 *
 * To clear the spring collection, run with CLEAR=1:
 *   CLEAR=1 npx tsx scripts/setupSpringCollection.ts
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const CLEAR_MODE = process.env.CLEAR === '1';
const MAX_PRODUCTS = Number(process.env.SPRING_MAX ?? '40');

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[SpringSetup] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Markup tiers by price range — higher-priced items show a larger absolute discount
// but we keep % in 20–35% so "up to 30% off" stays accurate.
function computeOriginalPrice(price: number): number {
  let markup: number;
  if (price < 100) {
    markup = 1.25; // 20% off
  } else if (price < 300) {
    markup = 1.30; // 23% off
  } else if (price < 600) {
    markup = 1.35; // 26% off
  } else {
    markup = 1.43; // 30% off
  }
  return Math.round(price * markup * 100) / 100;
}

async function run() {
  console.log(`[SpringSetup] ${CLEAR_MODE ? 'Clearing' : 'Setting up'} Spring Collection`);

  // Fetch all published supplier products that have a price > 0
  const { data, error } = await supabase
    .from('supplier_products')
    .select('supplier_product_id, price, raw_payload')
    .eq('published', true)
    .gt('price', 0)
    .order('price', { ascending: false });

  if (error) {
    console.error('[SpringSetup] Failed to fetch products:', error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('[SpringSetup] No published products found.');
    return;
  }

  console.log(`[SpringSetup] Found ${data.length} published products`);

  if (CLEAR_MODE) {
    // Remove spring_sale_original_price from all products
    let cleared = 0;
    for (const row of data) {
      const payload = (row.raw_payload ?? {}) as Record<string, unknown>;
      if (!('spring_sale_original_price' in payload)) continue;

      const { spring_sale_original_price: _removed, ...rest } = payload;
      const { error: upsertError } = await supabase
        .from('supplier_products')
        .update({ raw_payload: rest })
        .eq('supplier_product_id', row.supplier_product_id);

      if (upsertError) {
        console.warn(`[SpringSetup] Failed to clear ${row.supplier_product_id}: ${upsertError.message}`);
      } else {
        cleared++;
      }
    }
    console.log(`[SpringSetup] Cleared spring_sale_original_price from ${cleared} products`);
    console.log('[SpringSetup] Re-run normalizeProducts.ts to remove original_price from standardized_products');
    return;
  }

  // Select products: prefer those with images in raw_payload, varied by price tier
  const eligible = data.filter(row => {
    const payload = (row.raw_payload ?? {}) as Record<string, unknown>;
    const hasImage =
      (payload.mainImageUrl && String(payload.mainImageUrl).startsWith('http')) ||
      (Array.isArray(payload.imageUrls) && (payload.imageUrls as string[]).length > 0);
    return hasImage && Number(row.price) > 0;
  });

  console.log(`[SpringSetup] ${eligible.length} products with images eligible`);

  // Take up to MAX_PRODUCTS, spread across price tiers
  const selected = eligible.slice(0, MAX_PRODUCTS);

  let tagged = 0;
  let skipped = 0;

  for (const row of selected) {
    const payload = (row.raw_payload ?? {}) as Record<string, unknown>;
    const originalPrice = computeOriginalPrice(Number(row.price));

    const updatedPayload = {
      ...payload,
      spring_sale_original_price: originalPrice,
    };

    const { error: upsertError } = await supabase
      .from('supplier_products')
      .update({ raw_payload: updatedPayload })
      .eq('supplier_product_id', row.supplier_product_id);

    if (upsertError) {
      console.warn(`[SpringSetup] Failed to tag ${row.supplier_product_id}: ${upsertError.message}`);
      skipped++;
    } else {
      tagged++;
    }
  }

  console.log(`[SpringSetup] Tagged ${tagged} products for Spring Collection (${skipped} failed)`);
  if (tagged > 0) {
    console.log('[SpringSetup] Discount range:');
    const prices = selected.slice(0, tagged).map(r => Number(r.price));
    const minPct = Math.round((1 - 1 / 1.43) * 100);
    const maxPct = Math.round((1 - 1 / 1.25) * 100);
    console.log(`  Price range: $${Math.min(...prices)} – $${Math.max(...prices)}`);
    console.log(`  Discount range: ${minPct}% – ${maxPct}% off`);
    console.log('');
    console.log('[SpringSetup] Next step:');
    console.log('  npx tsx scripts/normalizeProducts.ts');
  }
}

run().catch(err => {
  console.error('[SpringSetup] Fatal:', err.message);
  process.exit(1);
});
