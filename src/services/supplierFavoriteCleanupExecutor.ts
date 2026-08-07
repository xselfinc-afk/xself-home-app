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
import { executeSyncOperation, type RemovalFetcher } from './supplierFavoriteRemoval';
import { isStale, isUsableMapping, toUsableMapping, type StoredPortalMapping } from './supplierPortalMapping';
import { type ProductIdMapping } from './supplierFavoriteProductId';

export type CleanupItemStatus =
  | 'skipped_checkpoint'
  | 'planned'          // dry run: would remove
  | 'exception'        // no usable mapping — never sent
  | 'send_failed'      // XHR did not return success
  | 'verified_removed' // gone from official Favorites
  | 'verification_failed' // code 200 but still favourited
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
  phase: 'resolve' | 'remove' | 'verify';
  index: number;
  total: number;
  account?: SyncAccount;
  supplier_product_id?: string;
  outcome:
    | 'started' | 'resolved' | 'exception' | 'timeout' | 'skipped_checkpoint'
    | 'send_failed' | 'verified_removed' | 'verification_failed' | 'global_stop';
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
    const removals = plan.removals[account] ?? [];
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
          phase: 'remove', index: start + indexInBatch + 1, total: removals.length,
          account, supplier_product_id: item.supplier_product_id, outcome,
        });
        const key = checkpointKey(account, item.supplier_product_id);
        const prior = checkpoint.items[key];
        if (prior?.status === 'verified_removed') {
          // Already proven gone on a previous run. Never re-send.
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
                operation: 'remove',
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
            const gone = !stillSaved.has(sent.sku);
            const rec = idx >= 0 ? items[idx] : null;
            if (rec) {
              rec.status = gone ? 'verified_removed' : 'verification_failed';
              rec.last_error = gone ? null : 'still_favorited_after_removal';
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
