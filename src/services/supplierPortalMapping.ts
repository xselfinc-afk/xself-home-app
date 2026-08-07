/**
 * Supplier SKU → website product_id mapping rules — pure, deterministic, side-effect free.
 *
 * WHY THIS IS ITS OWN LAYER
 * -------------------------
 * The wishlist XHR acts on the website's NUMERIC product_id, not the supplier SKU. Getting that
 * wrong does not fail loudly — it silently favourites or un-favourites a different product. So the
 * mapping is treated as evidence that must be proven, not a lookup that may be guessed.
 *
 * `inventory_cache.product_id` is NOT a source. Every one of its rows carries product_id equal to
 * supplier_product_id — it is a self-copy column, and a handful of SKUs that happen to be all
 * digits would sail through a naive numeric check and address an unrelated product. That source is
 * banned here structurally, not by convention.
 *
 * THE ONLY ACCEPTABLE EVIDENCE
 * ----------------------------
 * The supplier portal, queried per SKU, returning exactly one candidate whose own detail page
 * reports a SKU identical to the one we asked for. One candidate, numeric id, exact SKU echo.
 * Anything else — zero candidates, several candidates, a mismatched echo — is an exception the
 * caller must surface, never resolve.
 */

export const PORTAL_MAPPING_SOURCE = 'supplier_portal' as const;
export const PORTAL_MAPPING_CONFIDENCE = 'exact' as const;

/** Sources that must never be accepted as a website identity, whatever they contain. */
export const BANNED_MAPPING_SOURCES = ['inventory_cache', 'standardized_products', 'supplier_products'] as const;

export type PortalResolutionStatus =
  | 'resolved'
  | 'no_candidate'
  | 'multiple_candidates'
  | 'portal_sku_mismatch'
  | 'product_id_not_numeric'
  | 'detail_unavailable';

export interface PortalResolution {
  supplier_product_id: string;
  status: PortalResolutionStatus;
  website_product_id: number | null;
  portal_sku: string | null;
  source: typeof PORTAL_MAPPING_SOURCE;
  confidence: typeof PORTAL_MAPPING_CONFIDENCE | null;
  detail: string | null;
}

/** What one portal probe observed for a single SKU. */
export interface PortalObservation {
  supplier_product_id: string;
  /** Every candidate the portal search returned, in order. */
  candidates: readonly (string | number)[];
  /** The SKU the single candidate's own detail page reports. Null when detail was unreadable. */
  portal_sku: string | null;
}

function numericId(value: string | number): number | null {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Turn one observation into a mapping or an exception.
 *
 * Deliberately refuses to pick between candidates. A search that matched several products means we
 * do not know which one the SKU is, and choosing the first — as the pre-existing
 * `resolveProductId` helper does for warehouse lookups — would be a guess with outward-facing
 * consequences here.
 */
export function resolvePortalMapping(observation: PortalObservation): PortalResolution {
  const sku = observation.supplier_product_id.trim();
  const base = {
    supplier_product_id: sku,
    website_product_id: null,
    portal_sku: null,
    source: PORTAL_MAPPING_SOURCE,
    confidence: null,
  } as const;

  const candidates = observation.candidates.filter((c) => String(c ?? '').trim().length > 0);
  if (candidates.length === 0) {
    return { ...base, status: 'no_candidate', detail: '门户搜索无结果' };
  }
  if (candidates.length > 1) {
    return {
      ...base,
      status: 'multiple_candidates',
      detail: `门户搜索返回 ${candidates.length} 个候选，拒绝自动选取`,
    };
  }

  const id = numericId(candidates[0]);
  if (id === null) {
    return { ...base, status: 'product_id_not_numeric', detail: `候选 ${String(candidates[0])} 不是数字 product_id` };
  }

  if (observation.portal_sku === null) {
    return { ...base, status: 'detail_unavailable', detail: '无法读取候选商品详情，portal_sku 未知' };
  }

  const portalSku = observation.portal_sku.trim();
  if (portalSku !== sku) {
    // The reverse check. Without it a fuzzy search hit becomes a mapping.
    return {
      ...base,
      status: 'portal_sku_mismatch',
      portal_sku: portalSku,
      detail: `门户返回的 SKU 是 ${portalSku}，与目标 ${sku} 不一致`,
    };
  }

  return {
    supplier_product_id: sku,
    status: 'resolved',
    website_product_id: id,
    portal_sku: portalSku,
    source: PORTAL_MAPPING_SOURCE,
    confidence: PORTAL_MAPPING_CONFIDENCE,
    detail: null,
  };
}

/** One row of `supplier_portal_product_mappings`. */
export interface StoredPortalMapping {
  supplier_product_id: string;
  website_product_id: number | string | null;
  portal_sku: string | null;
  source: string | null;
  confidence: string | null;
  resolved_at: string | null;
  last_verified_at: string | null;
}

export interface UsableMapping {
  supplier_product_id: string;
  website_product_id: number;
  portal_sku: string;
}

/**
 * Re-validate a stored row before it is allowed to drive an outward-facing call.
 *
 * Storage is not trust. A row could have been written by an older, looser resolver, or by a source
 * that is no longer acceptable, so every gate is re-checked at read time: portal provenance, exact
 * confidence, a numeric id, and portal_sku still echoing the SKU.
 */
export function isUsableMapping(row: StoredPortalMapping | null | undefined): row is StoredPortalMapping {
  if (!row) return false;
  if (row.source !== PORTAL_MAPPING_SOURCE) return false;
  if (BANNED_MAPPING_SOURCES.includes(row.source as never)) return false;
  if (row.confidence !== PORTAL_MAPPING_CONFIDENCE) return false;
  if (numericId(row.website_product_id ?? '') === null) return false;
  const sku = row.supplier_product_id?.trim();
  if (!sku) return false;
  // The stored reverse check must still hold, and must not be the SKU echoed as its own id.
  if (!row.portal_sku || row.portal_sku.trim() !== sku) return false;
  if (String(row.website_product_id).trim() === sku) return false;
  return true;
}

export function toUsableMapping(row: StoredPortalMapping): UsableMapping | null {
  if (!isUsableMapping(row)) return null;
  return {
    supplier_product_id: row.supplier_product_id.trim(),
    website_product_id: numericId(row.website_product_id ?? '')!,
    portal_sku: row.portal_sku!.trim(),
  };
}

/** Mappings older than this are re-verified before use rather than trusted indefinitely. */
export const MAPPING_STALE_AFTER_DAYS = 90;

export function isStale(row: StoredPortalMapping, nowIso: string): boolean {
  const stamp = row.last_verified_at ?? row.resolved_at;
  if (!stamp) return true;
  const age = Date.parse(nowIso) - Date.parse(stamp);
  if (!Number.isFinite(age)) return true;
  return age > MAPPING_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}
