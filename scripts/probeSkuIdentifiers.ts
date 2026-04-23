/**
 * Probe: find the correct SKU identifier for GIGA warehouse stock API.
 * 1. Dumps all SKU-like fields from raw_payload for a real product
 * 2. Inspects sellerInfo from product detail API
 * 3. Probes warehouse stock endpoint with every possible identifier
 *
 * Run: npx tsx scripts/probeSkuIdentifiers.ts
 * Override SKU: TEST_SKU=SG000640AAL npx tsx scripts/probeSkuIdentifiers.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { gigaRequest } from '../src/services/gigaApiClient';

const TEST_SKU = process.env.TEST_SKU ?? 'W28209580';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const STOCK_PATH = '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1';

async function tryStock(label: string, body: Record<string, unknown>) {
  console.log(`\n  [TRY] ${label}`);
  console.log(`  body: ${JSON.stringify(body)}`);
  try {
    const res = await gigaRequest(STOCK_PATH, body);
    console.log(`  ✓ code=${res?.code} keys=${Object.keys(res?.data ?? {}).join(',')}`);
    console.log(`  data: ${JSON.stringify(res?.data).slice(0, 400)}`);
  } catch (err: any) {
    const msg = err.message ?? '';
    // Extract just code+msg from GIGA error
    try { const j = JSON.parse(msg.replace('[GIGA HTTP ERROR] ', '').replace('[GIGA BUSINESS ERROR] ', '')); console.log(`  ✗ code=${j.code} msg="${j.msg}"`); }
    catch { console.log(`  ✗ ${msg.slice(0, 200)}`); }
  }
}

async function run() {
  // ── Step 1: dump raw_payload SKU fields from DB ──────────────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log(`STEP 1: All SKU fields in raw_payload for ${TEST_SKU}`);
  console.log('='.repeat(60));

  const { data: spRows } = await supabase
    .from('supplier_products')
    .select('supplier_product_id, raw_payload')
    .eq('supplier_product_id', TEST_SKU)
    .limit(1);

  if (spRows && spRows.length > 0) {
    const row = spRows[0];
    const raw = (row.raw_payload ?? {}) as Record<string, unknown>;
    console.log('supplier_product_id:', row.supplier_product_id);
    const skuFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (/sku|item.*code|seller.*id|warehouse.*id|product.*id|ean|upc|mpn|barcode|gtin/i.test(k)) {
        skuFields[k] = v;
      }
    }
    console.log('SKU-like fields in raw_payload:', JSON.stringify(skuFields, null, 2));
    console.log('All raw_payload keys:', Object.keys(raw).join(', '));
  } else {
    console.log(`No supplier_products row found for ${TEST_SKU} — trying standardized_products`);
    const { data: stRows } = await supabase
      .from('standardized_products')
      .select('supplier_product_id, sku_custom, sku_search')
      .eq('supplier_product_id', TEST_SKU)
      .limit(1);
    console.log('standardized row:', JSON.stringify(stRows?.[0]));
  }

  // ── Step 2: inspect sellerInfo from product detail API ───────────────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('STEP 2: sellerInfo + all ID-like fields from detailInfo API');
  console.log('='.repeat(60));

  try {
    const detail = await gigaRequest('/b2b-overseas-api/v1/buyer/product/detailInfo/v1', { skus: [TEST_SKU] });
    const item = Array.isArray(detail?.data) ? detail.data[0] : detail?.data;
    console.log('sellerInfo:', JSON.stringify(item?.sellerInfo));
    console.log('sku:', item?.sku);
    console.log('mpn:', item?.mpn);
    console.log('upc:', item?.upc);
    console.log('skuAvailable:', item?.skuAvailable);
    // Dump all string/number fields that look like IDs
    const idFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(item ?? {})) {
      if (/sku|item.*code|seller|warehouse|product.*id|ean|upc|mpn|barcode|gtin|code|id/i.test(k) && typeof v !== 'object') {
        idFields[k] = v;
      }
    }
    console.log('All ID-like fields:', JSON.stringify(idFields, null, 2));
  } catch (err: any) {
    console.log('detailInfo error:', err.message?.slice(0, 200));
  }

  // ── Step 3: probe warehouse stock with every possible identifier ─────────────
  console.log(`\n${'='.repeat(60)}`);
  console.log('STEP 3: Probe warehouse stock with all identifier variants');
  console.log('='.repeat(60));

  // Re-fetch identifiers for the probes
  let mpn = '';
  let upc = '';
  let sellerSkuValue = '';
  try {
    const detail = await gigaRequest('/b2b-overseas-api/v1/buyer/product/detailInfo/v1', { skus: [TEST_SKU] });
    const item = Array.isArray(detail?.data) ? detail.data[0] : detail?.data;
    mpn = item?.mpn ?? '';
    upc = item?.upc ?? '';
    const si = item?.sellerInfo ?? {};
    sellerSkuValue = si?.sellerSku ?? si?.itemCode ?? si?.warehouseSku ?? si?.platformSku ?? '';
    if (typeof item?.sellerInfo === 'object' && item.sellerInfo) {
      console.log('  sellerInfo keys:', Object.keys(item.sellerInfo).join(', '));
    }
  } catch { /* ignore */ }

  await tryStock('skus:[supplier_product_id]', { skus: [TEST_SKU] });
  if (mpn) await tryStock(`skus:[mpn="${mpn}"]`, { skus: [mpn] });
  if (upc) await tryStock(`skus:[upc="${upc}"]`, { skus: [upc] });
  if (sellerSkuValue) await tryStock(`skus:[sellerSku="${sellerSkuValue}"]`, { skus: [sellerSkuValue] });

  // Also try with itemCode / skuCode wrappers
  await tryStock('itemCodes:[supplier_product_id]', { itemCodes: [TEST_SKU] });
  await tryStock('itemCode:supplier_product_id (string)', { itemCode: TEST_SKU });
  if (mpn) await tryStock(`itemCode:mpn="${mpn}"`, { itemCode: mpn });

  // Try price endpoint to see if it returns stock data
  console.log(`\n${'='.repeat(60)}`);
  console.log('STEP 4: Check price API for any stock fields');
  console.log('='.repeat(60));
  try {
    const price = await gigaRequest('/b2b-overseas-api/v1/buyer/product/price/v1', { skus: [TEST_SKU] });
    const item = Array.isArray(price?.data) ? price.data[0] : price?.data;
    console.log('price API keys:', Object.keys(item ?? {}).join(', '));
    console.log('price item:', JSON.stringify(item).slice(0, 500));
  } catch (err: any) {
    console.log('price API error:', err.message?.slice(0, 200));
  }

  console.log('\nDone.');
}

run().catch(console.error);
