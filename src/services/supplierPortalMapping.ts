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
  /** 被收藏那条 listing 自身的资料。有它才能在多候选里认出正确的一条。 */
  saved?: SavedListingFacts | null;
  /** 每个候选的详情。仅在候选多于一个时需要。 */
  candidate_details?: readonly CandidateListing[] | null;
}


/**
 * 被收藏的那条 listing 自身的资料。来源是 Pickup Saved Items 导入的 supplier_products 行 ——
 * 它描述的就是用户实际收藏的 listing，是身份的 Source of Truth。
 */
export interface SavedListingFacts {
  title: string | null;
  /** 主图 URL。比对时只取文件名 —— GIGA 的图片文件名是内容哈希，同图必同名。 */
  primary_image: string | null;
  image_count: number | null;
  /** 组装尺寸 L×W×H，各保留两位。 */
  dimensions: string | null;
  first_arrival_date: string | null;
}

/** 门户搜索返回的一个候选 listing 的详情。 */
export interface CandidateListing {
  product_id: number;
  portal_sku: string | null;
  title: string | null;
  main_image: string | null;
  image_count: number | null;
  dimensions: string | null;
  first_available_date: string | null;
}

/** 图片 URL → 文件名（去查询串）。GIGA 的文件名是内容哈希。 */
export function imageFingerprint(url: string | null | undefined): string | null {
  const raw = String(url ?? '').split('?')[0].split('/').pop() ?? '';
  return raw.trim() ? raw.trim().toLowerCase() : null;
}

const normTitle = (t: string | null | undefined) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 一个候选与收藏记录的吻合度。主图指纹一致是决定性证据（内容哈希）；其余各计一分。
 * 返回 -1 表示存在硬冲突（portal_sku 与目标 SKU 不同），该候选直接出局。
 */
export function scoreCandidate(saved: SavedListingFacts, c: CandidateListing, sku: string): number {
  if (c.portal_sku && c.portal_sku.trim() !== sku.trim()) return -1;
  let score = 0;
  const savedImg = imageFingerprint(saved.primary_image);
  const candImg = imageFingerprint(c.main_image);
  if (savedImg && candImg && savedImg === candImg) score += 10;      // 决定性
  if (saved.title && c.title && normTitle(saved.title) === normTitle(c.title)) score += 3;
  if (saved.image_count != null && c.image_count != null && saved.image_count === c.image_count) score += 2;
  if (saved.dimensions && c.dimensions && saved.dimensions === c.dimensions) score += 2;
  if (saved.first_arrival_date && c.first_available_date && saved.first_arrival_date === c.first_available_date) score += 2;
  return score;
}

/** 认定唯一匹配所需的最低证据量：要么主图指纹命中，要么至少三个字段一致。 */
const MIN_DECISIVE_SCORE = 6;

/**
 * 在多个候选里认出「用户实际收藏的那一条」。
 *
 * 业务原则：用户收藏的 listing 永远是 Source of Truth。同一个 Supplier SKU 在 GIGA 上可能有
 * 多条 listing（不同渠道、不同版本），**SKU 相同不代表 listing 相同**。未被收藏的那条不该
 * 参与身份判定，更不该把商品判成「身份不唯一」而拦住上架。
 *
 * 门户没有「只搜收藏夹」的接口（scene / dimension_type 都试过，返回一样），所以这里用收藏记录
 * 自己的资料去反查：主图内容哈希、标题、图片数、尺寸、入仓日期。唯一胜出且证据充分才认定；
 * 并列或证据不足时仍然交给人工确认 —— 不猜。
 */
export function matchSavedListing(
  saved: SavedListingFacts,
  candidates: readonly CandidateListing[],
  sku: string,
): { product_id: number; score: number; runnerUp: number } | null {
  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(saved, c, sku) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const best = scored[0];
  const runnerUp = scored.length > 1 ? scored[1].score : -1;
  if (best.score < MIN_DECISIVE_SCORE) return null;   // 证据不足
  if (best.score === runnerUp) return null;           // 并列，无法区分
  return { product_id: best.c.product_id, score: best.score, runnerUp };
}

function numericId(value: string | number): number | null {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const twoDp = (v: unknown): string | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : null;
};

/** L×W×H（组装尺寸，各两位）。任一维缺失就返回 null —— 半份尺寸不能当证据。 */
const dimsOf = (length: unknown, width: unknown, height: unknown): string | null => {
  const l = twoDp(length), w = twoDp(width), h = twoDp(height);
  return l && w && h ? `${l}x${w}x${h}` : null;
};

/**
 * 从 supplier_products 行取出收藏 listing 的资料。
 * 这张表装的就是 Pickup Saved Items 导入的那条 listing —— 它是身份的 Source of Truth。
 */
export function savedFactsFromSupplierProduct(row: {
  title?: string | null;
  images?: unknown;
  raw_payload?: unknown;
}): SavedListingFacts {
  const images = Array.isArray(row.images) ? (row.images as unknown[]).map(String) : [];
  const p = (row.raw_payload ?? {}) as Record<string, unknown>;
  return {
    title: row.title ?? (typeof p.productName === 'string' ? p.productName : null),
    primary_image: (typeof p.mainImageUrl === 'string' && p.mainImageUrl) || images[0] || null,
    image_count: images.length > 0 ? images.length : null,
    dimensions: dimsOf(p.assembledLength, p.assembledWidth, p.assembledHeight),
    first_arrival_date: typeof p.firstArrivalDate === 'string' && p.firstArrivalDate.trim() ? p.firstArrivalDate.trim() : null,
  };
}

/** 从门户 baseInfos 响应取出一个候选 listing 的资料。字段缺失一律给 null，不臆造。 */
export function candidateFromBaseInfos(productId: string | number, baseInfos: unknown): CandidateListing | null {
  const id = numericId(productId);
  if (id === null) return null;
  const info = ((baseInfos as { data?: { product_info?: Record<string, unknown> } } | null)?.data?.product_info ?? {}) as Record<string, unknown>;
  const mainImage = info.main_image as { popup?: string; thumb?: string } | undefined;
  const imageList = Array.isArray(info.image_list) ? info.image_list : null;
  const assemble = ((info.specification as { product_dimensions?: { assemble_info?: Record<string, unknown> } } | undefined)
    ?.product_dimensions?.assemble_info ?? {}) as Record<string, unknown>;
  const firstAvailable = typeof info.first_available_date === 'string' ? info.first_available_date.trim() : '';
  return {
    product_id: id,
    portal_sku: typeof info.sku === 'string' && info.sku.trim() ? info.sku.trim() : null,
    title: typeof info.product_name === 'string' && info.product_name.trim() ? info.product_name.trim() : null,
    main_image: mainImage?.popup ?? mainImage?.thumb ?? null,
    image_count: imageList ? imageList.length : null,
    dimensions: dimsOf(assemble.length_show, assemble.width_show, assemble.height_show),
    // 门户对本账号不可见时会返回 "**"，那不是日期，不能当证据。
    first_available_date: firstAvailable && !firstAvailable.includes('*') ? firstAvailable : null,
  };
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
    // 门户全局搜索会把同 SKU 的其它 listing 一并返回，但用户只收藏了其中一条。
    // 先用收藏记录自身的资料把它认出来；认不出来才算真的身份不唯一。
    const saved = observation.saved ?? null;
    const details = observation.candidate_details ?? null;
    if (saved && details && details.length > 0) {
      const hit = matchSavedListing(saved, details, sku);
      if (hit) {
        const chosen = details.find((d) => d.product_id === hit.product_id)!;
        return {
          supplier_product_id: sku,
          website_product_id: hit.product_id,
          portal_sku: chosen.portal_sku ?? sku,
          source: PORTAL_MAPPING_SOURCE,
          confidence: PORTAL_MAPPING_CONFIDENCE,
          status: 'resolved',
          detail: `${candidates.length} 个同 SKU 候选，按收藏记录资料认定 ${hit.product_id}（吻合度 ${hit.score}，次优 ${hit.runnerUp}）`,
        };
      }
    }
    return {
      ...base,
      status: 'multiple_candidates',
      detail: `门户搜索返回 ${candidates.length} 个候选，收藏记录无法区分，拒绝自动选取`,
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
