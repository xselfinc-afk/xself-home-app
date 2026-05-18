/**
 * Batch sync of GIGA per-warehouse inventory into Supabase.
 *
 * Pipeline:
 *   1. Read `sellable_products.supplier_product_id` from Supabase.
 *   2. For each SKU resolve the GIGA numeric product_id via search.
 *   3. Fetch real warehouse rows from
 *      /product/info/price/warehouse&product_id=<numeric> (XHR discovered via
 *      scripts/discoverGigaWarehouseXhr.ts).
 *   4. Upsert one row per warehouse into inventory_cache (source_type =
 *      'website_scrape', sync_status = 'ok', quantity_exact = true).
 *   5. Call refresh_product_inventory_status(supplier_product_id) so the
 *      sellable_products view picks up the new aggregate immediately.
 *   6. Run verifyInventoryFreshness at the end (skip with VERIFY_AFTER=0).
 *
 * Run (dry, 5 products, no DB writes):
 *   DRY_RUN=1 INVENTORY_LIMIT=5 npx tsx scripts/syncGigaInventoryXhr.ts
 *
 * Run (full):
 *   npx tsx scripts/syncGigaInventoryXhr.ts
 *
 * Env:
 *   SUPABASE_URL                — required
 *   SUPABASE_SERVICE_ROLE_KEY   — required
 *   GIGA_SESSION_FILE           — Playwright storageState (default scripts/.giga-session.json)
 *   INVENTORY_LIMIT             — max products per run (default: all)
 *   PRODUCT_IDS                 — comma-separated supplier_product_id values
 *                                 (overrides Supabase read; useful for spot-fix)
 *   PRODUCT_FILTER              — 'sellable' (default) | 'all_furniture'
 *   INTER_REQ_DELAY             — ms between products (default 600)
 *   DRY_RUN=1                   — skip Supabase writes
 *   VERIFY_AFTER=0              — skip post-sync freshness check
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  resolveProductId,
  fetchWarehouseRows,
  NormalizedRow,
} from './fetchGigaWarehouseInventoryFromXhr';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const INVENTORY_LIMIT = process.env.INVENTORY_LIMIT
  ? parseInt(process.env.INVENTORY_LIMIT, 10)
  : Infinity;
const PRODUCT_FILTER  = (process.env.PRODUCT_FILTER ?? 'sellable') as 'sellable' | 'all_furniture';
const INTER_REQ_DELAY = Number(process.env.INTER_REQ_DELAY ?? 600);
const DRY_RUN = process.env.DRY_RUN === '1';
const VERIFY_AFTER = process.env.VERIFY_AFTER !== '0';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[syncXhr] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

async function loadTargetSkus(supabase: SupabaseClient): Promise<string[]> {
  if (process.env.PRODUCT_IDS) {
    return process.env.PRODUCT_IDS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (PRODUCT_FILTER === 'all_furniture') {
    const { data, error } = await supabase
      .from('giga_products')
      .select('product_id')
      .eq('top_category', 'Furniture')
      .order('last_synced_at', { ascending: false });
    if (error) throw new Error(`giga_products: ${error.message}`);
    return (data ?? []).map(r => String(r.product_id));
  }
  const { data, error } = await supabase
    .from('sellable_products')
    .select('supplier_product_id');
  if (error) throw new Error(`sellable_products: ${error.message}`);
  return (data ?? []).map(r => String(r.supplier_product_id));
}

async function upsertRows(supabase: SupabaseClient, rows: NormalizedRow[]): Promise<{ written: number; error: string | null }> {
  if (rows.length === 0) return { written: 0, error: null };
  const { error } = await supabase
    .from('inventory_cache')
    .upsert(rows.map(r => ({
      product_id:          r.product_id,
      supplier_product_id: r.supplier_product_id,
      warehouse_code:      r.warehouse_code,
      warehouse_state:     r.warehouse_state,
      quantity:            r.quantity,
      quantity_floor:      r.quantity,
      quantity_raw:        r.quantity_raw,
      quantity_exact:      r.quantity_exact,
      total_available:     r.total_available,
      is_available:        r.is_available,
      supports_pickup:     r.supports_pickup,
      supports_shipping:   r.supports_shipping,
      last_synced_at:      r.last_synced_at,
      sync_status:         r.sync_status,
      source_type:         r.source_type,
    })), { onConflict: 'product_id,warehouse_code' });
  if (error) return { written: 0, error: error.message };
  return { written: rows.length, error: null };
}

async function refreshStatus(supabase: SupabaseClient, supplierId: string): Promise<void> {
  const { error } = await supabase.rpc('refresh_product_inventory_status', {
    p_supplier_product_id: supplierId,
  });
  if (error) console.warn(`   ⚠ refresh_product_inventory_status(${supplierId}) failed: ${error.message}`);
}

async function verifyFreshness(supabase: SupabaseClient): Promise<boolean> {
  const { data: newest } = await supabase
    .from('inventory_cache')
    .select('last_synced_at, product_id, warehouse_code')
    .eq('source_type', 'website_scrape')
    .eq('sync_status', 'ok')
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!newest) {
    console.error('[syncXhr] VERIFY FAIL: no website_scrape rows at all');
    return false;
  }
  const ageHours = (Date.now() - new Date(newest.last_synced_at as string).getTime()) / 3_600_000;
  console.log(`[syncXhr] Newest website_scrape row: ${newest.last_synced_at} (${ageHours.toFixed(2)}h ago)`);
  if (ageHours > 36) {
    console.error(`[syncXhr] VERIFY FAIL: newest row is ${ageHours.toFixed(1)}h old (>36h)`);
    return false;
  }
  return true;
}

async function run() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const allSkus = await loadTargetSkus(supabase);
  const skus = allSkus.slice(0, isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : allSkus.length);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA XHR INVENTORY SYNC');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Filter         : ${process.env.PRODUCT_IDS ? 'explicit list' : PRODUCT_FILTER}`);
  console.log(` Total available: ${allSkus.length}`);
  console.log(` Processing     : ${skus.length}`);
  console.log(` Dry run        : ${DRY_RUN}`);
  console.log(` Inter-req delay: ${INTER_REQ_DELAY}ms`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let rowsWritten = 0;
  let sessionExpired = false;
  const failures: { sku: string; reason: string }[] = [];

  for (let i = 0; i < skus.length; i++) {
    const sku = skus[i];
    attempted++;
    const prefix = `[${i + 1}/${skus.length}] ${sku}`;

    try {
      const { productId, sku: resolvedSku } = await resolveProductId(sku);
      const supplierId = resolvedSku ?? sku; // fallback to the supplier_product_id we started with
      const { rows, total } = await fetchWarehouseRows(productId, supplierId);

      if (rows.length === 0) {
        // Could be a) session expired, b) product genuinely has zero stock, or
        // c) product not yet indexed. We don't write — let the verifier catch
        // sync failures via the global freshness gate.
        console.warn(`${prefix} ⚠ no warehouse rows  (product_id=${productId})`);
        failures.push({ sku, reason: 'no_rows' });
        failed++;
        if (INTER_REQ_DELAY > 0 && i < skus.length - 1) await new Promise(r => setTimeout(r, INTER_REQ_DELAY));
        continue;
      }

      console.log(`${prefix} ✓ product_id=${productId}  warehouses=${rows.length}  total=${total}`);
      for (const r of rows) {
        console.log(`     ${r.warehouse_code.padEnd(8)} qty=${String(r.quantity).padStart(4)}  state=${r.warehouse_state ?? '?'}`);
      }

      if (!DRY_RUN) {
        const { written, error } = await upsertRows(supabase, rows);
        if (error) {
          console.error(`     ✗ upsert failed: ${error}`);
          failures.push({ sku, reason: `upsert: ${error}` });
          failed++;
          continue;
        }
        rowsWritten += written;
        await refreshStatus(supabase, supplierId);
      } else {
        rowsWritten += rows.length;
      }

      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // resolveProductId or fetch failure — usually session expired or rate limit
      if (/session|cookie|401|403|login/i.test(msg)) {
        sessionExpired = true;
        console.error(`${prefix} ✗ session error: ${msg}`);
        failures.push({ sku, reason: 'session_expired' });
        failed++;
        break; // abort the batch — every subsequent call would fail the same way
      }
      console.error(`${prefix} ✗ ${msg}`);
      failures.push({ sku, reason: msg.slice(0, 100) });
      failed++;
    }

    if (INTER_REQ_DELAY > 0 && i < skus.length - 1) {
      await new Promise(r => setTimeout(r, INTER_REQ_DELAY));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' SYNC SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Attempted     : ${attempted}`);
  console.log(` Succeeded     : ${succeeded}`);
  console.log(` Failed        : ${failed}`);
  console.log(` Rows ${DRY_RUN ? '(dry)' : 'upserted'}: ${rowsWritten}`);
  if (failures.length > 0 && failures.length <= 20) {
    console.log(' Failures:');
    for (const f of failures) console.log(`   ${f.sku}  ${f.reason}`);
  } else if (failures.length > 20) {
    console.log(` Failures: ${failures.length} total — first 10:`);
    for (const f of failures.slice(0, 10)) console.log(`   ${f.sku}  ${f.reason}`);
  }
  console.log('═══════════════════════════════════════════════════════════\n');

  if (sessionExpired) {
    console.error('[syncXhr] FAIL: GIGA session expired. Re-run: npm run inventory:save-session');
    process.exit(1);
  }

  if (VERIFY_AFTER && !DRY_RUN && succeeded > 0) {
    const ok = await verifyFreshness(supabase);
    if (!ok) process.exit(1);
  }

  if (succeeded === 0 && attempted > 0) {
    console.error('[syncXhr] FAIL: zero successful rows.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[syncXhr] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
