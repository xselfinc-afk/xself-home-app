/**
 * Phase 4 — full HTTP-only inventory sync.
 *
 * Reuses the captured cURL template from Phase 3 and walks every sellable
 * product in Supabase, fetches per-warehouse stock, then upserts into
 * inventory_cache with source_type='website_scrape' and refreshes the
 * aggregate columns on standardized_products via
 * refresh_product_inventory_status(p_supplier_product_id).
 *
 * This is the HTTP equivalent of syncGigaFurnitureInventory.ts (which uses
 * Playwright). It writes the same shape of rows so the existing
 * plan-fulfillment + checkout flow is unaffected.
 *
 * Run (dry run first, 5 products, no DB writes):
 *   DRY_RUN=1 INVENTORY_LIMIT=5 npx tsx scripts/syncGigaWarehouseInventoryHttp.ts
 *
 * Run (full):
 *   npx tsx scripts/syncGigaWarehouseInventoryHttp.ts
 *
 * Env:
 *   SUPABASE_URL                — required
 *   SUPABASE_SERVICE_ROLE_KEY   — required
 *   GIGA_CURL_FILE              — input cURL (default: tmp/giga_inventory_request.curl)
 *   CAPTURED_PID                — override the captured product id if auto-detect fails
 *   INVENTORY_LIMIT             — max products per run (default: all)
 *   PRODUCT_FILTER              — optional: 'sellable' (default) | 'all_furniture'
 *   INTER_REQ_DELAY             — ms between requests (default: 800)
 *   DRY_RUN=1                   — skip DB writes
 *   VERIFY_AFTER=0              — skip the freshness check
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { parseCurl } from './lib/curlParser';
import {
  detectCapturedPid,
  fetchForProduct,
  NormalizedRow,
} from './fetchGigaWarehouseInventoryFromCurl';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const CURL_FILE = process.env.GIGA_CURL_FILE
  ?? path.join(process.cwd(), 'tmp', 'giga_inventory_request.curl');
const INVENTORY_LIMIT = process.env.INVENTORY_LIMIT ? parseInt(process.env.INVENTORY_LIMIT, 10) : Infinity;
const PRODUCT_FILTER  = (process.env.PRODUCT_FILTER ?? 'sellable') as 'sellable' | 'all_furniture';
const INTER_REQ_DELAY = Number(process.env.INTER_REQ_DELAY ?? 800);
const DRY_RUN = process.env.DRY_RUN === '1';
const VERIFY_AFTER = process.env.VERIFY_AFTER !== '0';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[syncHttp] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(1);
}

async function loadTargetProducts(supabase: SupabaseClient): Promise<string[]> {
  if (PRODUCT_FILTER === 'all_furniture') {
    const { data, error } = await supabase
      .from('giga_products')
      .select('product_id')
      .eq('top_category', 'Furniture')
      .order('last_synced_at', { ascending: false });
    if (error) throw new Error(`giga_products: ${error.message}`);
    return (data ?? []).map(r => String(r.product_id));
  }
  // default: currently-sellable products only (these are the ones that
  // appear in the app and that customers can put in a cart)
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
      is_available:        (r.quantity ?? 0) > 0,
      supports_pickup:     r.supports_pickup,
      supports_shipping:   r.supports_shipping,
      last_synced_at:      r.last_synced_at,
      sync_status:         'ok',
      source_type:         'website_scrape',
    })), { onConflict: 'product_id,warehouse_code' });
  if (error) return { written: 0, error: error.message };
  return { written: rows.length, error: null };
}

async function refreshStatus(supabase: SupabaseClient, productId: string): Promise<void> {
  const { error } = await supabase.rpc('refresh_product_inventory_status', {
    p_supplier_product_id: productId,
  });
  if (error) console.warn(`   ⚠ refresh_product_inventory_status(${productId}) failed: ${error.message}`);
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
    console.error('[syncHttp] VERIFY FAIL: no website_scrape rows at all');
    return false;
  }
  const ageHours = (Date.now() - new Date(newest.last_synced_at as string).getTime()) / 3_600_000;
  console.log(`[syncHttp] Newest website_scrape row: ${newest.last_synced_at} (${ageHours.toFixed(2)}h ago)`);

  if (ageHours > 36) {
    console.error(`[syncHttp] VERIFY FAIL: newest row is ${ageHours.toFixed(1)}h old (>36h)`);
    return false;
  }
  return true;
}

async function run() {
  if (!fs.existsSync(CURL_FILE)) {
    console.error(`[syncHttp] cURL template not found: ${CURL_FILE}`);
    console.error('  Capture one by following docs/GIGA_NETWORK_CAPTURE.md.');
    process.exit(1);
  }

  const parsed = parseCurl(fs.readFileSync(CURL_FILE, 'utf8'));
  const capturedPid = detectCapturedPid(parsed);
  if (!capturedPid) {
    console.error('[syncHttp] Could not detect captured product id in the cURL.');
    console.error('  Re-run with CAPTURED_PID=<id> npx tsx scripts/syncGigaWarehouseInventoryHttp.ts');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA HTTP INVENTORY SYNC');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` cURL template  : ${CURL_FILE}`);
  console.log(` Captured PID   : ${capturedPid}`);
  console.log(` Product filter : ${PRODUCT_FILTER}`);
  console.log(` Inventory limit: ${isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : 'all'}`);
  console.log(` Inter-req delay: ${INTER_REQ_DELAY}ms`);
  console.log(` Dry run        : ${DRY_RUN}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const allPids = await loadTargetProducts(supabase);
  const pids = allPids.slice(0, isFinite(INVENTORY_LIMIT) ? INVENTORY_LIMIT : allPids.length);
  console.log(`[syncHttp] Loaded ${allPids.length} products; processing ${pids.length}\n`);

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let rowsWritten = 0;

  for (let i = 0; i < pids.length; i++) {
    const pid = pids[i];
    attempted++;
    const prefix = `[${i + 1}/${pids.length}] ${pid}`;

    try {
      const { status, rows, bodyPreview } = await fetchForProduct(parsed, capturedPid, pid);

      if (status === 401 || status === 403) {
        console.error(`${prefix} ✗ HTTP ${status} — session likely expired. Aborting batch.`);
        console.error('   Recapture the cURL per docs/GIGA_NETWORK_CAPTURE.md.');
        failed++;
        break;
      }
      if (status >= 400) {
        console.error(`${prefix} ✗ HTTP ${status} — skipping. Preview: ${bodyPreview.slice(0, 120)}`);
        failed++;
        continue;
      }
      if (rows.length === 0) {
        console.warn(`${prefix} ⚠ HTTP 200 but no warehouse rows extracted. Preview: ${bodyPreview.slice(0, 120)}`);
        failed++;
        continue;
      }

      console.log(`${prefix} ✓ HTTP ${status} — ${rows.length} warehouse row(s)`);
      for (const row of rows) {
        console.log(`     ${row.warehouse_code.padEnd(8)} qty=${String(row.quantity).padStart(4)} exact=${row.quantity_exact ? 'y' : 'n'}`);
      }

      if (!DRY_RUN) {
        const { written, error } = await upsertRows(supabase, rows);
        if (error) {
          console.error(`   ✗ upsert failed: ${error}`);
          failed++;
          continue;
        }
        rowsWritten += written;
        await refreshStatus(supabase, pid);
      } else {
        rowsWritten += rows.length;
      }

      succeeded++;
    } catch (err) {
      console.error(`${prefix} ✗ ${err instanceof Error ? err.message : err}`);
      failed++;
    }

    if (INTER_REQ_DELAY > 0 && i < pids.length - 1) {
      await new Promise(r => setTimeout(r, INTER_REQ_DELAY));
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' SYNC SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Attempted  : ${attempted}`);
  console.log(` Succeeded  : ${succeeded}`);
  console.log(` Failed     : ${failed}`);
  console.log(` Rows ${DRY_RUN ? '(dry)' : 'upserted'}: ${rowsWritten}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (VERIFY_AFTER && !DRY_RUN) {
    const ok = await verifyFreshness(supabase);
    if (!ok) process.exit(1);
  }

  if (succeeded === 0 && attempted > 0) {
    console.error('[syncHttp] FAIL: no successful rows. Recapture the cURL and retry.');
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[syncHttp] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
