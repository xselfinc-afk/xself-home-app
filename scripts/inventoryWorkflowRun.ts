/**
 * Stateful inventory workflow runner — SHADOW MODE.
 *
 * Loads the PERSISTED workflow state + counters, reads the latest inventory evidence from
 * inventory_cache, runs the EXISTING state machine (src/services/inventoryStateMachine.ts),
 * persists the new state, and appends an auditable transition row when something actually changed.
 *
 * This fixes the known defect that scripts/inventoryDecisionDryRun.ts rebuilt every product as
 * { published_in_stock, 0, 0 } on each run, which made multi-confirmation impossible.
 *
 * WHAT IT NEVER DOES:
 *   * never writes standardized_products.published or inventory_status;
 *   * never calls refresh_product_inventory_status();
 *   * never delists, relists, publishes, or touches Saved Items;
 *   * never advances counters on unknown / stale / failed evidence.
 *
 * Usage:
 *   DRY_RUN=1 npx tsx scripts/inventoryWorkflowRun.ts --only=W5881P505001,W2339P230587
 *   npx tsx scripts/inventoryWorkflowRun.ts --only=W5881P505001            # persists
 *   DRY_RUN=1 npx tsx scripts/inventoryWorkflowRun.ts --sellable --limit=50
 *
 * Flags:
 *   --only=A,B      hard SKU allowlist (required unless --sellable)
 *   --sellable      scan currently-sellable products instead of an allowlist
 *   --limit=N       cap the scan (default 100)
 *   --stale-hours=N freshness threshold (default 24, matching the RPC)
 *   DRY_RUN=1       compute + print, write NOTHING
 */
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import {
  planWorkflowUpdate,
  buildSignalsFromCacheRows,
  classifyInventoryResult,
  parseAllowlist,
  recommendationBucket,
  type CacheRow,
  type PersistedWorkflowRow,
} from '../src/services/inventoryWorkflowRunner';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DRY_RUN = process.env.DRY_RUN === '1';
const RUNNER = 'inventoryWorkflowRun';

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

/** Fail loudly: every Supabase error aborts. A query error is NEVER read as "no rows". */
function must<T extends { error: unknown }>(tag: string, res: T): T {
  const e = res.error as { code?: string; message?: string } | null;
  if (e) {
    console.error(`[invWorkflow] FATAL ${tag}: ${e.code ?? ''} ${e.message ?? String(e)}`);
    process.exit(1);
  }
  return res;
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[invWorkflow] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required (.env.local)');
    process.exit(1);
  }
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const allowlist = parseAllowlist(arg('only'));
  const useSellable = has('sellable');
  if (!allowlist && !useSellable) {
    console.error('[invWorkflow] FAIL-CLOSED: pass --only=SKU,SKU or --sellable. Never runs unscoped by default.');
    process.exit(1);
  }
  const limit = Math.min(Number(arg('limit') ?? 100), 500);
  const staleHours = Number(arg('stale-hours') ?? 24);
  const staleThresholdMs = staleHours * 3600_000;
  const runId = crypto.randomUUID();
  const nowMs = Date.now();

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' INVENTORY WORKFLOW RUN — SHADOW MODE (no publication writes)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Mode        : ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'PERSIST workflow state'}`);
  console.log(` Scope       : ${allowlist ? `ONLY ${allowlist.length} SKU(s)` : `sellable_products (limit ${limit})`}`);
  console.log(` Stale gate  : ${staleHours}h`);
  console.log(` Run id      : ${runId}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── 1. target set ─────────────────────────────────────────────────────────
  let targets: { supplier_product_id: string; sku_custom: string | null; product_title: string | null }[];
  if (allowlist) {
    const r = must('standardized_products', await sb
      .from('standardized_products')
      .select('supplier_product_id, sku_custom, product_title')
      .in('supplier_product_id', allowlist));
    targets = (r.data ?? []) as typeof targets;
    const found = new Set(targets.map(t => t.supplier_product_id));
    const missing = allowlist.filter(s => !found.has(s));
    if (missing.length) console.warn(`[invWorkflow] ⚠ not in standardized_products (skipped): ${missing.join(', ')}`);
  } else {
    const r = must('sellable_products', await sb
      .from('sellable_products')
      .select('supplier_product_id, sku_custom, product_title')
      .limit(limit));
    targets = (r.data ?? []) as typeof targets;
  }
  if (targets.length === 0) { console.log('[invWorkflow] no targets — nothing to do.'); return; }
  const ids = targets.map(t => t.supplier_product_id);

  // ── 2. evidence ───────────────────────────────────────────────────────────
  const cacheRes = must('inventory_cache', await sb
    .from('inventory_cache')
    .select('product_id, warehouse_code, warehouse_state, quantity, supports_pickup, supports_shipping, sync_status, source_type, last_synced_at')
    .in('product_id', ids));
  const cacheBy = new Map<string, CacheRow[]>();
  for (const c of (cacheRes.data ?? []) as CacheRow[]) {
    const arr = cacheBy.get(c.product_id) ?? [];
    arr.push(c);
    cacheBy.set(c.product_id, arr);
  }

  // ── 3. persisted prior state ──────────────────────────────────────────────
  const stateRes = must('inventory_workflow_states', await sb
    .from('inventory_workflow_states')
    .select('supplier_product_id, supplier_sku, workflow_state, consecutive_out_of_stock, consecutive_in_stock, last_observation_key, version')
    .in('supplier_product_id', ids));
  const priorBy = new Map<string, PersistedWorkflowRow>();
  for (const r of (stateRes.data ?? []) as PersistedWorkflowRow[]) priorBy.set(r.supplier_product_id, r);

  // ── 4. plan + persist ─────────────────────────────────────────────────────
  const summary: Record<string, number> = {};
  let wrote = 0, appended = 0, skippedDuplicate = 0, conflicts = 0, exceptions = 0;

  for (const t of targets) {
    const pid = t.supplier_product_id;
    const rows = cacheBy.get(pid) ?? [];
    const { signals, hasEvidence, observedAtMs } = buildSignalsFromCacheRows(rows, nowMs, staleThresholdMs);
    const result = classifyInventoryResult(signals, {
      source: 'cache', accountType: 'pickup', supplierProductId: pid,
      sku: t.sku_custom, checkedAt: new Date(nowMs).toISOString(),
    });
    const persistedRow = priorBy.get(pid) ?? null;
    const plan = planWorkflowUpdate({
      supplierProductId: pid, supplierSku: t.sku_custom, persisted: persistedRow,
      result, hasEvidence, observedAtMs,
    });
    const bucket = recommendationBucket(plan);
    summary[bucket] = (summary[bucket] ?? 0) + 1;
    if (plan.transition.isException) exceptions++;

    const arrow = plan.stateChanged ? `${plan.prior.state} → ${plan.next.state}` : `${plan.next.state} (unchanged)`;
    console.log(`${plan.alreadyProcessed ? '·' : plan.stateChanged ? '✎' : ' '} ${pid.padEnd(15)} ${String(result.status).padEnd(24)} ${arrow}  oos=${plan.next.consecutiveOutOfStock} in=${plan.next.consecutiveInStock}  [${bucket}]`);

    if (plan.alreadyProcessed) { skippedDuplicate++; continue; }
    if (DRY_RUN) continue;

    const nowIso = new Date().toISOString();
    const payload = {
      supplier_product_id: pid,
      supplier_sku: t.sku_custom,
      workflow_state: plan.next.state,
      consecutive_out_of_stock: plan.next.consecutiveOutOfStock,
      consecutive_in_stock: plan.next.consecutiveInStock,
      last_observed_inventory_status: result.status,
      last_observed_at: plan.observedAtIso,
      last_observation_key: plan.observationKey,
      transition_reason: plan.reason,
      updated_at: nowIso,
      ...(plan.stateChanged ? { last_transition_at: nowIso } : {}),
    };

    if (persistedRow == null) {
      const ins = await sb.from('inventory_workflow_states').insert({ ...payload, version: 1 });
      if (ins.error) {
        // A concurrent runner may have inserted first; that is a conflict, not a silent success.
        console.error(`[invWorkflow] FATAL insert ${pid}: ${ins.error.code} ${ins.error.message}`);
        process.exit(1);
      }
      wrote++;
    } else {
      // Optimistic concurrency: only update if the version we read is still current.
      const upd = must(`update ${pid}`, await sb
        .from('inventory_workflow_states')
        .update({ ...payload, version: persistedRow.version + 1 })
        .eq('supplier_product_id', pid)
        .eq('version', persistedRow.version)
        .select('supplier_product_id'));
      if ((upd.data ?? []).length === 0) {
        conflicts++;
        console.error(`[invWorkflow] ✗ CONCURRENCY CONFLICT on ${pid} (version ${persistedRow.version} moved) — skipped, no write`);
        continue;
      }
      wrote++;
    }

    if (plan.stateChanged) {
      const hist = await sb.from('inventory_workflow_transitions').insert({
        supplier_product_id: pid,
        supplier_sku: t.sku_custom,
        from_state: plan.prior.state,
        to_state: plan.next.state,
        observed_inventory_status: result.status,
        observed_at: plan.observedAtIso,
        observation_key: plan.observationKey,
        consecutive_out_of_stock_before: plan.prior.consecutiveOutOfStock,
        consecutive_in_stock_before: plan.prior.consecutiveInStock,
        consecutive_out_of_stock_after: plan.next.consecutiveOutOfStock,
        consecutive_in_stock_after: plan.next.consecutiveInStock,
        proposed_action: plan.transition.proposedAction,
        observed_exception: plan.transition.observedException,
        reason: plan.reason,
        run_id: runId,
        runner: RUNNER,
      });
      // 23505 = unique violation → this observation was already recorded. Benign, by design.
      if (hist.error && hist.error.code !== '23505') {
        console.error(`[invWorkflow] FATAL history ${pid}: ${hist.error.code} ${hist.error.message}`);
        process.exit(1);
      }
      if (!hist.error) appended++;
    }
  }

  console.log('\n─── summary ───');
  console.log(`  scanned=${targets.length}  rowsWritten=${wrote}  historyAppended=${appended}  duplicateSkipped=${skippedDuplicate}  conflicts=${conflicts}  exceptions=${exceptions}`);
  console.log(`  buckets: ${JSON.stringify(summary)}`);
  if (DRY_RUN) console.log('  DRY RUN — no database writes were performed.');
  console.log('  publication untouched: this runner never writes published/inventory_status.');
}

main().catch(err => {
  console.error('[invWorkflow] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
