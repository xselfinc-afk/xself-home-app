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
  ONBOARDING_PROTECTION_ACTOR,
  type OnboardingFacts,
} from '../src/services/productOnboarding';
import { isStale, isUsableMapping, type StoredPortalMapping } from '../src/services/supplierPortalMapping';

loadEnv({ path: path.join(__dirname, '..', '.env.local') });

const SCHEMA_VERSION = '1.0';
const LOOP_ID = 'product-onboarding';
const REPO = path.join(__dirname, '..');
const REPORT_DIR = path.join(REPO, 'reports', 'giga-auto-publish');
const CANDIDATES_FILE = path.join(REPORT_DIR, 'latest-newly-saved-candidates.json');
/** 首次上架的审计留痕，与既有报告体系同目录。 */
const ONBOARDING_AUDIT = path.join(REPORT_DIR, 'xone-onboarding-audit.jsonl');
const PAGE_MAX = 50;

export type OnboardingOperation =
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
}

export function parseOnboardingRequest(raw: string): OnboardingRequest {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('INVALID_REQUEST'); }
  const r = parsed as Partial<OnboardingRequest>;
  if (r?.schema_version !== SCHEMA_VERSION) throw new Error('INVALID_REQUEST');
  const ops: OnboardingOperation[] = ['onboarding-candidates', 'prepare-onboarding-candidate', 'approve-first-publish'];
  if (!r.operation || !ops.includes(r.operation)) throw new Error('INVALID_REQUEST');
  if (r.operation !== 'onboarding-candidates' && !String(r.sku ?? '').trim()) throw new Error('INVALID_SKU');
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

/** 读 Pickup 收藏事实。复用已同步的 memberships，不在这里再打一次供应商。 */
async function loadPickupSaved(client: SupabaseClient): Promise<Set<string>> {
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

function runScript(
  relative: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
) {
  const runtime = path.join(REPO, 'node_modules', '.bin', 'tsx');
  return spawnSync('/opt/homebrew/bin/node', [runtime, path.join(REPO, relative), ...args], {
    cwd: REPO, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...extraEnv },
  });
}

export async function executeOnboardingBridge(
  request: OnboardingRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
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
    return envelope('onboarding-candidates', {
      items: page,
      total: rows.length,
      offset,
      has_more: offset + page.length < rows.length,
      ready_count: rows.filter((r) => r.can_approve === true).length,
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
