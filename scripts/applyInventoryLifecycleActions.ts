/**
 * applyInventoryLifecycleActions.ts — the ONLY path that may change customer-visible publication
 * from Open API availability evidence.
 *
 * DRY-RUN BY DEFAULT. A live run requires ALL of:
 *   --approve  --approved-by=<name>   explicit human intent, recorded in the audit log
 *   inventory_automation_enabled      global kill switch
 *   inventory_auto_delist_enabled  /  inventory_auto_relist_enabled   per-direction switches
 *   --only=SKU,SKU                    explicit allowlist; there is deliberately no "all"
 *   per-run count and percentage caps, and the bulk-approval threshold
 *
 * It never writes `published` itself. Every mutation goes through
 * `set_publication_from_availability()`, which re-checks provenance, freshness, manual holds and
 * every quality gate server-side and returns a status. This script cannot talk the database into
 * an action the database would refuse.
 *
 * WHY NOT REUSE scripts/inventoryActionApply.ts
 * ---------------------------------------------
 * That runner is well-guarded but delegates to `refresh_product_inventory_status()`, which derives
 * publication from `inventory_cache` warehouse rows with a 24h staleness rule and cannot see Open
 * API availability. Every published product currently has warehouse evidence 10–40 days old, so it
 * resolves to 'stale' and unpublishes regardless of what the supplier API says. It remains correct
 * for the warehouse pipeline and is left untouched; this script serves the API pipeline.
 *
 * Usage:
 *   npm run inventory:lifecycle:apply -- --action=delist --only=SKU1,SKU2
 *   npm run inventory:lifecycle:apply -- --action=relist --only=SKU1 --approve --approved-by=he
 *
 * Exit codes: 0 ok · 1 fatal · 3 safety-gate blocked · 4 lock held.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INVENTORY_AUTOMATION_DEFAULTS,
  evaluateDelistBatchAllowed,
  type InventoryAutomationConfig,
} from '../src/services/inventoryAutomationConfig';
import {
  decidePublication,
  tallyDecisions,
  type Decision,
  type PublicationAction,
  type ProductRow,
} from '../src/services/publicationDecision';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => argv.find(a => a.startsWith(`--${f}=`))?.split('=').slice(1).join('=');

const ACTION = (val('action') ?? '') as PublicationAction;
const APPROVE = has('--approve');
const APPROVED_BY = val('approved-by') ?? '';
const ONLY = (val('only') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const REPORT_DIR = path.join(process.cwd(), 'reports', 'inventory-availability');
const LOCK_PATH = path.join(REPORT_DIR, '.lifecycle-apply.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

const die = (code: number, msg: string): never => { console.error(`LIFECYCLE_APPLY_ERROR ${msg}`); process.exit(code); };

function acquireLock(): boolean {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  try {
    const info = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as { pid: number; at: string };
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch { alive = false; }
    if (alive && Date.now() - Date.parse(info.at) < LOCK_STALE_MS) return false;
  } catch { /* absent or unreadable → reclaim */ }
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  return true;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* best effort */ } };

const chunk = <T,>(a: T[], n: number): T[][] => {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
};

async function main(): Promise<void> {
  if (ACTION !== 'delist' && ACTION !== 'relist') die(1, 'require --action=delist|relist');
  if (ONLY.length === 0) die(1, 'require --only=SKU,... — there is deliberately no "all" mode');
  if (APPROVE && !APPROVED_BY) die(1, '--approve requires --approved-by=<name>');

  const RUN_ID = `lifecycle-${ACTION}-${new Date().toISOString()}-${process.pid}`;
  if (!acquireLock()) die(4, 'another lifecycle apply is already running');

  try {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) die(1, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url!, key!, { auth: { persistSession: false } });

    let cfg: InventoryAutomationConfig = { ...INVENTORY_AUTOMATION_DEFAULTS };
    try {
      const { loadInventoryConfigForScript } = await import('./lib/inventoryConfigClient');
      cfg = await loadInventoryConfigForScript();
    } catch { /* defaults — fail safe */ }

    // ── Load exactly the requested SKUs ────────────────────────────────────────────────────
    const products = new Map<string, ProductRow>();
    for (const c of chunk(ONLY, 100)) {
      const { data, error } = await sb.from('standardized_products')
        .select('supplier_product_id,published,delist_reason,normalization_status,product_title,primary_image,price,selling_price,inventory_status,total_available_qty')
        .in('supplier_product_id', c);
      if (error) die(1, `standardized_products read failed: ${error.message} — is the provenance migration applied?`);
      for (const r of data ?? []) {
        products.set(r.supplier_product_id, {
          supplierProductId: r.supplier_product_id,
          published: r.published,
          delistReason: r.delist_reason ?? null,
          normalizationStatus: r.normalization_status,
          productTitle: r.product_title,
          primaryImage: r.primary_image,
          price: r.price == null ? null : Number(r.price),
          sellingPrice: r.selling_price == null ? null : Number(r.selling_price),
          inventoryStatus: r.inventory_status,
          totalAvailableQty: r.total_available_qty == null ? null : Number(r.total_available_qty),
        });
      }
    }

    const availability = new Map<string, { available: boolean; status: string; checkedAt: string }>();
    for (const c of chunk(ONLY, 100)) {
      const { data, error } = await sb.from('product_availability_current')
        .select('supplier_product_id,available,status,checked_at').in('supplier_product_id', c);
      if (error) die(1, `product_availability_current read failed: ${error.message}`);
      for (const r of data ?? []) availability.set(r.supplier_product_id, { available: r.available, status: r.status, checkedAt: r.checked_at });
    }

    // The two-confirmation lifecycle state is a hard precondition for any publication change.
    const workflowState = new Map<string, string>();
    for (const c of chunk(ONLY, 100)) {
      const { data, error } = await sb.from('inventory_workflow_states')
        .select('supplier_product_id,workflow_state').in('supplier_product_id', c);
      if (error) die(1, `inventory_workflow_states read failed: ${error.message}`);
      for (const r of data ?? []) workflowState.set(r.supplier_product_id, r.workflow_state);
    }

    const held = new Set<string>();
    {
      const { data, error } = await sb.from('active_inventory_holds').select('supplier_product_id').in('supplier_product_id', ONLY);
      if (error) die(1, `active_inventory_holds read failed: ${error.message} — is the provenance migration applied?`);
      for (const r of data ?? []) held.add(r.supplier_product_id);
    }

    // ── Decide (pure preview mirroring the SQL guards) ─────────────────────────────────────
    const nowIso = new Date().toISOString();
    const decisions: Decision[] = ONLY.map(sku => decidePublication({
      product: products.get(sku) ?? null,
      availability: availability.get(sku) ?? null,
      action: ACTION,
      heldManually: held.has(sku),
      nowIso,
      workflowState: workflowState.get(sku) ?? null,
    }));
    const t = tallyDecisions(decisions);

    // ── Safety gates ───────────────────────────────────────────────────────────────────────
    const { count: publishedTotal } = await sb.from('standardized_products')
      .select('id', { count: 'exact', head: true }).eq('published', true);

    // Relist is less destructive than delist, but an abnormal bulk relist still deserves a human:
    // it can resurrect many products at once, so the same per-run count cap applies.
    const relistBlocks: string[] = [];
    if (!cfg.automationEnabled) relistBlocks.push('automation_disabled');
    if (!cfg.autoRelistEnabled) relistBlocks.push('auto_relist_disabled');
    if (t.wouldApply > cfg.maxDelistPerRun) relistBlocks.push('exceeds_max_per_run');
    if (cfg.bulkChangeRequiresApproval && t.wouldApply > cfg.maxDelistPerRun) relistBlocks.push('requires_human_approval');

    const gate = ACTION === 'delist'
      ? evaluateDelistBatchAllowed(cfg, { proposedDelistCount: t.wouldApply, totalPublished: publishedTotal ?? 0 })
      : { allowed: relistBlocks.length === 0, blocks: relistBlocks };

    console.log(`LIFECYCLE_APPLY run=${RUN_ID}`);
    console.log(`action=${ACTION}  mode=${APPROVE ? '*** LIVE ***' : 'DRY RUN'}  requested=${ONLY.length}`);
    console.log(`would_apply=${t.wouldApply}  skipped=${t.skipped}`);
    for (const [k, v] of Object.entries(t.byOutcome)) console.log(`  outcome_${k}=${v}`);
    console.log(`gate_allowed=${gate.allowed}  blocks=${gate.blocks.join(',') || 'none'}`);
    for (const d of decisions) console.log(`  ${d.supplierProductId.padEnd(18)}${d.outcome.padEnd(34)}${d.reason}`);

    if (!APPROVE) {
      console.log('\nDRY RUN — nothing executed. Re-run with --approve --approved-by=<name>.');
      releaseLock();
      return;
    }
    if (!gate.allowed) {
      console.error(`\nBLOCKED: ${gate.blocks.join(', ')} — nothing executed.`);
      releaseLock();
      process.exit(3);
    }

    // ── Execute, one SKU at a time, through the server-side authority ──────────────────────
    let applied = 0, refused = 0, failed = 0;
    const outcomes: Record<string, number> = {};
    for (const d of decisions) {
      if (!d.willApply) continue;
      const { data, error } = await sb.rpc('set_publication_from_availability', {
        p_supplier_product_id: d.supplierProductId,
        p_target_published: ACTION === 'relist',
        p_actor: APPROVED_BY,
        p_run_id: RUN_ID,
      });
      if (error) { failed++; console.error(`  RPC FAILED ${d.supplierProductId}: ${error.message}`); continue; }
      const status = String(data);
      outcomes[status] = (outcomes[status] ?? 0) + 1;
      if (status === 'delisted' || status === 'relisted') applied++;
      else { refused++; console.log(`  server refused ${d.supplierProductId}: ${status}`); }
    }

    console.log('\nLIFECYCLE_APPLY_SUMMARY');
    console.log(`applied=${applied}  server_refused=${refused}  rpc_failed=${failed}`);
    for (const [k, v] of Object.entries(outcomes)) console.log(`  server_${k}=${v}`);
    console.log(`run_id=${RUN_ID}  actor=${APPROVED_BY}`);
    console.log(`rollback=SELECT * FROM publication_audit_log WHERE run_id='${RUN_ID}'`);

    releaseLock();
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    releaseLock();
    die(1, String((e as Error)?.message ?? e).slice(0, 200));
  }
}

main().catch(e => { releaseLock(); die(1, String((e as Error)?.message ?? e).slice(0, 200)); });
