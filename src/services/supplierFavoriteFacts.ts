/**
 * Supplier Favorite membership FACTS — pure mapping layer (no I/O, no database, no supplier call).
 *
 * XSelf Home owns Favorite reading and writes the canonical facts to
 * `public.supplier_favorite_memberships`. This module turns one Saved-Items observation into
 * proposed fact rows and nothing else.
 *
 * Authoritative contract: docs/product-supply/SAVED_ASSET_XONE_CONTRACT.md
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * `is_saved` is THREE-VALUED. Only a SUCCESSFUL and PROVABLY COMPLETE list observation may ever
 * produce `false`. Auth, CAPTCHA, network, permission, parse, pagination or completeness failure
 * yields `null` (unknown). A failure is never evidence of removal — losing Saved membership also
 * destroys supplier API access, so a wrong `false` is expensive and hard to detect.
 *
 * The production table enforces the same rule:
 *     CONSTRAINT sfm_failure_implies_unknown_chk CHECK (sync_status = 'ok' OR is_saved IS NULL)
 *
 * NEVER WRITTEN FROM HERE: saved_assets, saved_asset_transitions, supplier_products,
 * standardized_products, inventory_cache, pricing, reviews, orders, publication state.
 */

export type SupplierAccount = 'pickup' | 'dropship';

export type FavoriteSyncStatus =
  | 'ok'
  | 'auth_failed'
  | 'captcha_required'
  | 'network_failed'
  | 'parse_failed'
  | 'permission_denied'
  | 'rate_limited'
  | 'supplier_unavailable';

/** The ONLY table this path may write. */
export const WRITE_TABLE = 'supplier_favorite_memberships' as const;

/** Tables this path must never write. Asserted by tests. */
export const FORBIDDEN_WRITE_TABLES = [
  'saved_assets',
  'saved_asset_transitions',
  'supplier_products',
  'standardized_products',
  'inventory_cache',
  'sellable_products',
  'orders',
  'order_items',
  'product_reviews',
  'pricing_audit_log',
  'giga_delivery_fee_cache',
] as const;

/** One Favorite-list read for exactly ONE supplier account. */
export interface FavoriteObservation {
  supplierAccount: SupplierAccount;
  sourceRunId: string;
  observedAt: string;
  syncStatus: FavoriteSyncStatus;
  syncErrorCode: string | null;
  /** SKUs seen in the list (deduped). */
  skus: ReadonlySet<string>;
  /** `pageInfo.totalNum` when the supplier reported it; null when unknown. */
  reportedTotal: number | null;
  pagesFetched: number;
}

export interface FactRow {
  supplier_product_id: string;
  supplier_account: SupplierAccount;
  is_saved: boolean | null;
  sync_status: FavoriteSyncStatus;
  sync_error_code: string | null;
  observed_at: string;
  source_run_id: string;
  last_seen_saved_at?: string;
  last_seen_removed_at?: string;
}

/** PURE: trim, drop blanks, dedupe. */
export function normaliseSkus(raw: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const s of raw) {
    const t = (s ?? '').trim();
    if (t) out.add(t);
  }
  return out;
}

/** PURE: parse `--only=A,B`. Empty → null (never "all"). */
export function parseAllowlist(raw: string | undefined | null): string[] | null {
  const list = [...new Set((raw ?? '').split(',').map(s => s.trim()).filter(Boolean))];
  return list.length ? list.sort() : null;
}

/**
 * PURE: is this observation strong enough to conclude ABSENCE?
 *
 * Requires all three:
 *   1. the sync succeeded;
 *   2. the supplier reported a total (otherwise completeness is unprovable);
 *   3. we hold at least that many SKUs (a short walk means pages were missed).
 */
export function isAuthoritative(obs: FavoriteObservation): boolean {
  if (obs.syncStatus !== 'ok') return false;
  if (obs.reportedTotal == null) return false;
  return obs.skus.size >= obs.reportedTotal;
}

/** PURE: human-readable completeness explanation for the operator report. */
export function completenessReason(obs: FavoriteObservation): string {
  if (obs.syncStatus !== 'ok') return `sync_status=${obs.syncStatus} → not authoritative`;
  if (obs.reportedTotal == null) return 'supplier reported no total → completeness unprovable';
  if (obs.skus.size < obs.reportedTotal) {
    return `observed ${obs.skus.size} < reported ${obs.reportedTotal} → incomplete page walk`;
  }
  return `observed ${obs.skus.size} >= reported ${obs.reportedTotal} → complete`;
}

/**
 * PURE: map one account's observation to proposed fact rows.
 *
 * `knownSkus` are SKUs already recorded for THIS account — absence from a complete list is what
 * proves `is_saved=false`. A SKU we have never recorded and do not see is simply not our business.
 *
 * Scope guarantees:
 *   * every row carries `obs.supplierAccount`, so a sibling account's row can never be produced;
 *   * with an allowlist, only those SKUs are returned;
 *   * **when an allowlist is supplied, absence NEVER yields `false`** — an allowlisted view is a
 *     partial view by construction, and rule 10 forbids inferring removal from it.
 */
export function buildFactRows(
  obs: FavoriteObservation,
  knownSkus: Iterable<string>,
  allowlist?: Iterable<string> | null,
): FactRow[] {
  const observed = normaliseSkus(obs.skus);
  const known = normaliseSkus(knownSkus);
  const allow = allowlist ? normaliseSkus(allowlist) : null;

  let candidates = new Set<string>([...observed, ...known]);
  if (allow) candidates = new Set([...candidates].filter(s => allow.has(s)));

  const authoritative = isAuthoritative(obs);
  const rows: FactRow[] = [];

  for (const sku of [...candidates].sort()) {
    const present = observed.has(sku);

    // Rules 9 & 10: not authoritative, OR scoped by an allowlist and absent → UNKNOWN, never false.
    if (!authoritative || (!present && allow != null)) {
      rows.push({
        supplier_product_id: sku,
        supplier_account: obs.supplierAccount,
        is_saved: null,
        sync_status: obs.syncStatus,
        sync_error_code: obs.syncErrorCode,
        observed_at: obs.observedAt,
        source_run_id: obs.sourceRunId,
      });
      continue;
    }

    rows.push({
      supplier_product_id: sku,
      supplier_account: obs.supplierAccount,
      is_saved: present,
      sync_status: 'ok',
      sync_error_code: null,
      observed_at: obs.observedAt,
      source_run_id: obs.sourceRunId,
      ...(present ? { last_seen_saved_at: obs.observedAt } : { last_seen_removed_at: obs.observedAt }),
    });
  }
  return rows;
}

export type DiffAction = 'insert' | 'update' | 'unchanged';

export interface DiffEntry {
  sku: string;
  action: DiffAction;
  before: boolean | null | undefined;
  after: boolean | null;
  reason: string;
}

/** PURE: classify each proposed row against current table state (this account only). */
export function diffAgainstExisting(
  rows: readonly FactRow[],
  existing: Record<string, { is_saved?: boolean | null; sync_status?: string }>,
): DiffEntry[] {
  return rows.map(row => {
    const cur = existing[row.supplier_product_id];
    if (!cur) {
      return { sku: row.supplier_product_id, action: 'insert' as const, before: undefined, after: row.is_saved, reason: 'new_fact' };
    }
    const sameValue = (cur.is_saved ?? null) === row.is_saved;
    const sameStatus = cur.sync_status === row.sync_status;
    if (sameValue && sameStatus) {
      return { sku: row.supplier_product_id, action: 'unchanged' as const, before: cur.is_saved, after: row.is_saved, reason: 'identical_observation' };
    }
    return {
      sku: row.supplier_product_id,
      action: 'update' as const,
      before: cur.is_saved,
      after: row.is_saved,
      reason: `is_saved ${String(cur.is_saved)}→${String(row.is_saved)} status ${String(cur.sync_status)}→${row.sync_status}`,
    };
  });
}

export function summarise(entries: readonly DiffEntry[]): Record<DiffAction, number> {
  const out: Record<DiffAction, number> = { insert: 0, update: 0, unchanged: 0 };
  for (const e of entries) out[e.action] += 1;
  return out;
}
