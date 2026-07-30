/**
 * Pure inventory publication state machine (Scope C) — no I/O, no side effects, idempotent.
 *
 * Given a prior committed workflow snapshot, the current inventory RESULT status, and a
 * policy, it returns a PROPOSED transition. It NEVER performs a live delist/relist (Phase 1
 * has no apply path) — it only proposes. Critically, a failure/non-authoritative result
 * (auth/CAPTCHA/parse/network/supplier/unknown/stale) NEVER increments the zero counter,
 * NEVER clears last-known state, and NEVER mutates the committed publication state — it
 * only surfaces an exception observation.
 */
import { countsAsConfirmedZero, isConfirmedInStock, isFailure, type InventoryResultStatus } from './inventoryResult';
import { classifyPriority, type PriorityClass } from './inventoryPriority';

export type InventoryWorkflowState =
  | 'published_in_stock'
  | 'pending_out_of_stock'
  | 'eligible_for_delist'
  | 'delisted_out_of_stock'
  | 'relist_pending'
  | 'eligible_for_relist';

/** Transient, non-committing observation raised on a failure/ambiguous result. */
export type ObservedException = 'blocked_auth' | 'blocked_parse' | 'inventory_unknown' | null;

export type ProposedAction =
  | 'none'
  | 'mark_pending_out_of_stock'
  | 'propose_delist'
  | 'clear_to_published'
  | 'mark_relist_pending'
  | 'propose_relist'
  | 'raise_exception';

export interface WorkflowSnapshot {
  state: InventoryWorkflowState;
  consecutiveOutOfStock: number;
  consecutiveInStock: number;
}

export interface StateMachinePolicy {
  outOfStockConfirmationsRequired: number; // default 2
  inStockConfirmationsRequired: number;    // default 2
}
export const DEFAULT_STATE_MACHINE_POLICY: StateMachinePolicy = {
  outOfStockConfirmationsRequired: 2,
  inStockConfirmationsRequired: 2,
};

export interface Transition {
  next: WorkflowSnapshot;             // committed lifecycle — UNCHANGED on failure/ambiguous
  observedException: ObservedException;
  proposedAction: ProposedAction;
  priorityClass: PriorityClass;
  reason: string;
  isException: boolean;
}

/** States in which the product has already been (or is being) removed from the storefront. */
const POST_DELIST = (s: InventoryWorkflowState): boolean =>
  s === 'delisted_out_of_stock' || s === 'relist_pending' || s === 'eligible_for_relist';

const CAP = 1_000_000; // counter guard rail

export function transitionInventoryState(
  prior: WorkflowSnapshot,
  status: InventoryResultStatus,
  policy: StateMachinePolicy = DEFAULT_STATE_MACHINE_POLICY,
): Transition {
  const priorityClass = classifyPriority(status);
  const keepPrior = (observedException: ObservedException, reason: string): Transition => ({
    next: { ...prior }, observedException, proposedAction: 'raise_exception', priorityClass, reason, isException: true,
  });

  // Rule 3: failures & non-authoritative results never count as zero and never mutate state.
  if (isFailure(status)) {
    const obs: ObservedException =
      status === 'authentication_required' || status === 'captcha_required' ? 'blocked_auth' : 'blocked_parse';
    return keepPrior(obs, `failure:${status}`);
  }
  if (status === 'inventory_unknown' || status === 'stale') {
    return keepPrior('inventory_unknown', `non_authoritative:${status}`);
  }

  // ---- CONFIRMED results only from here ----
  if (isConfirmedInStock(status)) {
    if (POST_DELIST(prior.state)) {
      const n = Math.min(prior.consecutiveInStock + 1, CAP); // Rule 4: relist path
      if (n >= policy.inStockConfirmationsRequired) {
        return { next: { state: 'eligible_for_relist', consecutiveOutOfStock: 0, consecutiveInStock: n },
          observedException: null, proposedAction: 'propose_relist', priorityClass,
          reason: `in_stock x${n} >= ${policy.inStockConfirmationsRequired} after delist`, isException: false };
      }
      return { next: { state: 'relist_pending', consecutiveOutOfStock: 0, consecutiveInStock: n },
        observedException: null, proposedAction: 'mark_relist_pending', priorityClass,
        reason: `in_stock x${n} after delist`, isException: false };
    }
    const wasPending = prior.state === 'pending_out_of_stock' || prior.state === 'eligible_for_delist';
    return { next: { state: 'published_in_stock', consecutiveOutOfStock: 0, consecutiveInStock: Math.min(prior.consecutiveInStock + 1, CAP) },
      observedException: null, proposedAction: wasPending ? 'clear_to_published' : 'none', priorityClass,
      reason: wasPending ? 'recovered_to_in_stock' : 'still_in_stock', isException: false };
  }

  if (countsAsConfirmedZero(status)) {
    if (POST_DELIST(prior.state)) {
      // Already delisted and still zero → remain delisted (idempotent); reset relist progress.
      return { next: { state: 'delisted_out_of_stock', consecutiveOutOfStock: Math.min(prior.consecutiveOutOfStock + 1, CAP), consecutiveInStock: 0 },
        observedException: null, proposedAction: 'none', priorityClass, reason: 'still_zero_while_delisted', isException: false };
    }
    const n = Math.min(prior.consecutiveOutOfStock + 1, CAP);
    if (n >= policy.outOfStockConfirmationsRequired) {
      // Rule 2: second consecutive zero → eligible_for_delist (still no live delist in Phase 1).
      return { next: { state: 'eligible_for_delist', consecutiveOutOfStock: n, consecutiveInStock: 0 },
        observedException: null, proposedAction: 'propose_delist', priorityClass,
        reason: `confirmed_zero x${n} >= ${policy.outOfStockConfirmationsRequired}`, isException: false };
    }
    // Rule 1: first zero → pending_out_of_stock, do not delist.
    return { next: { state: 'pending_out_of_stock', consecutiveOutOfStock: n, consecutiveInStock: 0 },
      observedException: null, proposedAction: 'mark_pending_out_of_stock', priorityClass,
      reason: `confirmed_zero x${n} < ${policy.outOfStockConfirmationsRequired}`, isException: false };
  }

  return keepPrior(null, `unhandled_status:${status}`);
}
