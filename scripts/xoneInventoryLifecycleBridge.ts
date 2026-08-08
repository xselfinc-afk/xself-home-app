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
import { evaluatePublicationApproval, verifyPublicationOutcome } from '../src/services/inventoryPublicationApproval';
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
  | {
    schema_version: '1.0';
    operation: 'approve-publication';
    sku: string;
    action: 'delist' | 'relist';
    approved_by: string;
    source_run_id: string;
  }
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
    // 前端只被允许说「谁、对哪个 SKU、批准了哪个方向、基于哪次 run」。
    // eligible / evidence / safety_passed 这类结论一律不接受，由后台重新判断。
    'approve-publication': new Set(['schema_version', 'operation', 'sku', 'action', 'approved_by', 'source_run_id']),
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

/**
 * Which run kinds count as a scan of the whole published catalogue.
 *
 * `latest-availability-scan.json` used to be overwritten by any run that wasn't flagged
 * `--xone-targeted`, including a 1-SKU `--skus=` run. So the file alone cannot answer "was this a
 * full scan" — a report must say so explicitly. Legacy reports written before `is_full_scan`
 * existed are treated as unknown, never as full: claiming a full scan we cannot prove is exactly
 * the failure this is here to stop.
 */
export function isFullScanReport(report: Record<string, any> | null): boolean {
  if (!report) return false;
  return report.is_full_scan === true && report.report_kind === 'scheduled_inventory_scan';
}

/** Human-facing run kind. Not every run is 「自动48小时循环」. */
export function describeRunKind(report: Record<string, any> | null): {
  kind: string;
  label: string;
} {
  const raw = typeof report?.report_kind === 'string' ? report.report_kind : null;
  switch (raw) {
    case 'scheduled_inventory_scan':
      return report?.is_full_scan === true
        ? { kind: 'full_scan', label: '全量库存扫描' }
        : { kind: 'unknown_scope_scan', label: '扫描（范围未记录）' };
    case 'targeted_sku_scan':
      return { kind: 'targeted_sku_scan', label: '指定 SKU 复检' };
    case 'partial_limited_scan':
      return { kind: 'partial_limited_scan', label: '限量抽样扫描' };
    case 'xone_single_sku_recheck':
      return { kind: 'single_sku_recheck', label: '单件复检' };
    default:
      return { kind: 'unknown', label: '未知类型' };
  }
}

/**
 * The last run that actually scanned the whole catalogue.
 *
 * Walks the report directory rather than trusting the `latest` filename, because narrowed runs
 * used to overwrite it. Returns null when no report proves it was full — the overview then says
 * so instead of showing a 1-SKU run as 「上次 48 小时扫描」.
 */
function readAllReports(): Record<string, any>[] {
  let files: string[] = [];
  try { files = fs.readdirSync(REPORT_DIR).filter((name) => name.endsWith('.json')); } catch { return []; }
  const out: Record<string, any>[] = [];
  for (const name of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(REPORT_DIR, name), 'utf8'))); } catch { /* 跳过损坏文件 */ }
  }
  return out;
}

function newestBy(reports: Record<string, any>[]): Record<string, any> | null {
  let best: Record<string, any> | null = null;
  let bestAt = -Infinity;
  for (const report of reports) {
    const at = Date.parse(String(report.finished_at ?? report.started_at ?? ''));
    if (Number.isFinite(at) && at > bestAt) { bestAt = at; best = report; }
  }
  return best;
}

export function readLatestFullScanReport(): Record<string, any> | null {
  return newestBy(readAllReports().filter(isFullScanReport));
}

/** 最近一次运行，不限类型 —— 用户做的单件复检也应该出现在「最近运行」里。 */
function readMostRecentReport(): Record<string, any> | null {
  return newestBy(readAllReports()) ?? readLatestReport();
}

/** run_id → 报告，供运行记录标注真实类型。 */
function reportsByRunId(): Map<string, Record<string, any>> {
  const map = new Map<string, Record<string, any>>();
  for (const report of readAllReports()) {
    if (typeof report.run_id === 'string') map.set(report.run_id, report);
  }
  return map;
}

/**
 * Did the run actually succeed? A dry run where every probe failed is not 「上次成功扫描」.
 *
 * `failed` — nothing usable came back (all probes failed, or the failure-rate gate tripped).
 * `partial` — some evidence landed but there were failures or a blocked gate.
 * `success` — evidence for everything it looked at, no blocked gates.
 */
export function deriveRunTerminalStatus(report: Record<string, any> | null): string {
  if (!report) return 'unknown';
  const totals = report.totals ?? {};
  const scanned = Number(totals.total ?? 0);
  const failures = Number(totals.failures ?? 0);
  const blocked = Object.values(report.gates ?? {}).some((gate) => (
    gate && typeof gate === 'object' && (gate as { allowed?: boolean }).allowed === false
  ));
  if (scanned === 0) return 'failed';
  if (failures >= scanned) return 'failed';
  if (failures > 0 || blocked) return 'partial';
  return 'success';
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

/** Pull the few facts we need out of `launchctl print`. Absent keys stay null, never guessed. */
export function parseLaunchctlPrint(text: string): {
  runs: number | null;
  lastExitCode: number | null;
  runAtLoad: boolean | null;
  intervalSeconds: number | null;
} {
  const grab = (re: RegExp): string | null => text.match(re)?.[1]?.trim() ?? null;
  const runs = grab(/^\s*runs\s*=\s*(\d+)\s*$/m);
  const exit = grab(/^\s*last exit code\s*=\s*(\d+)\s*$/m);
  const interval = grab(/^\s*run interval\s*=\s*(\d+)\s*seconds\s*$/m);
  const runAtLoad = /^\s*runatload\s*=\s*(1|true)\s*$/im.test(text)
    ? true
    : /^\s*runatload\s*=\s*(0|false)\s*$/im.test(text) ? false : null;
  return {
    runs: runs === null ? null : Number(runs),
    lastExitCode: exit === null ? null : Number(exit),
    runAtLoad,
    intervalSeconds: interval === null ? null : Number(interval),
  };
}

/**
 * Why a loaded 48h job can still never have run.
 *
 * `StartInterval` counts from load, and launchd reloads agents on every boot. With
 * `RunAtLoad=false`, a Mac that reboots more often than the interval restarts the countdown
 * before it ever reaches 48h — the job stays loaded, healthy-looking, and permanently at
 * `runs = 0`. Reporting "已加载" without this is how the last audit found a scheduler that had
 * never executed a single scan.
 */
export function diagnoseScheduler(input: {
  installed: boolean;
  loaded: boolean;
  runs: number | null;
  runAtLoad: boolean | null;
  intervalSeconds: number | null;
}): { status: string; reason: string | null } {
  if (!input.installed) return { status: 'not_installed', reason: '调度器尚未安装' };
  if (!input.loaded) return { status: 'not_loaded', reason: '调度器已安装但未加载到 launchd' };
  if (input.runs === 0 && input.runAtLoad === false && (input.intervalSeconds ?? 0) > 0) {
    return {
      status: 'never_ran',
      reason: '倒计时从加载时刻重新开始，而这台 Mac 的重启间隔短于扫描间隔，所以计时器从未走完',
    };
  }
  if (input.runs === 0) return { status: 'never_ran', reason: '已加载，但至今没有执行过一次' };
  return { status: 'active', reason: null };
}

export function readSchedulerFact(): Record<string, unknown> {
  const installed = Boolean(process.env.HOME) && fs.existsSync(SCHEDULER_PLIST);
  const target = `gui/${process.getuid?.() ?? 0}/${SCHEDULER_LABEL}`;
  const printed = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 5_000 });
  const loaded = installed && printed.status === 0;
  const launchd = parseLaunchctlPrint(printed.stdout ?? '');
  // `launchctl print` does not echo RunAtLoad, so read it from the plist we installed. Without it
  // the diagnosis cannot tell "never fired because the countdown keeps resetting" apart from
  // "never fired for some other reason", and the user gets a reason that does not help them.
  let runAtLoad = launchd.runAtLoad;
  if (runAtLoad === null && installed) {
    try {
      const plist = fs.readFileSync(SCHEDULER_PLIST, 'utf8');
      if (/<key>RunAtLoad<\/key>\s*<true\s*\/>/.test(plist)) runAtLoad = true;
      else if (/<key>RunAtLoad<\/key>\s*<false\s*\/>/.test(plist)) runAtLoad = false;
    } catch { /* 读不到就保持未知，不猜 */ }
  }
  const diagnosis = diagnoseScheduler({
    installed, loaded, runs: launchd.runs, runAtLoad, intervalSeconds: launchd.intervalSeconds,
  });

  // 「上次扫描」只能是真正的全量扫描，而且只有真的成功了才算成功。
  const fullScan = readLatestFullScanReport();
  const lastFullScanAt = typeof fullScan?.finished_at === 'string' ? fullScan.finished_at : null;
  const lastFullScanStatus = fullScan ? deriveRunTerminalStatus(fullScan) : null;
  const lastSuccessfulFullScanAt = lastFullScanStatus === 'success' ? lastFullScanAt : null;

  // 只有真的跑过，才谈得上「下次」。而且这始终是我们自己按间隔推算的，launchd 不提供精确时间。
  const estimatedNextRunAt = lastFullScanAt
    ? new Date(Date.parse(lastFullScanAt) + INTERVAL_SECONDS * 1000).toISOString()
    : null;
  return {
    label: SCHEDULER_LABEL,
    installed,
    loaded,
    enabled: loaded,
    interval_seconds: INTERVAL_SECONDS,
    cadence_label: '每 48 小时',
    // launchd 的真实执行记录，与报告文件无关。
    launchd_runs: launchd.runs,
    launchd_last_exit_code: launchd.lastExitCode,
    launchd_run_at_load: runAtLoad,
    launchd_interval_seconds: launchd.intervalSeconds,
    status: diagnosis.status,
    status_reason: diagnosis.reason,
    last_full_scan_at: lastFullScanAt,
    last_full_scan_status: lastFullScanStatus,
    last_successful_full_scan_at: lastSuccessfulFullScanAt,
    // 推算值，不是 launchd 给的时间；UI 必须标成「预计」。
    estimated_next_run_at: estimatedNextRunAt,
    next_run_is_estimated: true,
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

/**
 * Every currently published product id.
 *
 * Paginated on purpose: PostgREST caps a plain select at 1000 rows, and an unpaginated read is
 * how the supplier-favorite facts job silently missed 467 rows. A truncated denominator here
 * would inflate coverage instead of reporting it.
 */
async function readPublishedIds(client: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const result = await client.from('standardized_products')
      .select('supplier_product_id').eq('published', true).range(from, from + page - 1);
    if (result.error) throw new Error('READ_FAILED:published_ids');
    const rows = (result.data ?? []) as Array<{ supplier_product_id: string }>;
    for (const row of rows) ids.add(row.supplier_product_id);
    if (rows.length < page) break;
  }
  return ids;
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
    run_kind: describeRunKind(report).kind,
    run_kind_label: describeRunKind(report).label,
    is_full_scan: report.is_full_scan === true,
    scanned: report.totals?.total ?? 0,
    available: report.totals?.confirmedAvailable ?? 0,
    unavailable: report.totals?.confirmedOutOfStock ?? 0,
    failures: report.totals?.failures ?? 0,
    failure_percent: report.totals?.failurePercent ?? 0,
    proposed_delist: report.counts?.second_strike_delist ?? 0,
    proposed_relist: report.counts?.relist_eligible ?? 0,
    gates: report.gates ?? {},
    // 全失败的 dry run 不是「完成」。success / partial / failed 三态由实际结果决定。
    terminal_status: deriveRunTerminalStatus(report),
    has_blocked_gate: hasBlockedGate,
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
  availability: ReadonlyArray<{ supplier_product_id?: string; checked_at?: string | null }>,
  published: ReadonlySet<string>,
  now: Date = new Date(),
): { published: number; covered: number; percent: number } {
  const cutoff = now.getTime() - AVAILABILITY_GRACE_HOURS * 3_600_000;
  // 分子只数当前已发布的商品。证据表里还留着早已下架商品的行，把它们算进来会让覆盖率超过
  // 100% —— 分子分母必须是同一个集合的两种状态，不是两份互不相干的数据。
  const seen = new Set<string>();
  for (const row of availability) {
    const id = row.supplier_product_id;
    if (!id || !published.has(id) || seen.has(id)) continue;
    if (!row.checked_at) continue;
    const checkedAt = Date.parse(row.checked_at);
    if (Number.isFinite(checkedAt) && checkedAt >= cutoff) seen.add(id);
  }
  const publishedCount = published.size;
  const percent = publishedCount > 0 ? Number(((seen.size / publishedCount) * 100).toFixed(1)) : 0;
  return { published: publishedCount, covered: seen.size, percent };
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
  /** not_installed | not_loaded | never_ran | active。缺省时只看 schedulerLoaded。 */
  schedulerStatus?: string;
}): string {
  if (input.runLockActive) return 'running';
  if (!input.schedulerLoaded) return 'blocked';
  // 一个加载着、却一次都没执行过的调度器不是「健康」—— 证据现在够新只是因为有人手动跑过，
  // 不代表这套自动化在工作。它会在证据过期时毫无预警地让商品从店面消失。
  if (input.schedulerStatus === 'never_ran') return 'attention_required';
  if (input.errors > 0 || input.coverageBelowMinimum) return 'attention_required';
  return 'healthy';
}

async function buildSummary(client: SupabaseClient): Promise<Record<string, unknown>> {
  const report = readMostRecentReport();
  const latestRunId = typeof report?.run_id === 'string' ? report.run_id : null;
  const [{ workflows, availability, holds }, cfg, relistAuditResult, latestAuditResult, sellableResult, publishedIds] = await Promise.all([
    readCoreRows(client),
    loadInventoryConfigForScript(),
    client.from('publication_audit_log').select('supplier_product_id', { count: 'exact', head: true }).eq('action', 'relist'),
    latestRunId
      ? client.from('publication_audit_log').select('action').eq('run_id', latestRunId).limit(1_000)
      : Promise.resolve({ data: [], error: null }),
    // Live storefront size. coverage.visible comes from the scan report and is measured BEFORE the
    // scan refreshes evidence, so it cannot answer "how many products can a customer see right now".
    client.from('sellable_products').select('supplier_product_id', { count: 'exact', head: true }),
    // Live published set — the ONLY valid coverage denominator, and also the filter for the
    // numerator. Reading it from the scan report is what produced 35200%: the numerator was live
    // (352 rows in grace) while the denominator came from a 1-SKU targeted run that had
    // overwritten latest-availability-scan.json.
    readPublishedIds(client),
  ]);
  if (relistAuditResult.error) throw new Error('READ_FAILED:relist_audit_count');
  if (latestAuditResult.error) throw new Error('READ_FAILED:latest_publication_audit');
  const stateCounts = groupStateCounts(workflows);
  // 「当前读取失败」必须来自实时证据表。用报告里的 failures 会让一次 1 件的 dry run 长期显示
  // 「读取失败 1」，即使那件商品早已恢复正常 —— 报告数字属于「最近运行」，不属于「当前状态」。
  const errors = availability.filter((row) => Number(row.consecutive_failures ?? 0) > 0).length;
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
  // 分子分母必须同源、同时刻：都取实时表。扫描报告的数字只出现在「最近运行」里。
  const visible = sellableResult.error ? 0 : (sellableResult.count ?? 0);
  const { published, covered, percent: coveragePercent } = computeAvailabilityCoverage(availability, publishedIds);
  // Reuses the existing inventory_min_coverage_percent (default 95) rather than adding a knob.
  const coverageBelowMinimum = published > 0 && coveragePercent < cfg.minCoveragePercent;
  const health = deriveInventoryHealth({
    runLockActive: Boolean(activeLock),
    schedulerLoaded: Boolean((scheduler as any).loaded),
    schedulerStatus: String((scheduler as any).status ?? ''),
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
    // 产生当前证据的那次 run。审批时必须原样带回：后台据此判断这条建议是否仍是最新的 ——
    // 一旦有更新的扫描写入新证据，last_run_id 就会变，旧建议随之作废。
    source_run_id: availability?.last_run_id ?? null,
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
  const latest = readMostRecentReport();
  const reportByRun = reportsByRunId();
  // 每份报告都可能对应一次没有写任何数据库行的运行（dry run），也要出现在运行记录里。
  for (const [runId, report] of reportByRun) {
    if (seen.has(runId)) continue;
    seen.add(runId);
    const at = Date.parse(String(report.finished_at ?? ''));
    if (Number.isFinite(at)) runIds.push(runId);
  }
  runIds.sort((a, b) => {
    const at = (id: string) => Date.parse(String(reportByRun.get(id)?.finished_at ?? '')) || 0;
    const fallback = (id: string) => {
      const rows = checks.filter((row) => row.run_id === id).map((row) => Date.parse(row.checked_at));
      return rows.length ? Math.max(...rows) : 0;
    };
    return (at(b) || fallback(b)) - (at(a) || fallback(a));
  });

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
    // 每次运行用它自己的报告，而不是只让「最近一次」享有报告。否则历史 run 全部退化成
    // 数据库行统计，类型也只能靠猜。
    const runReport = reportByRun.get(runId) ?? null;
    const isLatest = latest?.run_id === runId;
    const failures = runChecks.filter((row) => row.available === null).length;
    const displayedFailures = runReport ? runReport.totals?.failures ?? failures : failures;
    const hasBlockedGate = Boolean(runReport) && Object.values(runReport!.gates ?? {}).some((gate) => (
      gate && typeof gate === 'object' && (gate as { allowed?: boolean }).allowed === false
    ));
    const runKind = describeRunKind(runReport);
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
      // 单件复检是人点出来的，不是 48 小时循环。把两者都标成 automatic_48h 是误导。
      source: runKind.kind === 'full_scan' ? 'automatic' : 'manual',
      trigger_type: runKind.kind === 'full_scan' ? 'automatic_48h' : runKind.kind,
      run_kind: runKind.kind,
      run_kind_label: runKind.label,
      is_full_scan: runReport?.is_full_scan === true,
      started_at: runReport?.started_at ?? (times.length ? new Date(Math.min(...times)).toISOString() : null),
      finished_at: runReport?.finished_at ?? (times.length ? new Date(Math.max(...times)).toISOString() : null),
      scanned: runReport ? runReport.totals?.total ?? runChecks.length : runChecks.length,
      available: runReport ? runReport.totals?.confirmedAvailable ?? 0 : runChecks.filter((row) => row.available === true).length,
      unavailable: runReport ? runReport.totals?.confirmedOutOfStock ?? 0 : runChecks.filter((row) => row.available === false).length,
      failures: displayedFailures,
      proposed_delist: runReport ? runReport.counts?.second_strike_delist ?? 0 : runTransitions.filter((row) => row.proposed_action === 'propose_delist').length,
      proposed_relist: runReport ? runReport.counts?.relist_eligible ?? 0 : runTransitions.filter((row) => row.proposed_action === 'propose_relist').length,
      applied_delist: runAudits.filter((row) => row.action === 'delist').length,
      applied_relist: runAudits.filter((row) => row.action === 'relist').length,
      blocked_count: blockedCount,
      gates: runReport?.gates ?? null,
      steps: [
        { id: 'read_targets', label: '读取在售商品', status: 'completed', count: runReport ? runReport.totals?.total ?? runChecks.length : runChecks.length },
        { id: 'check_inventory', label: '检查库存', status: displayedFailures > 0 ? 'completed_with_errors' : 'completed', count: runChecks.length },
        { id: 'evaluate_rules', label: '评估生命周期规则', status: 'completed', count: proposedDelist.length },
        { id: 'apply_actions', label: '执行下架/恢复', status: blockedCount > 0 ? 'blocked' : 'completed', count: runAudits.length },
      ],
      proposed_delist_items: proposedDelist,
      error_items: errorItems,
      // 有报告就用报告的真实结果判定；没有报告只能按数据库行推断，全失败一样算 failed。
      terminal_status: runReport
        ? deriveRunTerminalStatus(runReport)
        : runChecks.length === 0
          ? 'unknown'
          : displayedFailures >= runChecks.length
            ? 'failed'
            : displayedFailures > 0 || hasBlockedGate ? 'partial' : 'success',
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

  // ── 人工批准一次发布变更 ─────────────────────────────────────────────────
  //
  // 这是 published 的唯一入口。它不自己写发布状态：判定通过后调用既有的
  // applyInventoryLifecycleActions.ts（精确单件 + --approve + 真人姓名），由它经
  // set_publication_from_availability() 落库并写 publication_audit_log。
  if (request.operation === 'approve-publication') {
    const sku = String(request.sku ?? '').trim();
    const action = request.action;
    const approvedBy = String(request.approved_by ?? '').trim();
    const sourceRunId = String(request.source_run_id ?? '').trim();
    if (action !== 'delist' && action !== 'relist') return failure('INVALID_ACTION', '未知的发布动作');

    // 后台重新读取最新事实 —— 前端传来的任何判断都不采信。
    const [workflowRes, availabilityRes, productRes, publishedCountRes] = await Promise.all([
      client.from('inventory_workflow_states')
        .select('supplier_product_id,workflow_state,consecutive_out_of_stock,consecutive_in_stock,source_run_id')
        .eq('supplier_product_id', sku).maybeSingle(),
      client.from('product_availability_current')
        .select('supplier_product_id,available,checked_at,last_run_id')
        .eq('supplier_product_id', sku).maybeSingle(),
      client.from('standardized_products')
        .select('supplier_product_id,published,product_title')
        .eq('supplier_product_id', sku).maybeSingle(),
      client.from('standardized_products').select('supplier_product_id', { count: 'exact', head: true }).eq('published', true),
    ]);
    const workflow = (workflowRes.data ?? null) as { workflow_state?: string; consecutive_out_of_stock?: number; consecutive_in_stock?: number } | null;
    const availability = (availabilityRes.data ?? null) as { available?: boolean | null; checked_at?: string | null; last_run_id?: string | null } | null;
    const product = (productRes.data ?? null) as { published?: boolean | null; product_title?: string | null } | null;
    const cfgNow = await loadInventoryConfigForScript();

    const verdict = evaluatePublicationApproval({
      supplier_product_id: sku,
      action,
      approved_by: approvedBy,
      source_run_id: sourceRunId,
      facts: {
        workflow_state: workflow?.workflow_state ?? null,
        published: product?.published ?? null,
        available: availability?.available ?? null,
        checked_at: availability?.checked_at ?? null,
        consecutive_out_of_stock: Number(workflow?.consecutive_out_of_stock ?? 0),
        consecutive_in_stock: Number(workflow?.consecutive_in_stock ?? 0),
        current_source_run_id: availability?.last_run_id ?? null,
      },
      config: cfgNow as never,
      total_published: publishedCountRes.count ?? 0,
    });

    if (!verdict.allowed) {
      return success('approve-publication', {
        status: 'blocked',
        supplier_product_id: sku,
        action,
        blocks: verdict.blocks,
        safety_blocks: verdict.safety_blocks,
        published_before: product?.published ?? null,
        published_after: product?.published ?? null,
        verified: false,
      });
    }

    // 判定通过 → 调用既有执行器。精确单件，绝无 "all"。
    const publishedBefore = product?.published ?? null;
    const runtime = path.join(REPO, 'node_modules', '.bin', 'tsx');
    const apply = spawnSync('/opt/homebrew/bin/node', [
      runtime,
      path.join(REPO, 'scripts', 'applyInventoryLifecycleActions.ts'),
      `--action=${action}`,
      `--only=${sku}`,
      '--approve',
      `--approved-by=${approvedBy}`,
    ], { cwd: REPO, encoding: 'utf8', timeout: 180_000, env: { ...process.env } });

    // 执行器用退出码 4 表示锁被占用 —— 同一 SKU 正在执行时的第二次批准落在这里。
    if (apply.status === 4) {
      return success('approve-publication', {
        status: 'already_running', supplier_product_id: sku, action,
        blocks: [], safety_blocks: [], published_before: publishedBefore,
        published_after: publishedBefore, verified: false,
      });
    }

    // 执行器返回成功不等于真的变了：回读 published 与 App 可见集合。
    const [afterRes, sellableRes] = await Promise.all([
      client.from('standardized_products').select('published').eq('supplier_product_id', sku).maybeSingle(),
      client.from('sellable_products').select('supplier_product_id').eq('supplier_product_id', sku).maybeSingle(),
    ]);
    const publishedAfter = ((afterRes.data ?? null) as { published?: boolean | null } | null)?.published ?? null;
    const outcome = verifyPublicationOutcome({
      action,
      published_before: publishedBefore,
      published_after: publishedAfter,
      sellable_after: sellableRes.data ? true : false,
    });

    return success('approve-publication', {
      status: apply.status === 0
        ? (outcome.verified ? 'verified_completed' : 'verification_failed')
        : 'failed',
      supplier_product_id: sku,
      action,
      approved_by: approvedBy,
      blocks: [],
      safety_blocks: [],
      executor_exit_code: apply.status,
      published_before: publishedBefore,
      published_after: publishedAfter,
      verified: outcome.verified,
      verification_reason: outcome.reason,
      product_title: product?.product_title ?? null,
    });
  }

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
