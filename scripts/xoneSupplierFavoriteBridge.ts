/**
 * XOne ⇄ supplier Favorites bridge — the ONLY interface between XOne and the website favorites
 * chain. Same fixed protocol as `xoneInventoryLifecycleBridge.ts`: one JSON request on stdin, one
 * JSON response on stdout, `schema_version: "1.0"`.
 *
 * CHAIN BOUNDARY — enforced structurally, not by convention
 * ---------------------------------------------------------
 * This file may read `standardized_products` and `supplier_products` to work out which items the
 * API inventory chain is already managing (that is what protects them from cleanup), but it may
 * never WRITE anything outside the three favorites tables. It does not import
 * `standardizedInventoryProjection`, `availabilityPersistence`, `openApiAvailability` or
 * `inventoryStateMachine`, and `supplierFavoriteChainIsolation.test.ts` fails if it ever does.
 *
 * Nothing here removes a Favorite. Removal lives behind `supplierFavoriteRemoval.ts`, is disabled
 * by default, and the only operation exposed to the UI is a dry preview.
 */
import { config as loadEnv } from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  buildSupplierFavoritePlan,
  resolveManualAction,
  type AccountReadState,
  type FavoriteManualAction,
  type SavedAssetState,
  type SupplierFavoriteInput,
} from '../src/services/supplierFavoriteCleanup';
import { previewRemoval, previewSyncOperation } from '../src/services/supplierFavoriteRemoval';
import { buildFavoriteSyncPlan, type AccountFavoritesState, type SyncAccount } from '../src/services/supplierFavoriteSync';
import { resolveProductIdMapping, type ProductIdMapping } from '../src/services/supplierFavoriteProductId';
import { isStale, isUsableMapping, toUsableMapping, verifyManualIdentity, PORTAL_MAPPING_SOURCE, PORTAL_MAPPING_CONFIDENCE, type StoredPortalMapping } from '../src/services/supplierPortalMapping';
import { buildFavoriteCleanupPlan } from '../src/services/supplierFavoriteCleanupExecutor';
// 兼容既有引用路径：解析逻辑已移到服务层，这里只转出。
export { resolveProductIdMapping, type ProductIdMapping };

/**
 * 从 `supplier_portal_product_mappings` 取网站身份，并在读取时重新校验每一道门禁。
 *
 * 绝不回退到 inventory_cache：那一列存的是 supplier_product_id 的副本，个别 SKU 全是数字，
 * 会被当成网站 id 发出去，作用到别的商品上。存了也不等于可信，所以来源、confidence、
 * 数字性、以及 portal_sku 的反查在每次读取时都重新验一遍。
 */
function portalMappingResolver(rows: readonly StoredPortalMapping[], nowIso: string) {
  const bySku = new Map(rows.map((r) => [r.supplier_product_id, r]));
  return (sku: string): ProductIdMapping => {
    const row = bySku.get(sku);
    if (!isUsableMapping(row)) return { product_id: null, verified_sku: null, status: 'not_mapped' };
    // 过期的映射不再直接采信，等待重新验证。
    if (isStale(row, nowIso)) return { product_id: null, verified_sku: null, status: 'not_mapped' };
    const usable = toUsableMapping(row);
    if (!usable) return { product_id: null, verified_sku: null, status: 'not_mapped' };
    return { product_id: usable.website_product_id, verified_sku: usable.portal_sku, status: 'unique' };
  };
}

// XOne 通过 Tauri 派生这个脚本，派生出的进程只继承 App 自己的环境变量，里面没有 Supabase
// 凭据。库存桥接同样在模块顶层加载 .env.local —— 少了这两行，面板打开时拿到的永远是
// NOT_CONFIGURED。Rust runner 以 xself-home-app 为工作目录，所以相对路径成立。
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const LOOP_ID = 'supplier-favorite-management';
const SCHEMA_VERSION = '1.0' as const;

export type FavoriteBridgeOperation =
  | 'exception-list'
  | 'resolve-exception'
  | 'resolve-exception-batch'
  | 'verify-identity'
  | 'save-identity'
  | 'summary'
  | 'pending-onboarding'
  | 'manual-action'
  | 'removal-preview'
  | 'sync-plan';

export interface FavoriteBridgeRequest {
  schema_version: '1.0';
  operation: FavoriteBridgeOperation;
  sku?: string;
  action?: FavoriteManualAction;
  operator?: string;
  /** resolve-exception：裁决落在哪个账号上。账号隔离由此保证。 */
  account?: 'pickup' | 'dropship';
  /** resolve-exception：keep_favorite | remove_favorite | no_action */
  resolution?: string;
  note?: string;
  /** verify-identity / save-identity：用户给出的 website product_id。 */
  website_product_id?: number;
  /** resolve-exception-batch：一次提交多条裁决。 */
  items?: Array<{ supplier_account?: string; supplier_product_id?: string; resolution?: string }>;
  /** pending-onboarding 分页：一次只返回一页，首屏不再拉满 140 条。 */
  offset?: number;
  limit?: number;
}

const PENDING_PAGE_MAX = 50;
/** 单批裁决上限，与 Rust 侧保持一致。 */
const BATCH_MAX = 100;

function envelope(operation: string, extra: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    operation,
    loop_id: LOOP_ID,
    source_system: 'xself-home-app',
    generated_at: now,
    source_observed_at: now,
    data_source: 'live',
    // This loop can never write inventory or publication state, by construction.
    production_write_attempted: false,
    inventory_write_attempted: false,
    favorite_removal_attempted: false,
    error_code: null,
    error_message: null,
    ...extra,
  };
}

function failure(code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...envelope('error', extra), ok: false, error_code: code, error_message: message };
}

export function parseFavoriteBridgeRequest(raw: string): FavoriteBridgeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('INVALID_REQUEST');
  }
  const r = parsed as Partial<FavoriteBridgeRequest>;
  if (r?.schema_version !== SCHEMA_VERSION) throw new Error('INVALID_REQUEST');
  const ops: FavoriteBridgeOperation[] = ['summary', 'pending-onboarding', 'manual-action', 'removal-preview', 'sync-plan', 'exception-list', 'resolve-exception', 'resolve-exception-batch', 'verify-identity', 'save-identity'];
  if (!r.operation || !ops.includes(r.operation)) throw new Error('INVALID_REQUEST');
  // pending-onboarding 是列表操作，用 offset/limit 分页，不再需要 sku。
  const skuless = new Set<FavoriteBridgeOperation>(['summary', 'sync-plan', 'pending-onboarding', 'exception-list', 'resolve-exception-batch']);
  if (!skuless.has(r.operation) && !String(r.sku ?? '').trim()) throw new Error('INVALID_SKU');
  const clampInt = (value: unknown, fallback: number, max: number): number => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(n, max);
  };
  return {
    schema_version: SCHEMA_VERSION,
    operation: r.operation,
    sku: String(r.sku ?? '').trim() || undefined,
    action: r.action,
    operator: String(r.operator ?? '').trim() || undefined,
    // 只接受两个字面量账号名，杜绝任意值落库。
    account: r.account === 'pickup' || r.account === 'dropship' ? r.account : undefined,
    resolution: ['keep_favorite', 'remove_favorite', 'no_action'].includes(String(r.resolution))
      ? String(r.resolution) : undefined,
    note: String(r.note ?? '').trim().slice(0, 500) || undefined,
    items: Array.isArray(r.items) ? r.items.slice(0, BATCH_MAX) : undefined,
    website_product_id: Number.isInteger(Number(r.website_product_id)) && Number(r.website_product_id) > 0
      ? Number(r.website_product_id) : undefined,
    offset: clampInt(r.offset, 0, 100_000),
    limit: clampInt(r.limit, 20, PENDING_PAGE_MAX),
  };
}

interface Rows {
  memberships: Array<{ supplier_product_id: string; supplier_account: string; is_saved: boolean | null; sync_status: string; observed_at: string }>;
  assets: Array<{ supplier_product_id: string; asset_state: string; founder_status: string; approved_at: string | null; approved_by: string | null }>;
  products: Array<{ supplier_product_id: string; sku_custom: string | null; published: boolean; delist_reason: string | null; product_title: string | null; primary_image: string | null }>;
  supplierManaged: Set<string>;
}

/** Delist reasons that leave a product eligible to come back — those items stay protected. */
const RESTORABLE_DELIST_REASONS = new Set(['out_of_stock', 'supplier_unavailable', 'temporarily_unavailable']);

const PAGE_SIZE = 1000;

/**
 * Read a whole table. Supabase caps an unbounded `select` at 1000 rows and returns them without
 * any error, so an unpaginated read of `supplier_favorite_memberships` silently loses everything
 * past the first page and every missing SKU then looks like a failed read. Paginate explicitly.
 */
async function readAll<T>(client: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`FAVORITE_READ_FAILED:${table}:${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function loadRows(client: SupabaseClient): Promise<Rows> {
  const [memberships, assets, products, supplier] = await Promise.all([
    readAll<Rows['memberships'][number]>(client, 'supplier_favorite_memberships', 'supplier_product_id,supplier_account,is_saved,sync_status,observed_at'),
    readAll<Rows['assets'][number]>(client, 'saved_assets', 'supplier_product_id,asset_state,founder_status,approved_at,approved_by'),
    readAll<Rows['products'][number]>(client, 'standardized_products', 'supplier_product_id,sku_custom,published,delist_reason,product_title,primary_image'),
    readAll<{ supplier_product_id: string }>(client, 'supplier_products', 'supplier_product_id'),
  ]);
  return {
    memberships,
    assets,
    products,
    supplierManaged: new Set(supplier.map((r) => r.supplier_product_id)),
  };
}

/**
 * Was this account's last sync complete and authoritative?
 *
 * The sync writes a row for every SKU it observed plus every SKU it already knew about, and marks
 * a failed read with a non-`ok` `sync_status` and `is_saved = null`. So an account whose rows are
 * all `ok` was read cleanly end to end — and for such an account the ABSENCE of a row is a real
 * answer ("this SKU is not in that account's Favorites"), not an unknown.
 */
function accountIsAuthoritative(memberships: Rows['memberships'], account: string): boolean {
  const rows = memberships.filter((r) => r.supplier_account === account);
  return rows.length > 0 && rows.every((r) => r.sync_status === 'ok');
}

/**
 * Assemble the per-SKU inputs.
 *
 * Whether a missing row means "not saved" or "unknown" depends entirely on whether that account's
 * last sync was authoritative — see `accountIsAuthoritative`. Treating every gap as unknown makes
 * "only Pickup" and "only Dropship" structurally impossible to report, since the two accounts
 * legitimately hold largely different Favorites.
 */
export function buildInputs(rows: Rows): SupplierFavoriteInput[] {
  const byAccount = new Map<string, Map<string, Rows['memberships'][number]>>();
  for (const r of rows.memberships) {
    if (!byAccount.has(r.supplier_account)) byAccount.set(r.supplier_account, new Map());
    byAccount.get(r.supplier_account)!.set(r.supplier_product_id, r);
  }
  const assets = new Map(rows.assets.map((r) => [r.supplier_product_id, r]));
  const products = new Map(rows.products.map((r) => [r.supplier_product_id, r]));
  const authoritative = {
    pickup: accountIsAuthoritative(rows.memberships, 'pickup'),
    dropship: accountIsAuthoritative(rows.memberships, 'dropship'),
  };
  // Counting duplicates once, instead of re-scanning every product per SKU.
  const productCounts = new Map<string, number>();
  for (const r of rows.products) {
    productCounts.set(r.supplier_product_id, (productCounts.get(r.supplier_product_id) ?? 0) + 1);
  }

  const skus = new Set<string>([
    ...rows.memberships.map((r) => r.supplier_product_id),
    ...rows.assets.map((r) => r.supplier_product_id),
  ]);

  /**
   * A row whose `sync_status` is not `ok` is UNKNOWN whatever `is_saved` holds. A MISSING row is
   * "not saved" when that account was read authoritatively, and UNKNOWN when it was not.
   */
  const factOf = (
    row: Rows['memberships'][number] | undefined,
    accountAuthoritative: boolean,
  ): boolean | null => {
    if (!row) return accountAuthoritative ? false : null;
    return row.sync_status !== 'ok' ? null : row.is_saved;
  };

  return [...skus].map((sku) => {
    const pickup = byAccount.get('pickup')?.get(sku);
    const dropship = byAccount.get('dropship')?.get(sku);
    const asset = assets.get(sku);
    const product = products.get(sku);

    const matchingProducts = { length: productCounts.get(sku) ?? 0 };
    return {
      supplier_product_id: sku,
      xself_sku: product?.sku_custom ?? null,
      product_title: product?.product_title ?? null,
      primary_image: product?.primary_image ?? null,
      pickup_is_saved: factOf(pickup, authoritative.pickup),
      dropship_is_saved: factOf(dropship, authoritative.dropship),
      api_managed: rows.supplierManaged.has(sku),
      published: product?.published === true,
      restorable_delisted: product?.published === false
        && RESTORABLE_DELIST_REASONS.has(String(product?.delist_reason ?? '')),
      asset_state: (asset?.asset_state ?? null) as SavedAssetState | null,
      founder_status: asset?.founder_status ?? null,
      approved_at: asset?.approved_at ?? null,
      approved_by: asset?.approved_by ?? null,
      identity_unique: matchingProducts.length <= 1,
    };
  });
}

function accountStates(rows: Rows): AccountReadState[] {
  // TARGET 与收藏数必须来自同一次 loadRows —— 面板上的「当前收藏」和「未上线残留」因此
  // 永远是同一个快照，不会一个新一个旧。
  const target = new Set(
    rows.products.filter((p) => p.published === true).map((p) => p.supplier_product_id),
  );
  return (['pickup', 'dropship'] as const).map((account) => {
    const forAccount = rows.memberships.filter((r) => r.supplier_account === account);
    const failed = forAccount.filter((r) => r.sync_status !== 'ok');
    const observed = forAccount.map((r) => r.observed_at).filter(Boolean).sort();
    const saved = forAccount.filter((r) => r.sync_status === 'ok' && r.is_saved === true);
    const extra = saved.filter((r) => !target.has(r.supplier_product_id));
    return {
      account,
      // Same predicate that decides whether a missing row means "not saved" or "unknown", so the
      // panel's per-account status can never disagree with how the diff was computed.
      ok: accountIsAuthoritative(rows.memberships, account),
      total: saved.length,
      // 未上线残留 = 该账号当前收藏中不在 TARGET 里的部分，同一快照内算出。
      extra_count: extra.length,
      // 结构性不变量：残留不可能多于当前收藏。不成立说明快照被拼接过，宁可报错也不显示矛盾数字。
      data_inconsistent: extra.length > saved.length,
      observed_at: observed[observed.length - 1] ?? null,
      error: forAccount.length === 0 ? 'never_synced' : failed.length ? failed[0].sync_status : null,
    };
  });
}


/**
 * 读一次门户详情页，拿到该 product_id 自报的 SKU 与商品名。
 *
 * 复用既有的 fetchGigaWarehouseInventoryFromXhr（同一个 session、同一套 HTTP 客户端），
 * 不新建第二套门户抓取框架，也不用浏览器点页面。
 */
async function readPortalIdentity(productId: number): Promise<
  | { ok: true; portal_sku: string | null; product_title: string | null }
  | { ok: false; reason: 'session_expired' | 'unavailable' }
> {
  try {
    const mod = await import('./fetchGigaWarehouseInventoryFromXhr');
    const session = mod.loadSession();
    const detail = await mod.fetchBaseInfos(String(productId), session as never);
    const info = (detail as { data?: { product_info?: { sku?: string; product_name?: string } } } | null)?.data?.product_info;
    return { ok: true, portal_sku: info?.sku ?? null, product_title: info?.product_name ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 技术错误串不外传，只归一成用户能看懂的两种情况。
    if (/AUTH|401|403|CAPTCHA|login/i.test(message)) return { ok: false, reason: 'session_expired' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** 查该 SKU 现有映射，以及该 product_id 是否已被别的 SKU 占用。 */
async function readIdentityContext(client: SupabaseClient, sku: string, productId: number) {
  const [mine, others] = await Promise.all([
    client.from('supplier_portal_product_mappings')
      .select('supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at')
      .eq('supplier_product_id', sku).maybeSingle(),
    client.from('supplier_portal_product_mappings')
      .select('supplier_product_id').eq('website_product_id', productId),
  ]);
  return {
    existing: (mine.data ?? null) as StoredPortalMapping | null,
    otherSkusUsingId: ((others.data ?? []) as Array<{ supplier_product_id: string }>)
      .map((r) => r.supplier_product_id).filter((s) => s !== sku),
  };
}

export async function executeFavoriteBridge(
  request: FavoriteBridgeRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const rows = await loadRows(client);
  // buildInputs 之前被调用了两次（一次给 plan，一次建索引），每次都要遍历上千行。算一次即可。
  const inputList = buildInputs(rows);
  const plan = buildSupplierFavoritePlan(inputList, accountStates(rows));
  const inputs = new Map(inputList.map((i) => [i.supplier_product_id, i]));

  if (request.operation === 'verify-identity' || request.operation === 'save-identity') {
    const sku = String(request.sku ?? '').trim();
    const productId = request.website_product_id;
    if (!sku) return { ok: false, error_message: '缺少 Supplier SKU' };
    if (!productId) return { ok: false, error_message: 'Website Product ID 必须是正整数' };

    // save 路径同样从这里开始：**不信任前端此前的验证结果**，重新读一次门户详情页。
    const portal = await readPortalIdentity(productId);
    if (portal.ok === false) {
      return portal.reason === 'session_expired'
        ? { ok: false, error_code: 'SESSION_EXPIRED', error_message: '供应商登录已失效，请重新登录' }
        : { ok: false, error_code: 'PORTAL_UNAVAILABLE', error_message: '暂时无法读取供应商商品详情，请稍后重试' };
    }

    const ctx = await readIdentityContext(client, sku, productId);
    const verdict = verifyManualIdentity({
      supplier_product_id: sku,
      website_product_id: productId,
      portal_sku: portal.portal_sku,
      product_title: portal.product_title,
      existing: ctx.existing,
      otherSkusUsingId: ctx.otherSkusUsingId,
    });

    if (request.operation === 'verify-identity') {
      return envelope('verify-identity', { verdict });
    }

    // save-identity：只有服务端这一次刚刚验证通过才允许写。
    if (!verdict.can_save) {
      return { ok: false, error_code: 'IDENTITY_NOT_VERIFIED', error_message: verdict.detail ?? '身份未通过验证，禁止保存' };
    }
    const now = new Date().toISOString();
    const { error } = await client.from('supplier_portal_product_mappings').upsert({
      supplier_product_id: sku,
      website_product_id: verdict.website_product_id,
      portal_sku: verdict.portal_sku,
      source: PORTAL_MAPPING_SOURCE,
      confidence: PORTAL_MAPPING_CONFIDENCE,
      resolved_at: now,
      last_verified_at: now,
      updated_at: now,
    }, { onConflict: 'supplier_product_id' });
    if (error) return { ok: false, error_message: error.message };
    return envelope('save-identity', { verdict, saved: true });
  }

  if (request.operation === 'exception-list') {
    // 异常 = 该账号当前收藏中不属于 TARGET、且没有唯一身份的条目，附上人工裁决。
    const target = new Set(rows.products.filter((p) => p.published === true).map((p) => p.supplier_product_id));
    const { data: resolutionRows } = await client
      .from('supplier_favorite_exception_resolutions')
      .select('supplier_product_id,supplier_account,resolution,resolved_at,resolved_by,note');
    const decided = new Map<string, { resolution: string; resolved_at: string; resolved_by: string; note: string | null }>();
    for (const r of (resolutionRows ?? []) as any[]) {
      decided.set(`${r.supplier_account}|${r.supplier_product_id}`, r);
    }
    const { data: mappingRows } = await client
      .from('supplier_portal_product_mappings')
      .select('supplier_product_id,website_product_id,portal_sku');
    const mapped = new Map<string, { website_product_id: number | null; portal_sku: string | null }>();
    for (const m of (mappingRows ?? []) as any[]) mapped.set(m.supplier_product_id, m);

    const items: Array<Record<string, unknown>> = [];
    for (const account of ['pickup', 'dropship'] as const) {
      const saved = rows.memberships.filter(
        (r) => r.supplier_account === account && r.sync_status === 'ok' && r.is_saved === true,
      );
      for (const row of saved) {
        const sku = row.supplier_product_id;
        if (target.has(sku)) continue;                       // 已上线：不是异常，也永不清理
        const m = mapped.get(sku);
        const identified = !!m && m.website_product_id !== null && m.portal_sku === sku;
        const verdict = decided.get(`${account}|${sku}`);
        // 身份已唯一且无人工裁决 → 自动就能处理，不算异常。
        if (identified && !verdict) continue;
        if (identified && verdict?.resolution === undefined) continue;
        items.push({
          account,
          supplier_product_id: sku,
          reason: identified ? 'resolved_identity' : (m ? 'multiple_product_ids' : 'not_mapped'),
          product_id: m?.website_product_id ?? null,
          resolution: verdict?.resolution ?? 'unresolved',
          resolved_at: verdict?.resolved_at ?? null,
          resolved_by: verdict?.resolved_by ?? null,
          note: verdict?.note ?? null,
        });
      }
    }
    const unresolved = items.filter((i) => i.resolution === 'unresolved').length;
    return envelope('exception-list', {
      items,
      total: items.length,
      unresolved_count: unresolved,
      resolved_count: items.length - unresolved,
    });
  }

  if (request.operation === 'resolve-exception-batch') {
    const items = request.items ?? [];
    if (items.length === 0) return { ok: false, error_message: '没有需要保存的决定' };
    if (items.length > BATCH_MAX) return { ok: false, error_message: `一次最多保存 ${BATCH_MAX} 条决定` };

    // 逐条校验：任一非法 → 整批拒绝，绝不部分静默成功。
    const seen = new Set<string>();
    const now = new Date().toISOString();
    const rowsToWrite: Array<Record<string, unknown>> = [];
    for (const [index, item] of items.entries()) {
      const position = index + 1;
      const account = item.supplier_account;
      const sku = String(item.supplier_product_id ?? '').trim();
      const resolution = item.resolution;
      if (account !== 'pickup' && account !== 'dropship') {
        return { ok: false, error_message: `第 ${position} 条的账号无效，整批未保存` };
      }
      if (resolution !== 'keep_favorite' && resolution !== 'remove_favorite' && resolution !== 'no_action') {
        return { ok: false, error_message: `第 ${position} 条的决定无效，整批未保存` };
      }
      if (!sku) return { ok: false, error_message: `第 ${position} 条缺少 SKU，整批未保存` };
      if (seen.has(`${account}|${sku}`)) {
        return { ok: false, error_message: `第 ${position} 条与批内其它条目重复，整批未保存` };
      }
      seen.add(`${account}|${sku}`);
      rowsToWrite.push({
        supplier_product_id: sku,
        supplier_account: account,
        resolution,
        resolved_at: now,
        resolved_by: request.operator ?? 'xone',
        updated_at: now,
      });
    }

    // 单次 upsert —— PostgREST 把整批当一条语句执行，要么全成要么全败。
    const { error } = await client
      .from('supplier_favorite_exception_resolutions')
      .upsert(rowsToWrite, { onConflict: 'supplier_product_id,supplier_account' });
    if (error) return { ok: false, error_message: error.message };
    return envelope('resolve-exception-batch', { saved: rowsToWrite.length, resolved_at: now });
  }

  if (request.operation === 'resolve-exception') {
    if (!request.account || !request.resolution || !request.sku) {
      return { ok: false, error_message: '裁决参数不完整' };
    }
    const now = new Date().toISOString();
    const { error } = await client
      .from('supplier_favorite_exception_resolutions')
      .upsert({
        supplier_product_id: request.sku,
        supplier_account: request.account,
        resolution: request.resolution,
        resolved_at: now,
        resolved_by: request.operator ?? 'xone',
        note: request.note ?? null,
        updated_at: now,
      }, { onConflict: 'supplier_product_id,supplier_account' });
    if (error) return { ok: false, error_message: error.message };
    return envelope('resolve-exception', {
      supplier_product_id: request.sku,
      account: request.account,
      resolution: request.resolution,
      resolved_at: now,
    });
  }

  if (request.operation === 'summary') {
    return envelope('summary', { accounts: plan.accounts, counts: plan.counts });
  }

  if (request.operation === 'sync-plan') {
    // TARGET 只认 published=true，不看 sellable_products、不看库存状态。
    // 临时缺货的商品仍然 published，因此仍应留在收藏夹里。
    const target = rows.products.filter((p) => p.published === true).map((p) => p.supplier_product_id);
    const savedOf = (account: SyncAccount): string[] => rows.memberships
      .filter((r) => r.supplier_account === account && r.sync_status === 'ok' && r.is_saved === true)
      .map((r) => r.supplier_product_id);
    const favorites = { pickup: savedOf('pickup'), dropship: savedOf('dropship') };

    // 网站身份只来自门户证明过的映射表 —— preview 绝不打门户。
    const mappings = await readAll<StoredPortalMapping>(
      client, 'supplier_portal_product_mappings',
      'supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at',
    );
    const mappingFor = portalMappingResolver(mappings, new Date().toISOString());

    // 人工裁决实时读取，不硬编码任何数量。表缺失时按「无裁决」处理。
    const { data: resolutionRows } = await client
      .from('supplier_favorite_exception_resolutions')
      .select('supplier_product_id,supplier_account,resolution');
    const resolutions = ((resolutionRows ?? []) as any[])
      .filter((r) => r.supplier_account === 'pickup' || r.supplier_account === 'dropship')
      .filter((r) => ['keep_favorite', 'remove_favorite', 'no_action'].includes(r.resolution))
      .map((r) => ({
        supplier_account: r.supplier_account as SyncAccount,
        supplier_product_id: r.supplier_product_id as string,
        resolution: r.resolution as 'keep_favorite' | 'remove_favorite' | 'no_action',
      }));

    // 与执行器调用同一个函数 —— 确认页看到的就是将要执行的那份计划。
    const plan = buildFavoriteCleanupPlan({ target, favorites, resolutions, mappingFor });

    // 结构性不变量：残留不可能多于当前收藏。不成立说明快照被拼接过。
    const inconsistent = (['pickup', 'dropship'] as const)
      .some((a) => plan.accounts[a].extra > plan.accounts[a].current_favorites);
    if (inconsistent) {
      return { ok: false, error_code: 'DATA_INCONSISTENT', error_message: '收藏事实快照自相矛盾，请先刷新数据' };
    }

    const totals = {
      automatic_remove: plan.manual.auto_removals,
      manual_keep: plan.manual.manual_keep,
      manual_remove: plan.manual.manual_remove,
      manual_remove_blocked: plan.manual.manual_remove_blocked,
      manual_no_action: plan.manual.manual_no_action,
      unresolved_exception: plan.manual.unresolved_exceptions,
      executable_remove: plan.removals.pickup.length + plan.removals.dropship.length,
    };

    return envelope('sync-plan', {
      target_count: plan.target_count,
      // 本节点只做「清理未上线收藏」，不再计算新增方向。
      direction: 'remove_only',
      pickup: plan.accounts.pickup,
      dropship: plan.accounts.dropship,
      totals,
      executable: totals.executable_remove > 0,
      sync_execution_enabled: process.env.SUPPLIER_FAVORITE_REMOVAL_ENABLED === 'true',
    });
  }

  if (request.operation === 'pending-onboarding') {
    // 一次只序列化一页，首屏不再把 140 条商品卡全推给前端。
    const offset = request.offset ?? 0;
    const limit = request.limit ?? 20;
    const total = plan.pending_onboarding.length;
    const page = plan.pending_onboarding.slice(offset, offset + limit);
    return envelope('pending-onboarding', {
      accounts: plan.accounts,
      total,
      offset,
      limit,
      has_more: offset + page.length < total,
      items: page.map((d) => {
        const i = inputs.get(d.supplier_product_id);
        return {
          supplier_product_id: d.supplier_product_id,
          xself_sku: d.xself_sku,
          product_title: i?.product_title ?? null,
          primary_image: i?.primary_image ?? null,
          asset_state: i?.asset_state ?? null,
          protection_reasons: d.retain_reasons,
          in_pickup: d.in_pickup,
          in_dropship: d.in_dropship,
        };
      }),
    });
  }

  const target = inputs.get(request.sku ?? '');
  if (!target) return failure('sku_not_found', '该 Supplier Item Code 不在收藏事实中', { sku: request.sku });

  if (request.operation === 'manual-action') {
    if (!request.action) return failure('invalid_action', '缺少人工动作');
    if (!request.operator) return failure('operator_required', '人工动作必须记录操作人');
    const outcome = resolveManualAction(request.action, target.asset_state);
    if (!outcome.allowed) {
      return failure('action_not_allowed', `当前状态不允许该动作：${outcome.reason}`, {
        sku: request.sku, current_state: target.asset_state,
      });
    }
    const now = new Date().toISOString();
    const approving = request.action === 'approve_for_cleanup';
    const patch: Record<string, unknown> = {
      asset_state: outcome.next_asset_state,
      founder_status: outcome.next_founder_status,
      previous_state: target.asset_state,
      state_reason_code: outcome.reason,
      entered_state_at: now,
      updated_at: now,
      approved_at: approving ? now : null,
      approved_by: approving ? request.operator : null,
    };
    const write = await client.from('saved_assets').update(patch)
      .eq('supplier_product_id', request.sku!).select('supplier_product_id');
    if (write.error || (write.data ?? []).length !== 1) {
      return failure('saved_asset_write_failed', '状态写入未影响恰好一行', {
        sku: request.sku, rows: (write.data ?? []).length, detail: write.error?.message ?? null,
      });
    }
    await client.from('saved_asset_transitions').insert({
      supplier_product_id: request.sku,
      from_state: target.asset_state,
      to_state: outcome.next_asset_state,
      reason: outcome.reason,
      actor: request.operator,
      transitioned_at: now,
    });
    return envelope('manual-action', {
      sku: request.sku,
      action: request.action,
      from_state: target.asset_state,
      to_state: outcome.next_asset_state,
      founder_status: outcome.next_founder_status,
      rows_written: 1,
    });
  }

  // removal-preview — never sends anything, whatever the switch says.
  // 网站身份只来自门户证明过的映射表，读取时逐条重验。没有可用映射时 product_id 为 null，
  // 预览据此拒绝 —— 宁可报告缺口，也不拿来路不明的 id 去操作。
  const mappings = await readAll<StoredPortalMapping>(
    client, 'supplier_portal_product_mappings',
    'supplier_product_id,website_product_id,portal_sku,source,confidence,resolved_at,last_verified_at',
  );
  const mapping = portalMappingResolver(mappings, new Date().toISOString())(target.supplier_product_id);
  const preview = previewRemoval({
    supplier_product_id: target.supplier_product_id,
    product_id: mapping.product_id,
    verified_sku_for_product_id: mapping.verified_sku,
    approval: {
      asset_state: target.asset_state,
      founder_status: target.founder_status,
      approved_at: target.approved_at,
      approved_by: target.approved_by,
    },
    // The website session lives outside this process; the preview reports it as a gate rather
    // than pretending to hold one.
    session_present: false,
  });
  return envelope('removal-preview', {
    sku: request.sku,
    product_id_mapping: mapping,
    preview,
    // Restated explicitly so the UI can never misread a preview as an execution.
    favorite_removal_attempted: false,
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    const request = parseFavoriteBridgeRequest(await readStdin());
    const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '';
    // 这个分支只可能是数据库凭据缺失。面板打开走的是已同步事实，与 Pickup / Dropship
    // 读取器配置无关，所以文案必须指向数据库，指向供应商侧会把排查引到错误方向。
    response = !url || !key
      ? failure('DATABASE_NOT_CONFIGURED', '数据库连接未配置：缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY')
      : await executeFavoriteBridge(request, createClient(url, key, { auth: { persistSession: false } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const raw = message.split(':')[0];
    const known = new Set(['INVALID_REQUEST', 'INVALID_SKU', 'FAVORITE_READ_FAILED']);
    // 数据库读取失败要如实报出是哪张表、什么错，不能笼统成一句「请求处理失败」。
    response = failure(
      known.has(raw) ? raw : 'BRIDGE_FAILED',
      raw === 'FAVORITE_READ_FAILED' ? `收藏事实读取失败：${message.slice('FAVORITE_READ_FAILED:'.length)}` : '供应商收藏请求处理失败',
    );
    console.error(`[xone-supplier-favorite] ${raw}`);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1]?.endsWith('xoneSupplierFavoriteBridge.ts')) void main();
