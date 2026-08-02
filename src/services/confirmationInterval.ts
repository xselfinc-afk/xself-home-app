/**
 * Minimum confirmation interval — pure, deterministic, side-effect free.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two out-of-stock confirmations are supposed to represent two genuinely separate observation
 * cycles three days apart. Without a timing guard they only represent "the command ran twice".
 * A bounded test re-ran the same unavailable SKUs within seconds and drove
 * consecutive_out_of_stock 1 → 2 and pending_out_of_stock → eligible_for_delist. A retry, a
 * duplicate scheduler invocation, or an operator running the command twice would have made a
 * product delist-eligible on a single real observation.
 *
 * The guard: a CONFIRMED observation may advance a counter only when at least
 * `minIntervalHours` have passed since the last observation that actually counted. Anything sooner
 * is `duplicate_or_too_soon` — audited, but inert.
 *
 * WHICH TIMESTAMP
 * ---------------
 * `inventory_workflow_states.last_observed_at` is reused as "when a confirmation last counted",
 * which requires that the writer advance it ONLY when the observation counts. `last_transition_at`
 * cannot serve this purpose: consecutive_in_stock advances 1 → 2 without any state change, so a
 * transition timestamp would never move on the relist path. No migration is needed.
 */
import type { InventoryResultStatus } from './inventoryResult';
import { countsAsConfirmedZero, isConfirmed } from './inventoryResult';
import {
  DEFAULT_STATE_MACHINE_POLICY,
  transitionInventoryState,
  type StateMachinePolicy,
  type Transition,
  type WorkflowSnapshot,
} from './inventoryStateMachine';

/** Safe default: 48h. The scan runs every 72h, so a real cycle always clears it with margin. */
export const DEFAULT_MIN_CONFIRMATION_INTERVAL_HOURS = 48;

export type ConfirmationOutcome =
  /** A confirmed observation that genuinely counted; counters/state may move. */
  | 'advanced'
  /** A confirmed observation arriving too soon after the last counted one. Inert. */
  | 'duplicate_or_too_soon'
  /** A failure/non-authoritative result. Never advances, never resets. */
  | 'no_confirmation';

export interface IntervalDecision {
  outcome: ConfirmationOutcome;
  /** Committed lifecycle after this observation — UNCHANGED unless `advanced`. */
  next: WorkflowSnapshot;
  /** True only when the writer should move `last_observed_at` forward. */
  countsAsConfirmation: boolean;
  /** Full state-machine transition, present only when the observation advanced. */
  transition: Transition | null;
  reason: string;
  hoursSinceLastConfirmation: number | null;
}

/** Hours between two ISO instants, or null when there is no prior. */
export function hoursSince(lastIso: string | null | undefined, nowIso: string): number | null {
  if (!lastIso) return null;
  const last = Date.parse(lastIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return null;
  return (now - last) / 3_600_000;
}

/**
 * May a confirmed observation count, given when one last counted?
 *
 * The first-ever confirmation always counts. An unparseable or absent timestamp also counts —
 * failing open here is safe because the FIRST strike is never destructive; only the second is, and
 * by then a real timestamp exists.
 */
export function mayAdvance(lastConfirmedAtIso: string | null | undefined, nowIso: string, minIntervalHours: number): boolean {
  const h = hoursSince(lastConfirmedAtIso, nowIso);
  if (h === null) return true;
  return h >= minIntervalHours;
}

export interface IntervalInput {
  prior: WorkflowSnapshot;
  status: InventoryResultStatus;
  /** `last_observed_at` from the persisted row — when a confirmation last counted. */
  lastConfirmedAtIso: string | null;
  nowIso: string;
  minIntervalHours?: number;
  policy?: StateMachinePolicy;
}

/**
 * Decide what one observation does to the lifecycle, with the interval guard applied.
 *
 * Precedence, deliberately in this order:
 *   1. Failures never advance and never reset — they are not observations of stock.
 *   2. A confirmed observation inside the minimum interval is inert.
 *   3. Otherwise the existing state machine decides, unchanged.
 */
export function decideWithInterval(input: IntervalInput): IntervalDecision {
  const minIntervalHours = input.minIntervalHours ?? DEFAULT_MIN_CONFIRMATION_INTERVAL_HOURS;
  const policy = input.policy ?? DEFAULT_STATE_MACHINE_POLICY;
  const hours = hoursSince(input.lastConfirmedAtIso, input.nowIso);

  // 1. Not a trustworthy supplier answer → nothing moves, nothing resets.
  if (!isConfirmed(input.status)) {
    return {
      outcome: 'no_confirmation',
      next: { ...input.prior },
      countsAsConfirmation: false,
      transition: null,
      reason: `non_confirmed:${input.status}`,
      hoursSinceLastConfirmation: hours,
    };
  }

  // 2. Confirmed, but too soon to be a separate observation cycle.
  if (!mayAdvance(input.lastConfirmedAtIso, input.nowIso, minIntervalHours)) {
    return {
      outcome: 'duplicate_or_too_soon',
      next: { ...input.prior },
      countsAsConfirmation: false,
      transition: null,
      reason: `too_soon:${hours === null ? 'unknown' : hours.toFixed(2)}h_of_${minIntervalHours}h`,
      hoursSinceLastConfirmation: hours,
    };
  }

  // 3. A genuine new cycle — the existing state machine is the authority.
  const transition = transitionInventoryState(input.prior, input.status, policy);
  return {
    outcome: 'advanced',
    next: transition.next,
    countsAsConfirmation: true,
    transition,
    reason: countsAsConfirmedZero(input.status) ? 'confirmed_zero_cycle' : 'confirmed_stock_cycle',
    hoursSinceLastConfirmation: hours,
  };
}
