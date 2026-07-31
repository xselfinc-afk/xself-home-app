/**
 * Founder-approved inventory action runner — DELIST / RELIST. DEFAULT-OFF, MANUAL ONLY.
 *
 * This is the ONLY path in the inventory automation that may cause a customer-visible change, and
 * it does so exclusively by calling the existing publication authority:
 *
 *     public.refresh_product_inventory_status(p_supplier_product_id)
 *
 * It NEVER writes standardized_products.published or inventory_status directly. That RPC derives
 * both from inventory_cache, so a "delist" here means: the evidence already says zero, and we ask
 * the authority to recompute. If the evidence does not support the action, the RPC will not delist,
 * and this runner reports that rather than forcing anything.
 *
 * Every guard must pass, or the SKU is skipped (fail closed):
 *   1. explicit --only allowlist (never "all", never implicit);
 *   2. --approve flag present (dry-run is the default);
 *   3. the SKU is currently in the required eligible workflow state;
 *   4. the live evidence still matches the observation the recommendation was based on;
 *   5. every query succeeds — any error aborts.
 *
 * Usage:
 *   npx tsx scripts/inventoryActionApply.ts --action=delist --only=SKU              # dry-run
 *   npx tsx scripts/inventoryActionApply.ts --action=delist --only=SKU --approve    # executes
 */
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import {
  buildSignalsFromCacheRows,
  classifyInventoryResult,
  observationKey,
  canExecuteAction,
  parseAllowlist,
  type CacheRow,
} from '../src/services/inventoryWorkflowRunner';
import type { InventoryWorkflowState } from '../src/services/inventoryStateMachine';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
const APPROVE = argv.includes('--approve');

function must<T extends { error: unknown }>(tag: string, res: T): T {
  const e = res.error as { code?: string; message?: string } | null;
  if (e) { console.error(`[invApply] FATAL ${tag}: ${e.code ?? ''} ${e.message ?? String(e)}`); process.exit(1); }
  return res;
}

const REQUIRED_STATE: Record<string, InventoryWorkflowState> = {
  delist: 'eligible_for_delist',
  relist: 'eligible_for_relist',
};

async function main(): Promise<void> {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('[invApply] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }

  const action = (arg('action') ?? '').toLowerCase();
  if (action !== 'delist' && action !== 'relist') {
    console.error('[invApply] FAIL-CLOSED: --action=delist|relist is required.');
    process.exit(1);
  }
  const allowlist = parseAllowlist(arg('only'));
  if (!allowlist) {
    console.error('[invApply] FAIL-CLOSED: --only=SKU[,SKU] is required. This runner NEVER operates on all products.');
    process.exit(1);
  }
  const approvedBy = arg('approved-by') ?? process.env.FOUNDER_APPROVED_BY ?? 'unspecified';
  if (APPROVE && approvedBy === 'unspecified') {
    console.error('[invApply] FAIL-CLOSED: --approved-by=<name> is required when using --approve.');
    process.exit(1);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const runId = crypto.randomUUID();
  const nowMs = Date.now();
  const requiredState = REQUIRED_STATE[action];
  const staleThresholdMs = Number(arg('stale-hours') ?? 24) * 3600_000;

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` INVENTORY ACTION APPLY — ${action.toUpperCase()}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Mode        : ${APPROVE ? '*** LIVE (customer-visible) ***' : 'DRY RUN (no execution)'}`);
  console.log(` Allowlist   : ${allowlist.join(', ')}`);
  console.log(` Requires    : workflow_state = ${requiredState}`);
  console.log(` Approved by : ${APPROVE ? approvedBy : '(dry-run)'}`);
  console.log(` Authority   : refresh_product_inventory_status() ONLY`);
  console.log(` Run id      : ${runId}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const wf = must('inventory_workflow_states', await sb
    .from('inventory_workflow_states')
    .select('supplier_product_id, supplier_sku, workflow_state, last_observation_key, consecutive_out_of_stock, consecutive_in_stock')
    .in('supplier_product_id', allowlist)).data ?? [];
  const wfBy = new Map(wf.map((r: any) => [r.supplier_product_id, r]));

  const cache = must('inventory_cache', await sb
    .from('inventory_cache')
    .select('product_id, warehouse_code, warehouse_state, quantity, supports_pickup, supports_shipping, sync_status, source_type, last_synced_at')
    .in('product_id', allowlist)).data ?? [];
  const cacheBy = new Map<string, CacheRow[]>();
  for (const c of cache as CacheRow[]) { const a = cacheBy.get(c.product_id) ?? []; a.push(c); cacheBy.set(c.product_id, a); }

  const before = must('published-before', await sb
    .from('standardized_products').select('supplier_product_id, published, inventory_status')
    .in('supplier_product_id', allowlist)).data ?? [];
  const beforeBy = new Map(before.map((r: any) => [r.supplier_product_id, r]));

  const results: any[] = [];
  for (const sku of allowlist) {
    const w = wfBy.get(sku) as any;
    if (!w) {
      console.log(`  ✗ ${sku}: SKIPPED — no persisted workflow row (run inventoryWorkflowRun.ts first)`);
      results.push({ sku, executed: false, reason: 'no_workflow_row' });
      continue;
    }
    const rows = cacheBy.get(sku) ?? [];
    const { signals, hasEvidence, observedAtMs } = buildSignalsFromCacheRows(rows, nowMs, staleThresholdMs);
    const result = classifyInventoryResult(signals, {
      source: 'cache', accountType: 'pickup', supplierProductId: sku, sku: w.supplier_sku, checkedAt: new Date(nowMs).toISOString(),
    });
    const currentKey = observationKey({ supplierProductId: sku, status: result.status, observedAtMs, totalQuantity: result.totalQuantity });

    const guard = canExecuteAction({
      sku,
      allowlist,
      currentState: w.workflow_state,
      requiredState,
      recommendedObservationKey: w.last_observation_key ?? '',
      currentObservationKey: currentKey,
    });
    if (!guard.ok) {
      console.log(`  ✗ ${sku}: REFUSED — ${guard.reason}`);
      results.push({ sku, executed: false, reason: guard.reason, workflow_state: w.workflow_state, evidence: result.status });
      continue;
    }
    if (!hasEvidence) {
      console.log(`  ✗ ${sku}: REFUSED — no usable inventory evidence`);
      results.push({ sku, executed: false, reason: 'no_evidence' });
      continue;
    }

    const b = beforeBy.get(sku) as any;
    if (!APPROVE) {
      console.log(`  • ${sku}: WOULD ${action.toUpperCase()} via refresh_product_inventory_status()  (published ${b?.published} → recomputed from evidence ${result.status})`);
      results.push({ sku, executed: false, reason: 'dry_run', would_act: true, evidence: result.status, published_before: b?.published });
      continue;
    }

    // ── LIVE: route the change ONLY through the publication authority ────────
    const rpc = await sb.rpc('refresh_product_inventory_status', { p_supplier_product_id: sku });
    if (rpc.error) {
      console.error(`[invApply] FATAL rpc ${sku}: ${rpc.error.code} ${rpc.error.message}`);
      process.exit(1);
    }
    const after = must('published-after', await sb
      .from('standardized_products').select('supplier_product_id, published, inventory_status, total_available_qty')
      .eq('supplier_product_id', sku).single());
    const a = after.data as any;
    const changed = b?.published !== a.published;
    console.log(`  ✓ ${sku}: executed — published ${b?.published} → ${a.published}  inventory_status=${a.inventory_status}  ${changed ? '(CHANGED)' : '(no change — evidence did not support it)'}`);
    results.push({
      sku, executed: true, action, approved_by: approvedBy,
      published_before: b?.published, published_after: a.published,
      inventory_status_after: a.inventory_status, evidence: result.status,
      observation_key: currentKey, changed,
    });
  }

  const outPath = arg('json') ?? `reports/inventory-decisions/action-${action}-${runId.slice(0, 8)}.json`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    run_id: runId, action, executed_live: APPROVE, approved_by: APPROVE ? approvedBy : null,
    authority: 'refresh_product_inventory_status', direct_published_write: false,
    allowlist, generated_at: new Date().toISOString(), results,
  }, null, 2));

  const did = results.filter(r => r.executed).length;
  console.log(`\n─── summary ───`);
  console.log(`  requested=${allowlist.length}  executed=${did}  refused=${results.length - did}`);
  console.log(`  evidence → ${outPath}`);
  if (!APPROVE) console.log('  DRY RUN — nothing was executed. Re-run with --approve --approved-by=<name> to act.');
}

main().catch(err => { console.error('[invApply] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
