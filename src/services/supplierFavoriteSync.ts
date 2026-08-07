/**
 * Favorites synchronisation planning — pure, deterministic, side-effect free.
 *
 * THE TARGET, AND ONLY THE TARGET
 * -------------------------------
 * Both accounts' Favorites should equal exactly one set: the supplier_product_ids of products
 * with `published = true`. Nothing else participates.
 *
 *   NOT sellable_products — that view also requires fresh availability evidence, so a product
 *   whose evidence lapsed would drop out of Favorites and have to be re-added later.
 *   NOT inventory status  — a temporarily out-of-stock product is still one we sell. Un-favouriting
 *   it would lose the supplier relationship over a transient condition.
 *
 * published = true  → should be favourited on both accounts
 * published = false → should not be
 *
 * WHAT CHANGED, AND WHAT DID NOT
 * ------------------------------
 * The Saved Asset states (SAVED_CANDIDATE / EVALUATING / HOLD / REVIEW_REQUIRED) no longer hold an
 * item out of `extra`. Under the previous rules "in Favorites but not live" was never a reason to
 * remove; under these rules `published = false` is exactly the reason. The state machine and its
 * tables are untouched — they simply no longer contribute to this TARGET.
 *
 * One guard survives unchanged, because it protects against acting on the wrong item rather than
 * against acting at all: an identity that cannot be resolved to exactly one website product_id,
 * verified in reverse, is never executed. It is reported as an exception.
 */

import type { ProductIdMapping } from './supplierFavoriteProductId';

export type SyncAccount = 'pickup' | 'dropship';
export type SyncOperation = 'add' | 'remove';

export interface FavoriteSyncItem {
  supplier_product_id: string;
  operation: SyncOperation;
  product_id: number;
  /** The SKU the product_id resolved back to. Always equal to supplier_product_id here. */
  verified_sku: string;
}

export type SyncExceptionReason =
  | 'not_mapped'
  | 'multiple_product_ids'
  | 'shared_product_id'
  | 'reverse_lookup_mismatch'
  | 'account_not_authoritative';

export interface FavoriteSyncException {
  supplier_product_id: string;
  intended_operation: SyncOperation;
  reason: SyncExceptionReason;
}

export interface AccountSyncPlan {
  account: SyncAccount;
  /** False when the account's last favorites read was incomplete — no plan may be executed. */
  authoritative: boolean;
  current_count: number;
  missing: FavoriteSyncItem[];
  extra: FavoriteSyncItem[];
  exceptions: FavoriteSyncException[];
  /** Operations that cleared identity resolution. */
  executable_count: number;
}

export interface FavoriteSyncPlan {
  target_count: number;
  accounts: AccountSyncPlan[];
  total_operations: number;
  unmappable_count: number;
  /** True only when every account read authoritatively. */
  executable: boolean;
}

export interface AccountFavoritesState {
  account: SyncAccount;
  /** SKUs currently saved on this account. */
  saved: readonly string[];
  /** Whether the last sync of this account was complete and clean. */
  authoritative: boolean;
}

const EXCEPTION_FOR: Record<Exclude<ProductIdMapping['status'], 'unique'>, SyncExceptionReason> = {
  not_mapped: 'not_mapped',
  multiple_product_ids: 'multiple_product_ids',
  shared_product_id: 'shared_product_id',
};

/**
 * Turn one intended operation into either an executable item or an exception. The mapping must be
 * unique AND verify back to the same SKU; anything else is reported, never guessed.
 */
function classify(
  sku: string,
  operation: SyncOperation,
  mapping: ProductIdMapping,
): { item?: FavoriteSyncItem; exception?: FavoriteSyncException } {
  if (mapping.status !== 'unique' || mapping.product_id === null) {
    return { exception: { supplier_product_id: sku, intended_operation: operation, reason: EXCEPTION_FOR[mapping.status as Exclude<ProductIdMapping['status'], 'unique'>] } };
  }
  if (mapping.verified_sku !== sku) {
    // The product_id resolves back to a different SKU. Acting on it would touch the wrong item.
    return { exception: { supplier_product_id: sku, intended_operation: operation, reason: 'reverse_lookup_mismatch' } };
  }
  return { item: { supplier_product_id: sku, operation, product_id: mapping.product_id, verified_sku: mapping.verified_sku } };
}

export function buildAccountSyncPlan(
  target: ReadonlySet<string>,
  state: AccountFavoritesState,
  resolveMapping: (sku: string) => ProductIdMapping,
): AccountSyncPlan {
  const current = new Set(state.saved);
  const missing: FavoriteSyncItem[] = [];
  const extra: FavoriteSyncItem[] = [];
  const exceptions: FavoriteSyncException[] = [];

  // A non-authoritative read means we do not actually know what is in the Favorites list. Planning
  // removals from a partial list could delete items that were simply never observed.
  if (!state.authoritative) {
    return {
      account: state.account,
      authoritative: false,
      current_count: current.size,
      missing: [],
      extra: [],
      exceptions: [{ supplier_product_id: '*', intended_operation: 'remove', reason: 'account_not_authoritative' }],
      executable_count: 0,
    };
  }

  for (const sku of target) {
    if (current.has(sku)) continue;                 // already favourited — no-op
    const { item, exception } = classify(sku, 'add', resolveMapping(sku));
    if (item) missing.push(item);
    if (exception) exceptions.push(exception);
  }

  for (const sku of current) {
    if (target.has(sku)) continue;                  // still published — keep it
    const { item, exception } = classify(sku, 'remove', resolveMapping(sku));
    if (item) extra.push(item);
    if (exception) exceptions.push(exception);
  }

  const byId = (a: FavoriteSyncItem, b: FavoriteSyncItem) => a.supplier_product_id.localeCompare(b.supplier_product_id);
  missing.sort(byId);
  extra.sort(byId);
  exceptions.sort((a, b) => a.supplier_product_id.localeCompare(b.supplier_product_id));

  return {
    account: state.account,
    authoritative: true,
    current_count: current.size,
    missing,
    extra,
    exceptions,
    executable_count: missing.length + extra.length,
  };
}

export function buildFavoriteSyncPlan(
  target: readonly string[],
  states: readonly AccountFavoritesState[],
  resolveMapping: (sku: string) => ProductIdMapping,
): FavoriteSyncPlan {
  const targetSet = new Set(target.filter(Boolean));
  const accounts = states.map((state) => buildAccountSyncPlan(targetSet, state, resolveMapping));
  return {
    target_count: targetSet.size,
    accounts,
    total_operations: accounts.reduce((sum, a) => sum + a.executable_count, 0),
    unmappable_count: accounts.reduce((sum, a) => sum + a.exceptions.length, 0),
    executable: accounts.every((a) => a.authoritative),
  };
}

/**
 * Verify a plan actually converges: applying it must leave each account's Favorites equal to the
 * TARGET, minus whatever could not be identified. Exported so the suite can assert the plan is
 * self-consistent rather than trusting the arithmetic.
 */
export function projectAccountAfterSync(
  plan: AccountSyncPlan,
  before: readonly string[],
): Set<string> {
  const after = new Set(before);
  for (const item of plan.missing) after.add(item.supplier_product_id);
  for (const item of plan.extra) after.delete(item.supplier_product_id);
  return after;
}
