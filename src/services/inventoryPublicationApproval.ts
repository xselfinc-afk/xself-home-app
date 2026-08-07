/**
 * 人工批准一次发布变更 —— 纯判定，无 IO。
 *
 * 立场：人工批准**不是**绕过安全门的钥匙，而是安全门之外**额外**必须具备的一项。最终条件是
 *
 *     人工明确批准  AND  系统安全门通过  AND  后台最新事实仍支持该动作
 *
 * 三者缺一不可。前端只被允许说「谁、对哪个 SKU、批准了哪个方向、基于哪次 run」；
 * 是否 eligible、证据够不够、安全门过没过，一律由后台用最新事实重新判断——前端说什么都不算。
 *
 * 这个模块只做判断，不执行。真正的发布变更仍然只经
 * applyInventoryLifecycleActions.ts → set_publication_from_availability()。
 */
import { evaluateDelistBatchAllowed, type InventoryAutomationConfig } from './inventoryAutomationConfig';

export type PublicationAction = 'delist' | 'relist';

/** 七道门，任何一道不过都不得写 published。 */
export type ApprovalBlock =
  | 'not_eligible'              // 1. SKU 已不在对应 eligible 状态
  | 'evidence_not_supporting'   // 2. 最新证据不再支持该动作
  | 'published_state_mismatch'  // 3. 当前发布状态与动作不匹配
  | 'stale_proposal'            // 4. 建议 / source run 已失效
  | 'approver_missing'          // 5. 没有明确的人工批准人
  | 'safety_blocked'            // 6. 现有安全门拦截
  | 'scope_not_single_sku';     // 7. 不是精确单件

export interface ApprovalVerdict {
  allowed: boolean;
  blocks: ApprovalBlock[];
  /** 安全门自己的原因码，原样透出以便界面说清是哪一条。 */
  safety_blocks: string[];
  action: PublicationAction;
  supplier_product_id: string;
}

export interface ApprovalFacts {
  /** 后台刚读到的 workflow 状态。 */
  workflow_state: string | null;
  /** 后台刚读到的 standardized_products.published。 */
  published: boolean | null;
  /** 后台刚读到的最新证据。 */
  available: boolean | null;
  checked_at: string | null;
  consecutive_out_of_stock: number;
  consecutive_in_stock: number;
  /** 该 SKU 当前建议所属的 run；与请求里的 source_run_id 比对。 */
  current_source_run_id: string | null;
}

/** 调度器不是人。任何自动化身份都不得充当批准人。 */
const NON_HUMAN_APPROVERS = new Set(['scheduler', 'system', 'automation', 'cron', 'launchd', 'xone']);

export function isHumanApprover(approvedBy: string | null | undefined): boolean {
  const name = (approvedBy ?? '').trim();
  if (!name || name.length > 40) return false;
  return !NON_HUMAN_APPROVERS.has(name.toLowerCase());
}

/**
 * 判断一次人工批准是否可以进入执行器。
 *
 * `facts` 必须是后台**刚刚重新读取**的事实，不是前端传来的快照。
 */
export function evaluatePublicationApproval(input: {
  supplier_product_id: string;
  action: PublicationAction;
  approved_by: string | null | undefined;
  source_run_id: string | null | undefined;
  facts: ApprovalFacts;
  config: InventoryAutomationConfig;
  /** 当前 published 总数，供比例安全门使用。 */
  total_published: number;
}): ApprovalVerdict {
  const sku = (input.supplier_product_id ?? '').trim();
  const blocks: ApprovalBlock[] = [];
  const f = input.facts;

  // 7. 精确单件：空、逗号、通配符一律拒绝。
  if (!sku || /[,*\s]/.test(sku) || sku.toLowerCase() === 'all') {
    blocks.push('scope_not_single_sku');
  }

  // 5. 必须是明确的人工批准人。
  if (!isHumanApprover(input.approved_by)) blocks.push('approver_missing');

  // 1. 仍处于对应的 eligible 状态。
  const wantedState = input.action === 'delist' ? 'eligible_for_delist' : 'eligible_for_relist';
  if (f.workflow_state !== wantedState) blocks.push('not_eligible');

  // 3. 当前发布状态必须与动作匹配：下架的前提是它还在架上。
  if (input.action === 'delist' && f.published !== true) blocks.push('published_state_mismatch');
  if (input.action === 'relist' && f.published !== false) blocks.push('published_state_mismatch');

  // 2. 最新证据仍支持该动作，且确认次数达到阈值。
  if (input.action === 'delist') {
    const supports = f.available === false
      && f.consecutive_out_of_stock >= input.config.outOfStockConfirmations;
    if (!supports) blocks.push('evidence_not_supporting');
  } else {
    const supports = f.available === true
      && f.consecutive_in_stock >= input.config.relistConfirmations;
    if (!supports) blocks.push('evidence_not_supporting');
  }

  // 4. 建议仍来自当前那次 run。前端拿着旧 run 的建议来批准，说明它看到的已经不是现状。
  const requested = (input.source_run_id ?? '').trim();
  if (!requested || !f.current_source_run_id || requested !== f.current_source_run_id) {
    blocks.push('stale_proposal');
  }

  // 6. 现有安全门照旧生效 —— 人工批准之外的第二层，不是替代品。
  //    单件批准即 proposedDelistCount = 1，仍要过每轮上限、比例上限与方向开关。
  const safety = input.action === 'delist'
    ? evaluateDelistBatchAllowed(input.config, { proposedDelistCount: 1, totalPublished: input.total_published })
    : {
      allowed: input.config.automationEnabled && input.config.autoRelistEnabled,
      blocks: [
        ...(input.config.automationEnabled ? [] : ['automation_disabled']),
        ...(input.config.autoRelistEnabled ? [] : ['auto_relist_disabled']),
      ],
    };
  if (!safety.allowed) blocks.push('safety_blocked');

  return {
    allowed: blocks.length === 0,
    blocks,
    safety_blocks: safety.blocks as string[],
    action: input.action,
    supplier_product_id: sku,
  };
}

/**
 * 执行之后的回读判定：RPC 说成功不等于真的变了。
 *
 * delist 必须看到 published true → false，relist 必须看到 false → true。回读不符即
 * verification_failed，绝不能显示「已完成」。
 */
export function verifyPublicationOutcome(input: {
  action: PublicationAction;
  published_before: boolean | null;
  published_after: boolean | null;
  /** 回读到的 App 可见状态，用于确认投影也跟上了。 */
  sellable_after?: boolean | null;
}): { verified: boolean; reason: string | null } {
  const expected = input.action === 'delist' ? false : true;
  if (input.published_after !== expected) {
    return {
      verified: false,
      reason: `回读发现 published 仍为 ${String(input.published_after)}，未变为 ${String(expected)}`,
    };
  }
  if (input.published_before === input.published_after) {
    return { verified: false, reason: '回读发现发布状态没有发生任何变化' };
  }
  // 投影可以稍后收敛，但下架后仍然可见是矛盾的，必须报出来。
  if (input.action === 'delist' && input.sellable_after === true) {
    return { verified: false, reason: '已标记下架，但商品仍出现在 App 可见集合中' };
  }
  return { verified: true, reason: null };
}
