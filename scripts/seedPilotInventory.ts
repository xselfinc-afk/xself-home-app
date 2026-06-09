/**
 * seedPilotInventory.ts — SCOPED, gate-driving inventory seeder for a small
 * pilot set of supplier_product_ids.
 *
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │ Why this exists                                                          │
 *   ├──────────────────────────────────────────────────────────────────────────┤
 *   │ The 20 pilot SKUs were imported via the GIGA B2B API into                │
 *   │ supplier_products, NOT via the catalog scrape into giga_products. The     │
 *   │ website scraper (which writes the gate-driving `website_scrape`           │
 *   │ inventory_cache rows) is keyed off giga_products, so it never sees them;  │
 *   │ and syncInventoryFromOfficialApi writes `official_api` rows that          │
 *   │ refresh_product_inventory_status() ignores. This script bridges the gap   │
 *   │ for an explicit ONLY_SKUS set only.                                       │
 *   │                                                                           │
 *   │ It pulls REAL per-warehouse inventory from the GIGA Open API             │
 *   │ (inventory/quantity/v2) and writes inventory_cache rows as               │
 *   │ source_type='website_scrape' (the only source refresh counts), then      │
 *   │ calls refresh_product_inventory_status() for each pilot SKU. The         │
 *   │ raw_payload records the true provenance (official_api) so the rows are    │
 *   │ auditable / reversible.                                                   │
 *   │                                                                           │
 *   │ Safety:                                                                   │
 *   │  - ONLY_SKUS is REQUIRED — refuses to run unscoped.                       │
 *   │  - DRY_RUN defaults TRUE. Real writes require DRY_RUN=false or APPLY=1.   │
 *   │  - Touches only the requested SKUs (cache rows + per-SKU refresh).        │
 *   │  - Does NOT modify refresh_product_inventory_status, the official sync,   │
 *   │    or the sellable_products view.                                         │
 *   │  - Reversible:                                                            │
 *   │      DELETE FROM inventory_cache                                          │
 *   │       WHERE source_type='website_scrape'                                  │
 *   │         AND raw_payload->>'source_note' = 'official_api_pilot_seed';      │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Env (loaded: .env.giga-alt.local first, then .env.local):
 *   SUPPLIER_API_BASE_URL (openapi.gigab2b.com), SUPPLIER_CLIENT_ID, SUPPLIER_CLIENT_SECRET
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   DRY_RUN=1 ONLY_SKUS="sku1,sku2,..." npx tsx scripts/seedPilotInventory.ts   # preview (default)
 *   DRY_RUN=false ONLY_SKUS="..."       npx tsx scripts/seedPilotInventory.ts   # real write
 *   APPLY=1 ONLY_SKUS="..."             npx tsx scripts/seedPilotInventory.ts   # real write (alias)
 */

import { config as loadEnv } from 'dotenv';
import crypto from 'crypto';

loadEnv({ path: '.env.giga-alt.local' });
loadEnv({ path: '.env.local' });

const GIGA_BASE = process.env.SUPPLIER_API_BASE_URL ?? '';
const GIGA_CID  = process.env.SUPPLIER_CLIENT_ID ?? '';
const GIGA_SEC  = process.env.SUPPLIER_CLIENT_SECRET ?? '';
const SUPA_URL  = process.env.SUPABASE_URL ?? '';
const SUPA_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

const ONLY_SKUS = (process.env.ONLY_SKUS ?? '').split(',').map(s => s.trim()).filter(Boolean);
// Default safe: DRY_RUN unless explicitly disabled (DRY_RUN=false/0/no) or APPLY=1.
const DRY_RUN_RAW = (process.env.DRY_RUN ?? 'true').toLowerCase();
const APPLY = process.env.APPLY === '1';
const WANT_WRITE = APPLY || DRY_RUN_RAW === 'false' || DRY_RUN_RAW === '0' || DRY_RUN_RAW === 'no';
const DRY_RUN = !WANT_WRITE;

const ENDPOINT = '/b2b-overseas-api/v1/buyer/inventory/quantity/v2';

// ── Guards ──────────────────────────────────────────────────────────────────
if (ONLY_SKUS.length === 0) {
  console.error('[seed] REFUSING TO RUN: ONLY_SKUS is required (this script never runs unscoped).');
  process.exit(1);
}
if (!GIGA_BASE || !GIGA_CID || !GIGA_SEC) { console.error('[seed] missing GIGA creds (need .env.giga-alt.local)'); process.exit(1); }
if (!/openapi\.gigab2b\.com/.test(GIGA_BASE)) { console.error(`[seed] expected openapi.gigab2b.com host, got ${GIGA_BASE}`); process.exit(1); }
if (!SUPA_URL || !SUPA_KEY) { console.error('[seed] missing Supabase creds (need .env.local)'); process.exit(1); }

// ── GIGA HMAC (mirrors syncInventoryFromOfficialApi.ts) ──────────────────────
function gigaNonce(length = 10): string {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < length; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function gigaSign(apiPath: string, ts: string, nc: string): string {
  const msg = `${GIGA_CID}&${apiPath}&${ts}&${nc}`;
  const key = `${GIGA_CID}&${GIGA_SEC}&${nc}`;
  return Buffer.from(crypto.createHmac('sha256', key).update(msg).digest('hex'), 'utf8').toString('base64');
}
async function gigaPost(apiPath: string, body: Record<string, unknown>) {
  const ts = Date.now().toString();
  const nc = gigaNonce();
  const res = await fetch(`${GIGA_BASE}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'client-id': GIGA_CID, timestamp: ts, nonce: nc, sign: gigaSign(apiPath, ts, nc) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { http: res.status, json, text };
}

// ── Supabase REST helpers ────────────────────────────────────────────────────
const SB_HEADERS = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };

function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}
function supportsPickup(code: string): boolean { return warehouseState(code) === 'CA'; }

type StdRow = {
  supplier_product_id: string;
  normalization_status: string | null;
  selling_price: number | null;
  primary_image: string | null;
  primary_image_mirror_path: string | null;
  primary_image_blurhash: string | null;
  published: boolean | null;
  inventory_status: string | null;
  total_available_qty: number | null;
};

async function fetchStandardized(skus: string[]): Promise<Map<string, StdRow>> {
  const cols = 'supplier_product_id,normalization_status,selling_price,primary_image,primary_image_mirror_path,primary_image_blurhash,published,inventory_status,total_available_qty';
  const map = new Map<string, StdRow>();
  for (let i = 0; i < skus.length; i += 100) {
    const chunk = skus.slice(i, i + 100);
    const url = `${SUPA_URL}/rest/v1/standardized_products?select=${cols}&supplier_product_id=in.(${encodeURIComponent(chunk.join(','))})`;
    const res = await fetch(url, { headers: SB_HEADERS });
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(`standardized_products non-array: ${JSON.stringify(rows).slice(0, 200)}`);
    for (const r of rows) map.set(String(r.supplier_product_id), r as StdRow);
  }
  return map;
}

async function upsertInventoryRows(rows: Record<string, unknown>[]): Promise<{ http: number; preview: string }> {
  // merge-duplicates so a re-seed updates quantities for the same (product_id, warehouse_code).
  const res = await fetch(`${SUPA_URL}/rest/v1/inventory_cache?on_conflict=product_id,warehouse_code`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return { http: res.status, preview: (await res.text()).slice(0, 300) };
}

async function callRefresh(sku: string): Promise<{ http: number; preview: string }> {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/refresh_product_inventory_status`, {
    method: 'POST',
    headers: SB_HEADERS,
    body: JSON.stringify({ p_supplier_product_id: sku }),
  });
  return { http: res.status, preview: (await res.text()).slice(0, 200) };
}

// ── Main ────────────────────────────────────────────────────────────────────
interface ApiSkuRow {
  sku: string;
  sellerInventoryInfo: null | {
    sellerAvailableInventory: number;
    discountAvailableInventory?: number;
    sellerInventoryDistribution?: Array<{ warehouseCode: string; availableQtyMin: number; availableQtyMax: number }>;
    nextArrivalInventory?: unknown;
  };
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' PILOT INVENTORY SEEDER (scoped, gate-driving)');
  console.log(`  mode        : ${DRY_RUN ? 'DRY_RUN (no writes, no refresh)' : 'APPLY (writes + refresh)'}`);
  console.log(`  ONLY_SKUS   : ${ONLY_SKUS.length}`);
  console.log(`  GIGA host   : ${GIGA_BASE}`);
  console.log('═══════════════════════════════════════════════════════════════');

  // ── Validate the requested SKUs ─────────────────────────────────────────
  const std = await fetchStandardized(ONLY_SKUS);
  const valid: string[] = [];
  const invalid: Array<{ sku: string; reason: string }> = [];
  for (const sku of ONLY_SKUS) {
    const r = std.get(sku);
    if (!r) { invalid.push({ sku, reason: 'not in standardized_products' }); continue; }
    if (r.normalization_status !== 'done') { invalid.push({ sku, reason: `normalization_status=${r.normalization_status}` }); continue; }
    if (!(Number(r.selling_price) > 0)) { invalid.push({ sku, reason: 'selling_price<=0/null' }); continue; }
    if (!r.primary_image) { invalid.push({ sku, reason: 'no primary_image' }); continue; }
    if (!r.primary_image_mirror_path) { invalid.push({ sku, reason: 'no primary_image_mirror_path' }); continue; }
    if (!r.primary_image_blurhash) { invalid.push({ sku, reason: 'no primary_image_blurhash' }); continue; }
    valid.push(sku);
  }
  console.log(`[seed] validated: ${valid.length} ready, ${invalid.length} skipped`);
  if (invalid.length) {
    console.warn('[seed] ⚠ skipped SKUs:');
    for (const x of invalid) console.warn(`    - ${x.sku}: ${x.reason}`);
  }
  if (valid.length === 0) { console.error('[seed] no valid SKUs to process — exiting.'); process.exit(1); }

  // ── Pull real GIGA inventory for the valid SKUs (≤200 per call) ──────────
  const apiRows: ApiSkuRow[] = [];
  for (let i = 0; i < valid.length; i += 200) {
    const batch = valid.slice(i, i + 200);
    const { http, json, text } = await gigaPost(ENDPOINT, { skus: batch });
    if (http !== 200 || !json || json.success !== true) {
      console.error(`[seed] GIGA inventory fetch failed: HTTP ${http} ${(text ?? '').slice(0, 200)}`);
      process.exit(1);
    }
    apiRows.push(...(json.data ?? []));
  }

  // ── Build rows + per-SKU totals ──────────────────────────────────────────
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  const perSku = new Map<string, { warehouses: Array<{ code: string; min: number; max: number }>; total: number }>();

  for (const ar of apiRows) {
    const sii = ar.sellerInventoryInfo;
    const dist = sii?.sellerInventoryDistribution ?? [];
    const agg = { warehouses: [] as Array<{ code: string; min: number; max: number }>, total: 0 };
    for (const w of dist) {
      const minQ = Number(w.availableQtyMin);
      const maxQ = Number(w.availableQtyMax);
      agg.warehouses.push({ code: w.warehouseCode, min: minQ, max: maxQ });
      agg.total += Math.max(0, minQ);
      rows.push({
        product_id: ar.sku,
        supplier_product_id: ar.sku,
        warehouse_code: w.warehouseCode,
        warehouse_state: warehouseState(w.warehouseCode),
        warehouse_city: null,
        quantity: minQ,
        quantity_floor: minQ,
        quantity_raw: minQ === maxQ ? String(minQ) : `${minQ}-${maxQ}`,
        quantity_exact: minQ === maxQ,
        total_available: sii?.sellerAvailableInventory ?? null,
        is_available: maxQ > 0,
        supports_pickup: supportsPickup(w.warehouseCode),
        supports_shipping: true,
        last_synced_at: now,
        sync_status: 'ok',
        // Gate-driving source. Provenance recorded in raw_payload for audit/rollback.
        source_type: 'website_scrape',
        raw_payload: {
          source_note: 'official_api_pilot_seed',
          original_source_type: 'official_api',
          seeded_for: 'pilot_import_20',
          availableQtyMin: minQ,
          availableQtyMax: maxQ,
          sellerAvailableInventory: sii?.sellerAvailableInventory ?? null,
          nextArrivalInventory: sii?.nextArrivalInventory ?? null,
        },
      });
    }
    perSku.set(ar.sku, agg);
  }

  // ── Report per SKU ────────────────────────────────────────────────────────
  console.log('\n=== PER-SKU PLAN ===');
  console.log('SKU | cur_published | cur_inv_status | cur_qty | proposed_warehouses | proposed_total | would_visible | reason');
  for (const sku of valid) {
    const r = std.get(sku)!;
    const agg = perSku.get(sku) ?? { warehouses: [], total: 0 };
    const whStr = agg.warehouses.length ? agg.warehouses.map(w => `${w.code}:${w.min}${w.min === w.max ? '' : '-' + w.max}`).join(',') : '(none)';
    const wouldVisible = agg.total > 0;
    const reason = wouldVisible ? '' : (agg.warehouses.length === 0 ? 'no warehouse distribution (likely 0/future stock)' : 'all warehouses qty 0');
    console.log(`${sku} | ${r.published} | ${r.inventory_status} | ${r.total_available_qty} | ${whStr} | ${agg.total} | ${wouldVisible ? 'YES' : 'NO'} | ${reason}`);
  }

  const wouldVisibleCount = valid.filter(s => (perSku.get(s)?.total ?? 0) > 0).length;
  console.log(`\n[seed] rows built: ${rows.length} | SKUs that would become in_stock: ${wouldVisibleCount}/${valid.length}`);

  // ── Write (only when explicitly enabled) ─────────────────────────────────
  if (DRY_RUN) {
    console.log('\n[seed] DRY_RUN — NO inventory_cache writes, refresh_product_inventory_status NOT called.');
    console.log('[seed] Re-run with DRY_RUN=false (or APPLY=1) to apply.');
    return;
  }

  console.log('\n[seed] APPLY — upserting inventory_cache rows (source_type=website_scrape, pilot-seed payload) ...');
  for (let i = 0; i < rows.length; i += 500) {
    const { http, preview } = await upsertInventoryRows(rows.slice(i, i + 500));
    if (http >= 400) { console.error(`[seed] inventory_cache upsert failed HTTP ${http}: ${preview}`); process.exit(1); }
  }
  console.log(`[seed] upserted ${rows.length} inventory_cache row(s).`);

  console.log('[seed] calling refresh_product_inventory_status() for each pilot SKU ...');
  let refreshed = 0;
  for (const sku of valid) {
    const { http, preview } = await callRefresh(sku);
    if (http >= 400) { console.error(`[seed] refresh failed for ${sku} HTTP ${http}: ${preview}`); continue; }
    refreshed++;
  }
  console.log(`[seed] refreshed ${refreshed}/${valid.length} SKUs. Done.`);
}

main().catch(err => {
  console.error('[seed] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
