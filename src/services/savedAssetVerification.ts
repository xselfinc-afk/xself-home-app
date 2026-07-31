/**
 * Saved Asset removal-verification — PURE decision layer (no I/O, no database).
 *
 * Implements the verification contract frozen in docs/product-supply/SAVED_ASSET_XONE_CONTRACT.md §9
 * and aligned in SAVED_ASSET_STATE_MACHINE_V1.md (commit ed88b860).
 *
 * THE ONE RULE THAT MATTERS:
 *   Only an affirmative supplier observation — sync_status === 'ok' AND is_saved === false — may
 *   produce REMOVED. Missing, stale, NULL, or failed evidence NEVER infers removal.
 *
 * Founder acknowledgement is an intent record, not proof. It only reaches
 * AWAITING_REMOVAL_VERIFICATION; the supplier fact decides REMOVED.
 *
 * This module is deliberately free of Supabase so the safety rules can be unit-tested exhaustively
 * before any orchestration exists.
 */

/** The 9 approved Saved Asset states. Names are Founder-approved and must not be altered. */
export type SavedAssetState =
  | 'SAVED_CANDIDATE'
  | 'EVALUATING'
  | 'ACTIVE_ASSET'
  | 'HOLD'
  | 'REVIEW_REQUIRED'
  | 'RETIRE_CANDIDATE'
  | 'REMOVABLE'
  | 'AWAITING_REMOVAL_VERIFICATION'
  | 'REMOVED';

export const ALL_SAVED_ASSET_STATES: readonly SavedAssetState[] = [
  'SAVED_CANDIDATE', 'EVALUATING', 'ACTIVE_ASSET', 'HOLD', 'REVIEW_REQUIRED',
  'RETIRE_CANDIDATE', 'REMOVABLE', 'AWAITING_REMOVAL_VERIFICATION', 'REMOVED',
];

export type SupplierAccount = 'pickup' | 'dropship';

export type SyncStatus =
  | 'ok'
  | 'auth_failed'
  | 'captcha_required'
  | 'network_failed'
  | 'parse_failed'
  | 'permission_denied'
  | 'rate_limited'
  | 'supplier_unavailable';

export type VerificationStatus =
  | 'not_started'
  | 'awaiting_verification'
  | 'verified_removed'
  | 'still_saved'
  | 'blocked_by_auth'
  | 'blocked_other';

/** Supplier fact row (supplier_favorite_memberships). `is_saved: null` means UNKNOWN. */
export interface MembershipFact {
  supplier_product_id: string;
  supplier_account: SupplierAccount;
  is_saved: boolean | null;
  sync_status: SyncStatus;
  sync_error_code?: string | null;
  observed_at: string;
}

/** Saved Asset row, narrowed to what verification needs. */
export interface SavedAssetRow {
  id: string;
  supplier_product_id: string;
  supplier_account: SupplierAccount;
  asset_state: SavedAssetState;
  founder_marked_done_at?: string | null;
  verification_attempts: number;
  version: number;
}

/** What a single observation proves — deliberately three-valued, never two. */
export type FactVerdict = 'confirmed_removed' | 'confirmed_still_saved' | 'unknown';

/**
 * PURE: what does this fact actually prove?
 * A non-ok sync proves NOTHING, regardless of what `is_saved` happens to contain.
 */
export function classifyMembershipFact(fact: MembershipFact | null | undefined): FactVerdict {
  if (!fact) return 'unknown';
  if (fact.sync_status !== 'ok') return 'unknown';        // failure proves nothing
  if (fact.is_saved === false) return 'confirmed_removed';
  if (fact.is_saved === true) return 'confirmed_still_saved';
  return 'unknown';                                        // NULL is unknown, never false
}

/** Map a failed sync to the recorded verification status. */
export function blockedStatusFor(sync: SyncStatus): VerificationStatus {
  return sync === 'auth_failed' || sync === 'captcha_required' || sync === 'permission_denied'
    ? 'blocked_by_auth'
    : 'blocked_other';
}

export interface VerificationPlan {
  /** State to write. Equals the prior state whenever nothing is proven. */
  nextState: SavedAssetState;
  verificationStatus: VerificationStatus;
  /** 0 or 1 — only a conclusive "still saved" counts as a failed attempt. */
  attemptsDelta: 0 | 1;
  failureReason: string | null;
  /** True only for AWAITING_REMOVAL_VERIFICATION → REMOVED. */
  transitions: boolean;
  /** True when the row should be written at all. */
  needsWrite: boolean;
  /** Set only when transitioning to REMOVED. */
  removedAt: string | null;
  lastSavedVerifiedAt: string | null;
  reason: string;
}

/**
 * PURE: decide the verification outcome for one asset against its latest supplier fact.
 *
 * `nowIso` is injected so the function stays deterministic and testable.
 */
export function planVerification(input: {
  asset: SavedAssetRow;
  fact: MembershipFact | null | undefined;
  nowIso: string;
}): VerificationPlan {
  const { asset, fact, nowIso } = input;

  const hold = (
    verificationStatus: VerificationStatus,
    reason: string,
    attemptsDelta: 0 | 1 = 0,
    failureReason: string | null = null,
    needsWrite = true,
  ): VerificationPlan => ({
    nextState: asset.asset_state,
    verificationStatus,
    attemptsDelta,
    failureReason,
    transitions: false,
    needsWrite,
    removedAt: null,
    lastSavedVerifiedAt: null,
    reason,
  });

  // Verification applies ONLY to assets awaiting it. Everything else is untouched.
  if (asset.asset_state !== 'AWAITING_REMOVAL_VERIFICATION') {
    return {
      nextState: asset.asset_state,
      verificationStatus: 'not_started',
      attemptsDelta: 0,
      failureReason: null,
      transitions: false,
      needsWrite: false,
      removedAt: null,
      lastSavedVerifiedAt: null,
      reason: `not_awaiting_verification:${asset.asset_state}`,
    };
  }

  const verdict = classifyMembershipFact(fact);

  // No fact at all → nothing observed yet. Never a removal.
  if (!fact) {
    return hold('awaiting_verification', 'no_supplier_fact_yet', 0, null, false);
  }

  // A fact observed BEFORE the Founder acted cannot verify that action.
  if (asset.founder_marked_done_at) {
    const observed = Date.parse(fact.observed_at);
    const marked = Date.parse(asset.founder_marked_done_at);
    if (Number.isFinite(observed) && Number.isFinite(marked) && observed <= marked) {
      return hold('awaiting_verification', 'fact_predates_founder_acknowledgement', 0, null, false);
    }
  }

  if (verdict === 'confirmed_removed') {
    return {
      nextState: 'REMOVED',
      verificationStatus: 'verified_removed',
      attemptsDelta: 0,
      failureReason: null,
      transitions: true,
      needsWrite: true,
      removedAt: nowIso,
      lastSavedVerifiedAt: fact.observed_at,
      reason: 'verified_supplier_removal:is_saved=false,sync_status=ok',
    };
  }

  if (verdict === 'confirmed_still_saved') {
    return hold(
      'still_saved',
      'verification_failed_still_saved',
      1,
      'Supplier still reports this SKU as saved. The manual removal did not take effect.',
    );
  }

  // verdict === 'unknown' — a failed sync, or `is_saved` NULL. Preserve everything.
  const blocked = blockedStatusFor(fact.sync_status);
  return hold(
    blocked,
    `verification_blocked:${fact.sync_status}`,
    0, // a blocked observation is NOT a failed attempt — it is no observation at all
    `Verification could not be performed (${fact.sync_status}${fact.sync_error_code ? `/${fact.sync_error_code}` : ''}). Removal NOT inferred.`,
  );
}

/**
 * PURE: guard for the narrow Founder action (mirrors the SQL function's checks so the same rules
 * can be asserted without a database).
 */
export function canMarkRemovalDone(input: {
  currentState: SavedAssetState;
  currentVersion: number;
  expectedVersion: number;
  idempotencyKey: string | null | undefined;
  lastIdempotencyKey: string | null | undefined;
}): { ok: boolean; reason: string; idempotentReplay: boolean } {
  const { currentState, currentVersion, expectedVersion, idempotencyKey, lastIdempotencyKey } = input;

  if (!idempotencyKey || idempotencyKey.trim() === '') {
    return { ok: false, reason: 'idempotency_key_required', idempotentReplay: false };
  }
  // Same key + already acknowledged → success no-op.
  if (lastIdempotencyKey === idempotencyKey && currentState === 'AWAITING_REMOVAL_VERIFICATION') {
    return { ok: true, reason: 'idempotent_replay', idempotentReplay: true };
  }
  if (currentState !== 'REMOVABLE') {
    return { ok: false, reason: `state_mismatch:expected=REMOVABLE,actual=${currentState}`, idempotentReplay: false };
  }
  if (currentVersion !== expectedVersion) {
    return { ok: false, reason: `version_conflict:expected=${expectedVersion},actual=${currentVersion}`, idempotentReplay: false };
  }
  return { ok: true, reason: 'ok', idempotentReplay: false };
}

/** PURE: the only transition the Operator Console may ever author. */
export const XONE_ALLOWED_TRANSITION = {
  from: 'REMOVABLE' as const,
  to: 'AWAITING_REMOVAL_VERIFICATION' as const,
};

/** PURE: is this transition permitted at all by the approved machine? */
export function isTransitionAllowed(from: SavedAssetState, to: SavedAssetState): boolean {
  // The direct edge is forbidden outright — acknowledgement is not proof.
  if (from === 'REMOVABLE' && to === 'REMOVED') return false;
  if (to === 'REMOVED') return from === 'AWAITING_REMOVAL_VERIFICATION';
  if (to === 'AWAITING_REMOVAL_VERIFICATION') return from === 'REMOVABLE';
  if (to === 'REMOVABLE') return from === 'RETIRE_CANDIDATE';
  return true; // earlier-lifecycle transitions are governed by the state machine document
}
