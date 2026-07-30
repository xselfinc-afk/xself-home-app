/**
 * Inventory decision DRY-RUN runner (Phase 1, Scope D + E).
 *
 * STRICTLY READ-ONLY toward production: it SELECTs sellable_products + inventory_cache,
 * classifies each published product's CURRENT inventory result from existing cache state,
 * computes the PROPOSED state transition + CA priority, evaluates the safety limits that
 * WOULD gate a live apply, and writes an audit report to reports/inventory-decisions/.
 * It performs NO Supabase writes, NO GIGA/supplier calls, NO browser automation, and has
 * NO delist/relist/publish apply path whatsoever. Dry-run is the only mode.
 *
 * Phase-1 scope notes:
 *  - "current result" is derived from the EXISTING inventory_cache (no live re-scan yet).
 *  - there is no persisted workflow-state column yet, so prior state is treated as
 *    published_in_stock with zero history; the report is a single-snapshot proposal
 *    (a confirmed-zero product therefore proposes pending_out_of_stock — never delist —
 *    which correctly reflects that 2 confirmations are required and none are on record).
 *
 * Usage:
 *   npx tsx scripts/inventoryDecisionDryRun.ts [--limit=100] [--skus=A,B,C] [--stale-hours=24]
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import {
  classifyInventoryResult, type RawInventorySignals, type WarehouseStock,
} from '../src/services/inventoryResult';
import { transitionInventoryState, type WorkflowSnapshot } from '../src/services/inventoryStateMachine';
import {
  INVENTORY_AUTOMATION_DEFAULTS, applyInventoryConfigRow, evaluateDelistBatchAllowed,
  type InventoryAutomationConfig,
} from '../src/services/inventoryAutomationConfig';

dotenv.config({ path: '.env.local' });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function arg(name: string): string | undefined {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}
const now = Date.now();
const runId = `inv-dry-${new Date(now).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

const CA = (s: string | null | undefined) => (s ?? '').toUpperCase() === 'CA';

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[inv-dry-run] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env.local). Aborting (read-only, no side effects).');
    process.exit(2);
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Config: reuse the PURE parser over DEFAULTS (no rows exist in Phase 1 → all off).
  let cfg: InventoryAutomationConfig = { ...INVENTORY_AUTOMATION_DEFAULTS };
  try {
    const { data } = await sb.from('home_content_config').select('key,value').eq('screen', 'inventory_automation').eq('is_active', true);
    for (const r of data ?? []) cfg = applyInventoryConfigRow(cfg, r.key as string, r.value as string);
  } catch { /* defaults */ }

  const staleHours = Number(arg('stale-hours') ?? 24);
  const staleThresholdMs = staleHours * 3600_000;
  const limit = Math.min(Number(arg('limit') ?? cfg.maxScanPerRun), cfg.maxScanPerRun);
  const skuFilter = (arg('skus') ?? '').split(',').map(s => s.trim()).filter(Boolean);

  // 1. Published products (the storefront gate view).
  let q = sb.from('sellable_products').select('supplier_product_id, sku_custom, product_title').limit(limit);
  if (skuFilter.length) q = q.in('supplier_product_id', skuFilter);
  const { data: products, error: pErr } = await q;
  if (pErr) { console.error('[inv-dry-run] sellable_products read failed:', pErr.message); process.exit(1); }
  const rows = products ?? [];
  const ids = rows.map(r => r.supplier_product_id as string);

  // 2. Their inventory_cache rows (trusted sources only, mirroring plan-fulfillment).
  const cacheByProduct = new Map<string, any[]>();
  if (ids.length) {
    const { data: cache } = await sb.from('inventory_cache')
      .select('product_id, warehouse_code, warehouse_state, quantity, is_available, supports_pickup, supports_shipping, sync_status, source_type, last_synced_at')
      .in('product_id', ids).in('source_type', ['website_scrape', 'official_api']).eq('sync_status', 'ok');
    for (const c of cache ?? []) {
      const arr = cacheByProduct.get(c.product_id as string) ?? [];
      arr.push(c); cacheByProduct.set(c.product_id as string, arr);
    }
  }

  const items: any[] = [];
  const counts: Record<string, number> = {};
  const priorityCounts: Record<string, number> = { P1: 0, P2: 0, P3: 0, P4: 0 };
  let proposedDelistCount = 0, proposedRelistCount = 0, exceptions = 0;

  for (const p of rows) {
    const pid = p.supplier_product_id as string;
    const whRows = cacheByProduct.get(pid) ?? [];
    // Build explicit signals from cache state (absence → unknown, never zero).
    let signals: RawInventorySignals;
    if (whRows.length === 0) {
      signals = { httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses: [] }; // → inventory_unknown
    } else {
      const ages = whRows.map(w => now - new Date(w.last_synced_at as string).getTime());
      const ageMs = Math.min(...ages);
      const parsedWarehouses: WarehouseStock[] = whRows.map(w => ({
        warehouseCode: w.warehouse_code, warehouseState: w.warehouse_state,
        quantity: Number(w.quantity ?? 0), supportsPickup: w.supports_pickup, supportsShipping: w.supports_shipping,
      }));
      const totalQty = parsedWarehouses.reduce((s, w) => s + (typeof w.quantity === 'number' && w.quantity > 0 ? w.quantity : 0), 0);
      signals = {
        httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses,
        ageMs, staleThresholdMs,
        // fresh + all-zero rows present == the scraper recorded an affirmative zero.
        affirmativeZeroSignal: totalQty === 0,
      };
    }
    const result = classifyInventoryResult(signals, {
      source: 'cache', accountType: 'pickup', supplierProductId: pid, sku: p.sku_custom, checkedAt: new Date(now).toISOString(),
    });
    // Phase 1: no persisted history → prior is published_in_stock, zero counters.
    const prior: WorkflowSnapshot = { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: 0 };
    const tr = transitionInventoryState(prior, result.status, {
      outOfStockConfirmationsRequired: cfg.outOfStockConfirmations, inStockConfirmationsRequired: cfg.relistConfirmations,
    });
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    priorityCounts[tr.priorityClass] = (priorityCounts[tr.priorityClass] ?? 0) + 1;
    if (tr.proposedAction === 'propose_delist') proposedDelistCount++;
    if (tr.proposedAction === 'propose_relist') proposedRelistCount++;
    if (tr.isException) exceptions++;
    items.push({
      runId, timestamp: new Date(now).toISOString(), sku: p.sku_custom, supplierProductId: pid,
      supplierSource: result.source, previousState: prior.state, currentResult: result.status,
      proposedNextState: tr.next.state, observedException: tr.observedException,
      consecutiveZero: tr.next.consecutiveOutOfStock, consecutiveInStock: tr.next.consecutiveInStock,
      priorityClass: tr.priorityClass, hasCaStock: result.hasCaStock, hasShippableStock: result.hasShippableStock,
      actionProposed: tr.proposedAction, reason: tr.reason,
    });
  }

  // Aggregate safety decision (what a live delist batch WOULD hit).
  const delistSafety = evaluateDelistBatchAllowed(cfg, { proposedDelistCount, totalPublished: rows.length });
  for (const it of items) {
    it.safetyLimitBlocked = it.actionProposed === 'propose_delist' && !delistSafety.allowed;
    it.safetyBlocks = it.actionProposed === 'propose_delist' ? delistSafety.blocks : [];
  }

  const report = {
    runId, generatedAt: new Date(now).toISOString(), mode: 'DRY_RUN',
    config: cfg, scanned: rows.length, limit,
    summary: { statusCounts: counts, priorityCounts, proposedDelistCount, proposedRelistCount, exceptions },
    liveApplyEnabled: false, autoDelistEnabled: cfg.autoDelistEnabled, autoRelistEnabled: cfg.autoRelistEnabled,
    delistBatchWouldBeAllowed: delistSafety.allowed, delistBatchBlocks: delistSafety.blocks,
    items,
  };

  const dir = path.join(process.cwd(), 'reports', 'inventory-decisions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${runId}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(report, null, 2));
  const csvHead = 'sku,supplierProductId,currentResult,priorityClass,proposedNextState,actionProposed,consecutiveZero,safetyLimitBlocked,reason';
  const csv = [csvHead, ...items.map(i => [i.sku, i.supplierProductId, i.currentResult, i.priorityClass, i.proposedNextState, i.actionProposed, i.consecutiveZero, i.safetyLimitBlocked, JSON.stringify(i.reason)].join(','))].join('\n');
  fs.writeFileSync(path.join(dir, `${runId}.csv`), csv);

  console.log(`[inv-dry-run] ${runId}`);
  console.log(`  scanned=${rows.length} (limit ${limit})  exceptions=${exceptions}`);
  console.log(`  status: ${JSON.stringify(counts)}`);
  console.log(`  priority: ${JSON.stringify(priorityCounts)}`);
  console.log(`  proposed delist=${proposedDelistCount} relist=${proposedRelistCount}`);
  console.log(`  live apply: DISABLED (auto_delist=${cfg.autoDelistEnabled}, auto_relist=${cfg.autoRelistEnabled}); delist batch allowed=${delistSafety.allowed} blocks=${JSON.stringify(delistSafety.blocks)}`);
  console.log(`  report → reports/inventory-decisions/${runId}.json (+ .csv, latest.json)`);
}

main().catch(e => { console.error('[inv-dry-run] fatal (no writes performed):', e instanceof Error ? e.message : e); process.exit(1); });
