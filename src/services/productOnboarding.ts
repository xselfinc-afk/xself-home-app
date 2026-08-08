/**
 * 新品首次上架 —— 纯判定层，无 IO。
 *
 * 立场与库存下架/恢复完全一致：**首次发布也必须人工明确批准**，而且批准之外还要通过
 * 后台用最新事实重跑的检查。前端只被允许说「谁、批准了哪个 SKU」；准备好没有、身份对
 * 不对、有没有货、价格图片全不全，一律由后台重新读取判断。
 *
 * 这个模块只做判断，不执行。真正的导入与发布仍然只走既有流水线：
 *   syncGigaNewlySavedCandidates → upsertPickupProducts → planGigaAutoPublish → runGigaAutoPublish
 * 首次上架与库存 relist 是两条独立路径，此处绝不调用 set_publication_from_availability()。
 */

/** 候选在界面上的业务状态。raw enum 不进 UI。 */
export type OnboardingState =
  | 'preparing'            // 正在准备资料
  | 'needs_identity'       // 网站身份无法唯一确认
  | 'needs_taxonomy'       // 分类需要人工确认
  | 'incomplete_data'      // 标题/图片/价格缺失
  | 'insufficient_stock'   // 首次库存证据不足或为零
  | 'ready_to_publish'     // 可以批准
  | 'publishing'           // 正在上架
  | 'published_visible'    // 已上架且 App 可见
  | 'published_not_visible'// 已上架但未达到 App 可见条件
  | 'publish_failed';      // 上架失败

export const ONBOARDING_STATE_LABELS: Record<OnboardingState, string> = {
  preparing: '准备中',
  needs_identity: '身份异常',
  needs_taxonomy: '分类需要确认',
  incomplete_data: '资料不完整',
  insufficient_stock: '库存不足',
  ready_to_publish: '可以批准',
  publishing: '上架中',
  published_visible: '已上架',
  published_not_visible: '已上架，但 App 暂不可见',
  publish_failed: '上架失败',
};

/** 后台重新读取到的候选事实。全部来自数据库或既有只读探测，不接受前端传入。 */
export interface OnboardingFacts {
  supplier_product_id: string;
  /** 仍在 Pickup 收藏里。首次上架的入口条件。 */
  in_pickup_favorites: boolean;
  /** supplier_products 是否已有该 SKU（导入完成的标志）。 */
  in_supplier_products: boolean;
  /** standardized_products 是否已有草稿。 */
  in_standardized_products: boolean;
  /** 当前发布状态。首次上架要求它现在是 false。 */
  published: boolean | null;
  /** 是否已经出现在 App 可售视图里。 */
  in_sellable_products: boolean;
  /** 身份：唯一且反查一致的 website product_id。 */
  has_unique_identity: boolean;
  product_title: string | null;
  primary_image: string | null;
  selling_price: number | null;
  /** 分类是否仍需人工确认。 */
  taxonomy_needs_review: boolean;
  /** 首次库存证据：true=有货，false=零库存，null=没有有效证据。 */
  stock_available: boolean | null;
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * 候选当前处于哪个业务状态。
 *
 * 判定顺序是刻意的：先看是否已经上架（终态），再按「必须人工介入」→「资料不全」→
 * 「库存」的顺序报出第一个真正的障碍，避免一次抛一堆并列问题让用户无从下手。
 */
export function deriveOnboardingState(facts: OnboardingFacts): OnboardingState {
  // 已经发布：区分「真的可见」与「发布了但没达到可见条件」。
  if (facts.published === true) {
    return facts.in_sellable_products ? 'published_visible' : 'published_not_visible';
  }
  // 还没导入完成 —— 资料都还没有，先准备。
  if (!facts.in_supplier_products) return 'preparing';
  if (!facts.has_unique_identity) return 'needs_identity';
  if (!hasText(facts.product_title) || !hasText(facts.primary_image)
    || facts.selling_price === null || facts.selling_price <= 0) {
    return 'incomplete_data';
  }
  // 分类未确认不得放行 —— 但排在资料之后，先补齐能自动补的。
  if (facts.taxonomy_needs_review) return 'needs_taxonomy';
  // 首次库存证据：没有证据与零库存都不发布，两者都不是「可以批准」。
  if (facts.stock_available !== true) return 'insufficient_stock';
  return 'ready_to_publish';
}

/** 只有这一个状态允许出现「批准上架」。 */
export function canApproveFirstPublish(state: OnboardingState): boolean {
  return state === 'ready_to_publish';
}

// ── 首次发布前的重新校验 ─────────────────────────────────────────────────────

export type FirstPublishBlock =
  | 'not_in_pickup_favorites'   // 已不在 Pickup 收藏
  | 'not_a_candidate'           // 已不是待上新候选
  | 'already_published'         // 已经发布过，重复批准
  | 'identity_unverified'       // 身份不唯一
  | 'supplier_row_missing'      // supplier_products 没有数据
  | 'incomplete_product_data'   // 标题/图片/价格不全
  | 'taxonomy_unconfirmed'      // 分类未确认
  | 'no_stock_evidence'         // 无有效库存证据
  | 'zero_stock'                // 明确零库存
  | 'approver_missing'          // 没有明确批准人
  | 'scope_not_single_sku';     // 不是精确单件

export interface FirstPublishVerdict {
  allowed: boolean;
  blocks: FirstPublishBlock[];
  supplier_product_id: string;
}

/** 自动化身份不是人。与库存审批用同一条规则。 */
const NON_HUMAN_APPROVERS = new Set(['scheduler', 'system', 'automation', 'cron', 'launchd', 'xone']);

export function isHumanApprover(approvedBy: string | null | undefined): boolean {
  const name = (approvedBy ?? '').trim();
  if (!name || name.length > 40) return false;
  return !NON_HUMAN_APPROVERS.has(name.toLowerCase());
}

/**
 * 首次发布前的重新校验。`facts` 必须是后台**刚刚重新读取**的，不是前端快照。
 *
 * 任何一项失败 → 0 publish writes。
 */
export function evaluateFirstPublish(input: {
  supplier_product_id: string;
  approved_by: string | null | undefined;
  facts: OnboardingFacts;
}): FirstPublishVerdict {
  const sku = (input.supplier_product_id ?? '').trim();
  const f = input.facts;
  const blocks: FirstPublishBlock[] = [];

  // 精确单件：空、逗号、通配符一律拒绝。
  if (!sku || /[,*\s]/.test(sku) || sku.toLowerCase() === 'all') blocks.push('scope_not_single_sku');
  if (!isHumanApprover(input.approved_by)) blocks.push('approver_missing');

  // 1 仍在 Pickup 收藏 —— 用户已经取消收藏就不该再上架。
  if (!f.in_pickup_favorites) blocks.push('not_in_pickup_favorites');
  // 3 未重复创建：已经发布过就不是首次上架。
  if (f.published === true) blocks.push('already_published');
  // 5 supplier_products 数据存在
  if (!f.in_supplier_products) blocks.push('supplier_row_missing');
  // 2 仍是候选。published===true 已由 already_published 报过，这里只管「读不出发布状态」
  //   的情况：状态未知就不能当成未发布的草稿去首次上架。
  if (f.published === null) blocks.push('not_a_candidate');
  // 4 身份仍合法
  if (!f.has_unique_identity) blocks.push('identity_unverified');
  // 7/8/9 标题、主图、售价
  if (!hasText(f.product_title) || !hasText(f.primary_image)
    || f.selling_price === null || f.selling_price <= 0) {
    blocks.push('incomplete_product_data');
  }
  // 分类未确认不得放行
  if (f.taxonomy_needs_review) blocks.push('taxonomy_unconfirmed');
  // 10 首次库存证据：读取失败与零库存分开报，用户才知道该等还是该放弃
  if (f.stock_available === null) blocks.push('no_stock_evidence');
  else if (f.stock_available === false) blocks.push('zero_stock');

  return { allowed: blocks.length === 0, blocks, supplier_product_id: sku };
}

// ── 候选期收藏保护 ───────────────────────────────────────────────────────────
//
// 收藏清理的 TARGET 只认 published=true，所以一个「已收藏、尚未首次发布」的新品会被
// 当成 extra 取消收藏。复用既有的 supplier_favorite_exception_resolutions.keep_favorite
// 作为保护，用 resolved_by 区分来源 —— 现有 schema 足够，不需要新表也不需要新状态机。

/** 系统自动保护的署名。任何其它值都视为用户手工设置。 */
export const ONBOARDING_PROTECTION_ACTOR = 'system:onboarding';

export type ProtectionAction =
  | 'create_protection'   // 候选进入待上新，建立自动保护
  | 'release_protection'  // 首次发布成功或候选被放弃，释放自动保护
  | 'keep_manual'         // 用户手工设置的 keep，永不触碰
  | 'noop';               // 无需变更

export interface ExistingProtection {
  resolution: string;
  resolved_by: string;
}

/**
 * 决定该对某个候选的收藏保护做什么。
 *
 * 铁律：**只有 resolved_by === 'system:onboarding' 的记录才允许被系统释放**。用户自己
 * 标的 keep_favorite 永远不动 —— 那是他的决定，不是我们的簿记。
 */
export function decideProtection(input: {
  /** 候选是否仍需要保护（尚未发布且未被放弃）。 */
  needs_protection: boolean;
  existing: ExistingProtection | null;
}): ProtectionAction {
  const existing = input.existing;
  const isSystemOwned = existing?.resolved_by === ONBOARDING_PROTECTION_ACTOR;

  // 用户手工设置的任何裁决都不属于我们，原样保留。
  if (existing && !isSystemOwned) return 'keep_manual';

  if (input.needs_protection) {
    if (isSystemOwned && existing?.resolution === 'keep_favorite') return 'noop';
    return 'create_protection';
  }
  // 不再需要保护：只释放我们自己建的那条。
  if (isSystemOwned) return 'release_protection';
  return 'noop';
}

// ── 发布后的双重回读 ─────────────────────────────────────────────────────────

export type PublishOutcome = 'published_visible' | 'published_not_visible' | 'publish_failed';

/**
 * 执行器返回成功不等于上架成功，上架成功也不等于 App 可见。
 *
 * published 必须 false→true；在此基础上再看 sellable_products 里有没有它。两者分别报，
 * 绝不把 published=true 直接当成「顾客能看到」。
 */
export function verifyFirstPublishOutcome(input: {
  published_before: boolean | null;
  published_after: boolean | null;
  in_sellable_after: boolean;
  /** sellable 视图未包含时，用当前事实说明差在哪一条。 */
  facts_after?: Pick<OnboardingFacts, 'stock_available' | 'primary_image' | 'selling_price'>;
}): { outcome: PublishOutcome; reason: string | null } {
  if (input.published_after !== true) {
    return { outcome: 'publish_failed', reason: `回读发现 published 仍为 ${String(input.published_after)}，未变为 true` };
  }
  if (input.published_before === true) {
    return { outcome: 'publish_failed', reason: '该商品在执行前就已经是已发布状态，不是首次上架' };
  }
  if (input.in_sellable_after) return { outcome: 'published_visible', reason: null };

  // 已发布但不可见：按 sellable_products 的条件挨个指认差在哪。
  const f = input.facts_after;
  const missing: string[] = [];
  if (f) {
    if (f.stock_available !== true) missing.push('缺少有效的在售库存证据');
    if (!hasText(f.primary_image)) missing.push('缺少主图');
    if (f.selling_price === null || f.selling_price <= 0) missing.push('缺少有效售价');
  }
  return {
    outcome: 'published_not_visible',
    reason: missing.length > 0
      ? `已发布，但未满足 App 可见条件：${missing.join('、')}`
      : '已发布，但尚未进入 App 可售视图（可能是库存证据或投影尚未刷新）',
  };
}
