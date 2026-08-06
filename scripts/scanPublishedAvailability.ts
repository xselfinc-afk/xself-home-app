/**
 * scanPublishedAvailability.ts — API-ONLY availability scan for every published product.
 *
 * Reads the GIGA Open API (credential-signed) and proposes lifecycle transitions. There is NO
 * browser anywhere in this path: no Playwright, no Chrome, no storefront XHR, no session cookies.
 * The only network calls are `/b2b-overseas-api/v1/buyer/product/price/v1` batches.
 *
 * DRY-RUN BY DEFAULT. `--live` is required before anything is written, and even then every write is
 * additionally gated by the remote safety config (all switches default OFF) and by the failure-rate,
 * per-run count and per-run percentage caps.
 *
 * Reuses, rather than reimplements:
 *   src/services/gigaApiClient.ts            — the signed Open API client
 *   src/services/openApiAvailability.ts      — response → status classification
 *   src/services/inventoryStateMachine.ts    — two-confirmation delist/relist + P1..P4
 *   src/services/inventoryAutomationConfig.ts— kill switches and caps
 *   sellable_products / standardized_products— the existing visibility contract
 *
 * Usage:
 *   npm run inventory:published:scan                  # dry-run, all published SKUs
 *   npm run inventory:published:scan -- --live        # apply (still gated by config switches)
 *   npm run inventory:published:scan -- --skus=A,B    # explicit SKUs
 *   npm run inventory:published:scan -- --limit=50    # bounded batch
 *
 * Exit codes: 0 ok · 1 fatal · 2 failure-rate abort · 3 safety-gate blocked · 4 lock held.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  INVENTORY_AUTOMATION_DEFAULTS,
  evaluateDelistBatchAllowed,
  evaluateFailureRateAllowed,
  evaluateSourceScanAllowed,
  type InventoryAutomationConfig,
} from '../src/services/inventoryAutomationConfig';
import {
  OPEN_API_SOURCE,
  classifyBatch,
  extractRows,
  isApiConfirmed,
  redactReason,
  tally,
  type AvailabilityResult,
  type BatchOutcome,
} from '../src/services/openApiAvailability';
import {
  applyStandardizedInventoryProjection,
  deriveStandardizedInventoryProjection,
} from '../src/services/standardizedInventoryProjection';
import {
  DEFAULT_STATE_MACHINE_POLICY,
  transitionInventoryState,
  type InventoryWorkflowState,
  type WorkflowSnapshot,
} from '../src/services/inventoryStateMachine';
import { decideWithInterval } from '../src/services/confirmationInterval';
import {
  assertNoPublicationWrite,
  planPersistence,
  tallyPlans,
  type PersistencePlan,
  type PriorCurrentRow,
} from '../src/services/availabilityPersistence';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => argv.find(a => a.startsWith(`--${f}=`))?.split('=').slice(1).join('=');

const LIVE = has('--live');
const DRY = !LIVE;                       // dry-run unless --live is explicit
const ONLY_SKUS = (val('skus') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const LIMIT = Math.max(0, parseInt(val('limit') ?? '0', 10) || 0);
const XONE_TARGETED_TOKEN = val('xone-targeted') ?? '';
const BATCH = 200;                        // the Open API accepts up to 200 SKUs per call
const REPORT_DIR = path.join(process.cwd(), 'reports', 'inventory-availability');
const LOCK_PATH = path.join(REPORT_DIR, '.scan.lock');
const LOCK_STALE_MS = 30 * 60 * 1000;

const die = (code: number, msg: string, extra: Record<string, unknown> = {}): never => {
  console.error(`INVENTORY_SCAN_ERROR ${msg}`);
  for (const [k, v] of Object.entries(extra)) console.error(`  ${k}=${String(v)}`);
  process.exit(code);
};

/** Single-run lock so a scheduled run can never overlap a manual one. Self-heals on a dead PID. */
function acquireLock(): boolean {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8');
    const info = JSON.parse(raw) as { pid: number; at: string };
    const age = Date.now() - Date.parse(info.at);
    let alive = false;
    try { process.kill(info.pid, 0); alive = true; } catch { alive = false; }
    if (alive && age < LOCK_STALE_MS) return false;
  } catch { /* no lock, or unreadable → reclaim */ }
  fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
  return true;
}
const releaseLock = () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* best effort */ } };

const chunk = <T,>(a: T[], n: number): T[][] => {
  const o: T[][] = [];
  for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n));
  return o;
};

/** Call the Open API for one batch and normalise every failure mode into a BatchOutcome. */
async function fetchBatch(skus: string[]): Promise<BatchOutcome> {
  try {
    const { fetchProductPrices } = await import('../src/services/gigaApiClient');
    const raw = await fetchProductPrices(skus);
    return { kind: 'ok', rows: raw };
  } catch (e) {
    const msg = redactReason(e);
    if (/429|rate.?limit|too many/i.test(msg)) return { kind: 'rate_limited', message: msg };
    if (/ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|network|timeout|fetch failed/i.test(msg)) {
      return { kind: 'network_error', message: msg };
    }
    if (/JSON|parse|unexpected token/i.test(msg)) return { kind: 'malformed', message: msg };
    return { kind: 'api_error', message: msg };
  }
}

/** Price rows that carried no usable `skuAvailable`. Only these need the detail fallback. */
const NEEDS_DETAIL_FALLBACK = (r: AvailabilityResult): boolean =>
  r.status === 'malformed_response' && r.reason === 'skuAvailable missing or non-boolean';

/**
 * Ask `/detailInfo/v1` for the handful of SKUs whose price row omitted `skuAvailable`.
 *
 * Some products report the flag only on the detail endpoint. Without this they stayed
 * `malformed_response` on every run, never got an availability row, and so were absent from
 * `sellable_products` while still published and in stock. This is the same price-then-detail
 * precedence the targeted read client already uses.
 *
 * A failure here is not an answer: the map comes back empty and the SKUs remain
 * `malformed_response`, which is non-authoritative and can never delist.
 */
async function fetchDetailFallback(skus: string[]): Promise<Map<string, { skuAvailable?: unknown }>> {
  const bySku = new Map<string, { skuAvailable?: unknown }>();
  if (!skus.length) return bySku;
  try {
    const { fetchProductDetails } = await import('../src/services/gigaApiClient');
    const rows = extractRows(await fetchProductDetails(skus));
    for (const row of rows ?? []) {
      const key = row?.sku ?? row?.skuCode;
      if (typeof key === 'string' && key) bySku.set(key, row);
    }
  } catch (e) {
    console.log(`  detail fallback unavailable → ${redactReason(e)}`);
  }
  return bySku;
}

interface Proposal {
  sku: string;
  status: AvailabilityResult['status'];
  available: boolean | null;
  reason: string;
  previousState: InventoryWorkflowState;
  proposedState: InventoryWorkflowState;
  proposedAction: string;
  priorityClass: string;
  isException: boolean;
  publishedNow: boolean;
  visibleNow: boolean;
  /** True when the API answer contradicts what the customer can currently see. */
  visibilityDisagreement: boolean;
}

async function main(): Promise<void> {
  if (XONE_TARGETED_TOKEN && (!/^[A-Za-z0-9_-]{8,80}$/.test(XONE_TARGETED_TOKEN) || ONLY_SKUS.length !== 1)) {
    die(1, '--xone-targeted requires one explicit SKU and a safe request token');
  }
  const RUN_ID = `avail-${new Date().toISOString()}-${process.pid}`;
  const startedAt = new Date().toISOString();

  if (!acquireLock()) die(4, 'another scan is already running', { lock: path.relative(process.cwd(), LOCK_PATH) });

  try {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) die(1, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (scripts only)');
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url!, key!, { auth: { persistSession: false } });

    // ── Config: every switch defaults OFF; a missing/unreadable row keeps defaults ───────────
    let cfg: InventoryAutomationConfig = { ...INVENTORY_AUTOMATION_DEFAULTS };
    try {
      const { loadInventoryConfigForScript } = await import('./lib/inventoryConfigClient');
      cfg = await loadInventoryConfigForScript();
    } catch { /* defaults — fail safe */ }

    const scanGate = evaluateSourceScanAllowed(cfg, OPEN_API_SOURCE);

    // ── 1. Enumerate currently published / customer-visible SKUs ─────────────────────────────
    const visible = new Set<string>();
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from('sellable_products').select('supplier_product_id').range(f, f + 999);
      if (error) die(1, `sellable_products read failed: ${error.message}`);
      (data ?? []).forEach(r => visible.add(r.supplier_product_id));
      if (!data || data.length < 1000) break;
    }
    // `sku_custom` and the two inventory fields ride along so the standardized projection can run
    // from the same read — matched by XSelf SKU, compared against the values already stored.
    const STD_COLS = 'supplier_product_id,sku_custom,published,inventory_status,total_available_qty';
    const published: Array<{
      sku: string; published: boolean; xselfSku: string | null;
      inventoryStatus: string | null; totalQty: number | null;
    }> = [];
    const pushProduct = (r: Record<string, unknown>) => published.push({
      sku: r.supplier_product_id as string,
      published: Boolean(r.published),
      xselfSku: (r.sku_custom as string | null) ?? null,
      inventoryStatus: (r.inventory_status as string | null) ?? null,
      totalQty: r.total_available_qty == null ? null : Number(r.total_available_qty),
    });
    if (XONE_TARGETED_TOKEN) {
      // A human-confirmed review may target a currently delisted item. The explicit one-SKU
      // allowlist is still bounded, and every observation follows the same API/state-machine path.
      const { data, error } = await sb.from('standardized_products')
        .select(STD_COLS).in('supplier_product_id', ONLY_SKUS);
      if (error) die(1, `standardized_products targeted read failed: ${error.message}`);
      (data ?? []).forEach(pushProduct);
    } else {
      for (let f = 0; ; f += 1000) {
        const { data, error } = await sb.from('standardized_products')
          .select(STD_COLS).eq('published', true).range(f, f + 999);
        if (error) die(1, `standardized_products read failed: ${error.message}`);
        (data ?? []).forEach(pushProduct);
        if (!data || data.length < 1000) break;
      }
    }

    let targets = published.map(p => p.sku);
    if (ONLY_SKUS.length) targets = targets.filter(s => ONLY_SKUS.includes(s));
    targets = targets.slice(0, LIMIT || cfg.maxScanPerRun);

    // ── 2. Existing lifecycle state (never invented) ─────────────────────────────────────────
    const priorState = new Map<string, WorkflowSnapshot>();
    /** `last_observed_at` per SKU — when a confirmation last COUNTED (see confirmationInterval.ts). */
    const priorObserved = new Map<string, string | null>();
    /** version + last_observation_key, for optimistic concurrency and duplicate suppression. */
    const priorMeta = new Map<string, { version: number; key: string | null }>();
    for (const c of chunk(targets, 200)) {
      // Column is `workflow_state`, not `state`. The error MUST be inspected: a silently failed
      // read leaves priorState empty, which pins the consecutive counters at 1 forever and means
      // the second strike — and therefore delist eligibility — can never be reached.
      const { data, error } = await sb.from('inventory_workflow_states')
        .select('supplier_product_id,workflow_state,consecutive_out_of_stock,consecutive_in_stock,last_observed_at,last_observation_key,version')
        .in('supplier_product_id', c);
      if (error) die(1, `inventory_workflow_states read failed: ${error.message}`);
      for (const r of data ?? []) {
        priorState.set(r.supplier_product_id, {
          state: r.workflow_state as InventoryWorkflowState,
          consecutiveOutOfStock: r.consecutive_out_of_stock ?? 0,
          consecutiveInStock: r.consecutive_in_stock ?? 0,
        });
        priorObserved.set(r.supplier_product_id, r.last_observed_at ?? null);
        priorMeta.set(r.supplier_product_id, { version: r.version ?? 1, key: r.last_observation_key ?? null });
      }
    }

    // ── 3. Scan ──────────────────────────────────────────────────────────────────────────────
    console.log(`INVENTORY_SCAN run=${RUN_ID} mode=${DRY ? 'DRY-RUN' : 'LIVE'} targets=${targets.length} batch=${BATCH}`);
    const results: AvailabilityResult[] = [];
    for (const batch of chunk(targets, BATCH)) {
      const outcome = await fetchBatch(batch);
      let classified = classifyBatch(batch, outcome);

      // Only re-read the SKUs whose price row had no usable flag — normally a handful per run.
      const needsDetail = classified.filter(NEEDS_DETAIL_FALLBACK).map(r => r.sku);
      if (needsDetail.length) {
        const detailBySku = await fetchDetailFallback(needsDetail);
        if (detailBySku.size) classified = classifyBatch(batch, outcome, detailBySku);
        const recovered = classified.filter(r => needsDetail.includes(r.sku) && !NEEDS_DETAIL_FALLBACK(r)).length;
        console.log(`  detail fallback ${needsDetail.length} sku → ${recovered} resolved`);
      }

      results.push(...classified);
      console.log(`  batch ${batch.length} → ${outcome.kind}`);
    }

    const t = tally(results);
    const failureGate = evaluateFailureRateAllowed(cfg, t.failurePercent);

    // ── 4. Propose transitions via the EXISTING state machine ────────────────────────────────
    const policy = {
      ...DEFAULT_STATE_MACHINE_POLICY,
      outOfStockConfirmationsRequired: cfg.outOfStockConfirmations,
      inStockConfirmationsRequired: cfg.relistConfirmations,
    };
    const publishedBySku = new Map(published.map((product) => [product.sku, product.published]));
    const publishedBySkuRow = new Map(published.map((product) => [product.sku, product]));
    const proposals: Proposal[] = results.map(r => {
      const prior = priorState.get(r.sku) ?? { state: 'published_in_stock' as InventoryWorkflowState, consecutiveOutOfStock: 0, consecutiveInStock: 0 };
      const tr = transitionInventoryState(prior, r.inventoryStatus, policy);
      const publishedNow = publishedBySku.get(r.sku) ?? false;
      const visibleNow = visible.has(r.sku);
      return {
        sku: r.sku, status: r.status, available: r.available, reason: r.reason,
        previousState: prior.state, proposedState: tr.next.state,
        proposedAction: tr.proposedAction, priorityClass: String(tr.priorityClass),
        isException: tr.isException, publishedNow, visibleNow,
        visibilityDisagreement: visibleNow && r.status === 'confirmed_out_of_stock',
      };
    });

    const delists = proposals.filter(p => p.proposedAction === 'propose_delist');
    const relists = proposals.filter(p => p.proposedAction === 'propose_relist');
    const firstStrike = proposals.filter(p => p.proposedAction === 'mark_pending_out_of_stock');
    const relistPending = proposals.filter(p => p.proposedAction === 'mark_relist_pending');
    const disagreements = proposals.filter(p => p.visibilityDisagreement);
    const delistGate = evaluateDelistBatchAllowed(cfg, { proposedDelistCount: delists.length, totalPublished: proposals.length });

    // ── 5. Report (redacted; no raw bodies, no credentials) ──────────────────────────────────
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = XONE_TARGETED_TOKEN
      ? path.join(REPORT_DIR, `xone-targeted-${XONE_TARGETED_TOKEN}.json`)
      : path.join(REPORT_DIR, 'latest-availability-scan.json');
    const report = {
      run_id: RUN_ID, started_at: startedAt, finished_at: new Date().toISOString(),
      mode: DRY ? 'dry_run' : 'live',
      source: OPEN_API_SOURCE,
      endpoint: '/b2b-overseas-api/v1/buyer/product/price/v1',
      browser_used: false,
      report_kind: XONE_TARGETED_TOKEN ? 'xone_single_sku_recheck' : 'scheduled_inventory_scan',
      database_rows_written: 0,
      totals: t,
      gates: { scan: scanGate, failureRate: failureGate, delistBatch: delistGate },
      counts: {
        published_targets: targets.length,
        visible_now: proposals.filter(p => p.visibleNow).length,
        first_strike: firstStrike.length,
        second_strike_delist: delists.length,
        relist_pending: relistPending.length,
        relist_eligible: relists.length,
        visibility_disagreements: disagreements.length,
        exceptions: proposals.filter(p => p.isException).length,
      },
      proposals,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // ── 6. Summary ───────────────────────────────────────────────────────────────────────────
    console.log('\nINVENTORY_SCAN_SUMMARY');
    console.log(`run_id=${RUN_ID}`);
    console.log(`mode=${DRY ? 'dry_run' : 'live'}`);
    console.log(`browser_used=false`);
    console.log(`scanned=${t.total}`);
    console.log(`confirmed_available=${t.confirmedAvailable}`);
    console.log(`confirmed_out_of_stock=${t.confirmedOutOfStock}`);
    console.log(`failures=${t.failures}`);
    console.log(`failure_percent=${t.failurePercent}`);
    for (const [k, v] of Object.entries(t.byStatus)) console.log(`status_${k}=${v}`);
    console.log(`first_strike=${firstStrike.length}`);
    console.log(`second_strike_delist=${delists.length}`);
    console.log(`relist_pending=${relistPending.length}`);
    console.log(`relist_eligible=${relists.length}`);
    console.log(`visibility_disagreements=${disagreements.length}`);
    console.log(`scan_gate_allowed=${scanGate.allowed} blocks=${scanGate.blocks.join(',') || 'none'}`);
    console.log(`failure_gate_allowed=${failureGate.allowed} blocks=${failureGate.blocks.join(',') || 'none'}`);
    console.log(`delist_gate_allowed=${delistGate.allowed} blocks=${delistGate.blocks.join(',') || 'none'}`);
    console.log(`report=${path.relative(process.cwd(), reportPath)}`);
    console.log(`database_rows_written=0`);

    if (disagreements.length) {
      console.log('\nVISIBILITY DISAGREEMENTS (visible in app, supplier says unavailable):');
      for (const d of disagreements) console.log(`  ${d.sku}  ${d.previousState} → ${d.proposedState}  ${d.proposedAction}`);
    }

    if (!failureGate.allowed) {
      console.error(`\nABORT: failure rate ${t.failurePercent}% exceeds max ${cfg.maxFailurePercent}% — nothing applied.`);
      releaseLock();
      process.exit(2);
    }

    if (LIVE) {
      // ── Scope 2 kill switch: production evidence writes require the scan switch ────────────
      // Dry-run is unaffected; only writes are gated. The override exists solely so automated
      // tests can exercise the live path, and it is documented, not a silent production bypass.
      const TEST_OVERRIDE = process.env.INVENTORY_SCAN_TEST_OVERRIDE === '1';
      if (!scanGate.allowed && !TEST_OVERRIDE) {
        console.error(`\nBLOCKED: live writes require inventory_api_scan_enabled=true (and inventory_automation_enabled).`);
        console.error(`  blocks=${scanGate.blocks.join(',')}`);
        console.error(`  nothing was written.`);
        releaseLock();
        process.exit(3);
      }
      if (TEST_OVERRIDE) console.log('WARNING test override active — INVENTORY_SCAN_TEST_OVERRIDE=1');

      // ── PHASE 1 LIVE WRITE: evidence + lifecycle ONLY ──────────────────────────────────────
      // Publication is untouched. Delist/relist remain gated by autoDelistEnabled /
      // autoRelistEnabled and are NOT performed here regardless of the proposed action.
      const checkedAt = new Date().toISOString();

      // Existing confirmed answers, so a failure can annotate rather than displace them.
      const priorCurrent = new Map<string, PriorCurrentRow>();
      for (const c of chunk(targets, 200)) {
        const { data, error } = await sb.from('product_availability_current')
          .select('supplier_product_id,available,status,checked_at,last_confirmed_available_at,last_confirmed_unavailable_at,consecutive_failures')
          .in('supplier_product_id', c);
        if (error) die(1, `product_availability_current read failed: ${error.message} — is the persistence migration applied?`);
        for (const r of data ?? []) priorCurrent.set(r.supplier_product_id, r as PriorCurrentRow);
      }

      const plans: PersistencePlan[] = results.map(r => planPersistence(r, priorCurrent.get(r.sku) ?? null, RUN_ID, checkedAt));
      assertNoPublicationWrite(plans);   // throws rather than writing a publication field
      const pt = tallyPlans(plans);

      let auditInserted = 0, currentUpserted = 0, failureAnnotated = 0, workflowWritten = 0, writeFailed = 0;
      const writeErrors: string[] = [];

      // Audit rows first (idempotent on run_id+supplier_product_id).
      for (const c of chunk(plans.map(p => p.checkRow), 100)) {
        const { data, error } = await sb.from('product_availability_checks')
          .upsert(c, { onConflict: 'run_id,supplier_product_id' }).select('supplier_product_id');
        if (error) { writeFailed += c.length; writeErrors.push(`audit: ${error.message}`); continue; }
        auditInserted += (data ?? []).length;
      }

      // Confirmed answers → the authoritative current row. Failures can never reach this table.
      const upserts = plans.map(p => p.currentUpsert).filter(Boolean) as NonNullable<PersistencePlan['currentUpsert']>[];
      for (const c of chunk(upserts, 100)) {
        const { data, error } = await sb.from('product_availability_current')
          .upsert(c, { onConflict: 'supplier_product_id' }).select('supplier_product_id');
        if (error) { writeFailed += c.length; writeErrors.push(`current: ${error.message}`); continue; }
        currentUpserted += (data ?? []).length;
      }

      // Failure telemetry — annotates an existing row, never creates or zeroes one.
      for (const p of plans) {
        if (!p.failureUpdate) continue;
        const { supplier_product_id, ...patch } = p.failureUpdate;
        const { data, error } = await sb.from('product_availability_current')
          .update(patch).eq('supplier_product_id', supplier_product_id).select('supplier_product_id');
        if (error) { writeFailed++; writeErrors.push(`failure-annotate ${supplier_product_id}: ${error.message}`); continue; }
        failureAnnotated += (data ?? []).length;
      }

      // Lifecycle counters LAST. If this step fails, the next run re-plans from the unchanged
      // persisted row and the new observation — consistent, never half-advanced.
      //
      // The minimum-confirmation-interval guard lives here: a confirmed observation advances a
      // counter only when it is a genuinely separate observation cycle. `last_observed_at` moves
      // ONLY when the observation counted, so it means "when a confirmation last counted".
      let tooSoon = 0, alreadyProcessed = 0, versionConflicts = 0;
      for (const r of results) {
        const prior = priorState.get(r.sku) ?? { state: 'published_in_stock' as InventoryWorkflowState, consecutiveOutOfStock: 0, consecutiveInStock: 0 };
        const priorObservedAt = priorObserved.get(r.sku) ?? null;
        const d = decideWithInterval({
          prior,
          status: r.inventoryStatus,
          lastConfirmedAtIso: priorObservedAt,
          nowIso: checkedAt,
          minIntervalHours: cfg.minConfirmationIntervalHours,
          policy,
        });

        if (d.outcome === 'no_confirmation') continue;              // failures write nothing
        if (d.outcome === 'duplicate_or_too_soon') { tooSoon++; continue; }

        const meta = priorMeta.get(r.sku);
        const observationKey = `${r.sku}|${checkedAt}|${r.status}`;

        // Idempotency: this exact observation was already committed — write nothing.
        if (meta && meta.key === observationKey) { alreadyProcessed++; continue; }

        const row = {
          supplier_product_id: r.sku,
          workflow_state: d.next.state,
          consecutive_out_of_stock: d.next.consecutiveOutOfStock,
          consecutive_in_stock: d.next.consecutiveInStock,
          last_observed_inventory_status: r.status,
          last_observed_at: checkedAt,          // advanced ONLY because this observation counted
          last_observation_key: observationKey,
          transition_reason: d.reason,
          updated_at: checkedAt,
        };

        if (meta) {
          // Optimistic concurrency: a concurrent run that already advanced this row bumps `version`,
          // so this update matches zero rows and we skip rather than clobbering its counters.
          const { data, error } = await sb.from('inventory_workflow_states')
            .update({ ...row, version: meta.version + 1 })
            .eq('supplier_product_id', r.sku)
            .eq('version', meta.version)
            .select('supplier_product_id');
          if (error) { writeFailed++; writeErrors.push(`workflow ${r.sku}: ${error.message}`); continue; }
          if ((data ?? []).length === 0) { versionConflicts++; continue; }
          workflowWritten += 1;
        } else {
          const { data, error } = await sb.from('inventory_workflow_states')
            .insert({ ...row, version: 1 }).select('supplier_product_id');
          if (error) { writeFailed++; writeErrors.push(`workflow ${r.sku}: ${error.message}`); continue; }
          workflowWritten += (data ?? []).length;
        }
      }

      // ── Standardized display fields, from the SAME shared projection the bridge uses ────────
      // The scan reads a single channel and gets no quantity from `/price/v1`, so in practice it
      // raises a product to `in_stock` and keeps the previous reliable number (rule E). It can
      // never write a zero on its own: a zero needs two independent channels to agree.
      let stdWriteAttempted = 0, stdWriteSucceeded = 0, stdSkippedNoChange = 0, stdSkippedUnreliable = 0;
      const stdErrors: string[] = [];
      for (const r of results) {
        const product = publishedBySkuRow.get(r.sku);
        if (!product?.xselfSku) continue;   // no XSelf SKU to match on exactly — never widen the filter
        const projection = deriveStandardizedInventoryProjection({
          channels: [{
            channel: OPEN_API_SOURCE,
            read_ok: isApiConfirmed(r.status),
            available: r.available,
            quantity: null,                 // the price endpoint carries no quantity, and none is invented
            failure_reason: isApiConfirmed(r.status) ? null : r.status,
          }],
          currentInventoryStatus: product.inventoryStatus,
          currentTotalAvailableQty: product.totalQty,
          evidenceCheckedAt: checkedAt,
        });
        if (!projection.should_write) {
          if (projection.reason === 'no_change') stdSkippedNoChange++; else stdSkippedUnreliable++;
          continue;
        }
        stdWriteAttempted++;
        const write = await applyStandardizedInventoryProjection(
          sb as never, product.xselfSku, projection, product.inventoryStatus, product.totalQty,
        );
        if (write.standardized_inventory_write_succeeded) stdWriteSucceeded++;
        else stdErrors.push(`std-inventory ${r.sku}: ${write.error ?? 'unknown'}`);
      }

      console.log('\nLIVE_WRITE_SUMMARY');
      console.log(`audit_rows_written=${auditInserted}`);
      console.log(`standardized_inventory_write_attempted=${stdWriteAttempted}`);
      console.log(`standardized_inventory_write_succeeded=${stdWriteSucceeded}`);
      console.log(`standardized_inventory_skipped_no_change=${stdSkippedNoChange}`);
      console.log(`standardized_inventory_skipped_unreliable=${stdSkippedUnreliable}`);
      for (const e of stdErrors.slice(0, 10)) console.log(`  standardized_inventory_error=${redactReason(e)}`);
      console.log(`current_rows_upserted=${currentUpserted}`);
      console.log(`current_unchanged_answer=${pt.unchanged}`);
      console.log(`failure_rows_annotated=${failureAnnotated}`);
      console.log(`workflow_rows_written=${workflowWritten}`);
      console.log(`skipped_too_soon_min_interval=${tooSoon}`);
      console.log(`skipped_already_processed=${alreadyProcessed}`);
      console.log(`skipped_version_conflict=${versionConflicts}`);
      console.log(`min_confirmation_interval_hours=${cfg.minConfirmationIntervalHours}`);
      console.log(`skipped_failures_no_prior_row=${pt.failures - failureAnnotated}`);
      console.log(`write_failed=${writeFailed}`);
      for (const e of writeErrors.slice(0, 10)) console.log(`  write_error=${redactReason(e)}`);
      console.log(`publication_fields_written=0`);
      console.log(`products_delisted=0`);
      console.log(`products_relisted=0`);

      releaseLock();
      process.exit(writeFailed > 0 ? 1 : 0);
    }

    releaseLock();
  } catch (e) {
    releaseLock();
    die(1, redactReason(e));
  }
}

main().catch(e => { releaseLock(); die(1, redactReason(e)); });
