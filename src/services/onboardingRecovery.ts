/**
 * 上架未完成商品的续跑判定 —— 纯逻辑，无 IO。
 *
 * 一次批量上架可能死在任何一个阶段，留下「已经做了一半」的商品。它们既不是新候选
 * （planGigaAutoPublish 的候选是「在 supplier_products 但不在 standardized_products」，
 * 一旦建了行就被排除），也不该从界面上消失。这里定义它们是什么、还差什么、该怎么续。
 *
 * 两个必须分清的阶段：
 *
 *   A. 上架流水线（runGigaAutoPublish 的八个阶段）
 *      资料 / 标题 / 定价 / 图片 / 库存 / 评价。产物在 standardized_products 与 product_reviews。
 *
 *   B. 库存证据（scanPublishedAvailability）
 *      产物在 product_availability_current。sellable_products 是对 latest_product_availability
 *      的 INNER JOIN，要求 available 且在宽限期内 —— 没有这一行，前面八个阶段全做完也不可售。
 *
 * B 属于库存扫描链，不属于上架流水线。首次上架的商品在扫描跑到它之前，天然处于
 * 「已发布、但 App 还看不到」的状态。把这一步说成「上架失败」是不诚实的。
 */

/** 续跑需要知道的每件商品的事实。全部来自数据库，不接受前端传入。 */
export interface OnboardingProgressFacts {
  supplier_product_id: string;
  /** supplier_products.published —— 流水线的批准位，不代表 App 可见。 */
  supplier_published: boolean;
  /** standardized_products 是否有行。 */
  in_standardized: boolean;
  standardized_published: boolean | null;
  normalization_status: string | null;
  optimized_title: string | null;
  selling_price: number | null;
  primary_image_mirror_status: string | null;
  primary_image_blurhash: string | null;
  inventory_status: string | null;
  total_available_qty: number | null;
  active_review_count: number;
  /** product_availability_current 是否有行。 */
  has_availability_evidence: boolean;
  in_sellable: boolean;
  /** giga_delivery_fee_cache 里有可用的运费。没有它，Checkout 只能显示 Quote required。 */
  has_delivery_fee: boolean;
}

export type OnboardingStage =
  | 'data'        // 资料（normalize）
  | 'title'       // 标题
  | 'pricing'     // 定价
  | 'media'       // 图片
  | 'inventory'   // 库存
  | 'reviews'     // 评价
  | 'visibility'  // App 可见验证（库存证据 + sellable）
  | 'delivery';   // 配送费用（Checkout 能否报价）

export const STAGE_LABELS: Record<OnboardingStage, string> = {
  data: '资料',
  title: '标题',
  pricing: '定价',
  media: '图片',
  inventory: '库存',
  reviews: '评价',
  visibility: 'App 可见验证',
  delivery: '配送费用',
};

/** 每个阶段是否已完成。判定只看产物，不看执行器说了什么。 */
export function stageCompletion(facts: OnboardingProgressFacts): Record<OnboardingStage, boolean> {
  return {
    data: facts.in_standardized && facts.normalization_status === 'done',
    title: Boolean(facts.optimized_title && facts.optimized_title.trim()),
    pricing: facts.selling_price !== null && facts.selling_price > 0,
    media: facts.primary_image_mirror_status === 'mirrored' && Boolean(facts.primary_image_blurhash),
    inventory: facts.inventory_status === 'in_stock' && (facts.total_available_qty ?? 0) > 0,
    reviews: facts.active_review_count > 0,
    // App 可见是回读出来的结论，不是某个脚本「跑过」就算数。
    visibility: facts.in_sellable,
    delivery: facts.has_delivery_fee,
  };
}

export type RecoveryState =
  | 'not_started'          // 还没开始，不属于续跑
  | 'pipeline_incomplete'  // 八个阶段还没走完 → 续跑流水线
  | 'awaiting_evidence'    // 阶段都完了，只差库存证据 → 需要一次库存读取
  | 'published_not_visible'// 证据也有了，却仍不在 sellable → 需要人看
  | 'awaiting_delivery_fee'// App 可见了，但 Checkout 报不出运费
  | 'complete';            // App 可见且可结算

/**
 * 这件商品现在处于什么状态，以及下一步该做什么。
 *
 * 顺序是刻意的：先确认流水线走完没有，再谈证据，最后才谈可见。任何一步没做完，就不该
 * 让它显示成「可以上架」，也不该显示成「上架失败」——它是「上架未完成」。
 */
export function deriveRecoveryState(facts: OnboardingProgressFacts): {
  state: RecoveryState;
  missing: OnboardingStage[];
  nextAction: 'none' | 'resume_pipeline' | 'refresh_availability' | 'refresh_delivery_fee' | 'needs_review';
} {
  if (!facts.supplier_published && !facts.in_standardized) {
    return { state: 'not_started', missing: [], nextAction: 'none' };
  }
  const done = stageCompletion(facts);
  const pipelineStages: OnboardingStage[] = ['data', 'title', 'pricing', 'media', 'inventory', 'reviews'];
  const missingPipeline = pipelineStages.filter((stage) => !done[stage]);

  if (missingPipeline.length > 0) {
    return { state: 'pipeline_incomplete', missing: [...missingPipeline, 'visibility'], nextAction: 'resume_pipeline' };
  }
  if (facts.in_sellable) {
    // 上架了不等于卖得出去：没有运费缓存，Checkout 只会显示 Quote required。
    // 运费是 Golden Path orchestrator 的第 7 步，发布之后单独跑，软失败不回滚。
    if (!facts.has_delivery_fee) {
      return { state: 'awaiting_delivery_fee', missing: ['delivery'], nextAction: 'refresh_delivery_fee' };
    }
    return { state: 'complete', missing: [], nextAction: 'none' };
  }
  // 八个阶段都完了却不可售：先看是不是根本还没有库存证据。
  if (!facts.has_availability_evidence) {
    return { state: 'awaiting_evidence', missing: ['visibility'], nextAction: 'refresh_availability' };
  }
  // 有证据仍然不可售 —— 说明证据本身是「无货」或已过宽限期，这需要人看，不能自动重试。
  return { state: 'published_not_visible', missing: ['visibility'], nextAction: 'needs_review' };
}

/** 只有这两种状态算「上架未完成」，需要出现在续跑清单里。 */
export function isResumable(state: RecoveryState): boolean {
  return state === 'pipeline_incomplete'
    || state === 'awaiting_evidence'
    || state === 'awaiting_delivery_fee';
}

/**
 * 用上一次的计划快照，为未完成的商品重建一份执行器认得的计划。
 *
 * **不重新规划，只是回放 planner 当时的决定。** 家族分组尤其不能自己算 —— 执行器的库存
 * 阶段是整族门禁（family 必须全员有货才放行），分组错了门禁的含义就变了。所以家族只要有
 * 任何一个成员还没完成，就整族带上，与 planner 当时的判断保持一致。
 *
 * 产出的 schema 与 planGigaAutoPublish 完全一致，因此可以直接喂给既有的
 * runGigaAutoPublish --plan <file> --apply，不需要第二个执行器。
 */
export function buildRecoveryPlan(
  previousPlan: Record<string, unknown> | null,
  resumeSkus: readonly string[],
): Record<string, unknown> | null {
  if (!previousPlan || resumeSkus.length === 0) return null;
  const wanted = new Set(resumeSkus);

  const families = (Array.isArray(previousPlan.safe_variant_families) ? previousPlan.safe_variant_families : [])
    .filter((entry): entry is { key: string; skus: string[] } => {
      const family = entry as { skus?: unknown };
      return Array.isArray(family.skus) && family.skus.some((sku) => wanted.has(String(sku)));
    });

  // 整族带上：族里已经完成的成员再跑一遍是幂等的，但把族拆开会让整族门禁失去意义。
  const skus = new Set<string>(resumeSkus.map(String));
  for (const family of families) for (const sku of family.skus) skus.add(String(sku));

  const candidates = (Array.isArray(previousPlan.candidates) ? previousPlan.candidates : [])
    .filter((entry) => skus.has(String((entry as { id?: unknown }).id ?? '')));
  if (skus.size === 0) return null;

  const orderedSkus = [...skus];
  return {
    ...previousPlan,
    generated: new Date().toISOString(),
    recovery_of: (previousPlan as { generated?: unknown }).generated ?? null,
    proposed_batch: {
      skus: orderedSkus,
      sku_count: orderedSkus.length,
      card_count: families.length || orderedSkus.length,
      families,
    },
    safe_variant_families: families,
    candidates,
  };
}
