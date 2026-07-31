/**
 * Inventory action recommendations — READ-ONLY.
 *
 * Reads persisted workflow state (inventory_workflow_states), current publication state and the
 * latest inventory evidence, then reports what SHOULD happen. It proposes; it never disposes.
 *
 * MUTATES NOTHING. No publication change, no workflow write, no supplier call.
 *
 * Usage:
 *   npx tsx scripts/inventoryActionRecommendations.ts
 *   npx tsx scripts/inventoryActionRecommendations.ts --only=W5881P505001,W244P172637
 *   npx tsx scripts/inventoryActionRecommendations.ts --json=reports/inventory-decisions/reco.json
 */
import { config as loadEnv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildSignalsFromCacheRows,
  classifyInventoryResult,
  observationClass,
  observationKey,
  recommendationBucket,
  requiresFounderApproval,
  parseAllowlist,
  type CacheRow,
  type RecommendationBucket,
} from '../src/services/inventoryWorkflowRunner';
import type { InventoryWorkflowState } from '../src/services/inventoryStateMachine';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const hit = argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};

function must<T extends { error: unknown }>(tag: string, res: T): T {
  const e = res.error as { code?: string; message?: string } | null;
  if (e) { console.error(`[invReco] FATAL ${tag}: ${e.code ?? ''} ${e.message ?? String(e)}`); process.exit(1); }
  return res;
}

const ACTION_FOR: Record<RecommendationBucket, string> = {
  eligible_for_delist: 'DELIST (remove from storefront)',
  eligible_for_relist: 'RELIST (restore to storefront)',
  pending_confirmation: 'WAIT — needs another confirming observation',
  no_action: 'none',
  blocked_unknown: 'BLOCKED — evidence unknown/stale/failed; do not act',
};

async function main(): Promise<void> {
  const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!SUPABASE_URL || !SERVICE_KEY) { console.error('[invReco] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }
  const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const allowlist = parseAllowlist(arg('only'));
  const staleHours = Number(arg('stale-hours') ?? 24);
  const staleThresholdMs = staleHours * 3600_000;
  const nowMs = Date.now();

  // Persisted workflow rows are the starting point — no rows means the runner has not run yet.
  let q = sb.from('inventory_workflow_states')
    .select('supplier_product_id, supplier_sku, workflow_state, consecutive_out_of_stock, consecutive_in_stock, last_observed_inventory_status, last_observed_at, last_observation_key, last_transition_at, version');
  if (allowlist) q = q.in('supplier_product_id', allowlist);
  const wf = must('inventory_workflow_states', await q).data ?? [];

  if (wf.length === 0) {
    console.log('[invReco] no persisted workflow rows found — run scripts/inventoryWorkflowRun.ts first.');
    return;
  }
  const ids = wf.map((r: any) => r.supplier_product_id as string);

  const std = must('standardized_products', await sb
    .from('standardized_products')
    .select('supplier_product_id, product_title, published, inventory_status, total_available_qty')
    .in('supplier_product_id', ids)).data ?? [];
  const stdBy = new Map(std.map((r: any) => [r.supplier_product_id, r]));

  const cache = must('inventory_cache', await sb
    .from('inventory_cache')
    .select('product_id, warehouse_code, warehouse_state, quantity, supports_pickup, supports_shipping, sync_status, source_type, last_synced_at')
    .in('product_id', ids)).data ?? [];
  const cacheBy = new Map<string, CacheRow[]>();
  for (const c of cache as CacheRow[]) {
    const a = cacheBy.get(c.product_id) ?? []; a.push(c); cacheBy.set(c.product_id, a);
  }

  const recos: any[] = [];
  for (const w of wf as any[]) {
    const pid = w.supplier_product_id as string;
    const s = stdBy.get(pid) as any;
    const rows = cacheBy.get(pid) ?? [];
    const { signals, hasEvidence, observedAtMs } = buildSignalsFromCacheRows(rows, nowMs, staleThresholdMs);
    const result = classifyInventoryResult(signals, {
      source: 'cache', accountType: 'pickup', supplierProductId: pid, sku: w.supplier_sku, checkedAt: new Date(nowMs).toISOString(),
    });
    const obsClass = observationClass(result.status, hasEvidence);
    const state = w.workflow_state as InventoryWorkflowState;
    const bucket = recommendationBucket({
      next: { state, consecutiveOutOfStock: w.consecutive_out_of_stock, consecutiveInStock: w.consecutive_in_stock },
      observationClass: obsClass,
    });
    const currentKey = observationKey({
      supplierProductId: pid, status: result.status, observedAtMs, totalQuantity: result.totalQuantity,
    });

    recos.push({
      sku: pid,
      sku_custom: w.supplier_sku,
      product_title: s?.product_title ?? null,
      currently_published: s?.published ?? null,
      current_inventory_status: s?.inventory_status ?? null,
      workflow_state: state,
      latest_inventory_evidence: result.status,
      total_quantity: result.totalQuantity,
      has_ca_stock: result.hasCaStock,
      consecutive_out_of_stock: w.consecutive_out_of_stock,
      consecutive_in_stock: w.consecutive_in_stock,
      last_observation_at: w.last_observed_at,
      last_transition_at: w.last_transition_at,
      observation_key: currentKey,
      recommendation: bucket,
      proposed_action: ACTION_FOR[bucket],
      reason:
        bucket === 'blocked_unknown' ? `non_authoritative_evidence:${result.status}`
        : bucket === 'eligible_for_delist' ? `confirmed_zero x${w.consecutive_out_of_stock}`
        : bucket === 'eligible_for_relist' ? `confirmed_in_stock x${w.consecutive_in_stock} after delist`
        : bucket === 'pending_confirmation' ? `awaiting another confirming observation (state=${state})`
        : 'in stock and published — nothing to do',
      founder_approval_required: requiresFounderApproval(bucket),
    });
  }

  // ── human-readable ────────────────────────────────────────────────────────
  const byBucket: Record<string, any[]> = {};
  for (const r of recos) (byBucket[r.recommendation] ??= []).push(r);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' INVENTORY ACTION RECOMMENDATIONS (read-only — nothing changed)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` scanned=${recos.length}  ${Object.entries(byBucket).map(([k, v]) => `${k}=${v.length}`).join('  ')}\n`);

  for (const bucket of ['eligible_for_delist', 'eligible_for_relist', 'pending_confirmation', 'blocked_unknown', 'no_action'] as const) {
    const list = byBucket[bucket] ?? [];
    if (!list.length) continue;
    console.log(`── ${bucket.toUpperCase()} (${list.length}) — ${ACTION_FOR[bucket]}`);
    for (const r of list.slice(0, 25)) {
      console.log(`   ${r.sku.padEnd(15)} pub=${String(r.currently_published).padEnd(5)} wf=${r.workflow_state.padEnd(22)} evi=${String(r.latest_inventory_evidence).padEnd(24)} oos=${r.consecutive_out_of_stock} in=${r.consecutive_in_stock} approval=${r.founder_approval_required ? 'REQUIRED' : 'no'}`);
      console.log(`       "${String(r.product_title ?? '').slice(0, 68)}"  — ${r.reason}`);
    }
    if (list.length > 25) console.log(`   … ${list.length - 25} more (see JSON)`);
    console.log('');
  }

  const outPath = arg('json') ?? 'reports/inventory-decisions/recommendations.json';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    read_only: true,
    mutated_anything: false,
    stale_threshold_hours: staleHours,
    counts: Object.fromEntries(Object.entries(byBucket).map(([k, v]) => [k, v.length])),
    recommendations: recos,
  }, null, 2));
  console.log(`JSON → ${outPath}`);
  console.log('This command mutates nothing. Execution requires scripts/inventoryActionApply.ts with an explicit allowlist.');
}

main().catch(err => { console.error('[invReco] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
