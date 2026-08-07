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
import { previewRemoval } from '../src/services/supplierFavoriteRemoval';

// XOne 通过 Tauri 派生这个脚本，派生出的进程只继承 App 自己的环境变量，里面没有 Supabase
// 凭据。库存桥接同样在模块顶层加载 .env.local —— 少了这两行，面板打开时拿到的永远是
// NOT_CONFIGURED。Rust runner 以 xself-home-app 为工作目录，所以相对路径成立。
loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

const LOOP_ID = 'supplier-favorite-management';
const SCHEMA_VERSION = '1.0' as const;

export type FavoriteBridgeOperation =
  | 'summary'
  | 'pending-onboarding'
  | 'manual-action'
  | 'removal-preview';

export interface FavoriteBridgeRequest {
  schema_version: '1.0';
  operation: FavoriteBridgeOperation;
  sku?: string;
  action?: FavoriteManualAction;
  operator?: string;
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
  const ops: FavoriteBridgeOperation[] = ['summary', 'pending-onboarding', 'manual-action', 'removal-preview'];
  if (!r.operation || !ops.includes(r.operation)) throw new Error('INVALID_REQUEST');
  if (r.operation !== 'summary' && !String(r.sku ?? '').trim()) throw new Error('INVALID_SKU');
  return {
    schema_version: SCHEMA_VERSION,
    operation: r.operation,
    sku: String(r.sku ?? '').trim() || undefined,
    action: r.action,
    operator: String(r.operator ?? '').trim() || undefined,
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
export interface ProductIdMapping {
  product_id: number | null;
  /** The SKU the product_id resolves back to. Null when the reverse lookup is not unique. */
  verified_sku: string | null;
  status: 'unique' | 'multiple_product_ids' | 'shared_product_id' | 'not_mapped';
}

/**
 * Resolve one supplier SKU to the website's numeric product_id, and verify it in REVERSE.
 *
 * Reuses `inventory_cache`, which already stores both identifiers side by side — no second product
 * identity model is introduced. READ ONLY: this chain never writes that table, and the isolation
 * test enforces it.
 *
 * The reverse check matters more than the forward one. Removing a Favorite is irreversible and the
 * request carries the product_id, not the SKU, so a product_id shared by two SKUs would remove the
 * wrong item. Anything short of a clean one-to-one match is reported for human review.
 */
export function resolveProductIdMapping(
  sku: string,
  cache: ReadonlyArray<{ supplier_product_id: string | null; product_id: string | number | null }>,
): ProductIdMapping {
  const forward = new Set<string>();
  const reverse = new Map<string, Set<string>>();
  for (const row of cache) {
    if (!row.supplier_product_id || row.product_id === null || row.product_id === undefined) continue;
    const id = String(row.product_id);
    if (row.supplier_product_id === sku) forward.add(id);
    if (!reverse.has(id)) reverse.set(id, new Set());
    reverse.get(id)!.add(row.supplier_product_id);
  }
  if (forward.size === 0) return { product_id: null, verified_sku: null, status: 'not_mapped' };
  if (forward.size > 1) return { product_id: null, verified_sku: null, status: 'multiple_product_ids' };

  const id = [...forward][0];
  const owners = reverse.get(id) ?? new Set();
  if (owners.size !== 1) return { product_id: null, verified_sku: null, status: 'shared_product_id' };
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { product_id: null, verified_sku: null, status: 'not_mapped' };
  }
  return { product_id: numeric, verified_sku: [...owners][0], status: 'unique' };
}

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
  return (['pickup', 'dropship'] as const).map((account) => {
    const forAccount = rows.memberships.filter((r) => r.supplier_account === account);
    const failed = forAccount.filter((r) => r.sync_status !== 'ok');
    const observed = forAccount.map((r) => r.observed_at).filter(Boolean).sort();
    return {
      account,
      // Same predicate that decides whether a missing row means "not saved" or "unknown", so the
      // panel's per-account status can never disagree with how the diff was computed.
      ok: accountIsAuthoritative(rows.memberships, account),
      total: forAccount.filter((r) => r.sync_status === 'ok' && r.is_saved === true).length,
      observed_at: observed[observed.length - 1] ?? null,
      error: forAccount.length === 0 ? 'never_synced' : failed.length ? failed[0].sync_status : null,
    };
  });
}

export async function executeFavoriteBridge(
  request: FavoriteBridgeRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const rows = await loadRows(client);
  const plan = buildSupplierFavoritePlan(buildInputs(rows), accountStates(rows));
  const inputs = new Map(buildInputs(rows).map((i) => [i.supplier_product_id, i]));

  if (request.operation === 'summary') {
    return envelope('summary', { accounts: plan.accounts, counts: plan.counts });
  }

  if (request.operation === 'pending-onboarding') {
    return envelope('pending-onboarding', {
      accounts: plan.accounts,
      items: plan.pending_onboarding.map((d) => {
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
  // Resolve the website product_id from the existing inventory_cache mapping and verify it in
  // reverse. A non-unique mapping leaves product_id null, which the preview rejects.
  const cache = await readAll<{ supplier_product_id: string | null; product_id: string | number | null }>(
    client, 'inventory_cache', 'supplier_product_id,product_id',
  );
  const mapping = resolveProductIdMapping(target.supplier_product_id, cache);
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
