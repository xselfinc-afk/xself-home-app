/**
 * GIGA API Diagnostic — discovers category filtering support and product field layout.
 *
 * Uses the same HMAC-signed gigaRequest client as all other working scripts.
 * No Playwright / browser required.
 *
 * Run:
 *   npx tsx scripts/debugGigaApi.ts
 *
 * Required (same as other scripts):
 *   SUPPLIER_API_BASE_URL, SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET
 *
 * Optional:
 *   TEST_SKU=W28209580   — override the first SKU used for detail probes
 *   OUTPUT_DIR           — where to save response samples (default: scripts/debug-output)
 */

import 'dotenv/config';
import { gigaRequest } from '../src/services/gigaApiClient';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ─────────────────────────────────────────────────────────────────────
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.join(process.cwd(), 'scripts', 'debug-output');
const OVERRIDE_SKU = process.env.TEST_SKU ?? '';

// ── Known API paths ────────────────────────────────────────────────────────────
const SKU_LIST_PATH = '/b2b-overseas-api/v1/buyer/product/skus/v1';
const DETAIL_PATH   = '/b2b-overseas-api/v1/buyer/product/detailInfo/v1';
const PRICE_PATH    = '/b2b-overseas-api/v1/buyer/product/price/v1';

// ── Helpers ────────────────────────────────────────────────────────────────────
function save(name: string, data: unknown): void {
  const p = path.join(OUTPUT_DIR, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`    [saved → ${name}]`);
}

function extractItems(res: any): any[] {
  if (!res) return [];
  const d = res.data;
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.records)) return d.records;
  if (d && Array.isArray(d.list))    return d.list;
  if (d && Array.isArray(d.data))    return d.data;
  return [];
}

function extractTotal(res: any): string {
  const d = res?.data;
  const t = d?.total ?? d?.totalCount ?? d?.totalNum ?? d?.total_count ?? '?';
  const p = d?.pages ?? d?.totalPages ?? d?.pageCount ?? '?';
  return `total=${t} pages=${p}`;
}

type ProbeResult = { success: boolean; items: any[]; res: any };

async function probe(
  label: string,
  apiPath: string,
  body: Record<string, unknown>,
  saveAs?: string,
): Promise<ProbeResult> {
  console.log(`\n  ┌─ ${label}`);
  console.log(`  │  body: ${JSON.stringify(body)}`);
  try {
    const res = await gigaRequest(apiPath, body);
    const items = extractItems(res);
    console.log(`  └─ ✓  ${extractTotal(res)}  items-this-page=${items.length}`);
    if (items.length > 0) {
      const keys = Object.keys(items[0]).join(', ');
      console.log(`       first-item-keys: ${keys.slice(0, 120)}`);
      console.log(`       first-item: ${JSON.stringify(items[0]).slice(0, 200)}`);
    }
    if (saveAs) save(saveAs, res);
    return { success: true, items, res };
  } catch (err: any) {
    const msg = err.message ?? '';
    let summary = msg.slice(0, 200);
    try {
      const j = JSON.parse(
        msg.replace('[GIGA BUSINESS ERROR] ', '').replace('[GIGA HTTP ERROR] ', ''),
      );
      summary = `code=${j.code ?? '?'} msg="${j.msg ?? j.message ?? ''}"`;
    } catch { /* use raw */ }
    console.log(`  └─ ✗  ${summary}`);
    return { success: false, items: [], res: null };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' GIGA API DIAGNOSTIC');
  console.log(`  BASE_URL  : ${process.env.SUPPLIER_API_BASE_URL}`);
  console.log(`  CLIENT_ID : ${process.env.SUPPLIER_CLIENT_ID}`);
  console.log(`  OUTPUT    : ${OUTPUT_DIR}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // ── SECTION 1: Category listing API ─────────────────────────────────────────
  console.log('\n\n╔══ SECTION 1: Category listing API ══════════════════════════╗');

  const CAT_PATHS = [
    '/b2b-overseas-api/v1/buyer/product/category/v1',
    '/b2b-overseas-api/v1/buyer/product/category/list/v1',
    '/b2b-overseas-api/v1/buyer/product/category/tree/v1',
    '/b2b-overseas-api/v1/buyer/goods/category/v1',
  ];

  let foundCategoryPath = '';
  let furnitureCategoryId = '';

  for (const catPath of CAT_PATHS) {
    const r = await probe(`GET ${catPath}`, catPath, {}, undefined);
    if (r.success) {
      foundCategoryPath = catPath;
      save('category-list.json', r.res);
      // Try to find a "Furniture" category
      const all: any[] = [];
      const walk = (items: any[]) => {
        for (const item of items) {
          all.push(item);
          if (item.children) walk(item.children);
          if (item.subCategories) walk(item.subCategories);
        }
      };
      walk(r.items.length > 0 ? r.items : [r.res?.data].filter(Boolean));
      const furniture = all.find((c: any) =>
        /furniture/i.test(c.categoryName ?? c.name ?? c.title ?? ''),
      );
      if (furniture) {
        furnitureCategoryId = String(furniture.categoryId ?? furniture.id ?? furniture.cid ?? '');
        console.log(`\n  → Found Furniture category: id=${furnitureCategoryId} name="${furniture.categoryName ?? furniture.name}"`);
      }
      break;
    }
  }

  // ── SECTION 2: SKU list baseline and category filter probes ─────────────────
  console.log('\n\n╔══ SECTION 2: SKU List Probes ════════════════════════════════╗');

  const baseline = await probe(
    'SKU list baseline (page 1, size 5)',
    SKU_LIST_PATH,
    { page: 1, pageSize: 5 },
    'sku-list-baseline.json',
  );

  // Collect a real SKU for downstream probes
  let firstSku = OVERRIDE_SKU;
  let firstCategoryId = '';
  if (baseline.success && baseline.items.length > 0) {
    const item = baseline.items[0];
    firstSku = firstSku || (item.sku ?? item.spuId ?? item.productId ?? item.itemCode ?? '');
    firstCategoryId = String(item.categoryId ?? item.cid ?? item.catId ?? '');
    console.log(`\n  → Discovered first SKU: "${firstSku}"  categoryId: "${firstCategoryId}"`);
  }

  // Category filter variants
  const catId = furnitureCategoryId || firstCategoryId;
  if (catId) {
    await probe(`SKU list + categoryId=${catId}`,   SKU_LIST_PATH, { page: 1, pageSize: 5, categoryId: catId });
    await probe(`SKU list + cid=${catId}`,          SKU_LIST_PATH, { page: 1, pageSize: 5, cid: catId });
    await probe(`SKU list + catId=${catId}`,        SKU_LIST_PATH, { page: 1, pageSize: 5, catId: catId });
  }
  await probe('SKU list + keyword=furniture',       SKU_LIST_PATH, { page: 1, pageSize: 5, keyword: 'furniture' });
  await probe('SKU list + category=Furniture',      SKU_LIST_PATH, { page: 1, pageSize: 5, category: 'Furniture' });

  // ── SECTION 3: Full count (page 1, large pageSize) ─────────────────────────
  console.log('\n\n╔══ SECTION 3: Total product count ════════════════════════════╗');
  const fullCount = await probe(
    'SKU list page 1 size 100',
    SKU_LIST_PATH,
    { page: 1, pageSize: 100 },
    'sku-list-page1-100.json',
  );
  if (fullCount.success) {
    const d = fullCount.res?.data;
    const total      = d?.total ?? d?.totalCount ?? d?.totalNum ?? '?';
    const totalPages = d?.pages ?? d?.totalPages ?? d?.pageCount ?? '?';
    console.log(`\n  ► Total SKUs in catalog: ${total}`);
    console.log(`  ► Total pages (pageSize=100): ${totalPages}`);
  }

  // ── SECTION 4: Detail + Price field layout ──────────────────────────────────
  console.log('\n\n╔══ SECTION 4: Product Detail Field Layout ═════════════════════╗');
  if (firstSku) {
    const detail = await probe(
      `detailInfo for "${firstSku}"`,
      DETAIL_PATH,
      { skus: [firstSku] },
      'detail-first-sku.json',
    );
    if (detail.success && detail.items.length > 0) {
      console.log('\n  ALL fields in detailInfo response:');
      const item = detail.items[0];
      for (const [k, v] of Object.entries(item)) {
        const preview = typeof v === 'object'
          ? JSON.stringify(v).slice(0, 100)
          : String(v).slice(0, 100);
        console.log(`    ${String(k).padEnd(25)} ${preview}`);
      }
    }

    const priceRes = await probe(
      `price/v1 for "${firstSku}"`,
      PRICE_PATH,
      { skus: [firstSku] },
      'price-first-sku.json',
    );
    if (priceRes.success && priceRes.items.length > 0) {
      console.log('\n  ALL fields in price response:');
      for (const [k, v] of Object.entries(priceRes.items[0])) {
        const preview = typeof v === 'object'
          ? JSON.stringify(v).slice(0, 100)
          : String(v).slice(0, 100);
        console.log(`    ${String(k).padEnd(25)} ${preview}`);
      }
    }
  } else {
    console.log('  ⚠ No SKU available — skipping detail probe. Set TEST_SKU= env var.');
  }

  // ── SECTION 5: Category field in SKU list items ─────────────────────────────
  console.log('\n\n╔══ SECTION 5: Category field analysis across first 20 SKUs ═══╗');
  if (baseline.success) {
    const page20 = await probe(
      'SKU list page 1 size 20 (category field inspection)',
      SKU_LIST_PATH,
      { page: 1, pageSize: 20 },
    );
    if (page20.success && page20.items.length > 0) {
      const categoryFields = ['categoryId', 'cid', 'catId', 'category', 'categoryName', 'categoryPath', 'cat'];
      const found: Record<string, Set<string>> = {};
      for (const item of page20.items) {
        for (const f of categoryFields) {
          if (item[f] !== undefined) {
            if (!found[f]) found[f] = new Set();
            found[f].add(String(item[f]).slice(0, 40));
          }
        }
      }
      if (Object.keys(found).length > 0) {
        console.log('\n  Category-related fields found in SKU list items:');
        for (const [f, vals] of Object.entries(found)) {
          console.log(`    ${f}: ${[...vals].slice(0, 5).join(', ')}`);
        }
      } else {
        console.log('\n  ⚠ No category fields found in SKU list items.');
        console.log('     The API may not expose category at the SKU list level.');
        console.log('     Will need detailInfo or category filter to identify Furniture SKUs.');
      }
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log(' SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(` Category API found       : ${foundCategoryPath || 'none'}`);
  console.log(` Furniture category ID    : ${furnitureCategoryId || 'not found'}`);
  console.log(` First discovered SKU     : ${firstSku || 'none'}`);
  console.log(` Output files             : ${OUTPUT_DIR}/`);
  console.log('');
  if (!firstSku) {
    console.log(' ⚠ BLOCKED: SKU list returned 0 items — check API credentials');
    console.log('   Verify SUPPLIER_API_BASE_URL, SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET in .env');
  } else {
    console.log(' ✓ API is reachable. Review saved JSON files for field names,');
    console.log('   then run: DRY_RUN=1 npx tsx scripts/syncGigaFurnitureCatalog.ts');
  }
  console.log('═══════════════════════════════════════════════════════════════\n');
}

run().catch(err => {
  console.error('[debugGigaApi] Fatal:', err.message);
  process.exit(1);
});
