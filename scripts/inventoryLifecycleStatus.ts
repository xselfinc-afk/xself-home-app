/**
 * inventoryLifecycleStatus.ts — READ-ONLY health, coverage and alerting for the inventory lifecycle.
 *
 * One script rather than two: coverage measurement and monitoring need the same reads, and splitting
 * them would duplicate every query. It performs no writes and calls no supplier endpoint.
 *
 * Answers, in one place:
 *   * Is availability coverage high enough to enforce visibility yet?
 *   * Would enabling enforcement remove more of the catalogue than the coverage gap explains?
 *   * Has the scheduler gone quiet (no scan within 72h)?
 *   * Is the failure rate spiking?
 *   * Are there abnormal numbers of delist-eligible products?
 *
 * Usage:  npm run inventory:lifecycle:status
 * Exit:   0 healthy · 5 alerts raised (non-fatal; intended for a scheduler/monitor to act on)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  evaluateCoverage,
  readyForVisibilityEnforcement,
} from '../src/services/coverageGate';
import {
  INVENTORY_AUTOMATION_DEFAULTS,
  type InventoryAutomationConfig,
} from '../src/services/inventoryAutomationConfig';

const REPORT_DIR = path.join(process.cwd(), 'reports', 'inventory-availability');
const SCAN_REPORT = path.join(REPORT_DIR, 'latest-availability-scan.json');
/** Two missed 48h cycles means the scheduler is not working. */
const SCAN_SILENCE_ALERT_HOURS = 96;

const chunk = <T,>(a: T[], n: number): T[][] => {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
};

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(url!, key!, { auth: { persistSession: false } });

  let cfg: InventoryAutomationConfig = { ...INVENTORY_AUTOMATION_DEFAULTS };
  try {
    const { loadInventoryAutomationConfig } = await import('../src/services/inventoryAutomationConfig');
    cfg = await loadInventoryAutomationConfig();
  } catch { /* defaults */ }

  const must = <T,>(tag: string, r: { data: T | null; error: { message: string } | null }): T => {
    if (r.error) { console.error(`FATAL [${tag}] ${r.error.message}`); process.exit(1); }
    return r.data as T;
  };

  // ── Published SKUs ────────────────────────────────────────────────────────────────────────
  const publishedSkus: string[] = [];
  for (let f = 0; ; f += 1000) {
    const data = must('published', await sb.from('standardized_products')
      .select('supplier_product_id').eq('published', true).range(f, f + 999));
    publishedSkus.push(...data.map((r: { supplier_product_id: string }) => r.supplier_product_id));
    if (data.length < 1000) break;
  }

  // ── Confirmed availability evidence ───────────────────────────────────────────────────────
  const evidence: Array<{ sku: string; checkedAt: string; available: boolean }> = [];
  for (const c of chunk(publishedSkus, 200)) {
    const data = must('availability', await sb.from('product_availability_current')
      .select('supplier_product_id,checked_at,available').in('supplier_product_id', c));
    for (const r of data as Array<{ supplier_product_id: string; checked_at: string; available: boolean }>) {
      evidence.push({ sku: r.supplier_product_id, checkedAt: r.checked_at, available: r.available });
    }
  }

  const nowIso = new Date().toISOString();
  let lastFailurePercent: number | null = null;
  let lastScanFinishedAt: string | null = null;
  try {
    const rep = JSON.parse(fs.readFileSync(SCAN_REPORT, 'utf8')) as
      { totals?: { failurePercent?: number }; finished_at?: string };
    lastFailurePercent = rep.totals?.failurePercent ?? null;
    lastScanFinishedAt = rep.finished_at ?? null;
  } catch { /* no scan yet */ }

  const coverage = evaluateCoverage({
    publishedSkus,
    evidence: evidence.map(e => ({ sku: e.sku, checkedAt: e.checkedAt })),
    nowIso,
    lastRunFailurePercent: lastFailurePercent,
    minCoveragePercent: cfg.minCoveragePercent,
    maxFailurePercent: cfg.maxFailurePercent,
  });

  // What would survive if visibility enforcement were switched on right now?
  const freshAvailable = evidence.filter(e =>
    e.available && (Date.parse(nowIso) - Date.parse(e.checkedAt)) / 3_600_000 <= 72).length;
  const { count: currentlyVisible } = await sb.from('sellable_products').select('*', { count: 'exact', head: true });
  // Removals attributable to a confirmed-unavailable answer are the feature working, not a fault.
  const freshUnavailable = evidence.filter(e =>
    !e.available && (Date.parse(nowIso) - Date.parse(e.checkedAt)) / 3_600_000 <= 72).length;
  const enforcement = readyForVisibilityEnforcement(coverage, currentlyVisible ?? 0, freshAvailable, freshUnavailable);

  // ── Workflow distribution ─────────────────────────────────────────────────────────────────
  const wf = must('workflow', await sb.from('inventory_workflow_states').select('workflow_state'));
  const states: Record<string, number> = {};
  for (const r of wf as Array<{ workflow_state: string }>) states[r.workflow_state] = (states[r.workflow_state] ?? 0) + 1;

  // ── Alerts ────────────────────────────────────────────────────────────────────────────────
  const alerts: string[] = [];
  const scanAgeHours = lastScanFinishedAt
    ? (Date.parse(nowIso) - Date.parse(lastScanFinishedAt)) / 3_600_000 : null;
  if (scanAgeHours === null) alerts.push('no availability scan has ever completed');
  else if (scanAgeHours > SCAN_SILENCE_ALERT_HOURS) {
    alerts.push(`last scan was ${scanAgeHours.toFixed(1)}h ago (>${SCAN_SILENCE_ALERT_HOURS}h) — scheduler may be down`);
  }
  if (lastFailurePercent !== null && lastFailurePercent > cfg.maxFailurePercent) {
    alerts.push(`last scan failure rate ${lastFailurePercent}% exceeds ${cfg.maxFailurePercent}%`);
  }
  const eligible = states['eligible_for_delist'] ?? 0;
  if (eligible > cfg.maxDelistPerRun) {
    alerts.push(`${eligible} products are delist-eligible, above the per-run cap of ${cfg.maxDelistPerRun} — needs human review`);
  }
  // `refresh_product_inventory_status()` can still republish from warehouse evidence without
  // clearing delist_reason, leaving a published row that claims to be inventory-delisted. Harmless
  // to customers but a sign the two authorities disagreed — surface it rather than let it rot.
  const { count: inconsistent } = await sb.from('standardized_products')
    .select('id', { count: 'exact', head: true })
    .eq('published', true).eq('delist_reason', 'inventory_unavailable');
  if ((inconsistent ?? 0) > 0) {
    alerts.push(`${inconsistent} products are published while still flagged delist_reason=inventory_unavailable — the warehouse authority likely republished them`);
  }

  if (cfg.visibilityEnforcementEnabled && !coverage.ready) {
    alerts.push('visibility enforcement is ENABLED while coverage is below threshold');
  }

  // ── Report ────────────────────────────────────────────────────────────────────────────────
  console.log('INVENTORY_LIFECYCLE_STATUS');
  console.log(`published=${coverage.publishedCount}`);
  console.log(`covered_fresh=${coverage.coveredCount}  stale=${coverage.staleCount}  missing=${coverage.missingCount}`);
  console.log(`coverage_percent=${coverage.coveragePercent}  required=${cfg.minCoveragePercent}`);
  console.log(`last_scan_failure_percent=${lastFailurePercent ?? 'n/a'}  max=${cfg.maxFailurePercent}`);
  console.log(`last_scan_age_hours=${scanAgeHours === null ? 'never' : scanAgeHours.toFixed(1)}`);
  console.log(`coverage_ready=${coverage.ready}  blocks=${coverage.blocks.join(',') || 'none'}`);
  console.log(`visibility_enforcement_safe=${enforcement.ready}  blocks=${enforcement.blocks.join(',') || 'none'}`);
  console.log(`would_remove_if_enforced=${enforcement.wouldRemove} of ${currentlyVisible ?? 0} (${enforcement.wouldRemovePercent}%)`);
  console.log(`  explained_by_confirmed_unavailable=${enforcement.explainedByUnavailable}  unexplained=${enforcement.unexplainedRemovals}`);
  console.log('workflow_states=' + JSON.stringify(states));
  console.log('switches=' + JSON.stringify({
    automation: cfg.automationEnabled, apiScan: cfg.apiScanEnabled,
    autoDelist: cfg.autoDelistEnabled, autoRelist: cfg.autoRelistEnabled,
    visibility: cfg.visibilityEnforcementEnabled, checkout: cfg.checkoutRevalidationEnabled,
  }));
  console.log(`alerts=${alerts.length}`);
  for (const a of alerts) console.log(`  ALERT ${a}`);
  console.log('database_rows_written=0');

  process.exit(alerts.length > 0 ? 5 : 0);
}

main().catch(e => { console.error('FATAL', String((e as Error)?.message ?? e).slice(0, 200)); process.exit(1); });
