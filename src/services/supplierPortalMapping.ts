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

// ── 人工确认商品身份 ─────────────────────────────────────────────────────────
//
// 门户搜索解析不出唯一候选的 SKU（56481.00 这类），用户在 XOne 里直接给出 website
// product_id。这不是放宽安全门 —— 反查仍然是同一条：product_id 的详情页必须回报
// 完全相同的 SKU。人工只是提供了「搜哪一个」，没有提供「答案」。
//
// 复用 resolvePortalMapping：把用户给的 id 当作唯一候选传进去，反查、数字校验、
// 精确比较全部沿用同一套判定，不另写一份。

export type ManualIdentityStatus =
  | 'verified'                  // 反查一致，可以保存
  | 'sku_mismatch'              // 详情页 SKU 与目标不同 —— 禁止保存
  | 'not_found'                 // 该 product_id 读不到详情
  | 'invalid_product_id'        // 不是正整数
  | 'already_mapped'            // 已存在完全相同的映射，幂等
  | 'conflict_existing_mapping'; // 该 SKU 已映射到别的 product_id —— 禁止静默覆盖

export interface ManualIdentityVerdict {
  status: ManualIdentityStatus;
  supplier_product_id: string;
  website_product_id: number | null;
  portal_sku: string | null;
  product_title: string | null;
  /**
   * 同一个 product_id 已被哪些别的 SKU 使用。供应商可能存在 alias，所以这只是警告，
   * 不构成阻断 —— 但用户仍然绕不过 portal_sku 精确反查。
   */
  also_used_by: string[];
  /** 只允许保存的唯一状态。 */
  can_save: boolean;
  detail: string | null;
}

/**
 * 判定一次人工身份确认。纯函数：所有 IO（详情页读取、现有映射查询）由调用方完成。
 */
export function verifyManualIdentity(input: {
  supplier_product_id: string;
  website_product_id: unknown;
  /** 详情页回报的 SKU。读不到时传 null。 */
  portal_sku: string | null;
  product_title?: string | null;
  /** 该 SKU 当前已存的映射行（若有）。 */
  existing?: StoredPortalMapping | null;
  /** 该 product_id 已被哪些别的 SKU 使用。 */
  otherSkusUsingId?: readonly string[];
}): ManualIdentityVerdict {
  const sku = input.supplier_product_id.trim();
  const id = numericId(input.website_product_id as string | number);
  const alsoUsedBy = [...(input.otherSkusUsingId ?? [])].filter((s) => s.trim() !== sku);
  const base = {
    supplier_product_id: sku,
    website_product_id: id,
    portal_sku: null as string | null,
    product_title: input.product_title?.trim() || null,
    also_used_by: alsoUsedBy,
    can_save: false,
  };

  if (id === null) {
    return { ...base, website_product_id: null, status: 'invalid_product_id', detail: 'Website Product ID 必须是正整数' };
  }

  // 反查判定完全复用既有规则：一个候选、数字 id、SKU 精确回显。
  const resolution = resolvePortalMapping({
    supplier_product_id: sku,
    candidates: [id],
    portal_sku: input.portal_sku,
  });

  if (resolution.status === 'detail_unavailable') {
    return { ...base, status: 'not_found', detail: '未找到该 Website Product ID' };
  }
  if (resolution.status !== 'resolved') {
    return {
      ...base,
      portal_sku: resolution.portal_sku,
      status: 'sku_mismatch',
      detail: resolution.detail,
    };
  }

  // 反查通过之后才看冲突。
  const existing = input.existing;
  if (existing && isUsableMapping(existing)) {
    const storedId = numericId(existing.website_product_id ?? '');
    if (storedId === id) {
      // 幂等：已经是同一条映射，重复保存不制造新记录。
      return { ...base, portal_sku: resolution.portal_sku, status: 'already_mapped', can_save: false, detail: '该商品身份已确认，无需重复保存' };
    }
    // 已映射到别的 product_id —— 本轮不做一键覆盖。
    return {
      ...base,
      portal_sku: resolution.portal_sku,
      status: 'conflict_existing_mapping',
      detail: '该 SKU 已存在不同的商品身份映射，需要人工确认覆盖。',
    };
  }

  return {
    ...base,
    portal_sku: resolution.portal_sku,
    status: 'verified',
    can_save: true,
    detail: alsoUsedBy.length > 0 ? '该 Website Product ID 已关联其他 Supplier SKU。' : null,
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
