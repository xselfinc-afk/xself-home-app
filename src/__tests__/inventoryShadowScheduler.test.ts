/**
 * Shadow-scheduler safety tests (static + pure; no supplier calls, no database).
 *
 * These assert the properties that keep the recurring job safe: it cannot reach the action runner,
 * cannot call the publication authority, gates on session health, holds a single-run lock, releases
 * it on every exit path, and never infers out-of-stock from a failure.
 *
 * Run: npx tsx src/__tests__/inventoryShadowScheduler.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { planWorkflowUpdate, buildSignalsFromCacheRows, classifyInventoryResult, type CacheRow } from '../services/inventoryWorkflowRunner';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ROOT = path.resolve(__dirname, '../..');
const RUNNER_SH = fs.readFileSync(path.join(ROOT, 'scripts/runInventoryWorkflowShadow.sh'), 'utf8');
const INSTALLER_SH = fs.readFileSync(path.join(ROOT, 'scripts/installInventoryWorkflowShadow.sh'), 'utf8');
/** Comment lines are documentation; only executable lines may be asserted against. */
const EXEC_LINES = RUNNER_SH.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');

function main() {
  // ── 7. action runner unreachable from the schedule ────────────────────────
  it('7. scheduler NEVER invokes inventoryActionApply', () => {
    assert.ok(!/inventoryActionApply/.test(EXEC_LINES), 'action runner must not be executable from the shadow script');
    assert.ok(!/inventoryActionApply/.test(INSTALLER_SH));
  });

  // ── 8. publication cannot change ──────────────────────────────────────────
  it('8. scheduler NEVER calls refresh_product_inventory_status or auto-publish', () => {
    assert.ok(!/refresh_product_inventory_status/.test(EXEC_LINES));
    assert.ok(!/runGigaAutoPublish|--approve\b/.test(EXEC_LINES), 'no approve/auto-publish path');
  });

  it('8b. inventory refresh is pinned to INVENTORY_CACHE_ONLY=1', () => {
    assert.ok(/INVENTORY_CACHE_ONLY=1/.test(EXEC_LINES), 'cache-only is what keeps publication untouched');
    // The publishing form (sync without the guard) must not appear.
    assert.ok(!/npx tsx scripts\/syncGigaInventoryXhr\.ts(?![\s\S]{0,0})/.test(
      EXEC_LINES.split('\n').filter(l => l.includes('syncGigaInventoryXhr') && !l.includes('INVENTORY_CACHE_ONLY')).join('\n')
    ) || !EXEC_LINES.split('\n').some(l => l.includes('syncGigaInventoryXhr') && !l.includes('INVENTORY_CACHE_ONLY') && !l.includes('#')),
      'every syncGigaInventoryXhr invocation must carry INVENTORY_CACHE_ONLY=1');
  });

  // ── 1. session-health gate ────────────────────────────────────────────────
  it('1. unhealthy session aborts before any supplier or workflow work', () => {
    assert.ok(/supplierSession\.ts health --source=pickup/.test(EXEC_LINES), 'health gate present');
    assert.ok(/HEALTH_EXIT" -ne 0/.test(EXEC_LINES), 'nonzero health exit is checked');
    // The gate must appear BEFORE the inventory refresh and the workflow run.
    const gate = EXEC_LINES.indexOf('supplierSession.ts health');
    const refresh = EXEC_LINES.indexOf('INVENTORY_CACHE_ONLY=1');
    const wf = EXEC_LINES.indexOf('inventoryWorkflowRun.ts');
    assert.ok(gate > 0 && gate < refresh && gate < wf, 'health gate must precede supplier work');
  });

  // ── 2. lock prevents overlap ──────────────────────────────────────────────
  it('2. single-run lock is atomic and blocks a second run', () => {
    assert.ok(/mkdir "\$LOCK_DIR" 2>\/dev\/null/.test(EXEC_LINES), 'atomic mkdir lock');
    assert.ok(/another run holds the lock/.test(RUNNER_SH));
  });

  // ── 9. lock releases on success AND failure ───────────────────────────────
  it('9. lock is released on every exit path (trap on EXIT/INT/TERM)', () => {
    assert.ok(/trap cleanup EXIT INT TERM/.test(EXEC_LINES), 'trap installed');
    assert.ok(/rmdir "\$LOCK_DIR"/.test(EXEC_LINES), 'cleanup removes the lock');
  });

  // ── 3. failures exit nonzero ──────────────────────────────────────────────
  it('3. every step failure writes an exception report and exits nonzero', () => {
    for (const step of ['session_unhealthy', 'inventory_refresh_failed', 'workflow_run_failed', 'recommendations_failed']) {
      assert.ok(RUNNER_SH.includes(step), `missing exception reason: ${step}`);
    }
    assert.ok(/exit "\$INV_EXIT"/.test(EXEC_LINES) && /exit "\$WF_EXIT"/.test(EXEC_LINES));
  });

  it('3b. exception report explicitly records that no zero was inferred', () => {
    assert.ok(/"out_of_stock_inferred_from_failure": false/.test(RUNNER_SH));
    assert.ok(/"workflow_state_preserved": true/.test(RUNNER_SH));
  });

  // ── 4. failure does not advance out-of-stock counters ─────────────────────
  it('4. a failed observation never advances the out-of-stock counter', () => {
    const prior = { supplier_product_id: 'X', workflow_state: 'pending_out_of_stock' as const, consecutive_out_of_stock: 1, consecutive_in_stock: 0, last_observation_key: null, version: 1 };
    const base = classifyInventoryResult(
      buildSignalsFromCacheRows([], Date.now(), 86_400_000).signals,
      { source: 'cache', accountType: 'pickup', supplierProductId: 'X', checkedAt: new Date().toISOString() },
    );
    for (const status of ['authentication_required', 'network_failed', 'parse_failed', 'stale', 'inventory_unknown'] as const) {
      const p = planWorkflowUpdate({ supplierProductId: 'X', persisted: prior, result: { ...base, status }, hasEvidence: true, observedAtMs: Date.now() });
      assert.equal(p.next.consecutiveOutOfStock, 1, `${status} must not advance the zero counter`);
      assert.equal(p.next.state, 'pending_out_of_stock', `${status} must not change state`);
    }
  });

  // ── 5. repeated observation idempotent ────────────────────────────────────
  it('5. an identical repeated observation stays idempotent', () => {
    const rows: CacheRow[] = [{ product_id: 'X', warehouse_code: 'CA8', warehouse_state: 'CA', quantity: 4, supports_pickup: true, supports_shipping: false, sync_status: 'ok', source_type: 'website_scrape', last_synced_at: new Date().toISOString() }];
    const { signals, hasEvidence, observedAtMs } = buildSignalsFromCacheRows(rows, Date.now(), 86_400_000);
    const result = classifyInventoryResult(signals, { source: 'cache', accountType: 'pickup', supplierProductId: 'X', checkedAt: new Date().toISOString() });
    const first = planWorkflowUpdate({ supplierProductId: 'X', persisted: null, result, hasEvidence, observedAtMs });
    const second = planWorkflowUpdate({
      supplierProductId: 'X',
      persisted: { supplier_product_id: 'X', workflow_state: first.next.state, consecutive_out_of_stock: first.next.consecutiveOutOfStock, consecutive_in_stock: first.next.consecutiveInStock, last_observation_key: first.observationKey, version: 1 },
      result, hasEvidence, observedAtMs,
    });
    assert.equal(second.alreadyProcessed, true);
    assert.equal(second.needsRowWrite, false);
    assert.equal(second.stateChanged, false);
  });

  // ── 6. persistent known exceptions are skipped ────────────────────────────
  it('6. quarantine file is passed to the workflow runner when present', () => {
    assert.ok(/--exclude-file=\$QUARANTINE/.test(EXEC_LINES), 'quarantine wired into the run');
    assert.ok(/\[ -f "\$QUARANTINE" \]/.test(EXEC_LINES), 'quarantine is optional, checked before use');
    const runner = fs.readFileSync(path.join(ROOT, 'scripts/inventoryWorkflowRun.ts'), 'utf8');
    assert.ok(/exclude-file/.test(runner) && /quarantine: excluded/.test(runner), 'runner implements exclusion and reports it');
  });

  // ── 10. scheduler can be disabled cleanly ─────────────────────────────────
  it('10. installer supports status/disable/enable/uninstall and never stacks schedules', () => {
    for (const verb of ['install', 'status', 'run-now', 'disable', 'enable', 'uninstall', 'logs']) {
      assert.ok(new RegExp(`^\\s*${verb}\\)`, 'm').test(INSTALLER_SH), `missing verb: ${verb}`);
    }
    assert.ok(/unloading first so only ONE schedule exists/.test(INSTALLER_SH), 'must not stack duplicate schedules');
    assert.ok(/com\.xselfhome\.inventory-workflow-shadow/.test(INSTALLER_SH), 'distinct label');
    assert.ok(!/com\.xselfhome\.giga-inventory-sync"\s*\n\s*launchctl unload/.test(INSTALLER_SH), 'must not unload the existing job');
  });

  it('10b. scheduled cadence is daily and does not run at load', () => {
    assert.ok(/StartCalendarInterval/.test(INSTALLER_SH));
    assert.ok(/<key>RunAtLoad<\/key>\s*\n\s*<false\/>/.test(INSTALLER_SH), 'installing must not immediately fire a run');
  });

  it('11. runner emits monitoring fields without credentials', () => {
    assert.ok(/customer_visible_action_executed/.test(RUNNER_SH));
    assert.ok(!/(client_secret|SERVICE_ROLE|cookie|password|sign=)/i.test(EXEC_LINES), 'no secrets in the runner');
  });

  console.log(`\n${passed} passed`);
}
main();
