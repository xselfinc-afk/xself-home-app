/**
 * Probe: test the GIGA warehouse stock endpoint with multiple path/body variants.
 * Run: npx tsx scripts/probeWarehouseStock.ts
 *
 * Uses the same gigaRequest signing as all other working GIGA calls.
 * SKU comes from .env or override below.
 */

import 'dotenv/config';
import { gigaRequest } from '../src/services/gigaApiClient';

// Replace with a real GIGA native SKU from your DB
// (supplier_product_id from standardized_products, e.g. "W28209580")
const TEST_SKU = process.env.TEST_SKU ?? 'W28209580';

async function probe(label: string, path: string, body: Record<string, unknown>) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`PROBE: ${label}`);
  console.log(`PATH : ${path}`);
  console.log(`BODY : ${JSON.stringify(body)}`);
  console.log('-'.repeat(60));
  try {
    const res = await gigaRequest(path, body);
    console.log('SUCCESS — top-level keys:', Object.keys(res ?? {}));
    console.log('code:', res?.code, '| msg:', res?.msg);
    const items = res?.data?.records ?? res?.data?.list ?? res?.data ?? res?.data?.stockList;
    if (Array.isArray(items)) {
      console.log('Items count:', items.length);
      if (items.length > 0) {
        console.log('First item:', JSON.stringify(items[0]).slice(0, 400));
      }
    } else {
      console.log('data field:', JSON.stringify(res?.data).slice(0, 400));
    }
  } catch (err: any) {
    // gigaRequest throws on HTTP error or business error — print the raw message
    console.log('ERROR:', err.message?.slice(0, 600));
  }
}

async function run() {
  console.log(`\nProbing GIGA warehouse stock for SKU: ${TEST_SKU}`);
  console.log(`BASE_URL: ${process.env.SUPPLIER_API_BASE_URL}`);

  // ── Variant 1: current path, skus array ──────────────────────────────────────
  await probe(
    'Current: /stock/warehouseStock/v1 + {skus:[...]}',
    '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 2: skuList field instead of skus ─────────────────────────────────
  await probe(
    'skuList field: /stock/warehouseStock/v1 + {skuList:[...]}',
    '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1',
    { skuList: [TEST_SKU] },
  );

  // ── Variant 3: with pagination params ───────────────────────────────────────
  await probe(
    'With pagination: /stock/warehouseStock/v1 + {skus, pageNum, pageSize}',
    '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1',
    { skus: [TEST_SKU], pageNum: 1, pageSize: 20 },
  );

  // ── Variant 4: alternative path skuStock ────────────────────────────────────
  await probe(
    'Alt path: /stock/skuStock/v1 + {skus:[...]}',
    '/b2b-overseas-api/v1/buyer/stock/skuStock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 5: product-level stock path ─────────────────────────────────────
  await probe(
    'Alt path: /product/stock/v1 + {skus:[...]}',
    '/b2b-overseas-api/v1/buyer/product/stock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 6: inventory path ────────────────────────────────────────────────
  await probe(
    'Alt path: /inventory/warehouseStock/v1 + {skus:[...]}',
    '/b2b-overseas-api/v1/buyer/inventory/warehouseStock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 7: single sku string field ──────────────────────────────────────
  await probe(
    'Singular sku string: /stock/warehouseStock/v1 + {sku:"..."}',
    '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1',
    { sku: TEST_SKU },
  );

  // ── Variant 8: itemCode field ────────────────────────────────────────────────
  await probe(
    'itemCode field: /stock/warehouseStock/v1 + {itemCode:"..."}',
    '/b2b-overseas-api/v1/buyer/stock/warehouseStock/v1',
    { itemCode: TEST_SKU },
  );

  // ── Variant 9: product detail — has skuAvailable/stock/inventory fields ──────
  await probe(
    'Product detail (KNOWN WORKING) + {skus:[...]}',
    '/b2b-overseas-api/v1/buyer/product/detailInfo/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 10: non-overseas base path ───────────────────────────────────────
  await probe(
    'Alt prefix: /b2b-api/v1/buyer/stock/warehouseStock/v1',
    '/b2b-api/v1/buyer/stock/warehouseStock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 11: v2 path ──────────────────────────────────────────────────────
  await probe(
    'v2: /b2b-overseas-api/v2/buyer/stock/warehouseStock/v1',
    '/b2b-overseas-api/v2/buyer/stock/warehouseStock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 12: warehouse/stock subpath ──────────────────────────────────────
  await probe(
    'Alt subpath: /b2b-overseas-api/v1/buyer/warehouse/stock/v1',
    '/b2b-overseas-api/v1/buyer/warehouse/stock/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 13: stock/query ──────────────────────────────────────────────────
  await probe(
    'Alt subpath: /b2b-overseas-api/v1/buyer/stock/query/v1',
    '/b2b-overseas-api/v1/buyer/stock/query/v1',
    { skus: [TEST_SKU] },
  );

  // ── Variant 14: product/inventory ────────────────────────────────────────────
  await probe(
    'Alt subpath: /b2b-overseas-api/v1/buyer/product/inventory/v1',
    '/b2b-overseas-api/v1/buyer/product/inventory/v1',
    { skus: [TEST_SKU] },
  );

  console.log('\nDone.');
}

run().catch(console.error);
