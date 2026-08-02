/**
 * Availability persistence planner — pure, deterministic, side-effect free.
 *
 * Decides exactly what the live writer should send to the database for one API answer, without
 * performing any I/O. The scanner executes these plans; every rule lives here so it can be tested
 * without a database.
 *
 * PHASE 1 SCOPE — evidence and lifecycle only.
 * This phase may write: availability evidence, checked_at, canonical status, state-machine counters
 * and proposed lifecycle state, and audit rows. It may NOT write any publication field. That is not
 * a convention — `FORBIDDEN_WRITE_TABLES` below is asserted against the writer's own source, so a
 * publication write cannot be added without failing the suite.
 *
 * THE STRUCTURAL SAFETY PROPERTY
 * ------------------------------
 * `product_availability_current.available` is NOT NULL and its `status` admits only the two
 * confirmed values. A failure therefore cannot be represented in that table at all — it is
 * impossible, at the schema level, for a network blip to overwrite the last good answer with a zero.
 * Failures update only the failure telemetry columns, leaving the confirmed answer standing.
 */
import type { AvailabilityResult } from './openApiAvailability';

/** Tables this phase must never write. Asserted against the writer's source by the test suite. */
export const FORBIDDEN_WRITE_TABLES = [
  'standardized_products',
  'supplier_products',
  'sellable_products',
  'inventory_cache',
  'saved_assets',
  'product_reviews',
  'orders',
] as const;

/** Publication columns that must never appear in a write payload in this phase. */
export const FORBIDDEN_WRITE_COLUMNS = [
  'published',
  'inventory_status',
  'total_available_qty',
  'has_ca_pickup',
  'has_valid_inventory',
  'available_warehouse_count',
] as const;

export interface CheckRow {
  supplier_product_id: string;
  source: 'open_api';
  available: boolean | null;
  status: string;
  failure_reason: string | null;
  run_id: string;
  checked_at: string;
}

export interface CurrentUpsert {
  supplier_product_id: string;
  source: 'open_api';
  available: boolean;
  status: 'confirmed_available' | 'confirmed_out_of_stock';
  last_run_id: string;
  checked_at: string;
  last_confirmed_available_at: string | null;
  last_confirmed_unavailable_at: string | null;
  consecutive_failures: 0;
  updated_at: string;
}

export interface FailureUpdate {
  supplier_product_id: string;
  consecutive_failures: number;
  last_failure_status: string;
  last_failure_reason: string | null;
  last_failure_at: string;
  updated_at: string;
}

/** The current row as already persisted, when one exists. */
export interface PriorCurrentRow {
  supplier_product_id: string;
  available: boolean;
  status: string;
  checked_at: string;
  last_confirmed_available_at: string | null;
  last_confirmed_unavailable_at: string | null;
  consecutive_failures: number;
}

export interface PersistencePlan {
  sku: string;
  /** Always written — the audit trail records failures too. */
  checkRow: CheckRow;
  /** Written ONLY for a confirmed answer. Null for every failure mode. */
  currentUpsert: CurrentUpsert | null;
  /** Written ONLY for a failure, and only when a prior row exists to annotate. */
  failureUpdate: FailureUpdate | null;
  /** True when the confirmed answer is unchanged from what is already stored. */
  currentUnchanged: boolean;
}

const isConfirmedStatus = (s: string): s is 'confirmed_available' | 'confirmed_out_of_stock' =>
  s === 'confirmed_available' || s === 'confirmed_out_of_stock';

/**
 * Build the complete write plan for one API answer.
 *
 * `prior` is the persisted current row, or null when this SKU has never had a confirmed answer.
 */
export function planPersistence(
  result: AvailabilityResult,
  prior: PriorCurrentRow | null,
  runId: string,
  checkedAt: string,
): PersistencePlan {
  // Narrow through the guard itself so the confirmed branch has a literal status type.
  const status = result.status;
  const confirmedStatus = isConfirmedStatus(status) ? status : null;

  const checkRow: CheckRow = {
    supplier_product_id: result.sku,
    source: 'open_api',
    available: confirmedStatus ? result.available : null,
    status,
    failure_reason: confirmedStatus ? null : result.reason,
    run_id: runId,
    checked_at: checkedAt,
  };

  if (!confirmedStatus) {
    // A failure never touches `available`. It only annotates telemetry, and only when there is an
    // existing row to annotate — we must not invent a current row from a failed read.
    const failureUpdate: FailureUpdate | null = prior
      ? {
          supplier_product_id: result.sku,
          consecutive_failures: prior.consecutive_failures + 1,
          last_failure_status: status,
          last_failure_reason: result.reason,
          last_failure_at: checkedAt,
          updated_at: checkedAt,
        }
      : null;
    return { sku: result.sku, checkRow, currentUpsert: null, failureUpdate, currentUnchanged: false };
  }

  const available = result.available === true;
  const currentUpsert: CurrentUpsert = {
    supplier_product_id: result.sku,
    source: 'open_api',
    available,
    status: confirmedStatus,
    last_run_id: runId,
    checked_at: checkedAt,
    // Each confirmation stamps its own side and preserves the other side's history.
    last_confirmed_available_at: available ? checkedAt : (prior?.last_confirmed_available_at ?? null),
    last_confirmed_unavailable_at: available ? (prior?.last_confirmed_unavailable_at ?? null) : checkedAt,
    consecutive_failures: 0,   // a confirmed answer clears the failure streak
    updated_at: checkedAt,
  };

  // "Unchanged" means the ANSWER is the same; checked_at still advances, which is the point of
  // re-scanning. Reported so a re-run can be shown to add no new information.
  const currentUnchanged = !!prior && prior.available === available && prior.status === confirmedStatus;

  return { sku: result.sku, checkRow, currentUpsert, failureUpdate: null, currentUnchanged };
}

export interface PlanTally {
  total: number;
  confirmed: number;
  failures: number;
  currentUpserts: number;
  failureAnnotations: number;
  unchanged: number;
}

export function tallyPlans(plans: readonly PersistencePlan[]): PlanTally {
  return {
    total: plans.length,
    confirmed: plans.filter(p => p.currentUpsert !== null).length,
    failures: plans.filter(p => p.currentUpsert === null).length,
    currentUpserts: plans.filter(p => p.currentUpsert !== null).length,
    failureAnnotations: plans.filter(p => p.failureUpdate !== null).length,
    unchanged: plans.filter(p => p.currentUnchanged).length,
  };
}

/**
 * Guard rail: assert no plan carries a publication field. Cheap, and it makes the invariant a
 * runtime failure rather than a code-review hope.
 */
export function assertNoPublicationWrite(plans: readonly PersistencePlan[]): void {
  for (const p of plans) {
    for (const payload of [p.checkRow, p.currentUpsert, p.failureUpdate]) {
      if (!payload) continue;
      for (const col of FORBIDDEN_WRITE_COLUMNS) {
        if (col in (payload as unknown as Record<string, unknown>)) {
          throw new Error(`publication column "${col}" must never be written in this phase (sku ${p.sku})`);
        }
      }
    }
  }
}
