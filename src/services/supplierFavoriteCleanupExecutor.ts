/**
 * Supplier Favorites cleanup executor — orchestration core, dependency-injected and testable.
 *
 * Removes only the FAVORITES that no longer belong: an account's saved SKUs minus TARGET, where
 * TARGET is `standardized_products.published = true`. It adds nothing and touches no inventory.
 *
 * The pieces are split so each is unit-testable without a network or database:
 *
 *   planFavoriteCleanup   — pure set math: extra = favorites − TARGET, reusing buildFavoriteSyncPlan
 *   resolveExtraMappings  — table-first, portal-on-demand identity resolution for the extra set only
 *   executeCleanup        — the run loop: per-account, single-item, verify, checkpoint, global-stop
 *
 * SAFETY POSTURE
 * --------------
 * Default is dry run. A real wishlist call happens only when BOTH the env switch is on AND the
 * caller passed execute:true. Every send is one product_id, verified in reverse. A code 200 is not
 * completion — the SKU must be gone from the official Favorites read before it counts as removed.
 */

import {
  buildFavoriteSyncPlan,
  type AccountFavoritesState,
  type FavoriteSyncItem,
  type SyncAccount,
} from './supplierFavoriteSync';
import { executeSyncOperation, type RemovalFetcher, type WishlistOperation } from './supplierFavoriteRemoval';
import { isStale, isUsableMapping, toUsableMapping, type StoredPortalMapping } from './supplierPortalMapping';
import { type ProductIdMapping } from './supplierFavoriteProductId';

export type CleanupItemStatus =
  | 'skipped_checkpoint'
  | 'planned'          // dry run: would remove
  | 'exception'        // no usable mapping — never sent
  | 'send_failed'      // XHR did not return success
  | 'verified_removed' // gone from official Favorites
  | 'verified_added'   // present in official Favorites（add 方向的成功语义）
  | 'verification_failed' // code 200 but the item did not end up in the intended state
  | 'timeout'          // this item exceeded its watchdog — recorded, run continues
  | 'global_stop';     // run halted before this item was processed

export type GlobalStopReason = 'auth_failed' | 'captcha_required' | 'rate_limited' | 'too_many_failures' | null;

export interface CleanupItemRecord {
  account: SyncAccount;
  supplier_product_id: string;
  product_id: number | null;
  status: CleanupItemStatus;
  attempts: number;
  last_error: string | null;
  verified_at: string | null;
}

export interface CleanupCheckpoint {
  run_id: string;
  /** Key is `${account}|${sku}`. Only terminal states are stored. */
  items: Record<string, {
    account: SyncAccount;
    supplier_product_id: string;
    product_id: number | null;
    status: CleanupItemStatus;
    attempts: number;
    last_error: string | null;
    verified_at: string | null;
  }>;
}

export const DEADLINE_EXCEEDED = 'deadline_exceeded';

/**
 * Bound one promise. Every underlying fetch already carries its own abort, but a watchdog here is
 * what guarantees that no single item — for any reason, including a hung DNS or a wedged socket —
 * can stall the whole run. On expiry the item is recorded and the loop moves on.
 */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(DEADLINE_EXCEEDED)), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const checkpointKey = (account: SyncAccount, sku: string): string => `${account}|${sku}`;

// ── 1. Planning ──────────────────────────────────────────────────────────────

export interface CleanupPlan {
  target_count: number;
  /** Per account: the extra items that have a usable mapping (executable removals). */
  removals: Record<SyncAccount, FavoriteSyncItem[]>;
  /** Per account: extra SKUs with no usable mapping. Reported, never sent. */
  exceptions: Record<SyncAccount, Array<{ supplier_product_id: string; reason: string }>>;
  /** Union of extra SKUs across both accounts — the ONLY SKUs mapping resolution may touch. */
  extra_skus: string[];
  /**
   * Per account: 要**新增**的收藏。只有 options.operation === 'add' 时才会被执行。
   *
   * 它刻意不是「TARGET − 收藏」的差集：那个差集当前是 322 件历史欠账，一次开闸就是 322 次
   * 对外写入。这里只接受调用方显式给出的名单（例如「本次批量上架的这几件」）。
   */
  additions?: Record<SyncAccount, FavoriteSyncItem[]>;
}

/**
 * 为一份**显式 SKU 名单**构造新增收藏计划。纯函数，不做集合运算、不查 TARGET。
 *
 * 这是范围控制的关键：调用方必须自己说清楚要加哪几件，执行器不会替它推断。
 * 身份仍然照删除那一套要求 —— 唯一且反查一致，否则进 exceptions，永不发送。
 */
export function planFavoriteAdditions(
  account: SyncAccount,
  skus: readonly string[],
  mappingFor: (sku: string) => ProductIdMapping,
): ResolvedCleanupPlan {
  const additions: FavoriteSyncItem[] = [];
  const exceptions: Array<{ supplier_product_id: string; reason: string }> = [];
  for (const sku of [...new Set(skus.map(String))].sort()) {
    const mapping = mappingFor(sku);
    if (mapping.status === 'unique' && mapping.product_id !== null && mapping.verified_sku === sku) {
      additions.push({ supplier_product_id: sku, operation: 'add', product_id: mapping.product_id, verified_sku: mapping.verified_sku });
    } else {
      exceptions.push({ supplier_product_id: sku, reason: mapping.status === 'unique' ? 'identity_mismatch' : `mapping_${mapping.status}` });
    }
  }
  const empty = { pickup: [] as FavoriteSyncItem[], dropship: [] as FavoriteSyncItem[] };
  const emptyEx = { pickup: [] as Array<{ supplier_product_id: string; reason: string }>, dropship: [] as Array<{ supplier_product_id: string; reason: string }> };
  // 新增方向没有「人工保留/人工取消」这套裁决 —— 那是取消收藏才有的概念，这里一律为 0。
  const noCounts = {
    current_favorites: 0, extra: 0, automatic_remove: 0, manual_keep: 0, manual_remove: 0,
    manual_remove_blocked: 0, manual_no_action: 0, unresolved_exception: 0, executable_remove: 0,
  };
  return {
    target_count: additions.length,
    removals: { ...empty },
    exceptions: { ...emptyEx, [account]: exceptions },
    extra_skus: [],
    additions: { ...empty, [account]: additions },
    manual: { auto_removals: 0, manual_keep: 0, manual_remove: 0, manual_remove_blocked: 0, manual_no_action: 0, unresolved_exceptions: exceptions.length },
    accounts: {
      pickup: { ...noCounts },
      dropship: { ...noCounts },
      [account]: { ...noCounts, unresolved_exception: exceptions.length },
    },
  };
}

/**
 * Compute the removal plan. `mappingFor` is a synchronous lookup into whatever mappings have
 * already been resolved for the extra set — planning never reaches out to the portal itself.
 */
export function planFavoriteCleanup(
  target: readonly string[],
  favorites: { pickup: readonly string[]; dropship: readonly string[] },
  mappingFor: (sku: string) => ProductIdMapping,
): CleanupPlan {
  const states: AccountFavoritesState[] = [
    { account: 'pickup', saved: favorites.pickup, authoritative: true },
    { account: 'dropship', saved: favorites.dropship, authoritative: true },
  ];
  const plan = buildFavoriteSyncPlan(target, states, mappingFor);

  const removals: Record<SyncAccount, FavoriteSyncItem[]> = { pickup: [], dropship: [] };
  const exceptions: Record<SyncAccount, Array<{ supplier_product_id: string; reason: string }>> = { pickup: [], dropship: [] };
  const extra = new Set<string>();

  for (const account of plan.accounts) {
    // Only removals — this executor never adds. `missing` is intentionally ignored.
    removals[account.account] = account.extra;
    for (const item of account.extra) extra.add(item.supplier_product_id);
    for (const ex of account.exceptions) {
      // Only remove-side exceptions belong to a cleanup run.
      if (ex.intended_operation === 'remove') {
        exceptions[account.account].push({ supplier_product_id: ex.supplier_product_id, reason: ex.reason });
        extra.add(ex.supplier_product_id);
      }
    }
  }

  return {
    target_count: new Set(target.filter(Boolean)).size,
    removals,
    exceptions,
    extra_skus: [...extra].sort(),
  };
}

/**
 * Which SKUs are extra, before any mapping is known. This is the exact set — and the ONLY set —
 * that mapping resolution is permitted to touch. Exposed so a caller can resolve mappings for it
 * without first pretending everything is unmapped.
 */
export function extraSkuSet(
  target: readonly string[],
  favorites: { pickup: readonly string[]; dropship: readonly string[] },
): string[] {
  const targetSet = new Set(target.filter(Boolean));
  const extra = new Set<string>();
  for (const sku of favorites.pickup) if (!targetSet.has(sku)) extra.add(sku);
  for (const sku of favorites.dropship) if (!targetSet.has(sku)) extra.add(sku);
  return [...extra].sort();
}

// ── 2. Mapping resolution (extra only) ───────────────────────────────────────

/** Structured twin of a progress line, so callers can render state without parsing text. */
export interface CleanupProgressEvent {
  phase: 'resolve' | 'remove' | 'add' | 'verify';
  index: number;
  total: number;
  account?: SyncAccount;
  supplier_product_id?: string;
  outcome:
    | 'started' | 'resolved' | 'exception' | 'timeout' | 'skipped_checkpoint'
    | 'send_failed' | 'verified_removed' | 'verified_added' | 'verification_failed' | 'global_stop';
}

export interface ResolvedMappings {
  usable: Map<string, ProductIdMapping>;
  exceptions: Array<{ supplier_product_id: string; reason: string }>;
  /** SKUs that actually required a live portal probe (i.e. not served from the table). */
  probed: string[];
}

/**
 * Resolve mappings for the extra set, table-first. A stored row that still passes every gate and is
 * not stale is reused; only the rest are probed live via `portalResolve`. A portal probe that fails
 * to produce a unique, reverse-verified mapping is an exception — never a guess.
 */
export async function resolveExtraMappings(
  extraSkus: readonly string[],
  deps: {
    storedMappings: readonly StoredPortalMapping[];
    portalResolve: (sku: string) => Promise<ProductIdMapping>;
    now: string;
    /** Live progress, so the probe phase is observable instead of silent for hours. */
    onProgress?: (line: string, event: CleanupProgressEvent) => void;
    /**
     * Watchdog for a single portal probe. A probe that blows it becomes an exception and the loop
     * moves on — one unresolvable SKU must never stall the whole resolution phase.
     */
    perSkuTimeoutMs?: number;
  },
): Promise<ResolvedMappings> {
  const table = new Map(deps.storedMappings.map((r) => [r.supplier_product_id, r]));
  const usable = new Map<string, ProductIdMapping>();
  const exceptions: Array<{ supplier_product_id: string; reason: string }> = [];
  const probed: string[] = [];

  for (const [index, sku] of extraSkus.entries()) {
    const row = table.get(sku);
    if (isUsableMapping(row) && !isStale(row, deps.now)) {
      const m = toUsableMapping(row)!;
      usable.set(sku, { product_id: m.website_product_id, verified_sku: m.portal_sku, status: 'unique' });
      continue;
    }
    // Missing / stale / unusable stored row → probe the portal on demand.
    probed.push(sku);
    const position = `[resolve ${index + 1}/${extraSkus.length}]`;
    const rev = (outcome: CleanupProgressEvent['outcome']): CleanupProgressEvent =>
      ({ phase: 'resolve', index: index + 1, total: extraSkus.length, supplier_product_id: sku, outcome });
    deps.onProgress?.(`${position} SKU ${sku} resolving...`, rev('started'));
    let resolved: ProductIdMapping;
    try {
      resolved = deps.perSkuTimeoutMs
        ? await withDeadline(deps.portalResolve(sku), deps.perSkuTimeoutMs)
        : await deps.portalResolve(sku);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Auth / CAPTCHA must still bubble out as a global stop; only a stall is absorbed here.
      if (msg !== DEADLINE_EXCEEDED) throw error;
      deps.onProgress?.(`${position} SKU ${sku} → timeout (probe watchdog)`, rev('timeout'));
      exceptions.push({ supplier_product_id: sku, reason: 'timeout' });
      continue;
    }
    if (resolved.status === 'unique' && resolved.product_id !== null && resolved.verified_sku === sku) {
      usable.set(sku, resolved);
      deps.onProgress?.(`${position} SKU ${sku} → product_id ${resolved.product_id}`, rev('resolved'));
    } else {
      exceptions.push({ supplier_product_id: sku, reason: resolved.status });
      deps.onProgress?.(`${position} SKU ${sku} → ${resolved.status}`, rev('exception'));
    }
  }

  return { usable, exceptions, probed };
}



// ── 人工裁决 ─────────────────────────────────────────────────────────────────

/**
 * 用户在 XOne 里对一条异常做出的裁决。这是「同步收藏夹时怎么处理这一条」，
 * **绝不是**发布或下架决策 —— 它永远不会写 standardized_products.published。
 */
export type ManualResolution = 'keep_favorite' | 'remove_favorite' | 'no_action';

export interface ManualResolutionRecord {
  supplier_account: SyncAccount;
  supplier_product_id: string;
  resolution: ManualResolution;
}

/** 一个账号在计划里的分项。preview 与 execute 共用同一份结构。 */
export interface AccountPlanCounts {
  current_favorites: number;
  extra: number;
  automatic_remove: number;
  manual_keep: number;
  manual_remove: number;
  manual_remove_blocked: number;
  manual_no_action: number;
  unresolved_exception: number;
  executable_remove: number;
}

export interface ManualPlanCounts {
  /** 自动规则算出的待取消（未被人工保留的部分）。 */
  auto_removals: number;
  /** 人工保留：本次不取消。 */
  manual_keep: number;
  /** 人工指定取消且通过唯一 product_id 安全门，真正进入取消流程。 */
  manual_remove: number;
  /** 人工指定取消但身份仍不唯一 —— 不猜着删，留在异常里。 */
  manual_remove_blocked: number;
  /** 已确认无需操作：不再算作未处理异常，也不发请求。 */
  manual_no_action: number;
  /** 仍未处理的异常。 */
  unresolved_exceptions: number;
}

export interface ResolvedCleanupPlan extends CleanupPlan {
  manual: ManualPlanCounts;
  /** 同一份计划的分账号视图。两个账号彼此独立。 */
  accounts: Record<SyncAccount, AccountPlanCounts>;
}

function resolutionKey(account: SyncAccount, sku: string): string {
  return `${account}|${sku}`;
}

/**
 * 把人工裁决叠加到自动计划上。
 *
 * 两道安全门，人工裁决都绕不过：
 *
 *   1. **published=true 永远保留。** TARGET 里的 SKU 不可能出现在 removals 里 —— 自动计划
 *      按定义就排除了它们，这里再显式拦一次：即便有人给一个已上线商品写了 remove_favorite，
 *      也不会被放进取消流程。
 *   2. **身份必须唯一。** remove_favorite 只是"允许进入取消流程"，不是"可以猜着删"。没有
 *      唯一且反查确认的 website product_id，它仍然留在异常里（manual_remove_blocked）。
 *
 * 账号隔离：裁决按 account|sku 索引，同一个 SKU 在两个账号可以有完全不同的裁决。
 */
export function applyManualResolutions(
  plan: CleanupPlan,
  resolutions: readonly ManualResolutionRecord[],
  target: readonly string[],
  mappingFor: (sku: string) => ProductIdMapping,
): ResolvedCleanupPlan {
  const targetSet = new Set(target);
  const decided = new Map<string, ManualResolution>();
  for (const r of resolutions) decided.set(resolutionKey(r.supplier_account, r.supplier_product_id), r.resolution);

  const removals: Record<SyncAccount, FavoriteSyncItem[]> = { pickup: [], dropship: [] };
  const exceptions: Record<SyncAccount, Array<{ supplier_product_id: string; reason: string }>> = { pickup: [], dropship: [] };
  const counts: ManualPlanCounts = {
    auto_removals: 0, manual_keep: 0, manual_remove: 0,
    manual_remove_blocked: 0, manual_no_action: 0, unresolved_exceptions: 0,
  };
  const blank = (): AccountPlanCounts => ({
    current_favorites: 0, extra: 0, automatic_remove: 0, manual_keep: 0, manual_remove: 0,
    manual_remove_blocked: 0, manual_no_action: 0, unresolved_exception: 0, executable_remove: 0,
  });
  const accounts: Record<SyncAccount, AccountPlanCounts> = { pickup: blank(), dropship: blank() };

  for (const account of ['pickup', 'dropship'] as const) {
    const acct = accounts[account];
    acct.extra = plan.removals[account].length + plan.exceptions[account].length;
    // 自动待取消：人工保留的剔除，其余照常。
    for (const item of plan.removals[account]) {
      const verdict = decided.get(resolutionKey(account, item.supplier_product_id));
      if (verdict === 'keep_favorite') { counts.manual_keep += 1; acct.manual_keep += 1; continue; }
      if (verdict === 'no_action') { counts.manual_no_action += 1; acct.manual_no_action += 1; continue; }
      // 安全门 1：已上线商品永不取消（自动计划本就排除，这里是显式冗余防线）。
      if (targetSet.has(item.supplier_product_id)) { counts.manual_keep += 1; acct.manual_keep += 1; continue; }
      removals[account].push(item);
      counts.auto_removals += 1;
      acct.automatic_remove += 1;
    }

    // 异常：按裁决分流。
    for (const ex of plan.exceptions[account]) {
      const verdict = decided.get(resolutionKey(account, ex.supplier_product_id));
      if (verdict === 'keep_favorite') { counts.manual_keep += 1; acct.manual_keep += 1; continue; }
      if (verdict === 'no_action') { counts.manual_no_action += 1; acct.manual_no_action += 1; continue; }
      if (verdict === 'remove_favorite') {
        // 安全门 1：已上线商品即便被人工点了取消也不执行。
        if (targetSet.has(ex.supplier_product_id)) { counts.manual_keep += 1; acct.manual_keep += 1; continue; }
        // 安全门 2：身份不唯一就不进取消流程，留在异常里。
        const mapping = mappingFor(ex.supplier_product_id);
        if (mapping.status === 'unique' && mapping.product_id !== null && mapping.verified_sku === ex.supplier_product_id) {
          removals[account].push({
            supplier_product_id: ex.supplier_product_id,
            operation: 'remove',
            product_id: mapping.product_id,
            verified_sku: mapping.verified_sku,
          });
          counts.manual_remove += 1;
          acct.manual_remove += 1;
        } else {
          exceptions[account].push({ supplier_product_id: ex.supplier_product_id, reason: ex.reason });
          counts.manual_remove_blocked += 1;
          acct.manual_remove_blocked += 1;
        }
        continue;
      }
      // 未处理：保持异常，不猜、不删。
      exceptions[account].push(ex);
      counts.unresolved_exceptions += 1;
      acct.unresolved_exception += 1;
    }
  }

  for (const account of ['pickup', 'dropship'] as const) {
    accounts[account].executable_remove = removals[account].length;
  }
  return { ...plan, removals, exceptions, manual: counts, accounts };
}

/**
 * 唯一的计划入口。preview（XOne 确认页）与 execute（执行器）都必须调用它 ——
 * 两条路径再也不会各算一套。
 *
 * `mappingFor` 由调用方注入：preview 只查已存的映射表（绝不打门户），execute 允许
 * 现场解析。这个差异只可能把条目从 manual_remove_blocked 移向可执行，绝不会反过来
 * 让 preview 显示得比实际更激进。
 */
export function buildFavoriteCleanupPlan(inputs: {
  target: readonly string[];
  favorites: { pickup: readonly string[]; dropship: readonly string[] };
  resolutions: readonly ManualResolutionRecord[];
  mappingFor: (sku: string) => ProductIdMapping;
}): ResolvedCleanupPlan {
  const auto = planFavoriteCleanup(inputs.target, inputs.favorites, inputs.mappingFor);
  const resolved = applyManualResolutions(auto, inputs.resolutions, inputs.target, inputs.mappingFor);
  resolved.accounts.pickup.current_favorites = inputs.favorites.pickup.length;
  resolved.accounts.dropship.current_favorites = inputs.favorites.dropship.length;
  return resolved;
}

// ── 冻结确认清单（execution manifest / removal allowlist）────────────────────
//
// 2026-09-05 首次生产同步事故的修复核心：确认页展示 11 个动作，执行器实际发送了 25 个。
// 机制是 preview 只用已存储映射、execute 又允许现场解析，把 preview 里 unresolved 的
// 条目在执行时解析成功后追加进了执行集合 —— preview 成了下界而不是上界。
//
// 从此确立的不变量：**EXECUTE_SET ⊆ CONFIRMED_ALLOWLIST**。
//   · 执行时可以变少（published 变化 / 保护变化 / 身份漂移 / 已不在收藏 → SKIP）；
//   · 绝不能变多（UNCONFIRMED → EXECUTED 在结构上不可达）。
//
// 这是第二道独立防线：即使编排层（XOne adapter）出 bug 传来更大的计划，
// 过滤发生在真实发送之前，任何不在 allowlist 的动作都发不出 XHR。

export interface RemovalAllowlistEntry {
  account: SyncAccount;
  supplier_product_id: string;
  /** 确认那一刻已解析的网站身份。执行时身份不一致 → 该条 SKIP，绝不按新身份发送。 */
  product_id: number;
}

export interface RemovalAllowlist {
  schema_version: '1.0';
  /** 编排层对 manifest 的摘要，随文件带下来仅作审计；过滤只认逐条内容。 */
  plan_digest?: string;
  actions: RemovalAllowlistEntry[];
}

/** allowlist 文件的最小结构校验。任何一条不合法 → 整份拒绝，绝不部分放行。 */
export function parseRemovalAllowlist(raw: unknown): RemovalAllowlist {
  if (!raw || typeof raw !== 'object') throw new Error('allowlist 不是对象');
  const a = raw as { schema_version?: unknown; plan_digest?: unknown; actions?: unknown };
  if (a.schema_version !== '1.0') throw new Error('allowlist 协议版本不受支持');
  if (!Array.isArray(a.actions)) throw new Error('allowlist 缺少 actions');
  const actions = a.actions.map((entry, index): RemovalAllowlistEntry => {
    const e = entry as { account?: unknown; supplier_product_id?: unknown; product_id?: unknown };
    const account: SyncAccount | null = e.account === 'pickup' ? 'pickup' : e.account === 'dropship' ? 'dropship' : null;
    if (account === null) throw new Error(`allowlist 第 ${index + 1} 条账号非法`);
    const sku = String(e.supplier_product_id ?? '').trim();
    if (!sku) throw new Error(`allowlist 第 ${index + 1} 条缺少 SKU`);
    if (typeof e.product_id !== 'number' || !Number.isInteger(e.product_id) || e.product_id <= 0) {
      throw new Error(`allowlist 第 ${index + 1} 条 product_id 非法`);
    }
    return { account, supplier_product_id: sku, product_id: e.product_id };
  });
  return {
    schema_version: '1.0',
    plan_digest: typeof a.plan_digest === 'string' ? a.plan_digest : undefined,
    actions,
  };
}

export interface AllowlistGateResult {
  /** removals 已收窄到 allowlist ∩ 当前计划（且 product_id 一致）的同一份计划。 */
  plan: ResolvedCleanupPlan;
  /** 当前计划里有、但不在确认清单里的removal —— 一律丢弃，绝不发送。 */
  off_manifest_dropped: Array<{ account: SyncAccount; supplier_product_id: string }>;
  /** 确认清单里有、但执行时已不再符合条件的动作（published/保护/身份/不在收藏）→ SKIP。 */
  manifest_not_eligible: Array<{ account: SyncAccount; supplier_product_id: string }>;
  /** 身份漂移：SKU 双方都有，但 product_id 已不一致 → SKIP，绝不按新身份发送。 */
  identity_drifted: Array<{ account: SyncAccount; supplier_product_id: string }>;
}

/**
 * 用确认清单收窄执行计划。纯函数。
 *
 * 结果计划满足：removals ⊆ allowlist（逐条含 product_id 一致）。
 * exceptions / manual 计数保持原样 —— 它们本就永不发送，无需重述。
 */
export function applyRemovalAllowlist(
  plan: ResolvedCleanupPlan,
  allowlist: RemovalAllowlist,
): AllowlistGateResult {
  const allowed = new Map<string, number>();
  for (const entry of allowlist.actions) {
    allowed.set(`${entry.account}|${entry.supplier_product_id}`, entry.product_id);
  }
  const removals: Record<SyncAccount, FavoriteSyncItem[]> = { pickup: [], dropship: [] };
  const off_manifest_dropped: AllowlistGateResult['off_manifest_dropped'] = [];
  const identity_drifted: AllowlistGateResult['identity_drifted'] = [];
  const matched = new Set<string>();
  for (const account of ['pickup', 'dropship'] as const) {
    for (const item of plan.removals[account]) {
      const key = `${account}|${item.supplier_product_id}`;
      const confirmedId = allowed.get(key);
      if (confirmedId === undefined) {
        off_manifest_dropped.push({ account, supplier_product_id: item.supplier_product_id });
        continue;
      }
      if (confirmedId !== item.product_id) {
        identity_drifted.push({ account, supplier_product_id: item.supplier_product_id });
        matched.add(key);
        continue;
      }
      matched.add(key);
      removals[account].push(item);
    }
  }
  const manifest_not_eligible = allowlist.actions
    .filter((entry) => !matched.has(`${entry.account}|${entry.supplier_product_id}`))
    .map((entry) => ({ account: entry.account, supplier_product_id: entry.supplier_product_id }));

  // 硬不变量自检：收窄后的每一条 removal 必须能在 allowlist 中逐条找到且身份一致。
  for (const account of ['pickup', 'dropship'] as const) {
    for (const item of removals[account]) {
      if (allowed.get(`${account}|${item.supplier_product_id}`) !== item.product_id) {
        throw new Error(`allowlist 过滤自检失败：${account}/${item.supplier_product_id} 不在确认清单内`);
      }
    }
  }
  return { plan: { ...plan, removals }, off_manifest_dropped, manifest_not_eligible, identity_drifted };
}

// ── 续跑判定 ─────────────────────────────────────────────────────────────────

/**
 * 一条 checkpoint 记录是否真的还需要重跑。
 *
 * 只看 status 是不够的：一条 send_failed 可能是对「早已取消收藏的商品」重复发请求造成的
 * 空操作失败 —— 目标其实已经达成，重跑没有意义。因此必须拿当前事实核对：
 *
 *   1. status 属于可重试失败（send_failed / verification_failed / timeout / global_stop）
 *   2. 且该 SKU 当前仍在对应账号的 Favorites 里
 *   3. 且该 SKU 仍不属于 TARGET（published=true 的商品永远不清理）
 *
 * 三条同时成立才算待续跑。异常（exception，即身份无法唯一确定）永远不算 —— 那要人工处理，
 * 重跑解决不了。
 */
export type ResumableVerdict =
  | 'resumable'
  | 'not_retryable'        // 状态本身不可重试（已验证取消 / 异常 / 跳过 / 计划中）
  | 'no_longer_favourited' // 目标已达成：当前已不在收藏里
  | 'now_published';       // 已上线，属于 TARGET，绝不清理

const RETRYABLE_STATUSES: readonly CleanupItemStatus[] = [
  'send_failed', 'verification_failed', 'timeout', 'global_stop',
];

export function resumableVerdict(
  item: { account: SyncAccount; supplier_product_id: string; status: CleanupItemStatus },
  currentFavorites: Readonly<Record<SyncAccount, ReadonlySet<string>>>,
  target: ReadonlySet<string>,
): ResumableVerdict {
  if (!RETRYABLE_STATUSES.includes(item.status)) return 'not_retryable';
  if (target.has(item.supplier_product_id)) return 'now_published';
  if (!currentFavorites[item.account]?.has(item.supplier_product_id)) return 'no_longer_favourited';
  return 'resumable';
}

/** 真正还需要重跑的条目数。历史 checkpoint 不因此被改写——这只是派生判断。 */
export function countResumable(
  items: readonly { account: SyncAccount; supplier_product_id: string; status: CleanupItemStatus }[],
  currentFavorites: Readonly<Record<SyncAccount, ReadonlySet<string>>>,
  target: ReadonlySet<string>,
): number {
  return items.filter((i) => resumableVerdict(i, currentFavorites, target) === 'resumable').length;
}

// ── 3. Execution ─────────────────────────────────────────────────────────────

export const REMOVAL_ENABLED_ENV = 'SUPPLIER_FAVORITE_REMOVAL_ENABLED';

export interface ExecuteDeps {
  /** A wishlist fetcher bound to ONE account's website session. Never shared across accounts. */
  fetcherFor: (account: SyncAccount) => RemovalFetcher;
  /** Official Favorites read for one account, returning the SKUs still saved. */
  readFavorites: (account: SyncAccount) => Promise<Set<string>>;
  /** Whether an authenticated website session exists for the account. */
  sessionPresent: (account: SyncAccount) => boolean;
  saveCheckpoint: (cp: CleanupCheckpoint) => void;
  /** Live per-item progress, so a long run is observable instead of silent. */
  onProgress?: (line: string, event: CleanupProgressEvent) => void;
  /** Awaited between sends — the rate guard lives here. Tests inject a no-op. */
  pace: () => Promise<void>;
  now: () => string;
  env: Record<string, string | undefined>;
}

export interface ExecuteOptions {
  execute: boolean;
  batchSize: number;
  maxConsecutiveFailures: number;
  runId: string;
  /** Watchdog for one SKU's send. Default 90s. */
  perItemTimeoutMs: number;
  /** Watchdog for one batch's official Favorites re-read. Default 90s. */
  verifyTimeoutMs: number;
  /**
   * 这一轮执行哪个方向。默认 'remove'，删除链的行为一字未变。
   *
   * 'add' 时执行的是 plan.additions（显式名单），不是 plan.removals（TARGET 差集）——
   * 两者永远不会在同一次运行里混着跑。成功语义也随之翻转：删除是「读回来没有了」，
   * 新增是「读回来有了」。
   */
  operation?: WishlistOperation;
}

export interface CleanupRunResult {
  run_id: string;
  dry_run: boolean;
  global_stop: GlobalStopReason;
  planned: number;
  verified_removed: number;
  verification_failed: number;
  send_failed: number;
  timeout: number;
  skipped: number;
  exceptions: number;
  xhr_sends: number;
  items: CleanupItemRecord[];
}

function classifyFatal(message: string, code: number | null): GlobalStopReason {
  if (/CAPTCHA|verify you are human/i.test(message)) return 'captcha_required';
  if (/AUTH_FAILED|login/i.test(message) || code === 401 || code === 403) return 'auth_failed';
  if (/429|rate.?limit|too many/i.test(message) || code === 429) return 'rate_limited';
  return null;
}

/**
 * Run the removals for one plan.
 *
 * Sends are gated twice: the env switch AND `options.execute`. With either missing this is a pure
 * dry run and `fetcherFor` is never invoked — that is the structural guarantee of zero XHR writes.
 */
export async function executeCleanup(
  plan: CleanupPlan,
  mappings: Map<string, ProductIdMapping>,
  deps: ExecuteDeps,
  options: ExecuteOptions,
  checkpoint: CleanupCheckpoint = { run_id: options.runId, items: {} },
): Promise<CleanupRunResult> {
  const gateOpen = deps.env[REMOVAL_ENABLED_ENV] === 'true' && options.execute === true;
  const items: CleanupItemRecord[] = [];
  let xhrSends = 0;
  let globalStop: GlobalStopReason = null;
  let consecutiveFailures = 0;

  const record = (r: CleanupItemRecord) => {
    items.push(r);
    checkpoint.items[checkpointKey(r.account, r.supplier_product_id)] = {
      account: r.account,
      supplier_product_id: r.supplier_product_id,
      product_id: r.product_id,
      status: r.status,
      attempts: r.attempts,
      last_error: r.last_error,
      verified_at: r.verified_at,
    };
  };

  const accounts: SyncAccount[] = ['pickup', 'dropship'];
  for (const account of accounts) {
    if (globalStop) break;
    // add 走显式名单，remove 走 TARGET 差集。两者永不混跑。
    const direction: WishlistOperation = options.operation ?? 'remove';
    const removals = (direction === 'add' ? plan.additions?.[account] : plan.removals[account]) ?? [];
    const doneStatus: CleanupItemStatus = direction === 'add' ? 'verified_added' : 'verified_removed';
    // Exceptions were never executable — surface them and move on.
    for (const ex of plan.exceptions[account] ?? []) {
      record({ account, supplier_product_id: ex.supplier_product_id, product_id: null, status: 'exception', attempts: 0, last_error: ex.reason, verified_at: null });
    }

    for (let start = 0; start < removals.length; start += options.batchSize) {
      if (globalStop) break;
      const batch = removals.slice(start, start + options.batchSize);
      const sentThisBatch: Array<{ sku: string; product_id: number }> = [];

      for (const [indexInBatch, item] of batch.entries()) {
        const position = `[${start + indexInBatch + 1}/${removals.length}]`;
        const ev = (outcome: CleanupProgressEvent['outcome']): CleanupProgressEvent => ({
          phase: direction === 'add' ? 'add' : 'remove', index: start + indexInBatch + 1, total: removals.length,
          account, supplier_product_id: item.supplier_product_id, outcome,
        });
        const key = checkpointKey(account, item.supplier_product_id);
        const prior = checkpoint.items[key];
        if (prior?.status === doneStatus) {
          // 上一轮已经验证到位（删除=已消失／新增=已存在）。永不重发。
          deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} skipped_checkpoint`, ev('skipped_checkpoint'));
          record({ account, supplier_product_id: item.supplier_product_id, product_id: item.product_id, status: 'skipped_checkpoint', attempts: prior.attempts, last_error: null, verified_at: prior.verified_at });
          deps.saveCheckpoint(checkpoint);
          continue;
        }

        deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} resolving...`, ev('started'));

        const mapping = mappings.get(item.supplier_product_id);
        // Belt and braces: a removal must carry a unique, reverse-verified id.
        if (!mapping || mapping.status !== 'unique' || mapping.product_id === null || mapping.verified_sku !== item.supplier_product_id) {
          deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} mapping_exception`, ev('exception'));
          record({ account, supplier_product_id: item.supplier_product_id, product_id: null, status: 'exception', attempts: (prior?.attempts ?? 0), last_error: 'mapping_not_unique', verified_at: null });
          deps.saveCheckpoint(checkpoint);
          continue;
        }

        if (!gateOpen) {
          record({ account, supplier_product_id: item.supplier_product_id, product_id: mapping.product_id, status: 'planned', attempts: 0, last_error: null, verified_at: null });
          continue;
        }

        await deps.pace();
        const attempts = (prior?.attempts ?? 0) + 1;

        // Per-SKU watchdog. Even with every fetch bounded, one stuck item must never hold the run.
        let result: Awaited<ReturnType<typeof executeSyncOperation>> | null = null;
        let timedOut = false;
        try {
          result = await withDeadline(
            executeSyncOperation(
              {
                supplier_product_id: item.supplier_product_id,
                operation: direction,
                product_id: mapping.product_id,
                verified_sku_for_product_id: mapping.verified_sku,
                session_present: deps.sessionPresent(account),
              },
              deps.fetcherFor(account),
              deps.env,
            ),
            options.perItemTimeoutMs,
          );
        } catch (error) {
          timedOut = error instanceof Error && error.message === DEADLINE_EXCEEDED;
          if (!timedOut) {
            // A thrown non-timeout error is still just this item's problem.
            deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} send_failed`, ev('send_failed'));
            consecutiveFailures += 1;
            record({ account, supplier_product_id: item.supplier_product_id, product_id: mapping.product_id, status: 'send_failed', attempts, last_error: error instanceof Error ? error.message : 'send_threw', verified_at: null });
            deps.saveCheckpoint(checkpoint);
            if (consecutiveFailures >= options.maxConsecutiveFailures) { globalStop = 'too_many_failures'; break; }
            continue;
          }
        }

        if (timedOut || !result) {
          // Timeout is an exception for THIS item only — record and move on.
          deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} timeout`, ev('timeout'));
          consecutiveFailures += 1;
          record({ account, supplier_product_id: item.supplier_product_id, product_id: mapping.product_id, status: 'timeout', attempts, last_error: `per-item timeout after ${options.perItemTimeoutMs}ms`, verified_at: null });
          deps.saveCheckpoint(checkpoint);
          if (consecutiveFailures >= options.maxConsecutiveFailures) { globalStop = 'too_many_failures'; break; }
          continue;
        }

        if (result.attempted) xhrSends += 1;

        if (result.succeeded) {
          // Not verified yet — the official read at the end of the batch decides.
          sentThisBatch.push({ sku: item.supplier_product_id, product_id: mapping.product_id });
          consecutiveFailures = 0;
          record({ account, supplier_product_id: item.supplier_product_id, product_id: mapping.product_id, status: 'verification_failed', attempts, last_error: 'pending_verification', verified_at: null });
        } else {
          const fatal = classifyFatal(result.error ?? '', result.response_code);
          if (fatal) {
            deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} GLOBAL STOP: ${fatal}`, ev('global_stop'));
            globalStop = fatal;
            record({ account, supplier_product_id: item.supplier_product_id, product_id: mapping.product_id, status: 'global_stop', attempts, last_error: result.error, verified_at: null });
            deps.saveCheckpoint(checkpoint);
            break;
          }
          deps.onProgress?.(`${position} ${account} ${item.supplier_product_id} send_failed`, ev('send_failed'));
          consecutiveFailures += 1;
          record({ account, supplier_product_id: item.supplier_product_id, product_id: mapping.product_id, status: 'send_failed', attempts, last_error: result.error, verified_at: null });
          if (consecutiveFailures >= options.maxConsecutiveFailures) {
            globalStop = 'too_many_failures';
            break;
          }
        }
        // Checkpoint after EVERY item, so an interruption never loses more than the item in flight.
        deps.saveCheckpoint(checkpoint);
      }

      // Per-batch verification: one official Favorites read, then reconcile every sent SKU.
      if (gateOpen && sentThisBatch.length > 0 && !globalStop) {
        let stillSaved: Set<string> | null = null;
        try {
          // Bounded too — a hung favorites read would otherwise strand the whole batch.
          stillSaved = await withDeadline(deps.readFavorites(account), options.verifyTimeoutMs);
        } catch {
          deps.onProgress?.(`${account} verification read timed out — items stay pending_verification`, { phase: 'verify', index: 0, total: sentThisBatch.length, account, outcome: 'timeout' });
        }
        if (stillSaved) {
          for (const [verifyIndex, sent] of sentThisBatch.entries()) {
            const idx = items.findIndex((r) => r.account === account && r.supplier_product_id === sent.sku && r.status === 'verification_failed');
            const reached = direction === 'add' ? stillSaved.has(sent.sku) : !stillSaved.has(sent.sku);
            const rec = idx >= 0 ? items[idx] : null;
            if (rec) {
              rec.status = reached ? doneStatus : 'verification_failed';
              rec.last_error = reached ? null : (direction === 'add' ? 'not_favorited_after_add' : 'still_favorited_after_removal');
              rec.verified_at = deps.now();
              deps.onProgress?.(`${account} ${sent.sku} ${rec.status}`, {
            phase: 'verify', index: verifyIndex + 1, total: sentThisBatch.length,
            account, supplier_product_id: sent.sku,
            outcome: rec.status === 'verified_removed' ? 'verified_removed' : 'verification_failed',
          });
              checkpoint.items[checkpointKey(account, sent.sku)] = { ...checkpoint.items[checkpointKey(account, sent.sku)], status: rec.status, last_error: rec.last_error, verified_at: rec.verified_at };
            }
          }
        }
      }

      deps.saveCheckpoint(checkpoint);
    }
  }

  return {
    run_id: options.runId,
    dry_run: !gateOpen,
    global_stop: globalStop,
    planned: items.filter((r) => r.status === 'planned').length,
    verified_removed: items.filter((r) => r.status === 'verified_removed').length,
    verification_failed: items.filter((r) => r.status === 'verification_failed').length,
    send_failed: items.filter((r) => r.status === 'send_failed').length,
    timeout: items.filter((r) => r.status === 'timeout').length,
    skipped: items.filter((r) => r.status === 'skipped_checkpoint').length,
    exceptions: items.filter((r) => r.status === 'exception').length,
    xhr_sends: xhrSends,
    items,
  };
}
