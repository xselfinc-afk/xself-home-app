/**
 * xoneProductOnboardingBridge.ts — XOne ↔ 新品首次上架的固定协议桥接。
 *
 * 一条 JSON 请求进 stdin，一条 JSON 响应出 stdout，与既有的两个 bridge 同构。
 *
 * 它是**薄编排**：不含任何导入 / normalize / 定价 / 媒体 / 库存 / 发布逻辑。全部委托给已经
 * 生产验证过的脚本：
 *   候选来源  planGigaNewlySavedCandidates.ts（只读，产出 latest-newly-saved-candidates.json）
 *   准备      syncGigaNewlySavedCandidates.ts --sync → upsertPickupProducts(insertNewOnly)
 *   首次发布  planGigaAutoPublish.ts → runGigaAutoPublish.ts --apply（精确单件 scope）
 *
 * 与库存生命周期是两条独立路径：这里绝不调用 applyInventoryLifecycleActions.ts，
 * 也绝不调用 set_publication_from_availability()。首次上架 ≠ 库存恢复上架。
 *
 * 候选期收藏保护复用 supplier_favorite_exception_resolutions，以 resolved_by 区分来源，
 * 用户手工设置的裁决永不触碰。
 */
import { config as loadEnv } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  deriveOnboardingState,
  canApproveFirstPublish,
  evaluateFirstPublish,
  decideProtection,
  verifyFirstPublishOutcome,
  isHumanApprover,
  ONBOARDING_PROTECTION_ACTOR,
  type OnboardingFacts,
} from '../src/services/productOnboarding';
import { isStale, isUsableMapping, type StoredPortalMapping } from '../src/services/supplierPortalMapping';
import {
  buildRecoveryPlan,
  deriveRecoveryState,
  isResumable,
  stageCompletion,
  STAGE_LABELS,
  type OnboardingProgressFacts,
} from '../src/services/onboardingRecovery';

loadEnv({ path: path.join(__dirname, '..', '.env.local') });

const SCHEMA_VERSION = '1.0';
const LOOP_ID = 'product-onboarding';
const REPO = path.join(__dirname, '..');
const REPORT_DIR = path.join(REPO, 'reports', 'giga-auto-publish');
const CANDIDATES_FILE = path.join(REPORT_DIR, 'latest-newly-saved-candidates.json');
const BASELINE_FILE = path.join(REPORT_DIR, 'saved-items-baseline.json');
const DELTA_FILE = path.join(REPORT_DIR, 'latest-saved-delta.json');
/** 首次上架的审计留痕，与既有报告体系同目录。 */
const ONBOARDING_AUDIT = path.join(REPORT_DIR, 'xone-onboarding-audit.jsonl');
/**
 * 既有 planner 的固定输出路径。Golden Path 自己也写这里，所以我们**读完立刻快照**，
 * 之后一律使用快照 —— 终端那条链随时可能重写它，而 XOne 展示的名单必须和执行的名单
 * 是同一份。快照文件由 XOne 独占。
 */
const AUTOPUB_PLAN_FILE = path.join(REPORT_DIR, 'latest-plan.json');
const XONE_PLAN_SNAPSHOT = path.join(REPORT_DIR, 'xone-onboarding-plan.json');
/** 预览产物。打开面板直接读它，不重跑 pipeline。 */
const XONE_PREVIEW_FILE = path.join(REPORT_DIR, 'xone-onboarding-preview.json');
/** 续跑用的计划快照。与新品那份分开，避免两种意图共用一个文件。 */
const XONE_RECOVERY_PLAN = path.join(REPORT_DIR, 'xone-onboarding-recovery-plan.json');
/** 库存证据扫描的报告目录。窄化运行各自写一份 targeted-*.json。 */
const AVAILABILITY_REPORT_DIR = path.join(REPO, 'reports', 'inventory-availability');
const PAGE_MAX = 50;

export type OnboardingOperation =
  | 'check-new-saved'
  | 'onboarding-recovery-list'
  | 'onboarding-recovery-resume'
  | 'onboarding-preview'
  | 'onboarding-preview-cached'
  | 'onboarding-batch-publish'
  | 'onboarding-candidates'
  | 'prepare-onboarding-candidate'
  | 'approve-first-publish';

export interface OnboardingRequest {
  schema_version: '1.0';
  operation: OnboardingOperation;
  sku?: string;
  approved_by?: string;
  offset?: number;
  limit?: number;
  /** check-new-saved / onboarding-preview 用：是否真的建立候选期收藏保护。默认只出计划。 */
  apply_protection?: boolean;
  /** onboarding-preview 用：是否做 additive 草稿导入（published=false，不是上架）。 */
  import_drafts?: boolean;
  /** onboarding-batch-publish 用：界面看到的 Ready 数量，用来确认计划没被换过。 */
  expected_ready?: number;
  /** onboarding-preview 用：把候选缩到这几个 SKU。为受控验收准备，日常不传。 */
  skus?: string[];
}

export function parseOnboardingRequest(raw: string): OnboardingRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_REQUEST'); }
  const r = parsed as Partial<OnboardingRequest>;
  if (r?.schema_version !== SCHEMA_VERSION) throw new Error('INVALID_REQUEST');
  const ops: OnboardingOperation[] = [
    'check-new-saved', 'onboarding-recovery-list', 'onboarding-recovery-resume',
    'onboarding-preview', 'onboarding-preview-cached', 'onboarding-batch-publish',
    'onboarding-candidates', 'prepare-onboarding-candidate', 'approve-first-publish',
  ];
  if (!r.operation || !ops.includes(r.operation)) throw new Error('INVALID_REQUEST');
  const needsSku = r.operation === 'prepare-onboarding-candidate' || r.operation === 'approve-first-publish';
  if (needsSku && !String(r.sku ?? '').trim()) throw new Error('INVALID_SKU');
  const clamp = (v: unknown, fallback: number, max: number): number => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(n, max);
  };
  return {
    schema_version: SCHEMA_VERSION,
    operation: r.operation,
    sku: String(r.sku ?? '').trim() || undefined,
    approved_by: String(r.approved_by ?? '').trim() || undefined,
    offset: clamp(r.offset, 0, 100_000),
    limit: clamp(r.limit, 20, PAGE_MAX),
    apply_protection: r.apply_protection === true,
    import_drafts: r.import_drafts === true,
    expected_ready: Number.isFinite(Number(r.expected_ready)) ? Math.max(0, Math.floor(Number(r.expected_ready))) : undefined,
    skus: Array.isArray(r.skus)
      ? r.skus.map((x) => String(x).trim()).filter((x) => x.length > 0 && x.length <= 64).slice(0, PAGE_MAX)
      : undefined,
  };
}

function envelope(operation: string, extra: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    operation,
    loop_id: LOOP_ID,
    source_system: 'xself-home-app',
    generated_at: now,
    // 这条链结构上碰不到库存与收藏取消。
    inventory_write_attempted: false,
    favorite_removal_attempted: false,
    error_code: null,
    error_message: null,
    ...extra,
  };
}

function failure(code: string, message: string): Record<string, unknown> {
  return { ...envelope('error', {}), ok: false, error_code: code, error_message: message };
}

/** 既有候选报告里被判定为可以导入的那些 SKU。 */
function readCandidateSkus(): Array<{ sku: string; title: string | null; classification: string }> {
  if (!fs.existsSync(CANDIDATES_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(CANDIDATES_FILE, 'utf8')) as {
      candidates?: Array<{ sku?: string; title?: string; classification?: string }>;
      items?: Array<{ sku?: string; title?: string; classification?: string }>;
    };
    const rows = parsed.candidates ?? parsed.items ?? [];
    return rows
      .map((r) => ({ sku: String(r.sku ?? '').trim(), title: r.title ?? null, classification: String(r.classification ?? '') }))
      .filter((r) => r.sku.length > 0);
  } catch {
    return [];
  }
}

/** 一次性读齐判定需要的全部事实。全部来自数据库，不接受前端传入。 */
async function loadFacts(client: SupabaseClient, sku: string, pickupSaved: Set<string>): Promise<OnboardingFacts> {
  const [supplierRes, stdRes, sellRes, mapRes] = await Promise.all([
    client.from('supplier_products').select('supplier_product_id,published').eq('supplier_product_id', sku).maybeSingle(),
    client.from('standardized_products')
      .select('supplier_product_id,published,product_title,primary_image,selling_price,inventory_status,total_available_qty,product_type_id')
      .eq('supplier_product_id', sku).maybeSingle(),
    client.from('sellable_products').select('supplier_product_id').eq('supplier_product_id', sku).maybeSingle(),
    client.from('supplier_portal_product_mappings')
      .select('supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at')
      .eq('supplier_product_id', sku).maybeSingle(),
  ]);
  const std = (stdRes.data ?? null) as {
    published?: boolean | null; product_title?: string | null; primary_image?: string | null;
    selling_price?: number | null; inventory_status?: string | null; total_available_qty?: number | null;
    product_type_id?: string | null;
  } | null;
  const mapping = (mapRes.data ?? null) as StoredPortalMapping | null;
  const now = new Date().toISOString();

  return {
    supplier_product_id: sku,
    in_pickup_favorites: pickupSaved.has(sku),
    in_supplier_products: Boolean(supplierRes.data),
    in_standardized_products: Boolean(std),
    // 尚未导入时 published 视为 false（还是草稿阶段），而不是 null。
    published: std ? (std.published ?? null) : (supplierRes.data ? false : false),
    in_sellable_products: Boolean(sellRes.data),
    has_unique_identity: isUsableMapping(mapping) && !isStale(mapping!, now),
    product_title: std?.product_title ?? null,
    primary_image: std?.primary_image ?? null,
    selling_price: std?.selling_price == null ? null : Number(std.selling_price),
    // 既有 taxonomy 判定：product_type_id 为 NEEDS_REVIEW 时需要人工确认。
    taxonomy_needs_review: (std?.product_type_id ?? '').toUpperCase() === 'NEEDS_REVIEW',
    stock_available: std
      ? (std.inventory_status === 'in_stock' && Number(std.total_available_qty ?? 0) > 0 ? true
        : std.inventory_status ? false : null)
      : null,
  };
}

/**
 * 当前 Pickup 收藏 —— 优先用最近一次「检查新收藏」抓到的实时快照。
 *
 * `supplier_favorite_memberships` 是收藏清理链的事实表，只有跑过 favorites:sync 才会更新。
 * 拿它判断「这件新品还在不在收藏里」会漏掉刚收藏、尚未同步过的商品：用户在 Pickup 收藏了
 * W5870P523986/7/8 之后待上新仍然看不到它们，一半原因就在这里。delta 报告本身就是一次实时
 * 抓取，newly ∪ unchanged 正是抓取时刻的完整收藏集合。
 */
export function extractSavedSkusFromDelta(delta: unknown): { skus: Set<string>; capturedAt: string | null } | null {
  const report = delta as {
    timestamp?: string;
    newly_saved_skus?: unknown[];
    unchanged_saved_skus?: unknown[];
  } | null;
  const newly = report?.newly_saved_skus ?? [];
  const unchanged = report?.unchanged_saved_skus ?? [];
  if (!Array.isArray(newly) || !Array.isArray(unchanged)) return null;
  // 两个列表的元素形状不一样：newly 带标题（{sku, title}），unchanged 是裸字符串。
  // 只认 SKU，两种都接受 —— 把对象直接塞进 Set 会得到一个永远命中不了的集合，
  // 三件新收藏的商品就是这样从候选里消失的。
  const skus = new Set<string>();
  for (const entry of [...newly, ...unchanged]) {
    const sku = typeof entry === 'string'
      ? entry
      : String((entry as { sku?: unknown })?.sku ?? '');
    if (sku.trim()) skus.add(sku.trim());
  }
  return skus.size > 0 ? { skus, capturedAt: report?.timestamp ?? null } : null;
}

function readLiveSavedSnapshot(): { skus: Set<string>; capturedAt: string | null } | null {
  if (!fs.existsSync(DELTA_FILE)) return null;
  try {
    return extractSavedSkusFromDelta(JSON.parse(fs.readFileSync(DELTA_FILE, 'utf8')));
  } catch {
    return null;
  }
}

/** 读 Pickup 收藏事实。有实时快照就用快照，否则退回已同步的 memberships。 */
async function loadPickupSaved(client: SupabaseClient): Promise<Set<string>> {
  const live = readLiveSavedSnapshot();
  if (live) return live.skus;
  const out = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from('supplier_favorite_memberships')
      .select('supplier_product_id,supplier_account,is_saved,sync_status')
      .eq('supplier_account', 'pickup').range(from, from + 999);
    if (error) break;
    for (const row of (data ?? []) as Array<{ supplier_product_id: string; is_saved: boolean | null; sync_status: string }>) {
      if (row.sync_status === 'ok' && row.is_saved === true) out.add(row.supplier_product_id);
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 按 decideProtection 的裁决维护候选期收藏保护。用户手工设置的记录永不触碰。 */
async function syncProtection(client: SupabaseClient, sku: string, needsProtection: boolean): Promise<string> {
  const { data } = await client.from('supplier_favorite_exception_resolutions')
    .select('resolution,resolved_by').eq('supplier_product_id', sku).eq('supplier_account', 'pickup').maybeSingle();
  const existing = (data ?? null) as { resolution: string; resolved_by: string } | null;
  const action = decideProtection({ needs_protection: needsProtection, existing });
  const now = new Date().toISOString();

  if (action === 'create_protection') {
    await client.from('supplier_favorite_exception_resolutions').upsert({
      supplier_product_id: sku,
      supplier_account: 'pickup',
      resolution: 'keep_favorite',
      resolved_at: now,
      resolved_by: ONBOARDING_PROTECTION_ACTOR,
      note: '待上新候选期间自动保护，首次上架成功后自动释放',
      updated_at: now,
    }, { onConflict: 'supplier_product_id,supplier_account' });
  } else if (action === 'release_protection') {
    // 只删我们自己署名的那条。
    await client.from('supplier_favorite_exception_resolutions').delete()
      .eq('supplier_product_id', sku).eq('supplier_account', 'pickup')
      .eq('resolved_by', ONBOARDING_PROTECTION_ACTOR);
  }
  return action;
}

/** 追加一条首次上架审计。App 重启后仍可查。 */
function appendAudit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.appendFileSync(ONBOARDING_AUDIT, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`);
  } catch { /* 审计写失败不该阻断主流程，但也不假装成功 */ }
}

/**
 * 收藏列表接口是账号维度的，只有 alt 账号读得到；默认账号会被 GIGA 直接拒绝。
 *
 * dotenv 从不覆盖已存在的变量。这个桥接在模块加载时读过 `.env.local`，于是默认账号的
 * SUPPLIER_* 已经在 process.env 里；子进程继承之后，`.env.giga-alt.local` 再也盖不上去，
 * 收藏读取必然失败。把这几个键从子进程环境里摘掉，让脚本自己按既定顺序加载。
 *
 * 只删键名，不读取也不打印任何凭据值。
 */
const SUPPLIER_CRED_KEYS = ['SUPPLIER_CLIENT_ID', 'SUPPLIER_CLIENT_SECRET', 'SUPPLIER_API_BASE_URL'];

/**
 * 给子进程一条能找到 node 工具链的 PATH。
 *
 * 这是 2026-08-08 首次真实批量上架 3/3 失败的根因。既有的 runGigaAutoPublish 用裸
 * `npx tsx <script>` 起每一个阶段脚本 —— 在终端里 PATH 含 nvm / homebrew 所以没问题；
 * 而 XOne 是 GUI 启动的 .app，PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，`npx` 直接
 * ENOENT。spawnSync 于是返回 status=null、stdout/stderr 全空，runner 只判 `status !== 0`，
 * 报成 `normalize: script_exit_nonzero`。
 *
 * 修在这一层而不是 runner：runner 是 Golden Path，终端那条链靠它保底，一个字都不能动。
 * 仓库里已有同样的先例 —— runAvailabilityScan.sh 也是显式 export PATH 解决的。
 *
 * 取值优先用当前进程自己的 node 所在目录（process.execPath），这样 nvm 换版本也不会失效，
 * 再补上 homebrew 与系统标准目录。
 */
export function toolchainPath(execPath: string, currentPath: string | undefined): string {
  const nodeBin = path.dirname(execPath);
  const wanted = [nodeBin, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const existing = (currentPath ?? '').split(':').filter(Boolean);
  const seen = new Set<string>();
  return [...wanted, ...existing].filter((dir) => {
    if (!dir || seen.has(dir)) return false;
    seen.add(dir);
    return true;
  }).join(':');
}

/**
 * 起子进程之前先确认工具链真的可用。
 *
 * 上一次失败之所以代价大，是因为 runGigaAutoPublish 的 Stage 1 先把
 * supplier_products.published 翻成 true，Stage 2 才因为找不到 npx 死掉 —— 留下三件
 * 「批准位已翻、什么都没生成」的半成品。先探一次，探不到就根本不启动执行器。
 */
export function preflightToolchain(env: NodeJS.ProcessEnv): { ok: boolean; reason: string | null } {
  const probe = spawnSync('npx', ['--version'], { env, encoding: 'utf8', timeout: 60_000 });
  if (probe.status === 0) return { ok: true, reason: null };
  return {
    ok: false,
    reason: probe.status === null
      ? '运行环境里找不到 node 工具链（npx），上架流水线无法启动'
      : `node 工具链自检失败（npx --version 退出码 ${probe.status}）`,
  };
}

/**
 * 供应商账号自检。
 *
 * 库存阶段（runGigaAutoPublish Stage 7）要求 SUPPLIER_API_BASE_URL 指向 openapi.gigab2b.com
 * —— 只有 alt 账号的那个是。这里按**脚本自己那套级联**（alt → local → env）解析一遍，
 * 确认库存阶段真的能拿到可用账号，再决定要不要启动执行器。
 *
 * 只判断键是否存在、base 是否匹配，绝不读取或打印任何凭据值。
 */
/**
 * 按 Golden Path 的级联解析出应该使用的供应商账号。
 *
 * 顺序与每个脚本自己写的一模一样：.env.giga-alt.local → .env.local → .env，先到先得
 * （dotenv 从不覆盖已存在的值）。库存相关接口只有 alt 账号能用，所以 alt 必须排第一。
 *
 * 返回值里带着凭据，**只允许交给子进程，不得写日志、不得放进任何响应**。
 */
function resolveSupplierAccount(repo: string): {
  values: Record<string, string>;
  source: string | null;
  missing: string[];
} {
  const cascade = ['.env.giga-alt.local', '.env.local', '.env'];
  const resolved: Record<string, { value: string; source: string }> = {};
  for (const file of cascade) {
    const full = path.join(repo, file);
    if (!fs.existsSync(full)) continue;
    let parsed: Record<string, string>;
    // 用 dotenv 自己的 parser，保持与脚本完全一致的解析行为。
    try { parsed = require('dotenv').parse(fs.readFileSync(full)) as Record<string, string>; } catch { continue; }
    for (const key of SUPPLIER_CRED_KEYS) {
      if (parsed[key] && !resolved[key]) resolved[key] = { value: parsed[key], source: file };
    }
  }
  const values: Record<string, string> = {};
  for (const key of SUPPLIER_CRED_KEYS) if (resolved[key]) values[key] = resolved[key].value;
  return {
    values,
    source: resolved.SUPPLIER_API_BASE_URL?.source ?? null,
    missing: SUPPLIER_CRED_KEYS.filter((key) => !resolved[key]),
  };
}

export function preflightSupplierAccount(repo: string): { ok: boolean; source: string | null; reason: string | null } {
  const account = resolveSupplierAccount(repo);
  if (account.missing.length) {
    return { ok: false, source: null, reason: `供应商账号配置缺失：${account.missing.join('、')}` };
  }
  if (!/openapi\.gigab2b\.com/.test(account.values.SUPPLIER_API_BASE_URL)) {
    return {
      ok: false,
      source: account.source,
      reason: `库存阶段需要开放平台账号，当前解析到的接口地址来自 ${account.source}，不是开放平台域名`,
    };
  }
  return { ok: true, source: account.source, reason: null };
}

/**
 * 子进程环境。
 *
 * 两条不变量，都是被真实故障教出来的：
 *
 * 1. PATH 必须含 node 工具链 —— 见 toolchainPath。
 *
 * 2. **绝不把 SUPPLIER_* 传给子进程。** 每个 Golden Path 脚本自己都有正确的账号级联
 *    （.env.giga-alt.local → .env.local → .env，alt 优先），而 dotenv 从不覆盖已存在的
 *    变量。这个桥接在模块加载时读过 .env.local，默认账号的 SUPPLIER_* 因此已经在
 *    process.env 里；子进程继承之后，脚本自己的 alt 文件再也盖不上去。
 *
 *    2026-08-08 的 no_giga_creds 就是这么来的：runGigaAutoPublish 拿到的是默认账号的
 *    SUPPLIER_API_BASE_URL，而它的 gigaReady() 要求 base 匹配 openapi.gigab2b.com ——
 *    只有 alt 账号的那个匹配。于是库存阶段判定「没有凭据」。
 *
 *    所以这里默认摘除，让每个脚本按自己既定的顺序决定用哪个账号。需要显式传账号的场景
 *    才 opt-out（目前没有）。只删键名，不读取也不打印任何凭据值。
 */
const SUPPLIER_CRED_KEYS_DOC = SUPPLIER_CRED_KEYS;

function childEnv(
  extraEnv: Record<string, string>,
  options: { passSupplierAccountThrough?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  env.PATH = toolchainPath(process.execPath, process.env.PATH);
  if (!options.passSupplierAccountThrough) {
    // 按级联解析出正确账号并**显式注入**。
    //
    // 上一版是「删掉这三个键，让脚本自己去 dotenv」——对有级联的脚本没问题，但
    // scanPublishedAvailability.ts 根本不加载 dotenv：Golden Path 是靠
    // `npx dotenv -e .env.giga-alt.local -e .env.local -- …` 从外部注入的。删了键它就拿到
    // undefined，gigaApiClient 拼出 `undefined/b2b-overseas-api/...`，fetch 报
    // "Failed to parse URL"，三件全部 malformed_response，一行证据都没写下。
    //
    // 注入解析值对两类脚本都正确：有级联的脚本本来也会解析出同一组值（dotenv 不覆盖已存在
    // 的值，而这些值正是它的级联结果）；没有级联的脚本则只有这一条路。
    const account = resolveSupplierAccount(REPO);
    for (const key of SUPPLIER_CRED_KEYS_DOC) {
      if (account.values[key]) env[key] = account.values[key];
      else delete env[key];
    }
  }
  return env;
}

function runScript(
  relative: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
  options: { passSupplierAccountThrough?: boolean } = {},
) {
  const runtime = path.join(REPO, 'node_modules', '.bin', 'tsx');
  return spawnSync('/opt/homebrew/bin/node', [runtime, path.join(REPO, relative), ...args], {
    cwd: REPO, encoding: 'utf8', timeout: timeoutMs, env: childEnv(extraEnv, options),
  });
}

/** 后台执行时逐步汇报进度。XOne 读这些行画进度条。 */
function progress(step: string, detail: string): void {
  console.log(`ONBOARDING_PROGRESS ${JSON.stringify({ step, detail, at: new Date().toISOString() })}`);
}

/**
 * 「检查新收藏」：把 Pickup 收藏的实时状态一路刷到待上新候选。
 *
 * 完全走既有链条，不重写 diff：
 *   giga-saved-baseline.ts（仅当基线不存在）
 *     → giga-saved-delta.ts        实时抓取 + 与基线比对，产出 newly_saved_skus
 *     → planGigaNewlySavedCandidates.ts  给这些 SKU 做分类与资料校验
 *
 * 基线**不会**被推进。基线是「开始做新品上架之前我们已有什么」的标记，推进它会让还没上架的
 * 候选凭空消失。delta 每次都重新实时抓取，所以取消收藏的商品会自动从候选里退出。
 *
 * 这一步不导入商品、不发布、不改收藏、不跑 48h 库存扫描。
 */
async function runCheckNewSaved(
  request: OnboardingRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  const record = (step: string, ok: boolean, detail: string) => {
    steps.push({ step, ok, detail });
    progress(step, detail);
  };

  if (!fs.existsSync(BASELINE_FILE)) {
    progress('baseline', '首次运行，正在建立收藏基线');
    const res = runScript('scripts/giga-saved-baseline.ts', [], 300_000);
    if (res.status !== 0) {
      record('baseline', false, '收藏基线建立失败');
      return failure('BASELINE_FAILED', '无法建立收藏基线，请稍后重试');
    }
    record('baseline', true, '收藏基线已建立');
  } else {
    record('baseline', true, '沿用既有收藏基线');
  }

  progress('delta', '正在读取 Pickup 当前收藏');
  const delta = runScript('scripts/giga-saved-delta.ts', [], 300_000);
  if (delta.status !== 0) {
    record('delta', false, '读取 Pickup 收藏失败');
    return failure('SAVED_FETCH_FAILED', '读取 Pickup 收藏失败，请确认供应商账号可用后重试');
  }
  const live = readLiveSavedSnapshot();
  record('delta', true, `当前收藏 ${live?.skus.size ?? 0} 件`);

  progress('candidates', '正在筛选新品候选');
  const plan = runScript('scripts/planGigaNewlySavedCandidates.ts', [], 600_000);
  if (plan.status !== 0) {
    record('candidates', false, '新品候选筛选失败');
    return failure('CANDIDATE_PLAN_FAILED', '新品候选筛选失败，请稍后重试');
  }

  // 只有真正成立的候选才算数：仍在收藏里、尚未发布。
  const pickupSaved = live?.skus ?? await loadPickupSaved(client);
  const reported = readCandidateSkus();
  const candidates: Array<{ sku: string; state: string }> = [];
  for (const candidate of reported) {
    const facts = await loadFacts(client, candidate.sku, pickupSaved);
    if (facts.published === true || !facts.in_pickup_favorites) continue;
    candidates.push({ sku: candidate.sku, state: deriveOnboardingState(facts) });
  }
  record('candidates', true, `待上新候选 ${candidates.length} 件`);

  // 候选期收藏保护绑定在「候选正式成立」这一刻，而不是所有 Pickup 收藏。
  const protectionPlan = candidates.map((c) => c.sku);
  const protectionApplied: Array<{ sku: string; action: string }> = [];
  if (request.apply_protection) {
    progress('protection', '正在为候选建立收藏保护');
    for (const sku of protectionPlan) {
      protectionApplied.push({ sku, action: await syncProtection(client, sku, true) });
    }
    record('protection', true, `已处理 ${protectionApplied.length} 件候选的收藏保护`);
  } else {
    record('protection', true, `${protectionPlan.length} 件候选需要收藏保护（本次只出计划）`);
  }

  return envelope('check-new-saved', {
    production_write_attempted: Boolean(request.apply_protection) && protectionApplied.some((p) => p.action !== 'noop' && p.action !== 'keep_manual'),
    steps,
    saved_captured_at: live?.capturedAt ?? null,
    saved_count: live?.skus.size ?? 0,
    newly_saved_count: reported.length,
    candidate_count: candidates.length,
    ready_count: candidates.filter((c) => c.state === 'ready_to_publish').length,
    candidate_skus: candidates.map((c) => c.sku),
    protection_planned: protectionPlan,
    protection_applied: protectionApplied,
  });
}

// ── 最终上架预览 ─────────────────────────────────────────────────────────────
//
// 目标是让人在点「批量上架」之前，看到的就是商品在 App 里会长的样子。做法是**只调既有能力**：
//
//   normalizeProduct()        纯函数，零 IO —— 最终标题 / Xself SKU / 分类 / 主图 / 图片数 / 规格
//   generateReviewSet()       纯函数，确定性 —— 冷启动评价 5 条（5,5,5,4,4 → 4.6★）
//   planGigaAutoPublish CLI   原样 spawn —— Ready 名单（proposed_batch）与 hold 原因
//
// 这里不生成任何商品数据，只是把既有产出摆出来。
//
// 一个必须说清的边界：**最终售价无法在上架前精确预览**。定价引擎（dynamic-pricing）读的是
// standardized_products，而那一行由 runGigaAutoPublish 的 Stage 2 normalize 写入，
// normalizeProducts.ts 又硬过滤 published=true。也就是说售价天然产生在发布之后。预览因此只给
// 成本与锚定价，并明确标注售价将在上架时生成 —— 绝不自己算一个价冒充最终价。

interface PreviewRow {
  supplier_product_id: string;
  ready: boolean;
  bucket: string;
  blocked_reason: string | null;
  title: string;
  sku_custom: string;
  category: string;
  primary_image: string | null;
  image_count: number;
  spec_summary: string[];
  cost: number | null;
  anchor_price: number | null;
  selling_price: number | null;
  selling_price_pending: boolean;
  stock_available: boolean | null;
  stock_qty: number | null;
  /** 冷启动评价是系统生成的，不是顾客写的。UI 必须照这个字段如实措辞。 */
  review_kind: 'generated' | 'customer';
  review_count: number;
  review_avg: number;
}

/** SAFE_* 是 planner 认定可以安全上架的桶；其余一律进「需要处理」。 */
function isReadyBucket(bucket: string): boolean {
  return bucket.startsWith('SAFE');
}

/** planner 的 hold 原因翻成运营看得懂的话。词汇来自既有 plan 报告，未新增判定。 */
const HOLD_REASON_LABELS: Record<string, string> = {
  cfgmissing_fragmented: '同系列商品配置不完整，需要人工确认',
  no_config_axis_standalone: '无法确定规格轴，需要人工确认',
  no_current_stock: '当前无库存',
  missing_image: '缺少主图',
  missing_price: '缺少成本价',
};

const BUCKET_LABELS: Record<string, string> = {
  HOLD_PHASE2: '商品配置需要人工确认',
  HOLD_PRICE: '价格数据不完整',
  HOLD_INVENTORY: '当前无库存',
  HOLD_QUALITY: '商品资料质量不达标',
  REJECT: '不符合上架条件',
};

function describeHold(bucket: string, reasons: string[]): string {
  const detail = reasons.map((r) => HOLD_REASON_LABELS[r] ?? r).filter(Boolean);
  if (detail.length) return detail.join('；');
  return BUCKET_LABELS[bucket] ?? '暂时无法上架';
}

/**
 * 把一份既有 plan 报告 + supplier 行，合成运营能看懂的预览。
 *
 * 纯计算，不写库。`plan` 是刚刚由既有 planner 产出的快照。
 */
export function buildPreviewRows(input: {
  plan: Record<string, any> | null;
  supplierRows: Array<Record<string, any>>;
  normalize: (row: Record<string, any>) => Record<string, any>;
  reviewCount: (product: Record<string, any>) => { count: number; avg: number };
}): PreviewRow[] {
  const proposed = new Set<string>(((input.plan?.proposed_batch?.skus ?? []) as unknown[]).map((s) => String(s)));
  const byId = new Map<string, Record<string, any>>();
  for (const c of (input.plan?.candidates ?? []) as Array<Record<string, any>>) {
    const id = String(c?.id ?? c?.sku ?? '').trim();
    if (id) byId.set(id, c);
  }

  const rows: PreviewRow[] = [];
  for (const supplierRow of input.supplierRows) {
    const id = String(supplierRow.supplier_product_id ?? '');
    if (!id) continue;
    let normalized: Record<string, any> = {};
    try { normalized = input.normalize({ ...supplierRow, id: supplierRow.id ?? id }); } catch { normalized = {}; }

    const candidate = byId.get(id) ?? null;
    const bucket = String(candidate?.bucket ?? (proposed.has(id) ? 'SAFE_SINGLETON' : 'UNKNOWN'));
    const ready = proposed.has(id);
    const reasons = Array.isArray(candidate?.reasons) ? candidate!.reasons.map(String) : [];
    const gallery = Array.isArray(normalized.gallery_images_json) ? normalized.gallery_images_json : [];
    const primary = typeof normalized.primary_image === 'string' && normalized.primary_image ? normalized.primary_image : null;
    const specs = normalized.specifications_json && typeof normalized.specifications_json === 'object'
      ? Object.entries(normalized.specifications_json as Record<string, string>)
        .slice(0, 3).map(([k, v]) => `${k}: ${v}`)
      : [];
    const review = input.reviewCount({
      supplier_product_id: id,
      product_title_display: normalized.product_title_display,
      category_code: normalized.category_code,
      key_features_json: normalized.key_features_json,
      short_description: normalized.short_description,
      material: normalized.material,
      dimensions: normalized.dimensions,
      color: normalized.color,
      specifications_json: normalized.specifications_json,
    });

    rows.push({
      supplier_product_id: id,
      ready,
      bucket,
      blocked_reason: ready ? null : describeHold(bucket, reasons),
      title: String(normalized.product_title_display ?? normalized.product_title ?? supplierRow.title ?? '未命名商品'),
      sku_custom: String(normalized.sku_custom ?? ''),
      category: String(normalized.category_label ?? normalized.category_code ?? ''),
      primary_image: primary,
      image_count: (primary ? 1 : 0) + gallery.length,
      spec_summary: specs,
      cost: typeof normalized.price === 'number' ? normalized.price : null,
      anchor_price: typeof normalized.original_price === 'number' ? normalized.original_price : null,
      // 售价由发布阶段的定价引擎生成，预览阶段给不出精确值 —— 绝不自己编一个。
      selling_price: null,
      selling_price_pending: true,
      stock_available: null,
      stock_qty: null,
      review_kind: 'generated',
      review_count: review.count,
      review_avg: review.avg,
    });
  }
  return rows;
}

/** 读一批 supplier_products 原始行 —— normalizeProduct 的输入。 */
async function readSupplierRows(client: SupabaseClient, skus: string[]): Promise<Array<Record<string, any>>> {
  if (!skus.length) return [];
  const out: Array<Record<string, any>> = [];
  for (let i = 0; i < skus.length; i += 200) {
    const { data, error } = await client.from('supplier_products')
      .select('id,supplier_product_id,title,images,price,description,raw_payload,published')
      .in('supplier_product_id', skus.slice(i, i + 200));
    if (error) throw new Error(`READ_FAILED:supplier_products:${error.message}`);
    out.push(...((data ?? []) as Array<Record<string, any>>));
  }
  return out;
}

/** 库存事实取自既有 inventory_cache，不另做探测。 */
async function readStock(client: SupabaseClient, skus: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!skus.length) return map;
  for (let i = 0; i < skus.length; i += 200) {
    const { data, error } = await client.from('inventory_cache')
      .select('supplier_product_id,total_available_qty')
      .in('supplier_product_id', skus.slice(i, i + 200));
    if (error) break;
    for (const row of (data ?? []) as Array<{ supplier_product_id: string; total_available_qty: number | null }>) {
      map.set(row.supplier_product_id, Number(row.total_available_qty ?? 0));
    }
  }
  return map;
}

/**
 * 生成最终上架预览。
 *
 * 步骤全部委托既有能力；这里只负责编排与摆放：
 *   1. 取当前 Pickup 收藏里、尚未发布的候选
 *   2. （可选）additive 草稿导入 —— insertNewOnly，published 取 DB 默认 false，幂等
 *   3. 原样 spawn planGigaAutoPublish --only=… —— Ready 名单只有这一个来源
 *   4. 立刻把 latest-plan.json 快照成 XOne 独占文件（终端那条链随时会重写它）
 *   5. normalizeProduct + generateReviewSet 在内存里算出最终成品字段
 *
 * 不发布、不写 standardized_products、不碰 sellable。
 */
async function runOnboardingPreview(
  request: OnboardingRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const { normalizeProduct } = await import('../src/services/normalizationPipeline');
  const { generateReviewSet } = await import('../src/services/reviewGenerator');

  const live = readLiveSavedSnapshot();
  const pickupSaved = live?.skus ?? await loadPickupSaved(client);
  const reported = readCandidateSkus();

  // 仍在 Pickup 收藏、且尚未发布的，才是候选。
  // 受控验收时可以把候选缩到指定几个；日常不传，走全量候选。
  const scope = request.skus && request.skus.length ? new Set(request.skus) : null;
  const candidateSkus: string[] = [];
  for (const candidate of reported) {
    if (scope && !scope.has(candidate.sku)) continue;
    if (!pickupSaved.has(candidate.sku)) continue;
    const facts = await loadFacts(client, candidate.sku, pickupSaved);
    if (facts.published === true) continue;
    candidateSkus.push(candidate.sku);
  }
  if (!candidateSkus.length) {
    return envelope('onboarding-preview', {
      production_write_attempted: false,
      saved_captured_at: live?.capturedAt ?? null,
      discovered: 0, ready_count: 0, blocked_count: 0, rows: [],
    });
  }

  // 2. 草稿导入：只 insert 未存在的行，published 取 DB 默认 false。不是上架。
  let importedDrafts = false;
  if (request.import_drafts) {
    progress('import', `正在导入 ${candidateSkus.length} 件商品草稿`);
    const sync = runScript(
      'scripts/syncGigaNewlySavedCandidates.ts',
      ['--sync', `--only=${candidateSkus.join(',')}`, '--summary'],
      900_000,
    );
    if (sync.status !== 0) return failure('DRAFT_IMPORT_FAILED', '商品草稿导入失败，请稍后重试');
    importedDrafts = true;
  }

  // 3. Ready 名单的唯一来源：既有 planner。CLI 原样调用，一个参数都没改。
  progress('plan', '正在生成上架计划');
  const plan = runScript(
    'scripts/planGigaAutoPublish.ts',
    [`--only=${candidateSkus.join(',')}`, `--max-skus=${Math.max(1, candidateSkus.length)}`, '--summary'],
    900_000,
  );
  if (plan.status !== 0) return failure('PLAN_FAILED', '上架计划生成失败，请稍后重试');

  // 4. 立刻快照。之后展示与执行都只认这一份。
  let planJson: Record<string, any> | null = null;
  try {
    const raw = fs.readFileSync(AUTOPUB_PLAN_FILE, 'utf8');
    fs.writeFileSync(XONE_PLAN_SNAPSHOT, raw);
    planJson = JSON.parse(raw);
  } catch {
    return failure('PLAN_UNREADABLE', '上架计划无法读取，请稍后重试');
  }

  // 5. 合成预览。
  progress('preview', '正在生成上架预览');
  const supplierRows = await readSupplierRows(client, candidateSkus);
  const rows = buildPreviewRows({
    plan: planJson,
    supplierRows,
    normalize: (row) => normalizeProduct(row as never) as unknown as Record<string, any>,
    reviewCount: (product) => {
      const set = generateReviewSet(product as never);
      const avg = set.length ? set.reduce((s, r) => s + (r.rating ?? 0), 0) / set.length : 0;
      return { count: set.length, avg: Math.round(avg * 10) / 10 };
    },
  });
  const stock = await readStock(client, candidateSkus);
  for (const row of rows) {
    const qty = stock.get(row.supplier_product_id);
    if (qty !== undefined) { row.stock_qty = qty; row.stock_available = qty > 0; }
  }

  // 候选期收藏保护：正式成立即自动生效，不作为用户步骤暴露。
  const protectionApplied: Array<{ sku: string; action: string }> = [];
  if (request.apply_protection) {
    for (const row of rows) protectionApplied.push({ sku: row.supplier_product_id, action: await syncProtection(client, row.supplier_product_id, true) });
  }

  const readyRows = rows.filter((r) => r.ready);
  const payload = envelope('onboarding-preview', {
    // 草稿导入是唯一会写库的一步，且只写 supplier_products（published=false）。
    production_write_attempted: importedDrafts,
    imported_drafts: importedDrafts,
    saved_captured_at: live?.capturedAt ?? null,
    plan_snapshot: path.relative(REPO, XONE_PLAN_SNAPSHOT),
    generated_at_ms: null,
    discovered: rows.length,
    ready_count: readyRows.length,
    blocked_count: rows.length - readyRows.length,
    ready_skus: readyRows.map((r) => r.supplier_product_id),
    rows,
    protection_applied: protectionApplied,
  });
  try { fs.writeFileSync(XONE_PREVIEW_FILE, JSON.stringify(payload, null, 2)); } catch { /* 缓存写失败不影响本次返回 */ }
  return payload;
}

/** 直接返回上次的预览产物。打开面板走这条路，不跑任何 pipeline。 */
function readCachedPreview(): Record<string, unknown> {
  try {
    const cached = JSON.parse(fs.readFileSync(XONE_PREVIEW_FILE, 'utf8')) as Record<string, unknown>;
    return { ...cached, from_cache: true };
  } catch {
    return envelope('onboarding-preview', {
      production_write_attempted: false,
      from_cache: true, discovered: 0, ready_count: 0, blocked_count: 0, rows: [], never_previewed: true,
    });
  }
}

/**
 * 批量上架。
 *
 * 执行的是**快照里的 proposed_batch**，与界面展示的 Ready 名单是同一份文件 —— UI 与执行器
 * 不可能是两套名单。runGigaAutoPublish 只吃 plan.proposed_batch，且拒绝非 SAFE 桶，所以
 * blocked 商品天然被排除。CLI 原样调用。
 */
/** 执行器的阶段名 → 运营看得懂的失败原因。技术细节留在报告里。 */
const STAGE_FAILURE_LABELS: Record<string, string> = {
  guardrail: '安全门拦截：计划里含有不允许自动上架的商品',
  publish: '发布批准位写入失败',
  normalize: '商品资料整理阶段失败',
  title: '标题生成阶段失败',
  pricing: '定价阶段失败',
  mirror: '图片转存阶段失败',
  blurhash: '图片占位图生成阶段失败',
  inventory: '库存验证暂不可用',
  reviews: '评价初始化阶段失败',
};

/**
 * 从执行器自己的报告里读出「死在第几阶段、为什么」。
 *
 * 之前只会说一句「上架流水线未完成」，用户没法判断该做什么。报告里其实一直有
 * reached_stage 与 stage_failures，只是没人读。
 */
export function describeApplyFailure(report: Record<string, any> | null): { stage: string | null; reason: string | null; detail?: string | null } {
  if (!report) return { stage: null, reason: null, detail: null };
  const failures = (report.stage_failures ?? {}) as Record<string, string>;
  // 没有任何阶段失败 = 这次跑完了。不能因为 reached_stage 是 'done' 就报「done 阶段失败」。
  if (Object.keys(failures).length === 0) return { stage: null, reason: null, detail: null };
  const stage = Object.keys(failures)[0];
  if (!stage) return { stage: null, reason: null, detail: null };
  const label = STAGE_FAILURE_LABELS[stage] ?? `${stage} 阶段失败`;
  const detail = failures[stage];
  // script_exit_nonzero 且没有任何输出，几乎总是子进程没起来（找不到 node 工具链）。
  // 供应商账号没解析到开放平台域名时，库存阶段直接判无凭据。给业务说法，raw enum 留技术详情。
  if (detail === 'no_giga_creds') {
    return { stage, reason: `${label}：供应商库存服务未连接`, detail };
  }
  if (detail === 'script_exit_nonzero') {
    const log = Array.isArray(report.log) ? report.log.join('\n') : '';
    if (/exit=null[\s\S]*--- stdout ---\s*\n\s*--- stderr ---\s*$/m.test(log) || /exit=null/.test(log)) {
      return { stage, reason: `${label}：脚本没有启动，通常是运行环境缺少 node 工具链`, detail };
    }
  }
  return { stage, reason: detail ? `${label}（${detail}）` : label, detail };
}

// ── 上架未完成商品的续跑 ─────────────────────────────────────────────────────
//
// 一次批量上架可能死在任何一个阶段。留下的半成品既不是新候选（planner 的候选是「在
// supplier_products 但不在 standardized_products」，建了行就被排除），也不该从界面消失。
//
// 续跑不新增执行器：runGigaAutoPublish 的八个阶段本身就是幂等的 ——
//   Stage 1 .eq('published', false) 命中 0 行，随后按「当前为 true 的数量」校验，通过
//   Stage 2 upsert onConflict=supplier_product_id，且 StandardizedProductInsert 不含 published
//   Stage 3 默认只处理 optimized_title IS NULL
//   Stage 5 内容寻址，已存在即复用
//   Stage 6 !FORCE 时只补 primary_image_blurhash IS NULL
//   Stage 8 upsert，unique(supplier_product_id, reviewer_name)
// 唯一会重算的是 Stage 4 定价 —— 那是它本来的设计，同样的成本得出同样的价。

/** 读齐续跑判定需要的全部事实。 */
async function readProgressFacts(client: SupabaseClient, skus: string[]): Promise<OnboardingProgressFacts[]> {
  if (!skus.length) return [];
  const [sp, std, sell, reviews, avail] = await Promise.all([
    client.from('supplier_products').select('supplier_product_id,published').in('supplier_product_id', skus),
    client.from('standardized_products')
      .select('supplier_product_id,published,normalization_status,optimized_title,selling_price,primary_image_mirror_status,primary_image_blurhash,inventory_status,total_available_qty')
      .in('supplier_product_id', skus),
    client.from('sellable_products').select('supplier_product_id').in('supplier_product_id', skus),
    client.from('product_reviews').select('supplier_product_id').eq('status', 'active').in('supplier_product_id', skus),
    client.from('product_availability_current').select('supplier_product_id').in('supplier_product_id', skus),
  ]);
  const supplierPub = new Map((sp.data ?? []).map((r: any) => [r.supplier_product_id, r.published === true]));
  const stdById = new Map((std.data ?? []).map((r: any) => [r.supplier_product_id, r]));
  const sellSet = new Set((sell.data ?? []).map((r: any) => r.supplier_product_id));
  const availSet = new Set((avail.data ?? []).map((r: any) => r.supplier_product_id));
  const reviewCount = new Map<string, number>();
  for (const r of (reviews.data ?? []) as any[]) {
    reviewCount.set(r.supplier_product_id, (reviewCount.get(r.supplier_product_id) ?? 0) + 1);
  }
  return skus.map((sku) => {
    const row = stdById.get(sku) as any;
    return {
      supplier_product_id: sku,
      supplier_published: supplierPub.get(sku) === true,
      in_standardized: Boolean(row),
      standardized_published: row ? (row.published ?? null) : null,
      normalization_status: row?.normalization_status ?? null,
      optimized_title: row?.optimized_title ?? null,
      selling_price: row?.selling_price == null ? null : Number(row.selling_price),
      primary_image_mirror_status: row?.primary_image_mirror_status ?? null,
      primary_image_blurhash: row?.primary_image_blurhash ?? null,
      inventory_status: row?.inventory_status ?? null,
      total_available_qty: row?.total_available_qty == null ? null : Number(row.total_available_qty),
      active_review_count: reviewCount.get(sku) ?? 0,
      has_availability_evidence: availSet.has(sku),
      in_sellable: sellSet.has(sku),
    };
  });
}

/** 上架未完成的商品从哪来：曾经进过计划快照、如今还没进 sellable 的那些。 */
function skusFromPlanSnapshots(): string[] {
  const out = new Set<string>();
  for (const file of [XONE_PLAN_SNAPSHOT, XONE_RECOVERY_PLAN]) {
    try {
      const plan = JSON.parse(fs.readFileSync(file, 'utf8')) as { proposed_batch?: { skus?: unknown[] } };
      for (const sku of plan.proposed_batch?.skus ?? []) out.add(String(sku));
    } catch { /* 没有快照就没有续跑对象 */ }
  }
  return [...out];
}

/** 库存读取失败的业务化表达。词汇来自既有扫描器的 status，未新增判定。 */
const AVAILABILITY_FAILURE_LABELS: Record<string, string> = {
  malformed_response: '供应商返回的库存数据不完整',
  api_failed: '供应商库存接口调用失败',
  network_failed: '连不上供应商',
  rate_limited: '供应商限流',
  parse_failed: '供应商响应无法解析',
  auth_failed: '供应商登录已失效',
  captcha_required: '供应商要求验证码',
};

/**
 * 最近一次库存证据读取到底发生了什么。
 *
 * 「App 暂不可见」只是结果，用户需要的是原因。扫描器自己的报告里有 totals / gates /
 * proposals，逐条写着每件商品的 status 与 reason —— 读出来翻成人话即可，不重新判定。
 */
export function describeAvailabilityFailure(report: Record<string, any> | null): {
  reason: string | null;
  detail: string | null;
} {
  if (!report) return { reason: null, detail: null };
  const totals = report.totals ?? {};
  const scanned = Number(totals.total ?? 0);
  const failures = Number(totals.failures ?? 0);
  if (scanned === 0) return { reason: '库存读取没有覆盖到这些商品', detail: 'no_targets' };
  if (failures === 0) return { reason: null, detail: null };

  const byStatus = (totals.byStatus ?? {}) as Record<string, number>;
  const status = Object.entries(byStatus).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  const label = AVAILABILITY_FAILURE_LABELS[status] ?? '库存读取失败';
  const gateBlocked = report.gates?.failureRate?.allowed === false;
  const suffix = gateBlocked ? '，本次没有写入任何库存证据' : '';
  return { reason: `${label}（${failures}/${scanned} 件读取失败）${suffix}`, detail: status };
}

/** 最近一次窄化库存扫描的报告。用来给「为什么还不可见」一个真实答案。 */
function readLatestTargetedAvailabilityReport(): Record<string, any> | null {
  let files: string[] = [];
  try {
    files = fs.readdirSync(AVAILABILITY_REPORT_DIR).filter((n) => n.startsWith('targeted-') && n.endsWith('.json'));
  } catch { return null; }
  let best: Record<string, any> | null = null;
  let bestAt = -Infinity;
  for (const name of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(AVAILABILITY_REPORT_DIR, name), 'utf8'));
      const at = Date.parse(String(parsed.finished_at ?? parsed.started_at ?? ''));
      if (Number.isFinite(at) && at > bestAt) { bestAt = at; best = parsed; }
    } catch { /* 跳过损坏文件 */ }
  }
  return best;
}

async function runRecoveryList(client: SupabaseClient): Promise<Record<string, unknown>> {
  const facts = await readProgressFacts(client, skusFromPlanSnapshots());
  const availabilityFailure = describeAvailabilityFailure(readLatestTargetedAvailabilityReport());
  const rows = facts.map((f) => {
    const verdict = deriveRecoveryState(f);
    const done = stageCompletion(f);
    return {
      supplier_product_id: f.supplier_product_id,
      state: verdict.state,
      resumable: isResumable(verdict.state),
      next_action: verdict.nextAction,
      missing: verdict.missing,
      missing_labels: verdict.missing.map((stage) => STAGE_LABELS[stage]),
      stages: done,
      stage_labels: STAGE_LABELS,
      selling_price: f.selling_price,
      standardized_published: f.standardized_published,
      in_sellable: f.in_sellable,
      // 等证据的商品，把上一次读取失败的真实原因带出来。
      blocked_reason: verdict.state === 'awaiting_evidence' ? availabilityFailure.reason : null,
      blocked_detail: verdict.state === 'awaiting_evidence' ? availabilityFailure.detail : null,
    };
  }).filter((row) => row.state !== 'not_started' && row.state !== 'complete');

  return envelope('onboarding-recovery-list', {
    production_write_attempted: false,
    total: rows.length,
    resumable_count: rows.filter((r) => r.resumable).length,
    rows,
  });
}

/**
 * 续跑。两种下一步，各自复用既有能力，都不新增执行器：
 *   resume_pipeline      → runGigaAutoPublish --plan <续跑快照> --apply（八阶段幂等）
 *   refresh_availability → scanPublishedAvailability --skus=… --live（库存证据的唯一产出者）
 *
 * 后者属于库存扫描链。首次上架的商品在扫描跑到它之前天然「已发布、App 还看不到」，
 * 这一步补的就是那一行证据，它不改变任何发布状态。
 */
async function runRecoveryResume(
  request: OnboardingRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  if (!isHumanApprover(request.approved_by)) return failure('APPROVER_MISSING', '续跑必须记录批准人');
  const preflight = preflightToolchain(childEnv({}, {}));
  if (!preflight.ok) return failure('TOOLCHAIN_UNAVAILABLE', `无法继续：${preflight.reason}`);
  const account = preflightSupplierAccount(REPO);
  if (!account.ok) return failure('SUPPLIER_ACCOUNT_UNAVAILABLE', `无法继续：${account.reason}`);

  const facts = await readProgressFacts(client, skusFromPlanSnapshots());
  const pipeline: string[] = [];
  const evidence: string[] = [];
  for (const f of facts) {
    const verdict = deriveRecoveryState(f);
    if (verdict.nextAction === 'resume_pipeline') pipeline.push(f.supplier_product_id);
    else if (verdict.nextAction === 'refresh_availability') evidence.push(f.supplier_product_id);
  }
  if (!pipeline.length && !evidence.length) return failure('NOTHING_TO_RESUME', '当前没有需要继续完成的商品');
  if (typeof request.expected_ready === 'number'
    && request.expected_ready !== pipeline.length + evidence.length) {
    return failure('STATE_CHANGED', '商品状态已经变化，请重新查看后再继续');
  }

  const steps: Array<{ step: string; skus: number; exit_code: number | null }> = [];

  if (pipeline.length) {
    progress('resume_pipeline', `正在继续完成 ${pipeline.length} 件商品的上架流程`);
    let previous: Record<string, unknown> | null = null;
    try { previous = JSON.parse(fs.readFileSync(XONE_PLAN_SNAPSHOT, 'utf8')); } catch { previous = null; }
    const plan = buildRecoveryPlan(previous, pipeline);
    if (!plan) return failure('NO_RECOVERY_PLAN', '找不到可用于续跑的计划快照');
    fs.writeFileSync(XONE_RECOVERY_PLAN, JSON.stringify(plan, null, 2));
    const run = runScript('scripts/runGigaAutoPublish.ts', ['--plan', XONE_RECOVERY_PLAN, '--apply', '--summary'], 1_800_000);
    steps.push({ step: 'resume_pipeline', skus: pipeline.length, exit_code: run.status });
  }

  if (evidence.length) {
    progress('refresh_availability', `正在为 ${evidence.length} 件商品读取库存证据`);
    // 既有的证据产出者，窄化运行会写到自己的报告文件，不覆盖全量扫描的 latest。
    const scan = runScript(
      'scripts/scanPublishedAvailability.ts',
      [`--skus=${evidence.join(',')}`, '--live'],
      1_800_000,
    );
    steps.push({ step: 'refresh_availability', skus: evidence.length, exit_code: scan.status });
  }

  const after = await readProgressFacts(client, [...pipeline, ...evidence]);
  const resumeFailure = describeAvailabilityFailure(readLatestTargetedAvailabilityReport());
  const results = after.map((f) => {
    const verdict = deriveRecoveryState(f);
    if (verdict.state === 'complete') return { sku: f.supplier_product_id, outcome: 'verified_visible', reason: null };
    if (f.standardized_published === true) {
      return {
        sku: f.supplier_product_id,
        outcome: 'published_but_not_sellable',
        reason: verdict.state === 'awaiting_evidence'
          ? (resumeFailure.reason
            ? `已发布，但库存证据没能拿到：${resumeFailure.reason}`
            : '已发布，但还没有可用的库存证据，App 暂时看不到')
          : '已发布，但未满足 App 可见条件',
      };
    }
    return { sku: f.supplier_product_id, outcome: 'pipeline_failed', reason: '上架流程仍未完成' };
  });
  const counts = {
    verified_visible: results.filter((r) => r.outcome === 'verified_visible').length,
    published_but_not_sellable: results.filter((r) => r.outcome === 'published_but_not_sellable').length,
    pipeline_failed: results.filter((r) => r.outcome === 'pipeline_failed').length,
  };
  appendAudit({
    event: 'recovery_resume', approved_by: request.approved_by, steps, ...counts,
    availability_failure: resumeFailure.detail,
  });
  return envelope('onboarding-recovery-resume', {
    production_write_attempted: true,
    approved_by: request.approved_by,
    steps,
    counts,
    results,
    availability_failure_reason: resumeFailure.reason,
    availability_failure_detail: resumeFailure.detail,
  });
}

async function runBatchPublish(
  request: OnboardingRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  if (!isHumanApprover(request.approved_by)) return failure('APPROVER_MISSING', '批量上架必须记录批准人');

  // 先确认工具链可用，再谈执行。执行器的 Stage 1 会先翻发布批准位，如果 Stage 2 才发现
  // 起不了进程，就会留下一批「已批准、什么都没生成」的半成品 —— 2026-08-08 那次就是这样。
  const preflight = preflightToolchain(childEnv({}, {}));
  if (!preflight.ok) return failure('TOOLCHAIN_UNAVAILABLE', `无法开始批量上架：${preflight.reason}`);

  // 账号同样要在翻发布位之前确认。库存阶段拿不到开放平台账号时会 no_giga_creds，
  // 而那时前六个阶段已经写完了 —— 2026-08-08 那次就停在这里。
  const account = preflightSupplierAccount(REPO);
  if (!account.ok) return failure('SUPPLIER_ACCOUNT_UNAVAILABLE', `无法开始批量上架：${account.reason}`);

  let planJson: Record<string, any>;
  try { planJson = JSON.parse(fs.readFileSync(XONE_PLAN_SNAPSHOT, 'utf8')); }
  catch { return failure('NO_PLAN_SNAPSHOT', '还没有可执行的上架计划，请先检查新收藏'); }

  const readySkus = ((planJson?.proposed_batch?.skus ?? []) as unknown[]).map(String).filter(Boolean);
  if (!readySkus.length) return failure('NOTHING_READY', '当前没有可以上架的商品');
  // 界面报的数量必须和计划里的一致，否则说明中间有人重新规划过。
  if (typeof request.expected_ready === 'number' && request.expected_ready !== readySkus.length) {
    return failure('PLAN_CHANGED', '上架计划已经变化，请重新检查新收藏后再试');
  }

  const before = await readPublishState(client, readySkus);
  progress('publish', `正在上架 ${readySkus.length} 件商品`);
  const run = runScript(
    'scripts/runGigaAutoPublish.ts',
    ['--plan', XONE_PLAN_SNAPSHOT, '--apply', '--summary'],
    1_800_000,
  );
  const after = await readPublishState(client, readySkus);
  // 死在哪一阶段、为什么 —— 执行器自己的报告里有，读出来给人看。
  let applyReport: Record<string, any> | null = null;
  try { applyReport = JSON.parse(fs.readFileSync(path.join(REPORT_DIR, 'latest-apply.json'), 'utf8')); } catch { /* 没有报告就退回通用文案 */ }
  const applyFailure = describeApplyFailure(applyReport);

  const results = readySkus.map((sku) => {
    const wasPublished = before.published.get(sku) === true;
    const nowPublished = after.published.get(sku) === true;
    const visible = after.sellable.has(sku);
    if (nowPublished && visible) return { sku, outcome: 'verified_visible', reason: null };
    if (nowPublished && !visible) {
      return {
        sku,
        outcome: 'published_but_not_sellable',
        reason: wasPublished ? '该商品此前已发布，但仍未进入 App 可售视图' : '已发布，但尚未满足 App 可见条件（资料、库存或价格仍在生成中）',
      };
    }
    return { sku, outcome: 'pipeline_failed', reason: applyFailure.reason ?? '上架流水线未完成，商品未发布' };
  });

  // 验证成功的才释放系统保护；失败的继续保护。用户手工裁决永不触碰。
  const protectionReleased: Array<{ sku: string; action: string }> = [];
  for (const r of results) {
    if (r.outcome !== 'verified_visible') continue;
    protectionReleased.push({ sku: r.sku, action: await syncProtection(client, r.sku, false) });
  }

  const counts = {
    verified_visible: results.filter((r) => r.outcome === 'verified_visible').length,
    published_but_not_sellable: results.filter((r) => r.outcome === 'published_but_not_sellable').length,
    pipeline_failed: results.filter((r) => r.outcome === 'pipeline_failed').length,
  };
  appendAudit({
    event: 'batch_publish', approved_by: request.approved_by, exit_code: run.status,
    requested: readySkus.length, ...counts,
    failed_stage: applyFailure.stage, failure_reason: applyFailure.reason,
  });
  return envelope('onboarding-batch-publish', {
    production_write_attempted: true,
    approved_by: request.approved_by,
    requested: readySkus.length,
    exit_code: run.status,
    failed_stage: applyFailure.stage,
    failure_reason: applyFailure.reason,
    failure_detail: applyFailure.detail ?? null,
    counts,
    results,
    protection_released: protectionReleased,
  });
}

async function readPublishState(
  client: SupabaseClient,
  skus: string[],
): Promise<{ published: Map<string, boolean>; sellable: Set<string> }> {
  const published = new Map<string, boolean>();
  const sellable = new Set<string>();
  for (let i = 0; i < skus.length; i += 200) {
    const chunk = skus.slice(i, i + 200);
    const std = await client.from('standardized_products').select('supplier_product_id,published').in('supplier_product_id', chunk);
    for (const row of (std.data ?? []) as Array<{ supplier_product_id: string; published: boolean | null }>) {
      published.set(row.supplier_product_id, row.published === true);
    }
    const sell = await client.from('sellable_products').select('supplier_product_id').in('supplier_product_id', chunk);
    for (const row of (sell.data ?? []) as Array<{ supplier_product_id: string }>) sellable.add(row.supplier_product_id);
  }
  return { published, sellable };
}

export async function executeOnboardingBridge(
  request: OnboardingRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  if (request.operation === 'check-new-saved') return runCheckNewSaved(request, client);
  if (request.operation === 'onboarding-recovery-list') return runRecoveryList(client);
  if (request.operation === 'onboarding-recovery-resume') return runRecoveryResume(request, client);
  if (request.operation === 'onboarding-preview') return runOnboardingPreview(request, client);
  if (request.operation === 'onboarding-preview-cached') return readCachedPreview();
  if (request.operation === 'onboarding-batch-publish') return runBatchPublish(request, client);

  const pickupSaved = await loadPickupSaved(client);

  if (request.operation === 'onboarding-candidates') {
    // 候选只来自既有报告，不在这里另做一套 diff。
    const reported = readCandidateSkus();
    const rows: Array<Record<string, unknown>> = [];
    for (const candidate of reported) {
      const facts = await loadFacts(client, candidate.sku, pickupSaved);
      const state = deriveOnboardingState(facts);
      // 已经上架的、已经不在 Pickup 收藏的，都不再是待上新候选。
      if (facts.published === true || !facts.in_pickup_favorites) continue;
      rows.push({
        supplier_product_id: candidate.sku,
        title: facts.product_title ?? candidate.title ?? '未命名商品',
        primary_image: facts.primary_image,
        state,
        can_approve: canApproveFirstPublish(state),
        in_pickup_favorites: facts.in_pickup_favorites,
        has_unique_identity: facts.has_unique_identity,
        in_supplier_products: facts.in_supplier_products,
        in_standardized_products: facts.in_standardized_products,
        selling_price: facts.selling_price,
        taxonomy_needs_review: facts.taxonomy_needs_review,
        stock_available: facts.stock_available,
        classification: candidate.classification,
      });
    }
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    const page = rows.slice(offset, offset + limit);
    // 候选是「上次检查新收藏」那一刻的实时抓取。把这个时间原样交给界面 —— 用户必须能分辨
    // 「现在确实没有新品」和「很久没检查过了」。
    const live = readLiveSavedSnapshot();
    const capturedAt = live?.capturedAt ?? null;
    const ageHours = capturedAt ? (Date.now() - Date.parse(capturedAt)) / 3_600_000 : null;
    return envelope('onboarding-candidates', {
      items: page,
      total: rows.length,
      offset,
      has_more: offset + page.length < rows.length,
      ready_count: rows.filter((r) => r.can_approve === true).length,
      saved_captured_at: capturedAt,
      saved_count: live?.skus.size ?? 0,
      // 超过一天没检查就明说，而不是让空列表冒充「没有新品」。
      is_stale: ageHours === null || ageHours > 24,
    });
  }

  const sku = String(request.sku ?? '').trim();

  if (request.operation === 'prepare-onboarding-candidate') {
    // 准备阶段委托既有导入脚本，并在候选期建立收藏保护。它绝不发布。
    const protection = await syncProtection(client, sku, true);
    const sync = runScript('scripts/syncGigaNewlySavedCandidates.ts', ['--sync'], 300_000);
    const facts = await loadFacts(client, sku, pickupSaved);
    const state = deriveOnboardingState(facts);
    appendAudit({ event: 'prepare', sku, exit_code: sync.status, state, protection });
    return envelope('prepare-onboarding-candidate', {
      supplier_product_id: sku,
      state,
      can_approve: canApproveFirstPublish(state),
      protection,
      // 准备阶段结构性地不发布：它只把商品导入成未发布候选。
      published: facts.published,
      executor_exit_code: sync.status,
    });
  }

  if (request.operation === 'approve-first-publish') {
    const approvedBy = String(request.approved_by ?? '').trim();
    const before = await loadFacts(client, sku, pickupSaved);
    const verdict = evaluateFirstPublish({ supplier_product_id: sku, approved_by: approvedBy, facts: before });

    if (!verdict.allowed) {
      appendAudit({ event: 'approve_blocked', sku, approved_by: approvedBy, blocks: verdict.blocks });
      return envelope('approve-first-publish', {
        status: 'blocked', supplier_product_id: sku, blocks: verdict.blocks,
        published_before: before.published, published_after: before.published,
        in_sellable_after: before.in_sellable_products, outcome: null, verification_reason: null,
      });
    }

    // 复用既有发布流水线，精确单件 scope。
    //
    // 用 onboardScopedSkus.ts 而不是 runGigaAutoPublish.ts：后者只处理 planner 报告里的
    // proposed_batch，不接受 --only，传了会被忽略并把整批一起发布 —— 那正是这里绝不能发生的
    // 隐式批量。onboardScopedSkus 是既有的 ONLY_SKUS 白名单编排器，缺失即 fail-closed。
    //
    // 它的前置条件是 supplier_products.published=true（批准位）。这里只对这一行、且只在它
    // 当前为 false 时翻转，幂等且不触碰其它 SKU。
    const approveRes = await client.from('supplier_products')
      .update({ published: true })
      .eq('supplier_product_id', sku)
      .eq('published', false)
      .select('supplier_product_id');
    if (approveRes.error) {
      return envelope('approve-first-publish', {
        status: 'failed', supplier_product_id: sku, blocks: [],
        published_before: before.published, published_after: before.published,
        in_sellable_after: before.in_sellable_products,
        outcome: 'publish_failed', verification_reason: '无法写入批准标记',
      });
    }
    const apply = runScript('scripts/onboardScopedSkus.ts', [], 900_000, { ONLY_SKUS: sku });

    const after = await loadFacts(client, sku, pickupSaved);
    const outcome = verifyFirstPublishOutcome({
      published_before: before.published,
      published_after: after.published,
      in_sellable_after: after.in_sellable_products,
      facts_after: after,
    });

    // 成功即释放系统自动保护（TARGET 自然包含 published=true）；失败则保留。
    const protection = await syncProtection(client, sku, outcome.outcome === 'publish_failed');

    appendAudit({
      event: 'approve_first_publish', sku, approved_by: approvedBy,
      executor_exit_code: apply.status, published_before: before.published,
      published_after: after.published, in_sellable_after: after.in_sellable_products,
      outcome: outcome.outcome, reason: outcome.reason, protection,
    });

    return envelope('approve-first-publish', {
      status: outcome.outcome === 'publish_failed' ? 'failed' : 'completed',
      supplier_product_id: sku,
      blocks: [],
      executor_exit_code: apply.status,
      published_before: before.published,
      published_after: after.published,
      in_sellable_after: after.in_sellable_products,
      outcome: outcome.outcome,
      verification_reason: outcome.reason,
      protection,
    });
  }

  return failure('UNSUPPORTED', '不支持的操作');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    const request = parseOnboardingRequest(await readStdin());
    const url = process.env.SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    response = !url || !key
      ? failure('DATABASE_NOT_CONFIGURED', '数据库连接未配置')
      : await executeOnboardingBridge(request, createClient(url, key, { auth: { persistSession: false } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const raw = message.split(':')[0];
    response = failure(
      ['INVALID_REQUEST', 'INVALID_SKU'].includes(raw) ? raw : 'BRIDGE_FAILED',
      '新品上架请求处理失败',
    );
    console.error(`[xone-product-onboarding] ${raw}`);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1]?.endsWith('xoneProductOnboardingBridge.ts')) void main();
