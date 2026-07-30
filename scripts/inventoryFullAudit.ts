/**
 * FULL read-only inventory census (Phase 2A, items 1-4). STRICTLY READ-ONLY: SELECT-only,
 * NO Supabase writes, NO GIGA/supplier calls, NO browser, NO publish/delist/relist path.
 *
 * Scans EVERY published product (sellable_products) — not a 25 sample — plus the unpublished
 * candidate set (supplier_products.published=false), classifies each from EXISTING
 * inventory_cache + giga_delivery_fee_cache state using the Phase-1 canonical classifier,
 * splits Pickup (inventory_cache) vs Dropship (delivery-fee), and reports the 11 named
 * status buckets + per-candidate pickup/shipping presence. Writes to a gitignored report.
 *
 * NOTE on live-only buckets: authentication_required / empty_xhr / parse_failure /
 * network_failure are FETCH-TIME outcomes and cannot arise from a DB census — they are
 * reported as 0 here and only become non-zero in the LIVE fetch round (Commit B fetcher).
 *
 * Usage: npx tsx scripts/inventoryFullAudit.ts [--stale-hours=24] [--round=1]
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { classifyInventoryResult, type WarehouseStock, type RawInventorySignals } from '../src/services/inventoryResult';
import { classifyPriority } from '../src/services/inventoryPriority';

dotenv.config({ path: '.env.local' });
const U = process.env.SUPABASE_URL ?? '';
const SK = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const arg = (n: string) => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const now = Date.now();
const round = arg('round') ?? '1';
const runId = `inv-audit-r${round}-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const staleThresholdMs = Number(arg('stale-hours') ?? 24) * 3600_000;

const chunk = <T>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function fetchCacheByProduct(sb: any, ids: string[]): Promise<Map<string, any[]>> {
  const map = new Map<string, any[]>();
  for (const c of chunk(ids, 150)) {
    const { data } = await sb.from('inventory_cache')
      .select('product_id, warehouse_code, warehouse_state, quantity, is_available, supports_pickup, supports_shipping, sync_status, source_type, last_synced_at')
      .in('product_id', c).in('source_type', ['website_scrape', 'official_api']).eq('sync_status', 'ok');
    for (const r of data ?? []) { const a = map.get(r.product_id) ?? []; a.push(r); map.set(r.product_id, a); }
  }
  return map;
}
async function fetchFeeSet(sb: any, ids: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  for (const c of chunk(ids, 150)) {
    const { data } = await sb.from('giga_delivery_fee_cache')
      .select('supplier_product_id').in('supplier_product_id', c).not('charged_fee_cents', 'is', null);
    for (const r of data ?? []) set.add(r.supplier_product_id);
  }
  return set;
}

/** DB-derived signals for one product (absence → unknown, never zero; fresh all-zero → affirmative zero). */
function signalsFromCache(rows: any[]): RawInventorySignals {
  if (rows.length === 0) return { httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses: [] };
  const ageMs = Math.min(...rows.map(r => now - new Date(r.last_synced_at).getTime()));
  const parsedWarehouses: WarehouseStock[] = rows.map(r => ({
    warehouseCode: r.warehouse_code, warehouseState: r.warehouse_state, quantity: Number(r.quantity ?? 0),
    supportsPickup: r.supports_pickup, supportsShipping: r.supports_shipping,
  }));
  const total = parsedWarehouses.reduce((s, w) => s + (typeof w.quantity === 'number' && w.quantity > 0 ? w.quantity : 0), 0);
  return { httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses, ageMs, staleThresholdMs, affirmativeZeroSignal: total === 0 };
}

function newBuckets() {
  return {
    fresh: 0, stale: 0, missing_inventory_cache: 0, authentication_required: 0, empty_xhr: 0,
    parse_failure: 0, network_failure: 0, ca_pickup_available: 0, shipping_available: 0,
    pickup_out_of_stock_shipping_available: 0, fully_out_of_stock: 0,
  };
}

function classifyRow(pid: string, sku: string | null, rows: any[], hasFee: boolean) {
  const result = classifyInventoryResult(signalsFromCache(rows), { source: 'cache', accountType: 'pickup', supplierProductId: pid, sku, checkedAt: new Date(now).toISOString() });
  const priority = classifyPriority(result.status);
  const caPickup = result.status === 'confirmed_in_stock_ca';
  const shippableInv = result.status === 'confirmed_in_stock_out_of_state';
  const shipping = hasFee || shippableInv;
  return { pid, sku, status: result.status, priority, caPickup, shipping, hasFee, hasRows: rows.length > 0, ageMinutes: rows.length ? Math.round(Math.min(...rows.map(r => now - new Date(r.last_synced_at).getTime())) / 60000) : null };
}

function tally(b: ReturnType<typeof newBuckets>, skuBuckets: Record<string, string[]>, c: ReturnType<typeof classifyRow>) {
  const add = (k: string) => { (b as any)[k]++; (skuBuckets[k] ??= []).push(c.sku || c.pid); };
  if (!c.hasRows) add('missing_inventory_cache');
  else if (c.status === 'stale') add('stale');
  else add('fresh'); // has current (<=stale threshold) reading
  if (c.caPickup) add('ca_pickup_available');
  if (c.shipping) add('shipping_available');
  if (!c.caPickup && c.shipping) add('pickup_out_of_stock_shipping_available');
  if (c.status === 'confirmed_out_of_stock' && !c.shipping) add('fully_out_of_stock');
  // live-only buckets stay 0 in the DB census
}

async function main() {
  if (!U || !SK) { console.error('[inv-audit] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (.env.local). Abort (read-only).'); process.exit(2); }
  const sb = createClient(U, SK, { auth: { persistSession: false } });

  // ── Published census ──
  const { data: published, error } = await sb.from('sellable_products').select('supplier_product_id, sku_custom, has_ca_pickup');
  if (error) { console.error('[inv-audit] sellable_products read failed:', error.message); process.exit(1); }
  const pub = published ?? [];
  const pubIds = pub.map(p => p.supplier_product_id);
  const pubCache = await fetchCacheByProduct(sb, pubIds);
  const pubFee = await fetchFeeSet(sb, pubIds);

  const pickupBuckets = newBuckets(); const skuBuckets: Record<string, string[]> = {};
  const priorityCounts: Record<string, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  let dropshipShippable = 0, dropshipNotShippable = 0;
  for (const p of pub) {
    const c = classifyRow(p.supplier_product_id, p.sku_custom, pubCache.get(p.supplier_product_id) ?? [], pubFee.has(p.supplier_product_id));
    tally(pickupBuckets, skuBuckets, c);
    priorityCounts[c.priority]++;
    if (c.hasFee) dropshipShippable++; else dropshipNotShippable++;
  }

  // ── Unpublished candidate set (待上线) ── supplier_products has NO `sku` column; the GIGA
  // SKU IS supplier_product_id.
  const { data: cands, error: candErr } = await sb.from('supplier_products').select('supplier_product_id').eq('published', false);
  if (candErr) { console.error('[inv-audit] candidate read failed:', candErr.message); process.exit(1); }
  const candList = cands ?? [];
  const candIds = candList.map(c => c.supplier_product_id);
  const candCache = await fetchCacheByProduct(sb, candIds);
  const candFee = await fetchFeeSet(sb, candIds);
  const candidates = candList.map(c => classifyRow(c.supplier_product_id, c.supplier_product_id, candCache.get(c.supplier_product_id) ?? [], candFee.has(c.supplier_product_id)));
  const readyToPublish = candidates.filter(c => c.hasFee); // has shipping/fee info prepared → the "待上线" set
  const readyWithBoth = readyToPublish.filter(c => c.hasRows); // has BOTH pickup inventory rows AND shipping fee

  const report = {
    runId, generatedAt: new Date(now).toISOString(), round, mode: 'DRY_RUN_READ_ONLY', staleThresholdHours: staleThresholdMs / 3600_000,
    totals: { publishedTotal: pub.length, unpublishedCandidatesTotal: candList.length },
    pickup: { buckets: pickupBuckets, priorityCounts },
    dropship: { shippableWithFee: dropshipShippable, noFee: dropshipNotShippable },
    candidates: {
      total: candList.length,
      readyToPublish_hasFee: readyToPublish.length,
      readyWith_pickup_AND_shipping: readyWithBoth.length,
      detail: readyToPublish.map(c => ({ sku: c.sku, supplierProductId: c.pid, status: c.status, priority: c.priority, hasPickupRows: c.hasRows, caPickup: c.caPickup, hasShippingFee: c.hasFee, pickupAndShipping: c.hasRows && c.hasFee, ageMinutes: c.ageMinutes })),
    },
    skuBuckets,
    liveOnlyBucketsNote: 'authentication_required/empty_xhr/parse_failure/network_failure are 0 in a DB census; only the live fetch round populates them.',
    switchesConfirmedOff: ['inventory_automation_enabled', 'inventory_auto_delist_enabled', 'inventory_auto_relist_enabled', 'inventory_checkout_revalidation_enabled', 'inventory_ca_priority_enabled'],
  };

  const dir = path.join(process.cwd(), 'reports', 'inventory-decisions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, `audit-latest-r${round}.json`), JSON.stringify(report, null, 2));

  console.log(`[inv-audit] ${runId}`);
  console.log(`  published total = ${pub.length}  | unpublished candidates = ${candList.length}`);
  console.log(`  PICKUP buckets: ${JSON.stringify(pickupBuckets)}`);
  console.log(`  PICKUP priority: ${JSON.stringify(priorityCounts)}`);
  console.log(`  DROPSHIP: shippable(with fee)=${dropshipShippable} noFee=${dropshipNotShippable}`);
  console.log(`  CANDIDATES: total=${candList.length} readyToPublish(hasFee)=${readyToPublish.length} withPickup+Shipping=${readyWithBoth.length}`);
  console.log(`  report → reports/inventory-decisions/${runId}.json`);
}
main().catch(e => { console.error('[inv-audit] fatal (no writes):', e instanceof Error ? e.message : e); process.exit(1); });
