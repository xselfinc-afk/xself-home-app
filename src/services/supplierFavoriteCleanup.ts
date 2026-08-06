/**
 * Supplier Favorites cleanup planning — pure, deterministic, side-effect free.
 *
 * WHAT THIS CHAIN IS, AND WHAT IT IS NOT
 * --------------------------------------
 * This is the WEBSITE FAVORITES chain. It answers exactly one question: "which items are still
 * sitting in the supplier's Favorites list that nobody needs any more?" It knows nothing about
 * stock, price, publication or customer visibility, and it must never learn.
 *
 * The API INVENTORY chain (`openApiAvailability` → `availabilityPersistence` →
 * `standardizedInventoryProjection` → `sellable_products`) is a separate chain with a separate
 * source of truth. The two are joined only by `supplier_product_id` as a lookup key. This module
 * imports nothing from the inventory chain, and `supplierFavoriteChainIsolation.test.ts` fails the
 * build if that ever changes.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * Removing a Favorite is irreversible and may affect negotiated pricing. So the default answer is
 * always "keep". An item becomes removable only by clearing every gate at once, and any unknown —
 * a failed read, an unresolved identity, a missing approval — puts it straight back into "keep".
 * "In Favorites but not currently live" is NOT a reason to remove anything.
 */

import type { SupplierAccount } from './supplierFavoriteFacts';

/** Canonical Saved Asset states (see 20260801_saved_asset_control_model.sql). */
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

/**
 * States that protect an item from cleanup outright. `SAVED_CANDIDATE` is in here on purpose:
 * "the API has not catalogued it yet" is the pending-onboarding case, and it is the single most
 * likely thing a naive "Favorites minus live products" query would wrongly delete.
 */
export const PROTECTED_ASSET_STATES: readonly SavedAssetState[] = [
  'ACTIVE_ASSET',
  'SAVED_CANDIDATE',
  'EVALUATING',
  'HOLD',
  'REVIEW_REQUIRED',
];

/** The only state from which removal may even be considered. */
export const REMOVABLE_STATE: SavedAssetState = 'REMOVABLE';

export type RetainReason =
  | 'api_managed'
  | 'published'
  | 'restorable_delisted'
  | 'protected_asset_state'
  | 'founder_approved_for_onboarding'
  | 'identity_not_unique'
  | 'favorite_read_failed'
  | 'not_in_favorites';

export type BlockedReason =
  | 'not_removable_state'
  | 'founder_not_approved'
  | 'approval_record_incomplete';

/** One SKU's full input picture. Every field is an observed fact, never an inference. */
export interface SupplierFavoriteInput {
  supplier_product_id: string;
  xself_sku: string | null;
  product_title?: string | null;
  primary_image?: string | null;

  /** null = the read FAILED. It never means "not saved". */
  pickup_is_saved: boolean | null;
  dropship_is_saved: boolean | null;

  /** Present in `supplier_products` — the API inventory chain is managing it. */
  api_managed: boolean;
  published: boolean;
  /** Delisted but eligible to come back (e.g. delist_reason = out_of_stock). */
  restorable_delisted: boolean;

  asset_state: SavedAssetState | null;
  founder_status: string | null;
  approved_at: string | null;
  approved_by: string | null;

  /** False when identity resolution is missing/ambiguous — we do not know what we would remove. */
  identity_unique: boolean;
}

export type FavoriteDisposition =
  | 'retained'
  | 'cleanup_blocked'
  | 'cleanup_eligible'
  | 'not_in_favorites';

export interface SupplierFavoriteDecision {
  supplier_product_id: string;
  xself_sku: string | null;
  disposition: FavoriteDisposition;
  /** Every reason that applies, so the panel can explain the decision rather than assert it. */
  retain_reasons: RetainReason[];
  blocked_reasons: BlockedReason[];
  in_pickup: boolean;
  in_dropship: boolean;
  read_failed: boolean;
  /** True only when every gate cleared. Still requires the runtime switch AND a per-item approval. */
  removal_preview_allowed: boolean;
}

function readFailed(input: SupplierFavoriteInput): boolean {
  return input.pickup_is_saved === null || input.dropship_is_saved === null;
}

/**
 * Decide one SKU. Order matters only for readability — every applicable reason is collected, so a
 * reviewer sees all of them rather than just the first.
 */
export function classifySupplierFavorite(input: SupplierFavoriteInput): SupplierFavoriteDecision {
  const inPickup = input.pickup_is_saved === true;
  const inDropship = input.dropship_is_saved === true;
  const failed = readFailed(input);

  const retain: RetainReason[] = [];
  if (input.api_managed) retain.push('api_managed');
  if (input.published) retain.push('published');
  if (input.restorable_delisted) retain.push('restorable_delisted');
  if (input.asset_state && PROTECTED_ASSET_STATES.includes(input.asset_state)) {
    retain.push('protected_asset_state');
  }
  // Approved for ONBOARDING is protective. Approval only unlocks removal once the asset has also
  // been moved to REMOVABLE — approval alone must never be readable as "approved to delete".
  if (input.founder_status === 'approved' && input.asset_state !== REMOVABLE_STATE) {
    retain.push('founder_approved_for_onboarding');
  }
  if (!input.identity_unique) retain.push('identity_not_unique');
  // An unknown is not a permission. A failed read protects the item.
  if (failed) retain.push('favorite_read_failed');

  const base = {
    supplier_product_id: input.supplier_product_id,
    xself_sku: input.xself_sku,
    in_pickup: inPickup,
    in_dropship: inDropship,
    read_failed: failed,
  };

  // Nothing to clean up if it is not actually in either Favorites list (and we know that for sure).
  if (!inPickup && !inDropship && !failed) {
    return {
      ...base,
      disposition: 'not_in_favorites',
      retain_reasons: ['not_in_favorites'],
      blocked_reasons: [],
      removal_preview_allowed: false,
    };
  }

  if (retain.length > 0) {
    return { ...base, disposition: 'retained', retain_reasons: retain, blocked_reasons: [], removal_preview_allowed: false };
  }

  const blocked: BlockedReason[] = [];
  if (input.asset_state !== REMOVABLE_STATE) blocked.push('not_removable_state');
  if (input.founder_status !== 'approved') blocked.push('founder_not_approved');
  if (!input.approved_at || !input.approved_by) blocked.push('approval_record_incomplete');

  if (blocked.length > 0) {
    return { ...base, disposition: 'cleanup_blocked', retain_reasons: [], blocked_reasons: blocked, removal_preview_allowed: false };
  }

  return { ...base, disposition: 'cleanup_eligible', retain_reasons: [], blocked_reasons: [], removal_preview_allowed: true };
}

export interface AccountReadState {
  account: SupplierAccount;
  ok: boolean;
  total: number;
  observed_at: string | null;
  error: string | null;
}

export interface SupplierFavoritePlan {
  accounts: AccountReadState[];
  counts: {
    pickup_total: number;
    dropship_total: number;
    both_accounts: number;
    pickup_only: number;
    dropship_only: number;
    read_failed: number;
    api_managed: number;
    pending_onboarding_protected: number;
    cleanup_candidates: number;
    identity_conflicts: number;
  };
  decisions: SupplierFavoriteDecision[];
  /** Cleared every gate. Executing still needs the runtime switch and a per-item approval. */
  cleanup_eligible: SupplierFavoriteDecision[];
  /** Items held back specifically because the API has not catalogued them yet. */
  pending_onboarding: SupplierFavoriteDecision[];
}

export function buildSupplierFavoritePlan(
  inputs: readonly SupplierFavoriteInput[],
  accounts: readonly AccountReadState[],
): SupplierFavoritePlan {
  const decisions = inputs.map(classifySupplierFavorite);
  const inFavorites = decisions.filter((d) => d.in_pickup || d.in_dropship || d.read_failed);
  const bySku = new Map(inputs.map((i) => [i.supplier_product_id, i]));

  const isPendingOnboarding = (d: SupplierFavoriteDecision): boolean =>
    bySku.get(d.supplier_product_id)?.asset_state === 'SAVED_CANDIDATE';

  return {
    accounts: [...accounts],
    counts: {
      pickup_total: decisions.filter((d) => d.in_pickup).length,
      dropship_total: decisions.filter((d) => d.in_dropship).length,
      both_accounts: decisions.filter((d) => d.in_pickup && d.in_dropship).length,
      pickup_only: decisions.filter((d) => d.in_pickup && !d.in_dropship && !d.read_failed).length,
      dropship_only: decisions.filter((d) => d.in_dropship && !d.in_pickup && !d.read_failed).length,
      read_failed: decisions.filter((d) => d.read_failed).length,
      api_managed: decisions.filter((d) => d.retain_reasons.includes('api_managed')).length,
      pending_onboarding_protected: inFavorites.filter(isPendingOnboarding).length,
      cleanup_candidates: decisions.filter((d) => d.disposition === 'cleanup_eligible').length,
      identity_conflicts: decisions.filter((d) => d.retain_reasons.includes('identity_not_unique')).length,
    },
    decisions,
    cleanup_eligible: decisions.filter((d) => d.disposition === 'cleanup_eligible'),
    pending_onboarding: inFavorites.filter(isPendingOnboarding),
  };
}

/** Manual actions the XOne panel may request. None of them removes anything from the supplier. */
export type FavoriteManualAction =
  | 'protect_as_pending_onboarding'
  | 'release_protection'
  | 'approve_for_cleanup'
  | 'revoke_cleanup_approval';

export interface ManualActionOutcome {
  allowed: boolean;
  next_asset_state: SavedAssetState | null;
  next_founder_status: string | null;
  reason: string;
}

/**
 * Resolve one manual action into the state change it implies. Pure — the caller performs the write
 * against `saved_assets` / `saved_asset_transitions` and nothing else.
 */
export function resolveManualAction(
  action: FavoriteManualAction,
  current: SavedAssetState | null,
): ManualActionOutcome {
  const deny = (reason: string): ManualActionOutcome =>
    ({ allowed: false, next_asset_state: null, next_founder_status: null, reason });

  // Once removal is under way the asset is out of the panel's hands.
  if (current === 'AWAITING_REMOVAL_VERIFICATION' || current === 'REMOVED') {
    return deny('removal_already_in_progress');
  }

  switch (action) {
    case 'protect_as_pending_onboarding':
      return { allowed: true, next_asset_state: 'HOLD', next_founder_status: 'pending', reason: 'manually_protected' };
    case 'release_protection':
      if (current !== 'HOLD') return deny('not_protected');
      return { allowed: true, next_asset_state: 'EVALUATING', next_founder_status: 'pending', reason: 'protection_released' };
    case 'approve_for_cleanup':
      // Only an asset already triaged as retire-worthy may be approved. Approving straight out of
      // SAVED_CANDIDATE would defeat pending-onboarding protection entirely.
      if (current !== 'RETIRE_CANDIDATE') return deny('must_be_retire_candidate_first');
      return { allowed: true, next_asset_state: 'REMOVABLE', next_founder_status: 'approved', reason: 'cleanup_approved' };
    case 'revoke_cleanup_approval':
      if (current !== 'REMOVABLE') return deny('not_approved');
      return { allowed: true, next_asset_state: 'RETIRE_CANDIDATE', next_founder_status: 'pending', reason: 'cleanup_approval_revoked' };
  }
}

/** Tables this chain may write. Anything else is a chain violation. */
export const FAVORITE_CHAIN_WRITABLE_TABLES = [
  'supplier_favorite_memberships',
  'saved_assets',
  'saved_asset_transitions',
] as const;

/** Tables owned by the API inventory chain. This chain must never write any of them. */
export const INVENTORY_CHAIN_TABLES = [
  'product_availability_checks',
  'product_availability_current',
  'inventory_workflow_states',
  'inventory_workflow_transitions',
  'standardized_products',
  'sellable_products',
  'inventory_cache',
] as const;
