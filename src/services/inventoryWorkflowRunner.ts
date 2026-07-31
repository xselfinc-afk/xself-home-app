/**
 * Pure planning layer for the persisted inventory workflow.
 *
 * This module adds NO new state-machine logic. The six-state machine in
 * `inventoryStateMachine.ts` and the fail-closed classifier in `inventoryResult.ts` remain
 * authoritative; this file only decides:
 *
 *   1. how a set of inventory_cache rows becomes one observation (buildSignalsFromCacheRows);
 *   2. whether that observation is allowed to advance counters (observationClass);
 *   3. whether it has already been processed (observationKey → idempotency);
 *   4. what row/history writes the runner should perform (planWorkflowUpdate).
 *
 * Everything here is pure and I/O-free so it can be tested without a database.
 *
 * Fail-closed rules preserved from the existing architecture:
 *   * absence of evidence → `inventory_unknown`, never zero;
 *   * failures (auth/captcha/parse/network) → never zero, never advance;
 *   * stale evidence → never a confirmed zero, never advance;
 *   * only CONFIRMED in-stock / out-of-stock observations move counters.
 */
import {
  classifyInventoryResult,
  isFailure,
  isConfirmed,
  type InventoryResult,
  type InventoryResultStatus,
  type RawInventorySignals,
  type WarehouseStock,
} from './inventoryResult';
import {
  transitionInventoryState,
  DEFAULT_STATE_MACHINE_POLICY,
  type InventoryWorkflowState,
  type StateMachinePolicy,
  type WorkflowSnapshot,
  type Transition,
} from './inventoryStateMachine';

export const ALL_WORKFLOW_STATES: readonly InventoryWorkflowState[] = [
  'published_in_stock',
  'pending_out_of_stock',
  'eligible_for_delist',
  'delisted_out_of_stock',
  'relist_pending',
  'eligible_for_relist',
];

/** The default a product starts in when it has no persisted workflow row yet. */
export const INITIAL_SNAPSHOT: WorkflowSnapshot = {
  state: 'published_in_stock',
  consecutiveOutOfStock: 0,
  consecutiveInStock: 0,
};

/** One inventory_cache row, narrowed to the fields the workflow needs. */
export interface CacheRow {
  product_id: string;
  warehouse_code?: string | null;
  warehouse_state?: string | null;
  quantity?: number | string | null;
  supports_pickup?: boolean | null;
  supports_shipping?: boolean | null;
  last_synced_at?: string | null;
  sync_status?: string | null;
  source_type?: string | null;
}

/** Persisted workflow row as loaded from inventory_workflow_states. */
export interface PersistedWorkflowRow {
  supplier_product_id: string;
  supplier_sku?: string | null;
  workflow_state: InventoryWorkflowState;
  consecutive_out_of_stock: number;
  consecutive_in_stock: number;
  last_observation_key?: string | null;
  version: number;
}

/**
 * How an observation may affect counters.
 *   'advance'    — a CONFIRMED result; the state machine may move counters/state.
 *   'hold'       — non-authoritative (unknown/stale) or a failure; state is preserved.
 *   'no_evidence'— no usable cache rows at all; treated as unknown, never as zero.
 */
export type ObservationClass = 'advance' | 'hold' | 'no_evidence';

export function observationClass(status: InventoryResultStatus, hasEvidence: boolean): ObservationClass {
  if (!hasEvidence) return 'no_evidence';
  if (isFailure(status)) return 'hold';
  if (!isConfirmed(status)) return 'hold'; // inventory_unknown, stale
  return 'advance';
}

/** PURE: only trusted, successfully-synced sources may be used as evidence. */
export function usableCacheRows(rows: CacheRow[]): CacheRow[] {
  return rows.filter(
    r =>
      r.sync_status === 'ok' &&
      (r.source_type === 'website_scrape' || r.source_type === 'official_api'),
  );
}

/**
 * PURE: turn cache rows into classifier signals.
 * Mirrors the derivation already used by scripts/inventoryDecisionDryRun.ts so both paths
 * classify identically. No rows → signals that classify as `inventory_unknown` (never zero).
 */
export function buildSignalsFromCacheRows(
  rows: CacheRow[],
  nowMs: number,
  staleThresholdMs: number,
): { signals: RawInventorySignals; hasEvidence: boolean; observedAtMs: number | null } {
  const usable = usableCacheRows(rows);
  if (usable.length === 0) {
    return {
      signals: { httpStatus: 200, bodyParseable: true, warehouseSelectorPresent: true, parsedWarehouses: [] },
      hasEvidence: false,
      observedAtMs: null,
    };
  }

  const times = usable
    .map(w => (w.last_synced_at ? new Date(w.last_synced_at).getTime() : NaN))
    .filter(t => Number.isFinite(t));
  // Freshness is judged by the OLDEST row (worst case), matching the existing dry-run derivation.
  const ageMs = times.length ? Math.min(...times.map(t => nowMs - t)) : null;
  const observedAtMs = times.length ? Math.max(...times) : null;

  const parsedWarehouses: WarehouseStock[] = usable.map(w => ({
    warehouseCode: String(w.warehouse_code ?? ''),
    warehouseState: String(w.warehouse_state ?? ''),
    quantity: Number(w.quantity ?? 0),
    supportsPickup: !!w.supports_pickup,
    supportsShipping: !!w.supports_shipping,
  }));

  const totalQty = parsedWarehouses.reduce(
    (s, w) => s + (typeof w.quantity === 'number' && w.quantity > 0 ? w.quantity : 0),
    0,
  );

  return {
    signals: {
      httpStatus: 200,
      bodyParseable: true,
      warehouseSelectorPresent: true,
      parsedWarehouses,
      ageMs,
      staleThresholdMs,
      // Fresh rows that all read zero are an affirmative supplier zero.
      affirmativeZeroSignal: totalQty === 0,
    },
    hasEvidence: true,
    observedAtMs,
  };
}

/**
 * PURE: stable fingerprint of one observation.
 * Re-processing identical evidence yields the same key, which is how the runner stays idempotent.
 * Includes the evidence timestamp and the classified status, so a genuinely NEW scrape (new
 * last_synced_at) always produces a new key even when the status is unchanged.
 */
export function observationKey(input: {
  supplierProductId: string;
  status: InventoryResultStatus;
  observedAtMs: number | null;
  totalQuantity: number | null;
}): string {
  const ts = input.observedAtMs == null ? 'no-evidence' : new Date(input.observedAtMs).toISOString();
  const qty = input.totalQuantity == null ? 'null' : String(input.totalQuantity);
  return `${input.supplierProductId}|${ts}|${input.status}|${qty}`;
}

export interface WorkflowUpdatePlan {
  supplierProductId: string;
  supplierSku: string | null;
  prior: WorkflowSnapshot;
  next: WorkflowSnapshot;
  transition: Transition;
  result: InventoryResult;
  observationClass: ObservationClass;
  observationKey: string;
  observedAtIso: string | null;
  /** True when this exact observation was already processed → runner must write nothing. */
  alreadyProcessed: boolean;
  /** True when committed state or counters differ from prior → history row must be appended. */
  stateChanged: boolean;
  /** True when the workflow row needs an UPDATE (state change OR new observation metadata). */
  needsRowWrite: boolean;
  expectedVersion: number | null;
  reason: string;
}

/**
 * PURE: decide everything the runner should do for one product, without performing any I/O.
 *
 * `prior` is the persisted row (or null when the product has never been observed).
 * The caller supplies the classified result so this stays free of clock/network dependencies.
 */
export function planWorkflowUpdate(input: {
  supplierProductId: string;
  supplierSku?: string | null;
  persisted: PersistedWorkflowRow | null;
  result: InventoryResult;
  hasEvidence: boolean;
  observedAtMs: number | null;
  policy?: StateMachinePolicy;
}): WorkflowUpdatePlan {
  const policy = input.policy ?? DEFAULT_STATE_MACHINE_POLICY;

  const prior: WorkflowSnapshot = input.persisted
    ? {
        state: input.persisted.workflow_state,
        consecutiveOutOfStock: input.persisted.consecutive_out_of_stock,
        consecutiveInStock: input.persisted.consecutive_in_stock,
      }
    : { ...INITIAL_SNAPSHOT };

  const obsClass = observationClass(input.result.status, input.hasEvidence);
  const key = observationKey({
    supplierProductId: input.supplierProductId,
    status: input.result.status,
    observedAtMs: input.observedAtMs,
    totalQuantity: input.result.totalQuantity,
  });

  const alreadyProcessed = !!input.persisted && input.persisted.last_observation_key === key;

  // The state machine itself preserves state for failures / non-authoritative results;
  // we call it unconditionally so its reason/exception reporting stays authoritative.
  const transition = transitionInventoryState(prior, input.result.status, policy);
  const next = transition.next;

  const stateChanged =
    next.state !== prior.state ||
    next.consecutiveOutOfStock !== prior.consecutiveOutOfStock ||
    next.consecutiveInStock !== prior.consecutiveInStock;

  return {
    supplierProductId: input.supplierProductId,
    supplierSku: input.supplierSku ?? null,
    prior,
    // On an already-processed observation the plan reports the prior snapshot verbatim: counters
    // must never advance twice for the same evidence.
    next: alreadyProcessed ? { ...prior } : next,
    transition,
    result: input.result,
    observationClass: obsClass,
    observationKey: key,
    observedAtIso: input.observedAtMs == null ? null : new Date(input.observedAtMs).toISOString(),
    alreadyProcessed,
    stateChanged: alreadyProcessed ? false : stateChanged,
    needsRowWrite: !alreadyProcessed,
    expectedVersion: input.persisted ? input.persisted.version : null,
    reason: alreadyProcessed ? `duplicate_observation:${key}` : transition.reason,
  };
}

/** PURE: classify a plan into the recommendation buckets used by the reporting command. */
export type RecommendationBucket =
  | 'eligible_for_delist'
  | 'eligible_for_relist'
  | 'pending_confirmation'
  | 'no_action'
  | 'blocked_unknown';

export function recommendationBucket(plan: {
  next: WorkflowSnapshot;
  observationClass: ObservationClass;
}): RecommendationBucket {
  if (plan.observationClass !== 'advance') return 'blocked_unknown';
  switch (plan.next.state) {
    case 'eligible_for_delist':
      return 'eligible_for_delist';
    case 'eligible_for_relist':
      return 'eligible_for_relist';
    case 'pending_out_of_stock':
    case 'relist_pending':
      return 'pending_confirmation';
    default:
      return 'no_action';
  }
}

/** PURE: every recommendation that proposes a customer-visible action needs Founder approval. */
export function requiresFounderApproval(bucket: RecommendationBucket): boolean {
  return bucket === 'eligible_for_delist' || bucket === 'eligible_for_relist';
}

/** PURE: parse and validate a comma-separated SKU allowlist. Empty → null (never "all"). */
export function parseAllowlist(raw: string | undefined | null): string[] | null {
  const list = [...new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  return list.length ? list : null;
}

/**
 * PURE: guard for the execution path. An approved action may run only when the SKU is in the
 * allowlist, is in the required eligible state, and the evidence has not moved since the
 * recommendation was produced.
 */
export function canExecuteAction(input: {
  sku: string;
  allowlist: string[] | null;
  currentState: InventoryWorkflowState;
  requiredState: InventoryWorkflowState;
  recommendedObservationKey: string;
  currentObservationKey: string | null;
}): { ok: boolean; reason: string } {
  if (!input.allowlist || !input.allowlist.includes(input.sku)) {
    return { ok: false, reason: 'not_in_allowlist' };
  }
  if (input.currentState !== input.requiredState) {
    return { ok: false, reason: `state_mismatch:expected=${input.requiredState},actual=${input.currentState}` };
  }
  if (input.currentObservationKey !== input.recommendedObservationKey) {
    return { ok: false, reason: 'evidence_changed_since_recommendation' };
  }
  return { ok: true, reason: 'ok' };
}

/** Re-exported so callers need only this module. */
export { classifyInventoryResult };
export type { InventoryWorkflowState, WorkflowSnapshot, StateMachinePolicy, InventoryResult };
