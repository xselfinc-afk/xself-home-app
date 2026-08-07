/**
 * Fixed, versioned XOne bridge for the existing Inventory Lifecycle.
 *
 * This file is intentionally an adapter only: it reads the established lifecycle tables/reports
 * and triggers the established LaunchAgent one-run path. It does not implement inventory rules,
 * mutate lifecycle state, or expose credentials to XOne.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { loadInventoryConfigForScript } from './lib/inventoryConfigClient';
import {
  readSupplierAccountProductFacts,
  SupplierTargetedReadError,
  type SupplierAccountProductFacts,
} from './lib/gigaAccountReadClient';
import {
  acceptCapabilityVerifiedIdentity,
  isPendingCapabilityVerification,
  isResolvedInventoryLookupIdentity,
  resolveInventoryLookupIdentity,
  type ResolvedInventoryLookupIdentity,
} from '../src/services/supplierInventoryLookupIdentity';
import { planPersistence, assertNoPublicationWrite, type PriorCurrentRow } from '../src/services/availabilityPersistence';
import {
  applyStandardizedInventoryProjection,
  channelFromAccountFacts,
  deriveStandardizedInventoryProjection,
} from '../src/services/standardizedInventoryProjection';
import { transitionInventoryState, type InventoryWorkflowState } from '../src/services/inventoryStateMachine';
import type { AvailabilityResult } from '../src/services/openApiAvailability';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

export const XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION = '1.0';
export const INVENTORY_LIFECYCLE_LOOP_ID = 'inventory-lifecycle';

const REPO = process.cwd();
const REPORT_DIR = path.join(REPO, 'reports', 'inventory-availability');
const LATEST_REPORT = path.join(REPORT_DIR, 'latest-availability-scan.json');
const SCAN_LOCK = path.join(REPORT_DIR, '.scan.lock');
const APPLY_LOCK = path.join(REPORT_DIR, '.lifecycle-apply.lock');
const SCHEDULER_SCRIPT = path.join(REPO, 'scripts', 'installAvailabilityScanScheduler.sh');
const SCHEDULER_LABEL = 'com.xselfhome.inventory-availability-scan';
const SCHEDULER_PLIST = path.join(
  process.env.HOME ?? '',
  'Library',
  'LaunchAgents',
  `${SCHEDULER_LABEL}.plist`,
);
const INTERVAL_SECONDS = 172_800;
const LOCK_STALE_MS = 30 * 60 * 1000;
const MAX_REQUEST_BYTES = 16_384;
const MAX_ITEMS_LIMIT = 100;
const MAX_RUNS_LIMIT = 50;
/**
 * The window `sellable_products` accepts availability evidence within, via
 * latest_product_availability.within_grace. Coverage must be measured against the SAME window
 * the storefront enforces: evidence older than this is already invisible to customers, so
 * counting it as "covered" reports health during an outage.
 *
 * 120h absorbs two missed 48h scan cycles. The previous 72h could not absorb even one
 * (48 + 48 = 96 > 72), which is why a single failed scan emptied the storefront on 2026-08-05.
 *
 * KEEP IN SYNC: supabase/migrations/20260808_availability_grace_120h.sql
 */
const AVAILABILITY_GRACE_HOURS = 120;
/**
 * Targeted recheck works for any pending SKU. The restore write stays behind an
 * explicit local switch so a read-only recheck can never publish by accident.
 */
const RESTORE_EXECUTION_ENABLED = process.env.XONE_INVENTORY_RESTORE_ENABLED === 'true';

export type InventoryLifecycleBucket =
  | 'pending'
  | 'eligible'
  | 'delisted'
  | 'relisted'
  | 'blocked'
  | 'errors';

export type InventoryLifecycleBridgeRequest =
  | { schema_version: '1.0'; operation: 'summary' }
  | { schema_version: '1.0'; operation: 'items'; bucket: InventoryLifecycleBucket; limit?: number; cursor?: number; sku?: string }
  | { schema_version: '1.0'; operation: 'runs'; limit?: number; cursor?: number }
  | { schema_version: '1.0'; operation: 'recheck-item'; sku: string; operator: string }
  | { schema_version: '1.0'; operation: 'run-now' };

type WorkflowRow = {
  supplier_product_id: string;
  supplier_sku: string | null;
  workflow_state: string;
  consecutive_out_of_stock: number;
  consecutive_in_stock: number;
  last_observed_inventory_status: string | null;
  last_observed_at: string | null;
  last_transition_at: string | null;
  transition_reason: string | null;
  last_observation_key?: string | null;
  version: number;
};

type AvailabilityRow = {
  supplier_product_id: string;
  source: string;
  available: boolean;
  status: string;
  last_run_id: string;
  checked_at: string;
  consecutive_failures: number;
  last_failure_status: string | null;
  last_failure_reason: string | null;
  last_failure_at: string | null;
};

type ProductRow = {
  supplier_product_id: string;
  sku_custom: string | null;
  product_title: string | null;
  published: boolean | null;
  delist_reason: string | null;
  primary_image: string | null;
  selling_price: number | string | null;
  specifications_json: unknown;
  inventory_status?: string | null;
  total_available_qty?: number | string | null;
};

type SupplierRelationshipRow = {
  supplier_product_id: string;
  raw_payload: Record<string, unknown> | null;
};

type HoldRow = {
  supplier_product_id: string;
  reason: string;
  held_by: string;
  held_until: string | null;
};

type AuditRow = {
  supplier_product_id: string;
  action: 'delist' | 'relist';
  actor: string;
  run_id: string | null;
  evidence_checked_at: string | null;
  created_at: string;
};

type TransitionRow = {
  supplier_product_id: string;
  supplier_sku: string | null;
  from_state: string;
  to_state: string;
  proposed_action: string | null;
  observed_exception: string | null;
  reason: string;
  run_id: string;
  runner: string;
  transitioned_at: string;
};

type AvailabilityCheckRow = {
  supplier_product_id: string;
  available: boolean | null;
  status: string;
  failure_reason: string | null;
  run_id: string;
  checked_at: string;
};

type RecommendationEvidence = {
  run_id: string;
  proposed_action: 'propose_delist';
  previous_state: string;
  proposed_state: string;
  supplier_status: string;
  report_reason: string;
  report_confirmation_count: number;
  authoritative_confirmation_count: number;
  first_out_of_stock_at: string | null;
  latest_out_of_stock_at: string | null;
  actual_confirmation_interval_hours: number | null;
  minimum_confirmation_interval_hours: number;
  confirmation_threshold: number;
  threshold_reached_in_report: boolean;
  threshold_currently_reached: boolean;
  has_hold: boolean;
  hold_reason: string | null;
  approval_required: boolean;
  auto_delist_enabled: boolean;
  apply_gate_allowed: boolean;
  apply_gate_blocks: string[];
  suggested_action: 'review_delist';
  currently_executable: false;
  explanation: string;
};

export function parseInventoryLifecycleBridgeRequest(raw: string): InventoryLifecycleBridgeRequest {
  if (!raw.trim() || raw.length > MAX_REQUEST_BYTES) throw new Error('INVALID_REQUEST');
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  if (value.schema_version !== XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION) throw new Error('INVALID_REQUEST');
  const operation = value.operation;
  const allowedByOperation: Record<string, Set<string>> = {
    summary: new Set(['schema_version', 'operation']),
    items: new Set(['schema_version', 'operation', 'bucket', 'limit', 'cursor', 'sku']),
    runs: new Set(['schema_version', 'operation', 'limit', 'cursor']),
    'recheck-item': new Set(['schema_version', 'operation', 'sku', 'operator']),
    'run-now': new Set(['schema_version', 'operation']),
  };
  if (typeof operation !== 'string' || !allowedByOperation[operation]) throw new Error('INVALID_REQUEST');
  if (Object.keys(value).some((key) => !allowedByOperation[operation].has(key))) throw new Error('INVALID_REQUEST');
  if (operation === 'items') {
    const buckets = new Set<InventoryLifecycleBucket>(['pending', 'eligible', 'delisted', 'relisted', 'blocked', 'errors']);
    if (!buckets.has(value.bucket as InventoryLifecycleBucket)) throw new Error('INVALID_BUCKET');
    validateBoundedInteger(value.limit, 1, MAX_ITEMS_LIMIT, 'INVALID_LIMIT');
    validateBoundedInteger(value.cursor, 0, 1_000_000, 'INVALID_CURSOR');
    if (value.sku !== undefined && (typeof value.sku !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.sku))) {
      throw new Error('INVALID_SKU');
    }
  }
  if (operation === 'runs') {
    validateBoundedInteger(value.limit, 1, MAX_RUNS_LIMIT, 'INVALID_LIMIT');
    validateBoundedInteger(value.cursor, 0, 1_000_000, 'INVALID_CURSOR');
  }
  if (operation === 'recheck-item') {
    if (typeof value.sku !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.sku)) throw new Error('INVALID_SKU');
    if (typeof value.operator !== 'string' || !value.operator.trim() || value.operator.length > 40 || /[\u0000-\u001f\u007f]/.test(value.operator)) {
      throw new Error('INVALID_OPERATOR');
    }
  }
  return value as InventoryLifecycleBridgeRequest;
}

function validateBoundedInteger(value: unknown, min: number, max: number, code: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(code);
}

function success(operation: string, payload: Record<string, unknown>): Record<string, unknown> {
  const generatedAt = new Date().toISOString();
  return {
    schema_version: XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION,
    ok: true,
    operation,
    loop_id: INVENTORY_LIFECYCLE_LOOP_ID,
    source_system: 'xself-home-app',
    source_observed_at: generatedAt,
    data_source: 'live',
    generated_at: generatedAt,
    last_success_at: generatedAt,
    cache_age: 0,
    is_stale: false,
    error_code: null,
    production_write_attempted: false,
    ...payload,
  };
}

function failure(code: string, message: string): Record<string, unknown> {
  const generatedAt = new Date().toISOString();
  return {
    schema_version: XONE_INVENTORY_LIFECYCLE_SCHEMA_VERSION,
    ok: false,
    loop_id: INVENTORY_LIFECYCLE_LOOP_ID,
    source_system: 'xself-home-app',
    source_observed_at: generatedAt,
    data_source: 'unavailable',
    generated_at: generatedAt,
    last_success_at: null,
    cache_age: null,
    is_stale: true,
    error_code: code,
    production_write_attempted: false,
    error: { code, message },
  };
}

function mustRows<T>(result: { data: T[] | null; error: { message: string } | null }, tag: string): T[] {
  if (result.error) throw new Error(`READ_FAILED:${tag}`);
  return result.data ?? [];
}

function readLatestReport(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(LATEST_REPORT, 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readActiveLock(file: string): { active: boolean; pid: number | null; at: string | null; kind: string } {
  const kind = path.basename(file).includes('apply') ? 'apply' : 'scan';
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number; at?: string };
    const age = parsed.at ? Date.now() - Date.parse(parsed.at) : Number.POSITIVE_INFINITY;
    const active = Boolean(parsed.pid && processAlive(parsed.pid) && age >= 0 && age < LOCK_STALE_MS);
    return { active, pid: active ? parsed.pid ?? null : null, at: active ? parsed.at ?? null : null, kind };
  } catch {
    return { active: false, pid: null, at: null, kind };
  }
}

export function readSchedulerFact(): Record<string, unknown> {
  const installed = Boolean(process.env.HOME) && fs.existsSync(SCHEDULER_PLIST);
  const target = `gui/${process.getuid?.() ?? 0}/${SCHEDULER_LABEL}`;
  const printed = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 5_000 });
  const loaded = installed && printed.status === 0;
  const report = readLatestReport();
  const lastRunAt = typeof report?.finished_at === 'string' ? report.finished_at : null;
  const expectedNextRunAt = lastRunAt
    ? new Date(Date.parse(lastRunAt) + INTERVAL_SECONDS * 1000).toISOString()
    : null;
  return {
    label: SCHEDULER_LABEL,
    installed,
    loaded,
    enabled: loaded,
    interval_seconds: INTERVAL_SECONDS,
    cadence_label: '每 48 小时',
    last_run_at: lastRunAt,
    expected_next_run_at: expectedNextRunAt,
    next_run_is_estimated: Boolean(expectedNextRunAt),
  };
}

async function readCoreRows(client: SupabaseClient): Promise<{
  workflows: WorkflowRow[];
  availability: AvailabilityRow[];
  holds: HoldRow[];
}> {
  const [workflowResult, availabilityResult, holdResult] = await Promise.all([
    client.from('inventory_workflow_states').select(
      'supplier_product_id,supplier_sku,workflow_state,consecutive_out_of_stock,consecutive_in_stock,last_observed_inventory_status,last_observed_at,last_transition_at,transition_reason,version',
    ).limit(10_000),
    client.from('product_availability_current').select(
      'supplier_product_id,source,available,status,last_run_id,checked_at,consecutive_failures,last_failure_status,last_failure_reason,last_failure_at',
    ).limit(10_000),
    client.from('active_inventory_holds').select('supplier_product_id,reason,held_by,held_until').limit(10_000),
  ]);
  return {
    workflows: mustRows(workflowResult as never, 'workflow_states') as WorkflowRow[],
    availability: mustRows(availabilityResult as never, 'availability_current') as AvailabilityRow[],
    holds: mustRows(holdResult as never, 'active_holds') as HoldRow[],
  };
}

function groupStateCounts(workflows: WorkflowRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of workflows) counts[row.workflow_state] = (counts[row.workflow_state] ?? 0) + 1;
  return counts;
}

function latestReportSummary(report: Record<string, any> | null): Record<string, unknown> | null {
  if (!report) return null;
  const hasBlockedGate = Object.values(report.gates ?? {}).some((gate) => (
    gate && typeof gate === 'object' && (gate as { allowed?: boolean }).allowed === false
  ));
  return {
    run_id: report.run_id ?? null,
    started_at: report.started_at ?? null,
    finished_at: report.finished_at ?? null,
    mode: report.mode ?? null,
    scanned: report.totals?.total ?? 0,
    available: report.totals?.confirmedAvailable ?? 0,
    unavailable: report.totals?.confirmedOutOfStock ?? 0,
    failures: report.totals?.failures ?? 0,
    failure_percent: report.totals?.failurePercent ?? 0,
    proposed_delist: report.counts?.second_strike_delist ?? 0,
    proposed_relist: report.counts?.relist_eligible ?? 0,
    gates: report.gates ?? {},
    terminal_status: hasBlockedGate
      ? 'completed_with_blocks'
      : report.totals?.failures > 0
        ? 'completed_with_errors'
        : 'completed',
  };
}

/**
 * Coverage = published products whose availability evidence is still inside the grace window.
 *
 * The previous implementation counted any row that had ever been checked, so it reported 99.2%
 * on 2026-08-05 while only 1 of 350 products was actually within grace and the storefront was
 * empty. A monitor that reads green during a total outage is worse than no monitor.
 *
 * `now` is injectable so tests can pin time instead of drifting with the clock.
 */
export function computeAvailabilityCoverage(
  availability: ReadonlyArray<{ checked_at?: string | null }>,
  publishedCount: number,
  now: Date = new Date(),
): { published: number; covered: number; percent: number } {
  const cutoff = now.getTime() - AVAILABILITY_GRACE_HOURS * 3_600_000;
  const covered = availability.filter((row) => {
    if (!row.checked_at) return false;
    const checkedAt = Date.parse(row.checked_at);
    return Number.isFinite(checkedAt) && checkedAt >= cutoff;
  }).length;
  const percent = publishedCount > 0 ? Number(((covered / publishedCount) * 100).toFixed(1)) : 0;
  return { published: publishedCount, covered, percent };
}

/**
 * Health for the XOne loop node. Coverage is part of it: evidence that has aged out of the
 * grace window means products are already hidden from customers, which is never "healthy".
 */
export function deriveInventoryHealth(input: {
  runLockActive: boolean;
  schedulerLoaded: boolean;
  errors: number;
  coverageBelowMinimum: boolean;
}): string {
  if (input.runLockActive) return 'running';
  if (!input.schedulerLoaded) return 'blocked';
  if (input.errors > 0 || input.coverageBelowMinimum) return 'attention_required';
  return 'healthy';
}

async function buildSummary(client: SupabaseClient): Promise<Record<string, unknown>> {
  const report = readLatestReport();
  const latestRunId = typeof report?.run_id === 'string' ? report.run_id : null;
  const [{ workflows, availability, holds }, cfg, relistAuditResult, latestAuditResult, sellableResult] = await Promise.all([
    readCoreRows(client),
    loadInventoryConfigForScript(),
    client.from('publication_audit_log').select('supplier_product_id', { count: 'exact', head: true }).eq('action', 'relist'),
    latestRunId
      ? client.from('publication_audit_log').select('action').eq('run_id', latestRunId).limit(1_000)
      : Promise.resolve({ data: [], error: null }),
    // Live storefront size. coverage.visible comes from the scan report and is measured BEFORE the
    // scan refreshes evidence, so it cannot answer "how many products can a customer see right now".
    client.from('sellable_products').select('supplier_product_id', { count: 'exact', head: true }),
  ]);
  if (relistAuditResult.error) throw new Error('READ_FAILED:relist_audit_count');
  if (latestAuditResult.error) throw new Error('READ_FAILED:latest_publication_audit');
  const stateCounts = groupStateCounts(workflows);
  const errors = Number(report?.totals?.failures
    ?? availability.filter((row) => Number(row.consecutive_failures ?? 0) > 0).length);
  const eligibleDelist = stateCounts.eligible_for_delist ?? 0;
  const eligibleRelist = stateCounts.eligible_for_relist ?? 0;
  const blockedIds = new Set(holds.map((row) => row.supplier_product_id));
  for (const workflow of workflows) {
    if ((!cfg.autoDelistEnabled && workflow.workflow_state === 'eligible_for_delist')
      || (!cfg.autoRelistEnabled && workflow.workflow_state === 'eligible_for_relist')) {
      blockedIds.add(workflow.supplier_product_id);
    }
  }
  const latestReport = latestReportSummary(report);
  if (latestReport) {
    const latestAudits = (latestAuditResult.data ?? []) as Array<{ action: string }>;
    latestReport.applied_delist = latestAudits.filter((row) => row.action === 'delist').length;
    latestReport.applied_relist = latestAudits.filter((row) => row.action === 'relist').length;
  }
  const scheduler = readSchedulerFact();
  const locks = [readActiveLock(SCAN_LOCK), readActiveLock(APPLY_LOCK)];
  const activeLock = locks.find((lock) => lock.active) ?? null;
  const coverageReport = report;
  const published = Number(coverageReport?.counts?.published_targets ?? workflows.length);
  const visible = Number(coverageReport?.counts?.visible_now ?? 0);
  const { covered, percent: coveragePercent } = computeAvailabilityCoverage(availability, published);
  // Reuses the existing inventory_min_coverage_percent (default 95) rather than adding a knob.
  const coverageBelowMinimum = published > 0 && coveragePercent < cfg.minCoveragePercent;
  const health = deriveInventoryHealth({
    runLockActive: Boolean(activeLock),
    schedulerLoaded: Boolean((scheduler as any).loaded),
    errors,
    coverageBelowMinimum,
  });
  return success('summary', {
    health,
    scheduler,
    run_lock: activeLock,
    latest_run: latestReport,
    coverage: {
      published,
      visible,
      covered,
      percent: coveragePercent,
      // Live count of what a customer can actually see. Null when the read failed, so XOne can
      // tell "zero products visible" apart from "could not measure".
      sellable_now: sellableResult.error ? null : (sellableResult.count ?? 0),
    },
    counts: {
      healthy: stateCounts.published_in_stock ?? 0,
      pending: (stateCounts.pending_out_of_stock ?? 0) + (stateCounts.relist_pending ?? 0),
      pending_out_of_stock: stateCounts.pending_out_of_stock ?? 0,
      relist_pending: stateCounts.relist_pending ?? 0,
      eligible: eligibleDelist + eligibleRelist,
      eligible_for_delist: eligibleDelist,
      eligible_for_relist: eligibleRelist,
      delisted: stateCounts.delisted_out_of_stock ?? 0,
      relisted: relistAuditResult.count ?? 0,
      blocked: blockedIds.size,
      errors,
    },
    safety: {
      automation_enabled: cfg.automationEnabled,
      api_scan_enabled: cfg.apiScanEnabled,
      auto_delist_enabled: cfg.autoDelistEnabled,
      auto_relist_enabled: cfg.autoRelistEnabled,
      visibility_enforcement_enabled: cfg.visibilityEnforcementEnabled,
      out_of_stock_confirmations: cfg.outOfStockConfirmations,
      relist_confirmations: cfg.relistConfirmations,
      min_confirmation_interval_hours: cfg.minConfirmationIntervalHours,
      max_scan_per_run: cfg.maxScanPerRun,
      max_delist_per_run: cfg.maxDelistPerRun,
      max_delist_percent: cfg.maxDelistPercent,
      max_failure_percent: cfg.maxFailurePercent,
      // Exposed so XOne can render "coverage below minimum" without hardcoding the threshold.
      min_coverage_percent: cfg.minCoveragePercent,
      bulk_change_requires_approval: cfg.bulkChangeRequiresApproval,
      active_holds: holds.length,
    },
  });
}

async function readProducts(client: SupabaseClient, ids: string[]): Promise<Map<string, ProductRow>> {
  if (!ids.length) return new Map();
  const result = await client.from('standardized_products')
    .select('supplier_product_id,sku_custom,product_title,published,delist_reason,primary_image,selling_price,specifications_json')
    .in('supplier_product_id', ids.slice(0, MAX_ITEMS_LIMIT));
  return new Map(
    (mustRows(result as never, 'products') as ProductRow[]).map((row) => [row.supplier_product_id, row]),
  );
}

async function readProductIdsMatchingSku(client: SupabaseClient, sku: string): Promise<Set<string>> {
  if (!sku) return new Set();
  const result = await client.from('standardized_products')
    .select('supplier_product_id,sku_custom')
    .ilike('sku_custom', `%${sku}%`)
    .limit(MAX_ITEMS_LIMIT);
  return new Set(
    (mustRows(result as never, 'product_sku_search') as ProductRow[])
      .map((row) => row.supplier_product_id),
  );
}

function specificationSummary(value: unknown): string[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value as Record<string, unknown>).map(([name, detail]) => ({ name, value: detail }))
      : [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const name = String(row.name ?? row.label ?? row.key ?? '').trim();
    const detail = String(row.value ?? row.detail ?? row.text ?? '').trim();
    if (!name && !detail) return [];
    return [name && detail ? `${name}: ${detail}` : name || detail];
  }).slice(0, 3);
}

function itemFromFacts(
  workflow: WorkflowRow | null,
  availability: AvailabilityRow | null,
  product: ProductRow | null,
  hold: HoldRow | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const id = workflow?.supplier_product_id ?? availability?.supplier_product_id ?? String(extra.supplier_product_id ?? '');
  return {
    supplier_product_id: id,
    sku: product?.sku_custom ?? workflow?.supplier_sku ?? id,
    title: product?.product_title ?? '未命名商品',
    main_image: product?.primary_image ?? null,
    selling_price: product?.selling_price == null ? null : Number(product.selling_price),
    specification_summary: specificationSummary(product?.specifications_json),
    workflow_state: workflow?.workflow_state ?? null,
    published: product?.published ?? null,
    delist_reason: product?.delist_reason ?? null,
    inventory_status: availability?.status ?? workflow?.last_observed_inventory_status ?? 'unknown',
    available: availability?.available ?? null,
    checked_at: availability?.checked_at ?? workflow?.last_observed_at ?? null,
    source: availability?.source ?? 'inventory_workflow_states',
    consecutive_out_of_stock: workflow?.consecutive_out_of_stock ?? 0,
    consecutive_in_stock: workflow?.consecutive_in_stock ?? 0,
    last_transition_at: workflow?.last_transition_at ?? null,
    reason: workflow?.transition_reason ?? availability?.last_failure_reason ?? null,
    hold: hold ? { reason: hold.reason, held_by: hold.held_by, held_until: hold.held_until } : null,
    failure: availability && availability.consecutive_failures > 0 ? {
      count: availability.consecutive_failures,
      status: availability.last_failure_status,
      reason: availability.last_failure_reason,
      at: availability.last_failure_at,
    } : null,
    available_quantity: null,
    first_out_of_stock_at: null,
    latest_out_of_stock_at: availability?.available === false ? availability.checked_at : null,
    hours_since_last_confirmation: workflow?.last_observed_at
      ? Number(((Date.now() - Date.parse(workflow.last_observed_at)) / 3_600_000).toFixed(2))
      : null,
    gate_status: workflow?.workflow_state === 'eligible_for_delist' || workflow?.workflow_state === 'eligible_for_relist'
      ? 'eligible'
      : hold
        ? 'blocked'
        : availability?.consecutive_failures
          ? 'error'
          : 'pending_confirmation',
    not_executable_reason: hold?.reason
      ?? (workflow?.workflow_state === 'pending_out_of_stock'
        ? '尚未满足独立确认周期与确认次数门禁'
        : workflow?.workflow_state === 'relist_pending'
          ? '尚未满足恢复确认门禁'
          : availability?.last_failure_reason ?? null),
    recommendation: null,
    ...extra,
  };
}

/**
 * Echo the resolved identity. Every supplier-facing lookup in this flow uses the
 * one resolved `lookup_identity`, so all four capability fields report that same
 * value by construction; they are not four independent resolutions.
 */
function identityEnvelope(identity: ResolvedInventoryLookupIdentity): Record<string, unknown> {
  return {
    xself_sku: identity.xself_sku,
    legacy_supplier_product_id: identity.legacy_supplier_product_id,
    lookup_identity: identity.lookup_identity,
    identity_source: identity.identity_source,
    identity_confidence: identity.identity_confidence,
    identity_error: null,
    favorites_lookup_identity: identity.lookup_identity,
    product_detail_identity: identity.lookup_identity,
    availability_lookup_identity: identity.lookup_identity,
    inventory_lookup_identity: identity.lookup_identity,
    website_search_identity: 'pending_verification',
  };
}

/**
 * Map a supplier read failure onto a per-step code so the operator can tell which
 * capability failed on which account. None of these mean "out of stock".
 */
function supplierReadFailure(error: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
  retryable: boolean;
} {
  if (!(error instanceof SupplierTargetedReadError)) {
    return {
      code: 'product_detail_read_error',
      message: '供应商账号定向读取失败',
      details: {},
      retryable: true,
    };
  }
  const byCapability: Record<string, string> = {
    favorites: error.account === 'pickup' ? 'pickup_favorites_read_error' : 'dropship_favorites_read_error',
    product_detail: 'product_detail_read_error',
    availability: 'availability_read_error',
    inventory: 'inventory_read_error',
  };
  return {
    code: byCapability[error.capability] ?? 'product_detail_read_error',
    message: error.message,
    details: {
      account: error.account,
      capability: error.capability,
      supplier_error_code: error.code,
    },
    retryable: true,
  };
}

export interface TargetedRecheckDeps {
  /** Injected only by tests. Production always uses the real supplier read client. */
  readAccountFacts?: (
    role: 'pickup' | 'dropship',
    lookupIdentity: string,
  ) => Promise<SupplierAccountProductFacts>;
}

export async function runTargetedRecheck(
  request: Extract<InventoryLifecycleBridgeRequest, { operation: 'recheck-item' }>,
  client: SupabaseClient,
  deps: TargetedRecheckDeps = {},
): Promise<Record<string, unknown>> {
  const readAccountFacts = deps.readAccountFacts
    ?? ((role: 'pickup' | 'dropship', lookupIdentity: string) =>
      readSupplierAccountProductFacts(role, lookupIdentity, { repo: REPO }));
  const targetedFailure = (input: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable?: boolean;
    product?: ProductRow | null;
    identity?: ResolvedInventoryLookupIdentity | null;
    pickup?: SupplierAccountProductFacts | null;
    dropship?: SupplierAccountProductFacts | null;
    checkedAt?: string;
    productionWriteAttempted?: boolean;
  }): Record<string, unknown> => success('recheck-item', {
    production_write_attempted: input.productionWriteAttempted ?? false,
    sku: request.sku,
    supplier_product_id: input.product?.supplier_product_id ?? null,
    targeted_recheck_attempted: true,
    targeted_recheck_result: 'failed',
    resulting_action: 'none',
    final_status: 'recheck_failed',
    checked_at: input.checkedAt ?? new Date().toISOString(),
    inventory_status: 'unknown',
    restore_candidate: false,
    error_code: input.code,
    error_message: input.message,
    // Structured error so XOne never has to slice a Chinese string to get a code.
    error: {
      code: input.code,
      message: input.message,
      details: input.details ?? {},
      retryable: input.retryable ?? false,
    },
    other_items_scanned: 0,
    identity: input.identity ? identityEnvelope(input.identity) : null,
    accounts: {
      pickup: input.pickup ?? null,
      dropship: input.dropship ?? null,
    },
  });

  const matchesResult = await client.from('standardized_products')
    .select('supplier_product_id,sku_custom,product_title,published,delist_reason,primary_image,selling_price,specifications_json,inventory_status,total_available_qty')
    .eq('sku_custom', request.sku)
    .limit(3);
  const matches = mustRows(matchesResult as never, 'targeted_product_lookup') as ProductRow[];
  if (matches.length !== 1) {
    return targetedFailure({
      code: matches.length ? 'duplicate_sku' : 'sku_not_found',
      message: matches.length ? '该 SKU 对应多个商品，已拒绝单商品复核' : '未找到该 SKU',
      details: { xself_sku: request.sku, matched_products: matches.length },
    });
  }
  const product = matches[0];
  const relationshipResult = await client.from('supplier_products')
    .select('supplier_product_id,raw_payload')
    .eq('supplier_product_id', product.supplier_product_id)
    .limit(2);
  const relationshipRows = mustRows(relationshipResult as never, 'targeted_supplier_relationship') as SupplierRelationshipRow[];
  if (relationshipRows.length !== 1) {
    return targetedFailure({
      code: relationshipRows.length > 1 ? 'identity_mapping_conflict' : 'identity_mapping_missing',
      message: relationshipRows.length > 1
        ? '该商品存在多条供应商商品关系，已拒绝猜测查询身份'
        : '该商品缺少供应商商品关系，无法解析查询身份',
      details: { xself_sku: request.sku, supplier_relationship_rows: relationshipRows.length },
      product,
    });
  }

  const identityResult = resolveInventoryLookupIdentity({
    xselfSku: request.sku,
    legacySupplierProductId: product.supplier_product_id,
    associateProductList: relationshipRows[0].raw_payload?.associateProductList,
    supplierPayloadSku: relationshipRows[0].raw_payload?.sku,
  });
  if (!isResolvedInventoryLookupIdentity(identityResult) && !isPendingCapabilityVerification(identityResult)) {
    return targetedFailure({
      code: identityResult.identity_error.code,
      message: identityResult.identity_error.message,
      details: identityResult.identity_error.details,
      retryable: identityResult.identity_error.retryable,
      product,
    });
  }

  // A pending candidate is not yet an identity. It is queried exactly like a resolved one, and it
  // is only accepted if the full capability chain succeeds on BOTH accounts. Anything less leaves
  // it unresolved — we never fall back to the XSelf SKU and never guess a sibling code.
  const pendingVerification = isPendingCapabilityVerification(identityResult) ? identityResult : null;
  const lookupIdentity = pendingVerification ? pendingVerification.candidate : identityResult.lookup_identity;

  let pickup: SupplierAccountProductFacts | null = null;
  let dropship: SupplierAccountProductFacts | null = null;
  try {
    // Every supplier call uses the resolved lookup identity — never the XSelf SKU,
    // never a constructed variant code.
    pickup = await readAccountFacts('pickup', lookupIdentity);
    dropship = await readAccountFacts('dropship', lookupIdentity);
  } catch (error) {
    const mapped = supplierReadFailure(error);
    // A read failure is a read failure. It is never reported as "out of stock", and for a pending
    // candidate it means the candidate stays unproven.
    return targetedFailure({
      code: mapped.code,
      message: mapped.message,
      details: {
        ...mapped.details,
        lookup_identity: lookupIdentity,
        ...(pendingVerification ? { identity_verification: 'failed' } : {}),
      },
      retryable: mapped.retryable,
      product,
      identity: pendingVerification ? null : identityResult,
      pickup,
      dropship,
    });
  }

  // Both accounts answered. Confirm they answered about the SAME item before trusting anything.
  if (pickup.lookup_identity !== lookupIdentity || dropship.lookup_identity !== lookupIdentity) {
    return targetedFailure({
      code: 'identity_mapping_conflict',
      message: '供应商返回的商品身份与查询身份不一致，已拒绝采信',
      details: {
        xself_sku: request.sku,
        lookup_identity: lookupIdentity,
        pickup_identity: pickup.lookup_identity,
        dropship_identity: dropship.lookup_identity,
      },
      retryable: false,
      product,
    });
  }

  // Proven on both accounts across favorites, detail, availability and inventory. The P/S letter
  // plays no part in this decision — capability did.
  const identity: ResolvedInventoryLookupIdentity = pendingVerification
    ? acceptCapabilityVerifiedIdentity(pendingVerification)
    : identityResult;

  const checkedAt = new Date().toISOString();
  const sourceFacts = { pickup, dropship };
  if (!pickup.available || !dropship.available) {
    return success('recheck-item', {
      production_write_attempted: false,
      sku: request.sku,
      supplier_product_id: product.supplier_product_id,
      targeted_recheck_attempted: true,
      targeted_recheck_result: 'still_out_of_stock',
      resulting_action: 'none',
      final_status: 'recheck_still_out_of_stock',
      checked_at: checkedAt,
      inventory_status: 'confirmed_out_of_stock',
      restore_candidate: false,
      error_code: 'confirmed_out_of_stock',
      error_message: '至少一个已验证供应商账号明确返回当前商品不可售，未执行恢复',
      error: {
        code: 'confirmed_out_of_stock',
        message: '至少一个已验证供应商账号明确返回当前商品不可售，未执行恢复',
        details: {
          lookup_identity: identity.lookup_identity,
          pickup_available: pickup.available,
          dropship_available: dropship.available,
        },
        retryable: false,
      },
      other_items_scanned: 0,
      identity: identityEnvelope(identity),
      accounts: sourceFacts,
    });
  }

  // Available but with no trustworthy quantity is "unknown", never "out of stock".
  const pickupQuantity = Number(pickup.total_available_qty);
  if (!Number.isFinite(pickupQuantity) || pickupQuantity <= 0) {
    return targetedFailure({
      code: 'inventory_unknown',
      message: 'Pickup 可售状态存在，但未读取到生产规则认可的正库存数量',
      details: {
        lookup_identity: identity.lookup_identity,
        pickup_total_available_qty: pickup.total_available_qty,
      },
      retryable: true,
      product,
      identity,
      pickup,
      dropship,
      checkedAt,
    });
  }

  // Restore gate. Evaluated before any write so a blocked reason is always reportable.
  const restoreGateBlocks: string[] = [];
  if (!pickup.favorite) restoreGateBlocks.push('pickup_not_favorited');
  if (!dropship.favorite) restoreGateBlocks.push('dropship_not_favorited');
  if (!(Number(pickup.price) > 0)) restoreGateBlocks.push('pickup_price_unavailable');
  if (!String(product.product_title ?? '').trim()) restoreGateBlocks.push('product_title_missing');
  if (!String(product.primary_image ?? '').trim()) restoreGateBlocks.push('product_image_missing');
  const restoreCandidate = restoreGateBlocks.length === 0;

  if (!restoreCandidate) {
    return targetedFailure({
      code: 'restore_gate_blocked',
      message: '已确认有货，但恢复门禁未通过',
      details: { lookup_identity: identity.lookup_identity, blocks: restoreGateBlocks },
      retryable: false,
      product,
      identity,
      pickup,
      dropship,
      checkedAt,
    });
  }

  if (!RESTORE_EXECUTION_ENABLED) {
    // Read-only outcome: the item qualifies, but nothing is written from here.
    return success('recheck-item', {
      production_write_attempted: false,
      sku: request.sku,
      supplier_product_id: product.supplier_product_id,
      targeted_recheck_attempted: true,
      targeted_recheck_result: 'confirmed_in_stock',
      resulting_action: 'restore_candidate_recorded',
      final_status: 'manual_confirmed_in_stock',
      checked_at: checkedAt,
      inventory_status: 'confirmed_in_stock',
      restore_candidate: true,
      restore_gate_blocks: [],
      restore_execution_enabled: false,
      error_code: null,
      error_message: null,
      error: null,
      other_items_scanned: 0,
      identity: identityEnvelope(identity),
      accounts: sourceFacts,
    });
  }

  const runId = `xone-targeted-identity-${randomUUID()}`;
  const [priorAvailabilityResult, workflowResult, config] = await Promise.all([
    client.from('product_availability_current')
      .select('supplier_product_id,available,status,checked_at,last_confirmed_available_at,last_confirmed_unavailable_at,consecutive_failures')
      .eq('supplier_product_id', product.supplier_product_id)
      .limit(2),
    client.from('inventory_workflow_states')
      .select('supplier_product_id,supplier_sku,workflow_state,consecutive_out_of_stock,consecutive_in_stock,last_observed_inventory_status,last_observed_at,last_observation_key,last_transition_at,transition_reason,version')
      .eq('supplier_product_id', product.supplier_product_id)
      .limit(2),
    loadInventoryConfigForScript(),
  ]);
  const priorAvailabilityRows = mustRows(priorAvailabilityResult as never, 'targeted_prior_availability') as PriorCurrentRow[];
  const workflowRows = mustRows(workflowResult as never, 'targeted_prior_workflow') as WorkflowRow[];
  if (priorAvailabilityRows.length > 1 || workflowRows.length > 1) {
    return targetedFailure({ code: 'restore_gate_blocked', message: '现有库存状态存在身份冲突，已拒绝写入', product, identity, pickup, dropship, checkedAt });
  }

  const hasCaStock = pickup.warehouses.some((warehouse) => warehouse.state === 'CA' && warehouse.available_qty_min > 0);
  const availabilityResult: AvailabilityResult = {
    sku: product.supplier_product_id,
    status: 'confirmed_available',
    available: true,
    inventoryStatus: hasCaStock ? 'confirmed_in_stock_ca' : 'confirmed_in_stock_out_of_state',
    reason: `corrected_lookup_identity:${identity.lookup_identity}`,
  };
  const plan = planPersistence(availabilityResult, priorAvailabilityRows[0] ?? null, runId, checkedAt);
  assertNoPublicationWrite([plan]);

  const priorWorkflow = workflowRows[0] ?? null;
  const priorSnapshot = priorWorkflow
    ? {
      state: priorWorkflow.workflow_state as InventoryWorkflowState,
      consecutiveOutOfStock: priorWorkflow.consecutive_out_of_stock,
      consecutiveInStock: priorWorkflow.consecutive_in_stock,
    }
    : {
      state: product.published === false ? 'delisted_out_of_stock' as const : 'published_in_stock' as const,
      consecutiveOutOfStock: 0,
      consecutiveInStock: 0,
    };
  const transition = transitionInventoryState(priorSnapshot, availabilityResult.inventoryStatus, {
    outOfStockConfirmationsRequired: config.outOfStockConfirmations,
    inStockConfirmationsRequired: config.relistConfirmations,
  });
  const observationKey = `${product.supplier_product_id}|${runId}|corrected_lookup_identity`;
  const workflowPatch = {
    supplier_product_id: product.supplier_product_id,
    supplier_sku: request.sku,
    workflow_state: transition.next.state,
    consecutive_out_of_stock: transition.next.consecutiveOutOfStock,
    consecutive_in_stock: transition.next.consecutiveInStock,
    last_observed_inventory_status: availabilityResult.inventoryStatus,
    last_observed_at: checkedAt,
    last_observation_key: observationKey,
    last_transition_at: checkedAt,
    transition_reason: 'corrected_lookup_identity',
    updated_at: checkedAt,
  };

  let productionWriteAttempted = false;
  try {
    productionWriteAttempted = true;
    if (priorWorkflow) {
      const { data, error } = await client.from('inventory_workflow_states')
        .update({ ...workflowPatch, version: priorWorkflow.version + 1 })
        .eq('supplier_product_id', product.supplier_product_id)
        .eq('version', priorWorkflow.version)
        .select('supplier_product_id');
      if (error || (data ?? []).length !== 1) throw new Error('workflow_write_failed');
    } else {
      const { error } = await client.from('inventory_workflow_states').insert({ ...workflowPatch, version: 1 });
      if (error) throw new Error('workflow_write_failed');
    }

    const transitionInsert = await client.from('inventory_workflow_transitions').insert({
      supplier_product_id: product.supplier_product_id,
      supplier_sku: request.sku,
      from_state: priorSnapshot.state,
      to_state: transition.next.state,
      observed_inventory_status: availabilityResult.inventoryStatus,
      observed_at: checkedAt,
      observation_key: observationKey,
      consecutive_out_of_stock_before: priorSnapshot.consecutiveOutOfStock,
      consecutive_in_stock_before: priorSnapshot.consecutiveInStock,
      consecutive_out_of_stock_after: transition.next.consecutiveOutOfStock,
      consecutive_in_stock_after: transition.next.consecutiveInStock,
      proposed_action: transition.proposedAction,
      observed_exception: transition.observedException,
      reason: 'corrected_lookup_identity',
      run_id: runId,
      runner: 'xone_targeted_identity_recheck',
      transitioned_at: checkedAt,
    });
    if (transitionInsert.error) throw new Error('workflow_audit_write_failed');

    const checkWrite = await client.from('product_availability_checks')
      .upsert(plan.checkRow, { onConflict: 'run_id,supplier_product_id' });
    if (checkWrite.error) throw new Error('availability_audit_write_failed');
    if (!plan.currentUpsert) throw new Error('availability_plan_not_confirmed');
    const currentWrite = await client.from('product_availability_current')
      .upsert(plan.currentUpsert, { onConflict: 'supplier_product_id' });
    if (currentWrite.error) throw new Error('availability_current_write_failed');
  } catch (error) {
    const stage = error instanceof Error ? error.message : 'restore_execution_failed';
    const code = stage === 'workflow_write_failed' ? 'workflow_write_failed' : 'restore_execution_failed';
    return targetedFailure({
      code,
      message: '真实有货读取成功，但现有生命周期写入未完整完成',
      details: { lookup_identity: identity.lookup_identity, failed_stage: stage },
      retryable: true,
      product,
      identity,
      pickup,
      dropship,
      checkedAt,
      productionWriteAttempted,
    });
  }

  // Evidence is written. Now bring the two display fields on standardized_products in line with
  // it, using the SAME shared projection the full scan uses. Both accounts reported real
  // per-warehouse quantities here, so nothing is invented; if they had not, the projection would
  // decline to write rather than guess.
  const inventoryProjection = deriveStandardizedInventoryProjection({
    channels: [
      channelFromAccountFacts('pickup', pickup),
      channelFromAccountFacts('dropship', dropship),
    ],
    currentInventoryStatus: product.inventory_status ?? null,
    currentTotalAvailableQty: product.total_available_qty == null ? null : Number(product.total_available_qty),
    evidenceCheckedAt: checkedAt,
  });
  const standardizedInventoryWrite = await applyStandardizedInventoryProjection(
    client as never,
    request.sku,
    inventoryProjection,
    product.inventory_status ?? null,
    product.total_available_qty == null ? null : Number(product.total_available_qty),
  );

  // 复核只刷新证据并推进状态，**不再**顺手把商品重新上架。
  //
  // 这里原本在判定为 eligible_for_relist 时直接调用发布执行器，并用发起复核的操作者名字
  // 充当批准人。操作者确实是真人，但他批准的是「重新检测这一件」，不是「把它重新上架」——
  // 那是拿一次点击的授权去做另一件事。恢复上架现在与下架同一条规则：必须是明确的批准动作。
  //
  // 复核结果照常体现在 workflow state 上，该 SKU 因此进入工作队列的「建议恢复」等待批准。
  const relistAttempted = false;
  const relistExitCode: number | null = null;
  const relistProposed = product.published === false
    && transition.next.state === 'eligible_for_relist';

  const readbackResult = await client.from('standardized_products')
    .select('supplier_product_id,published,inventory_status,total_available_qty')
    .eq('supplier_product_id', product.supplier_product_id)
    .limit(2);
  const readbackRows = mustRows(readbackResult as never, 'targeted_readback') as ProductRow[];
  const readback = readbackRows[0] ?? null;
  const sellableResult = await client.from('sellable_products')
    .select('supplier_product_id')
    .eq('supplier_product_id', product.supplier_product_id)
    .limit(1);
  const sellable = mustRows(sellableResult as never, 'targeted_sellable_readback').length === 1;
  const availabilityReadbackResult = await client.from('product_availability_current')
    .select('supplier_product_id,available,status,checked_at,last_run_id')
    .eq('supplier_product_id', product.supplier_product_id)
    .limit(1);
  const availabilityReadback = mustRows(availabilityReadbackResult as never, 'targeted_availability_readback')[0] as Record<string, unknown> | undefined;
  const workflowReadbackResult = await client.from('inventory_workflow_states')
    .select('supplier_product_id,workflow_state,consecutive_out_of_stock,consecutive_in_stock,transition_reason,last_observed_inventory_status,last_observed_at')
    .eq('supplier_product_id', product.supplier_product_id)
    .limit(1);
  const workflowReadback = mustRows(workflowReadbackResult as never, 'targeted_workflow_readback')[0] as Record<string, unknown> | undefined;
  const quantity = readback?.total_available_qty == null ? null : Number(readback.total_available_qty);
  const readbackVerified = readback?.published === true
    && readback.inventory_status === 'in_stock'
    && Number.isFinite(quantity)
    && Number(quantity) > 0
    && sellable
    && availabilityReadback?.available === true
    && availabilityReadback?.status === 'confirmed_available'
    && workflowReadback?.workflow_state === 'published_in_stock'
    && Number(workflowReadback?.consecutive_out_of_stock ?? -1) === 0;
  return success('recheck-item', {
    production_write_attempted: productionWriteAttempted,
    standardized_inventory: standardizedInventoryWrite,
    sku: request.sku,
    supplier_product_id: product.supplier_product_id,
    targeted_recheck_attempted: true,
    targeted_recheck_result: 'confirmed_in_stock',
    resulting_action: readbackVerified ? 'safe_restore_verified' : relistAttempted ? 'safe_relist_not_applied' : 'inventory_state_refreshed',
    final_status: readbackVerified ? 'restored_after_manual_review' : 'manual_confirmed_in_stock',
    checked_at: checkedAt,
    inventory_status: availabilityResult.inventoryStatus,
    restore_candidate: true,
    restore_gate_blocks: [],
    restore_execution_enabled: true,
    relist_attempted: relistAttempted,
    relist_exit_code: relistExitCode,
    // 复核只提建议：为 true 表示该 SKU 现在进入「建议恢复」，等待人工批准后才会上架。
    relist_proposed: relistProposed,
    run_id: runId,
    identity: identityEnvelope(identity),
    accounts: sourceFacts,
    restore_result: readbackVerified ? 'restored_and_verified' : 'restore_readback_failed',
    readback: {
      published: readback?.published ?? null,
      inventory_status: readback?.inventory_status ?? 'unknown',
      total_available_qty: quantity,
      sellable,
      verified: readbackVerified,
      availability: availabilityReadback ?? null,
      workflow: workflowReadback ?? null,
    },
    error_code: readbackVerified ? null : 'restore_readback_failed',
    error_message: readbackVerified ? null : '已确认有货，但现有恢复流程未通过全部回读验证',
    error: readbackVerified ? null : {
      code: 'restore_readback_failed',
      message: '已确认有货，但现有恢复流程未通过全部回读验证',
      details: { lookup_identity: identity.lookup_identity, relist_exit_code: relistExitCode },
      retryable: true,
    },
    other_items_scanned: 0,
  });
}

function hoursBetween(first: string | null, last: string | null): number | null {
  if (!first || !last) return null;
  const delta = Date.parse(last) - Date.parse(first);
  return Number.isFinite(delta) ? Number((delta / 3_600_000).toFixed(2)) : null;
}

function latestDelistProposalMap(report: Record<string, any> | null): Map<string, Record<string, any>> {
  const rows = Array.isArray(report?.proposals) ? report.proposals as Array<Record<string, any>> : [];
  return new Map(
    rows
      .filter((row) => row.proposedAction === 'propose_delist' && typeof row.sku === 'string')
      .map((row) => [String(row.sku), row]),
  );
}

async function readCheckEvidence(
  client: SupabaseClient,
  ids: string[],
): Promise<Map<string, AvailabilityCheckRow[]>> {
  if (!ids.length) return new Map();
  const result = await client.from('product_availability_checks')
    .select('supplier_product_id,available,status,failure_reason,run_id,checked_at')
    .in('supplier_product_id', ids.slice(0, MAX_ITEMS_LIMIT))
    .order('checked_at', { ascending: true })
    .limit(10_000);
  const grouped = new Map<string, AvailabilityCheckRow[]>();
  for (const row of mustRows(result as never, 'availability_check_evidence') as AvailabilityCheckRow[]) {
    const current = grouped.get(row.supplier_product_id) ?? [];
    current.push(row);
    grouped.set(row.supplier_product_id, current);
  }
  return grouped;
}

function recommendationFromFacts(input: {
  report: Record<string, any>;
  proposal: Record<string, any>;
  workflow: WorkflowRow | null;
  checks: AvailabilityCheckRow[];
  hold: HoldRow | null;
  config: Awaited<ReturnType<typeof loadInventoryConfigForScript>>;
}): RecommendationEvidence {
  const confirmedOut = input.checks.filter((row) => row.available === false && row.status === 'confirmed_out_of_stock');
  const first = confirmedOut[0]?.checked_at ?? null;
  const latest = confirmedOut.at(-1)?.checked_at ?? null;
  const reportCount = Number(input.config.outOfStockConfirmations);
  const currentCount = Number(input.workflow?.consecutive_out_of_stock ?? 0);
  const applyGate = input.report.gates?.delistBatch ?? { allowed: false, blocks: ['unknown_gate'] };
  const interval = hoursBetween(first, latest);
  const repaired = currentCount < reportCount;
  return {
    run_id: String(input.report.run_id),
    proposed_action: 'propose_delist',
    previous_state: String(input.proposal.previousState ?? 'unknown'),
    proposed_state: String(input.proposal.proposedState ?? 'unknown'),
    supplier_status: String(input.proposal.status ?? 'unknown'),
    report_reason: String(input.proposal.reason ?? '未提供'),
    report_confirmation_count: reportCount,
    authoritative_confirmation_count: currentCount,
    first_out_of_stock_at: first,
    latest_out_of_stock_at: latest,
    actual_confirmation_interval_hours: interval,
    minimum_confirmation_interval_hours: Number(input.config.minConfirmationIntervalHours),
    confirmation_threshold: reportCount,
    threshold_reached_in_report: true,
    threshold_currently_reached: currentCount >= reportCount,
    has_hold: Boolean(input.hold),
    hold_reason: input.hold?.reason ?? null,
    approval_required: Boolean(input.config.bulkChangeRequiresApproval),
    // This describes the policy evaluated by the recorded run, not a later config value.
    auto_delist_enabled: !Array.isArray(applyGate.blocks) || !applyGate.blocks.includes('auto_delist_disabled'),
    apply_gate_allowed: Boolean(applyGate.allowed),
    apply_gate_blocks: Array.isArray(applyGate.blocks) ? applyGate.blocks.map(String) : [],
    suggested_action: 'review_delist',
    currently_executable: false,
    explanation: repaired
      ? `最近运行曾按当时计数建议下架；权威状态已修复为 ${currentCount}/${reportCount} 次独立确认，且自动下架关闭，因此只保留建议证据。`
      : `最近运行达到 ${reportCount} 次缺货确认，但自动下架门禁未通过，因此只建议人工复核，未执行下架。`,
  };
}

async function buildItems(
  request: Extract<InventoryLifecycleBridgeRequest, { operation: 'items' }>,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const limit = Math.min(MAX_ITEMS_LIMIT, Math.max(1, Number(request.limit ?? 50)));
  const cursor = Math.max(0, Number(request.cursor ?? 0));
  const { workflows, availability, holds } = await readCoreRows(client);
  const wfById = new Map(workflows.map((row) => [row.supplier_product_id, row]));
  const avById = new Map(availability.map((row) => [row.supplier_product_id, row]));
  const holdById = new Map(holds.map((row) => [row.supplier_product_id, row]));
  const productIdsMatchingSku = request.sku
    ? await readProductIdsMatchingSku(client, request.sku)
    : new Set<string>();
  let raw: Array<{ id: string; extra?: Record<string, unknown> }> = [];

  if (request.bucket === 'pending') {
    raw = workflows.filter((row) => ['pending_out_of_stock', 'relist_pending'].includes(row.workflow_state)).map((row) => ({ id: row.supplier_product_id }));
  } else if (request.bucket === 'eligible') {
    raw = workflows.filter((row) => ['eligible_for_delist', 'eligible_for_relist'].includes(row.workflow_state)).map((row) => ({ id: row.supplier_product_id }));
  } else if (request.bucket === 'delisted') {
    raw = workflows.filter((row) => row.workflow_state === 'delisted_out_of_stock').map((row) => ({ id: row.supplier_product_id }));
  } else if (request.bucket === 'blocked') {
    const cfg = await loadInventoryConfigForScript();
    const ids = new Set(holds.map((row) => row.supplier_product_id));
    for (const row of workflows) {
      if ((!cfg.autoDelistEnabled && row.workflow_state === 'eligible_for_delist')
        || (!cfg.autoRelistEnabled && row.workflow_state === 'eligible_for_relist')) {
        ids.add(row.supplier_product_id);
      }
    }
    raw = [...ids].map((id) => ({ id }));
  } else if (request.bucket === 'errors') {
    const result = await client.from('product_availability_checks')
      .select('supplier_product_id,available,status,failure_reason,run_id,checked_at')
      .order('checked_at', { ascending: false })
      .limit(10_000);
    const checks = mustRows(result as never, 'availability_checks_errors') as AvailabilityCheckRow[];
    const latestRunId = readLatestReport()?.run_id;
    const latestFailures = new Map<string, AvailabilityCheckRow>();
    for (const check of checks) {
      if ((!latestRunId || check.run_id === latestRunId)
        && (check.available === null || check.failure_reason)
        && !latestFailures.has(check.supplier_product_id)) {
        latestFailures.set(check.supplier_product_id, check);
      }
    }
    raw = [...latestFailures.values()].map((check) => ({
      id: check.supplier_product_id,
      extra: {
        inventory_status: check.status || 'unknown',
        available: null,
        checked_at: check.checked_at,
        source: 'product_availability_checks',
        reason: check.failure_reason,
        failure: {
          count: 1,
          status: check.status,
          reason: check.failure_reason,
          at: check.checked_at,
        },
      },
    }));
  } else {
    const result = await client.from('publication_audit_log')
      .select('supplier_product_id,action,actor,run_id,evidence_checked_at,created_at')
      .eq('action', 'relist')
      .order('created_at', { ascending: false })
      .limit(10_000);
    let audits = mustRows(result as never, 'relist_audit') as AuditRow[];
    if (request.sku) {
      const needle = request.sku.toLowerCase();
      audits = audits.filter((audit) => (
        audit.supplier_product_id.toLowerCase().includes(needle)
        || (wfById.get(audit.supplier_product_id)?.supplier_sku ?? '').toLowerCase().includes(needle)
        || productIdsMatchingSku.has(audit.supplier_product_id)
      ));
    }
    const page = audits.slice(cursor, cursor + limit);
    const products = await readProducts(client, page.map((row) => row.supplier_product_id));
    const items = page.map((audit) => itemFromFacts(
      wfById.get(audit.supplier_product_id) ?? null,
      avById.get(audit.supplier_product_id) ?? null,
      products.get(audit.supplier_product_id) ?? null,
      holdById.get(audit.supplier_product_id) ?? null,
      { relisted_at: audit.created_at, audit_actor: audit.actor, audit_run_id: audit.run_id },
    ));
    return success('items', {
      bucket: request.bucket,
      items,
      cursor,
      total: audits.length,
      next_cursor: cursor + items.length < audits.length ? cursor + items.length : null,
    });
  }

  if (request.sku) {
    const needle = request.sku.toLowerCase();
    raw = raw.filter(({ id }) => (
      id.toLowerCase().includes(needle)
      || (wfById.get(id)?.supplier_sku ?? '').toLowerCase().includes(needle)
      || productIdsMatchingSku.has(id)
    ));
  }
  raw.sort((a, b) => a.id.localeCompare(b.id));
  const page = raw.slice(cursor, cursor + limit);
  const pageIds = page.map((row) => row.id);
  const [products, checkEvidence, cfg] = await Promise.all([
    readProducts(client, pageIds),
    readCheckEvidence(client, pageIds),
    loadInventoryConfigForScript(),
  ]);
  const report = readLatestReport();
  const proposalById = latestDelistProposalMap(report);
  const items = page.map(({ id, extra }) => itemFromFacts(
    wfById.get(id) ?? null,
    avById.get(id) ?? null,
    products.get(id) ?? null,
    holdById.get(id) ?? null,
    {
      ...extra,
      first_out_of_stock_at: (checkEvidence.get(id) ?? []).find((row) => row.available === false)?.checked_at ?? null,
      latest_out_of_stock_at: (checkEvidence.get(id) ?? []).filter((row) => row.available === false).at(-1)?.checked_at ?? null,
      recommendation: report && proposalById.has(id)
        ? recommendationFromFacts({
          report,
          proposal: proposalById.get(id)!,
          workflow: wfById.get(id) ?? null,
          checks: checkEvidence.get(id) ?? [],
          hold: holdById.get(id) ?? null,
          config: cfg,
        })
        : null,
    },
  ));
  return success('items', {
    bucket: request.bucket,
    items,
    cursor,
    total: raw.length,
    next_cursor: cursor + items.length < raw.length ? cursor + items.length : null,
  });
}

async function buildRuns(
  request: Extract<InventoryLifecycleBridgeRequest, { operation: 'runs' }>,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const limit = Math.min(MAX_RUNS_LIMIT, Math.max(1, Number(request.limit ?? 20)));
  const cursor = Math.max(0, Number(request.cursor ?? 0));
  const [checksResult, transitionsResult, auditResult] = await Promise.all([
    client.from('product_availability_checks')
      .select('supplier_product_id,available,status,failure_reason,run_id,checked_at')
      .order('checked_at', { ascending: false }).limit(10_000),
    client.from('inventory_workflow_transitions')
      .select('supplier_product_id,supplier_sku,from_state,to_state,proposed_action,observed_exception,reason,run_id,runner,transitioned_at')
      .order('transitioned_at', { ascending: false }).limit(10_000),
    client.from('publication_audit_log')
      .select('supplier_product_id,action,actor,run_id,evidence_checked_at,created_at')
      .order('created_at', { ascending: false }).limit(10_000),
  ]);
  const checks = mustRows(checksResult as never, 'availability_checks') as AvailabilityCheckRow[];
  const transitions = mustRows(transitionsResult as never, 'workflow_transitions') as TransitionRow[];
  const audits = mustRows(auditResult as never, 'publication_audit') as AuditRow[];
  const runIds: string[] = [];
  const seen = new Set<string>();
  for (const row of checks) if (!seen.has(row.run_id)) { seen.add(row.run_id); runIds.push(row.run_id); }
  for (const row of transitions) if (!seen.has(row.run_id)) { seen.add(row.run_id); runIds.push(row.run_id); }
  for (const row of audits) if (row.run_id && !seen.has(row.run_id)) { seen.add(row.run_id); runIds.push(row.run_id); }
  const latest = readLatestReport();
  if (latest?.run_id && !seen.has(String(latest.run_id))) runIds.unshift(String(latest.run_id));

  const relevantIds = new Set<string>();
  for (const row of transitions) if (row.proposed_action || row.observed_exception) relevantIds.add(row.supplier_product_id);
  for (const row of checks) if (row.available === null || row.failure_reason) relevantIds.add(row.supplier_product_id);
  for (const id of latestDelistProposalMap(latest).keys()) relevantIds.add(id);
  const [products, core, cfg] = await Promise.all([
    readProducts(client, [...relevantIds]),
    readCoreRows(client),
    loadInventoryConfigForScript(),
  ]);
  const workflowById = new Map(core.workflows.map((row) => [row.supplier_product_id, row]));
  const holdById = new Map(core.holds.map((row) => [row.supplier_product_id, row]));

  const runs = runIds.slice(cursor, cursor + limit).map((runId) => {
    const runChecks = checks.filter((row) => row.run_id === runId);
    const runTransitions = transitions.filter((row) => row.run_id === runId);
    const runAudits = audits.filter((row) => row.run_id === runId);
    const times = runChecks.map((row) => Date.parse(row.checked_at)).filter(Number.isFinite);
    const isLatest = latest?.run_id === runId;
    const failures = runChecks.filter((row) => row.available === null).length;
    const displayedFailures = isLatest ? latest.totals?.failures ?? failures : failures;
    const hasBlockedGate = isLatest && Object.values(latest.gates ?? {}).some((gate) => (
      gate && typeof gate === 'object' && (gate as { allowed?: boolean }).allowed === false
    ));
    const proposedDelist = isLatest
      ? [...latestDelistProposalMap(latest).entries()].map(([id, proposal]) => ({
        supplier_product_id: id,
        sku: products.get(id)?.sku_custom ?? workflowById.get(id)?.supplier_sku ?? id,
        title: products.get(id)?.product_title ?? '未命名商品',
        recommendation: recommendationFromFacts({
          report: latest,
          proposal,
          workflow: workflowById.get(id) ?? null,
          checks: checks.filter((row) => row.supplier_product_id === id),
          hold: holdById.get(id) ?? null,
          config: cfg,
        }),
      }))
      : runTransitions
        .filter((row) => row.proposed_action === 'propose_delist')
        .map((row) => ({
          supplier_product_id: row.supplier_product_id,
          sku: products.get(row.supplier_product_id)?.sku_custom ?? row.supplier_sku ?? row.supplier_product_id,
          title: products.get(row.supplier_product_id)?.product_title ?? '未命名商品',
          recommendation: null,
        }));
    const errorItems = runChecks.filter((row) => row.available === null || row.failure_reason).map((row) => ({
      supplier_product_id: row.supplier_product_id,
      sku: products.get(row.supplier_product_id)?.sku_custom ?? workflowById.get(row.supplier_product_id)?.supplier_sku ?? row.supplier_product_id,
      title: products.get(row.supplier_product_id)?.product_title ?? '未命名商品',
      error_code: row.status || 'unknown_error',
      error_message: row.status === 'malformed_response' ? '供应商库存响应格式不完整，无法确认库存。' : '库存读取失败，未改变商品状态。',
      technical_detail: row.failure_reason,
      data_source: 'product_availability_checks',
      retryable: true,
      failed_at: row.checked_at,
    }));
    const blockedCount = hasBlockedGate ? proposedDelist.length : 0;
    return {
      run_id: runId,
      source: 'automatic',
      trigger_type: 'automatic_48h',
      started_at: isLatest ? latest.started_at ?? null : times.length ? new Date(Math.min(...times)).toISOString() : null,
      finished_at: isLatest ? latest.finished_at ?? null : times.length ? new Date(Math.max(...times)).toISOString() : null,
      scanned: isLatest ? latest.totals?.total ?? runChecks.length : runChecks.length,
      available: isLatest ? latest.totals?.confirmedAvailable ?? 0 : runChecks.filter((row) => row.available === true).length,
      unavailable: isLatest ? latest.totals?.confirmedOutOfStock ?? 0 : runChecks.filter((row) => row.available === false).length,
      failures: displayedFailures,
      proposed_delist: isLatest ? latest.counts?.second_strike_delist ?? 0 : runTransitions.filter((row) => row.proposed_action === 'propose_delist').length,
      proposed_relist: isLatest ? latest.counts?.relist_eligible ?? 0 : runTransitions.filter((row) => row.proposed_action === 'propose_relist').length,
      applied_delist: runAudits.filter((row) => row.action === 'delist').length,
      applied_relist: runAudits.filter((row) => row.action === 'relist').length,
      blocked_count: blockedCount,
      gates: isLatest ? latest.gates ?? {} : null,
      steps: [
        { id: 'read_targets', label: '读取在售商品', status: 'completed', count: isLatest ? latest.totals?.total ?? runChecks.length : runChecks.length },
        { id: 'check_inventory', label: '检查库存', status: displayedFailures > 0 ? 'completed_with_errors' : 'completed', count: runChecks.length },
        { id: 'evaluate_rules', label: '评估生命周期规则', status: 'completed', count: proposedDelist.length },
        { id: 'apply_actions', label: '执行下架/恢复', status: blockedCount > 0 ? 'blocked' : 'completed', count: runAudits.length },
      ],
      proposed_delist_items: proposedDelist,
      error_items: errorItems,
      terminal_status: hasBlockedGate
        ? 'completed_with_blocks'
        : displayedFailures > 0
          ? 'completed_with_errors'
          : 'completed',
    };
  });
  return success('runs', {
    runs,
    cursor,
    total: runIds.length,
    next_cursor: cursor + runs.length < runIds.length ? cursor + runs.length : null,
  });
}

function triggerRunNow(): Record<string, unknown> {
  const scheduler = readSchedulerFact();
  if (!(scheduler as any).installed) return failure('SCHEDULER_NOT_INSTALLED', '现有 48 小时调度器尚未安装');
  if (!(scheduler as any).loaded) return failure('SCHEDULER_NOT_LOADED', '现有 48 小时调度器当前未加载');
  const activeLock = [readActiveLock(SCAN_LOCK), readActiveLock(APPLY_LOCK)].find((lock) => lock.active);
  if (activeLock) return failure('RUN_LOCKED', '库存生命周期已有运行正在执行');
  const baseline = readLatestReport();
  const result = spawnSync('/bin/bash', [SCHEDULER_SCRIPT, 'run-now'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env },
  });
  if (result.status !== 0) return failure('TRIGGER_FAILED', '现有库存生命周期未能接受运行触发');
  return success('run-now', {
    trigger_status: 'trigger_accepted',
    baseline_upstream_run_id: baseline?.run_id ?? null,
    scheduler_label: SCHEDULER_LABEL,
    schedule_changed: false,
    scheduler_created: false,
  });
}

export async function executeInventoryLifecycleBridge(
  request: InventoryLifecycleBridgeRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  if (request.operation === 'summary') return buildSummary(client);
  if (request.operation === 'items') return buildItems(request, client);
  if (request.operation === 'runs') return buildRuns(request, client);
  if (request.operation === 'recheck-item') return runTargetedRecheck(request, client);
  return triggerRunNow();
}

async function main(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    const raw = await readStdin();
    const request = parseInventoryLifecycleBridgeRequest(raw);
    const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
    if (request.operation === 'run-now') {
      response = triggerRunNow();
    } else if (!url || !key) {
      response = failure('NOT_CONFIGURED', '库存生命周期读取器尚未配置');
    } else {
      const client = createClient(url, key, { auth: { persistSession: false } });
      response = await executeInventoryLifecycleBridge(request, client);
    }
  } catch (error) {
    const rawCode = error instanceof Error ? error.message.split(':')[0] : 'BRIDGE_FAILED';
    const known = new Set(['INVALID_REQUEST', 'INVALID_BUCKET', 'INVALID_LIMIT', 'INVALID_CURSOR', 'INVALID_SKU', 'INVALID_OPERATOR']);
    const code = known.has(rawCode) ? rawCode : 'BRIDGE_FAILED';
    response = failure(code, known.has(rawCode) ? '库存生命周期请求无效' : '库存生命周期读取失败');
    console.error(`[xone-inventory-lifecycle] ${code}`);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1]?.endsWith('xoneInventoryLifecycleBridge.ts')) void main();
