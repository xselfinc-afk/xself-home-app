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

async function loadRows(client: SupabaseClient): Promise<Rows> {
  const [m, a, p, s] = await Promise.all([
    client.from('supplier_favorite_memberships').select('supplier_product_id,supplier_account,is_saved,sync_status,observed_at'),
    client.from('saved_assets').select('supplier_product_id,asset_state,founder_status,approved_at,approved_by'),
    client.from('standardized_products').select('supplier_product_id,sku_custom,published,delist_reason,product_title,primary_image'),
    client.from('supplier_products').select('supplier_product_id'),
  ]);
  for (const r of [m, a, p, s]) {
    if (r.error) throw new Error(`FAVORITE_READ_FAILED:${r.error.message}`);
  }
  return {
    memberships: (m.data ?? []) as Rows['memberships'],
    assets: (a.data ?? []) as Rows['assets'],
    products: (p.data ?? []) as Rows['products'],
    supplierManaged: new Set(((s.data ?? []) as Array<{ supplier_product_id: string }>).map((r) => r.supplier_product_id)),
  };
}

/** Assemble the per-SKU inputs. A SKU with no membership row for an account reads as UNKNOWN. */
export function buildInputs(rows: Rows): SupplierFavoriteInput[] {
  const byAccount = new Map<string, Map<string, Rows['memberships'][number]>>();
  for (const r of rows.memberships) {
    if (!byAccount.has(r.supplier_account)) byAccount.set(r.supplier_account, new Map());
    byAccount.get(r.supplier_account)!.set(r.supplier_product_id, r);
  }
  const assets = new Map(rows.assets.map((r) => [r.supplier_product_id, r]));
  const products = new Map(rows.products.map((r) => [r.supplier_product_id, r]));

  const skus = new Set<string>([
    ...rows.memberships.map((r) => r.supplier_product_id),
    ...rows.assets.map((r) => r.supplier_product_id),
  ]);

  return [...skus].map((sku) => {
    const pickup = byAccount.get('pickup')?.get(sku);
    const dropship = byAccount.get('dropship')?.get(sku);
    const asset = assets.get(sku);
    const product = products.get(sku);
    // A membership row whose sync_status is not 'ok' is an UNKNOWN, whatever is_saved happens to
    // hold. An absent row is likewise unknown — never "not saved".
    const factOf = (row?: Rows['memberships'][number]): boolean | null =>
      !row || row.sync_status !== 'ok' ? null : row.is_saved;

    const matchingProducts = rows.products.filter((r) => r.supplier_product_id === sku);
    return {
      supplier_product_id: sku,
      xself_sku: product?.sku_custom ?? null,
      product_title: product?.product_title ?? null,
      primary_image: product?.primary_image ?? null,
      pickup_is_saved: factOf(pickup),
      dropship_is_saved: factOf(dropship),
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
      // No rows at all means the account has never been read — not that it read clean.
      ok: forAccount.length > 0 && failed.length === 0,
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
  const preview = previewRemoval({
    supplier_product_id: target.supplier_product_id,
    // Mapping is supplied by a later phase; with none present the preview reports the gap rather
    // than inventing a product_id.
    product_id: null,
    verified_sku_for_product_id: null,
    approval: {
      asset_state: target.asset_state,
      founder_status: target.founder_status,
      approved_at: target.approved_at,
      approved_by: target.approved_by,
    },
    session_present: false,
  });
  return envelope('removal-preview', {
    sku: request.sku,
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
    const url = process.env.SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    response = !url || !key
      ? failure('NOT_CONFIGURED', '供应商收藏读取器尚未配置')
      : await executeFavoriteBridge(request, createClient(url, key, { auth: { persistSession: false } }));
  } catch (error) {
    const raw = error instanceof Error ? error.message.split(':')[0] : 'BRIDGE_FAILED';
    const known = new Set(['INVALID_REQUEST', 'INVALID_SKU', 'FAVORITE_READ_FAILED']);
    response = failure(known.has(raw) ? raw : 'BRIDGE_FAILED', '供应商收藏请求处理失败');
    console.error(`[xone-supplier-favorite] ${raw}`);
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1]?.endsWith('xoneSupplierFavoriteBridge.ts')) void main();
