import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseEnv } from 'dotenv';

export type SupplierAccountRole = 'pickup' | 'dropship';
export type SupplierReadCapability = 'favorites' | 'product_detail' | 'availability' | 'inventory';

export type SupplierTargetedReadErrorCode =
  | 'favorites_not_synchronized'
  | 'pickup_account_read_error'
  | 'dropship_account_read_error'
  | 'supplier_product_not_found'
  | 'availability_read_error'
  | 'inventory_read_error';

export class SupplierTargetedReadError extends Error {
  constructor(
    readonly code: SupplierTargetedReadErrorCode,
    message: string,
    readonly account: SupplierAccountRole,
    readonly capability: SupplierReadCapability,
  ) {
    super(message);
    this.name = 'SupplierTargetedReadError';
  }
}

export interface SupplierAccountConfig {
  role: SupplierAccountRole;
  source: '.env.giga-alt.local' | '.env.giga-delivery.local';
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface SupplierWarehouseQuantity {
  warehouse_code: string | null;
  warehouse_name: string | null;
  available_qty_min: number;
  state: string | null;
}

export interface SupplierAccountProductFacts {
  account: SupplierAccountRole;
  account_source: string;
  lookup_identity: string;
  favorite: boolean;
  detail_found: boolean;
  available: boolean;
  price: number;
  total_available_qty: number;
  warehouses: SupplierWarehouseQuantity[];
  checked_at: string;
}

type FetchLike = typeof fetch;

const ENDPOINTS = {
  favorites: '/b2b-overseas-api/v1/buyer/product/skus/v1',
  product_detail: '/b2b-overseas-api/v1/buyer/product/detailInfo/v1',
  availability: '/b2b-overseas-api/v1/buyer/product/price/v1',
  inventory: '/b2b-overseas-api/v1/buyer/inventory/quantity/v2',
} as const;

function accountReadCode(role: SupplierAccountRole): SupplierTargetedReadErrorCode {
  return role === 'pickup' ? 'pickup_account_read_error' : 'dropship_account_read_error';
}

function readEnvFile(repo: string, filename: string): Record<string, string> {
  const absolute = path.join(repo, filename);
  if (!fs.existsSync(absolute)) return {};
  return parseEnv(fs.readFileSync(absolute));
}

export function loadSupplierAccountConfig(
  role: SupplierAccountRole,
  repo = process.cwd(),
): SupplierAccountConfig {
  if (role === 'pickup') {
    const values = readEnvFile(repo, '.env.giga-alt.local');
    const config = {
      role,
      source: '.env.giga-alt.local' as const,
      baseUrl: values.SUPPLIER_API_BASE_URL ?? '',
      clientId: values.SUPPLIER_CLIENT_ID ?? '',
      clientSecret: values.SUPPLIER_CLIENT_SECRET ?? '',
    };
    if (!config.baseUrl || !config.clientId || !config.clientSecret) {
      throw new SupplierTargetedReadError(accountReadCode(role), 'Pickup 账号读取配置不完整', role, 'favorites');
    }
    return config;
  }

  const values = readEnvFile(repo, '.env.giga-delivery.local');
  const config = {
    role,
    source: '.env.giga-delivery.local' as const,
    baseUrl: values.SUPPLIER_DELIVERY_API_BASE_URL ?? '',
    clientId: values.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID ?? '',
    clientSecret: values.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET ?? '',
  };
  if (!config.baseUrl || !config.clientId || !config.clientSecret) {
    throw new SupplierTargetedReadError(accountReadCode(role), 'Dropship 账号读取配置不完整', role, 'favorites');
  }
  return config;
}

function nonce(length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

function signature(config: SupplierAccountConfig, endpoint: string, timestamp: string, requestNonce: string): string {
  const message = `${config.clientId}&${endpoint}&${timestamp}&${requestNonce}`;
  const key = `${config.clientId}&${config.clientSecret}&${requestNonce}`;
  const hex = crypto.createHmac('sha256', key).update(message).digest('hex');
  return Buffer.from(hex, 'utf8').toString('base64');
}

async function post(
  config: SupplierAccountConfig,
  capability: SupplierReadCapability,
  body: Record<string, unknown>,
  fetcher: FetchLike,
): Promise<any> {
  const endpoint = ENDPOINTS[capability];
  const timestamp = Date.now().toString();
  const requestNonce = nonce();
  let response: Response;
  try {
    response = await fetcher(`${config.baseUrl.replace(/\/$/, '')}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-id': config.clientId,
        timestamp,
        nonce: requestNonce,
        sign: signature(config, endpoint, timestamp, requestNonce),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new SupplierTargetedReadError(
      capability === 'availability' ? 'availability_read_error'
        : capability === 'inventory' ? 'inventory_read_error'
          : accountReadCode(config.role),
      `${config.role} ${capability} 网络读取失败`,
      config.role,
      capability,
    );
  }

  let payload: any = null;
  try { payload = JSON.parse(await response.text()); } catch { /* classified below */ }
  const code = payload?.code;
  const businessFailed = payload?.success === false
    || (code !== undefined && code !== null && String(code) !== '200');
  if (!response.ok || !payload || businessFailed) {
    throw new SupplierTargetedReadError(
      capability === 'availability' ? 'availability_read_error'
        : capability === 'inventory' ? 'inventory_read_error'
          : accountReadCode(config.role),
      `${config.role} ${capability} 接口未返回可靠结果`,
      config.role,
      capability,
    );
  }
  return payload;
}

export function extractSupplierRows(payload: unknown): Array<Record<string, any>> | null {
  if (Array.isArray(payload)) return payload as Array<Record<string, any>>;
  const data = (payload as any)?.data;
  if (Array.isArray(data)) return data;
  for (const candidate of [data?.records, data?.list, data?.items, (payload as any)?.records, (payload as any)?.list]) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function rowIdentity(row: Record<string, any>): string {
  return String(row.sku ?? row.skuCode ?? row.skuId ?? '').trim();
}

function exactRow(payload: unknown, lookupIdentity: string): Record<string, any> | null {
  return extractSupplierRows(payload)?.find((row) => rowIdentity(row) === lookupIdentity) ?? null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return null;
}

function numericValue(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function warehouseState(code: string): string | null {
  if (/^CA\d/i.test(code)) return 'CA';
  if (/^AT/i.test(code)) return 'GA';
  if (/^NJ/i.test(code)) return 'NJ';
  if (/^TX/i.test(code)) return 'TX';
  return null;
}

export function normalizeInventoryPayload(
  payload: unknown,
  lookupIdentity: string,
): { total_available_qty: number; warehouses: SupplierWarehouseQuantity[] } | null {
  const row = exactRow(payload, lookupIdentity);
  const distributions = row?.sellerInventoryInfo?.sellerInventoryDistribution;
  if (!row || !Array.isArray(distributions)) return null;
  if (distributions.length === 0) {
    const accountTotal = numericValue(row?.sellerInventoryInfo?.sellerAvailableInventory);
    if (accountTotal === null) return null;
    return {
      total_available_qty: accountTotal,
      warehouses: [{
        warehouse_code: null,
        warehouse_name: null,
        available_qty_min: accountTotal,
        state: null,
      }],
    };
  }
  const warehouses: SupplierWarehouseQuantity[] = [];
  for (const distribution of distributions) {
    const quantity = numericValue(
      distribution?.availableQtyMin,
      distribution?.availableQty,
      distribution?.quantity,
      distribution?.qty,
    );
    if (quantity === null) return null;
    const code = String(
      distribution?.warehouseCode
      ?? distribution?.sellerInventoryWarehouseCode
      ?? distribution?.warehouse_code
      ?? distribution?.code
      ?? '',
    ).trim();
    warehouses.push({
      warehouse_code: code || null,
      warehouse_name: String(distribution?.warehouseName ?? distribution?.warehouse_name ?? '').trim() || null,
      available_qty_min: quantity,
      state: warehouseState(code),
    });
  }
  return {
    total_available_qty: warehouses.reduce((sum, warehouse) => sum + warehouse.available_qty_min, 0),
    warehouses,
  };
}

export interface AccountFavoritesListing {
  role: SupplierAccountRole;
  account_source: string;
  /** Every identity the account has saved. Only trustworthy when `complete` is true. */
  skus: string[];
  pages_fetched: number;
  /** False means the listing is partial — callers must treat it as UNKNOWN, never as "not saved". */
  complete: boolean;
  observed_at: string;
}

/**
 * Page through one account's entire Favorites ("My Saved Items") list.
 *
 * Reuses the same config cascade, signed `post()` and pagination that `favoriteContains` uses —
 * this is the list-shaped sibling of the membership check, not a second client. It exists here
 * rather than in `gigaSavedItems.ts` because that module resolves credentials by mutating
 * process-wide `SUPPLIER_*` env once per process, which makes reading a SECOND account in the same
 * run impossible. `SupplierAccountConfig` is per-call, so pickup and dropship can both be read.
 *
 * Throws rather than returning a short list: a partial read must never look like a small Favorites.
 */
export async function listAccountFavorites(
  role: SupplierAccountRole,
  options: { repo?: string; fetcher?: FetchLike; config?: SupplierAccountConfig; maxPages?: number } = {},
): Promise<AccountFavoritesListing> {
  const config = options.config ?? loadSupplierAccountConfig(role, options.repo ?? process.cwd());
  if (config.role !== role) {
    throw new SupplierTargetedReadError(accountReadCode(role), '供应商账号配置与目标账号不匹配', role, 'favorites');
  }
  const fetcher = options.fetcher ?? fetch;
  const maxPages = options.maxPages ?? 200;

  const skus = new Set<string>();
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await post(config, 'favorites', { page, pageSize: 100 }, fetcher);
    const rows = extractSupplierRows(payload);
    if (!rows) {
      throw new SupplierTargetedReadError(accountReadCode(role), `${role} Favorites 响应不可解析`, role, 'favorites');
    }
    for (const row of rows) {
      const identity = String(row?.sku ?? '').trim();
      if (identity) skus.add(identity);
    }
    totalPages = Math.max(1, Number(payload?.data?.pageInfo?.totalPage ?? 1) || 1);
    page += 1;
  } while (page <= totalPages && page <= maxPages);

  const complete = page > totalPages;
  if (!complete) {
    throw new SupplierTargetedReadError(accountReadCode(role), `${role} Favorites 分页未读完`, role, 'favorites');
  }
  return {
    role,
    account_source: config.source,
    skus: [...skus],
    pages_fetched: page - 1,
    complete: true,
    observed_at: new Date().toISOString(),
  };
}

async function favoriteContains(
  config: SupplierAccountConfig,
  lookupIdentity: string,
  fetcher: FetchLike,
): Promise<boolean> {
  let page = 1;
  let totalPages = 1;
  do {
    const payload = await post(config, 'favorites', { page, pageSize: 100 }, fetcher);
    const rows = extractSupplierRows(payload);
    if (!rows) {
      throw new SupplierTargetedReadError(accountReadCode(config.role), `${config.role} Favorites 响应不可解析`, config.role, 'favorites');
    }
    if (rows.some((row) => rowIdentity(row) === lookupIdentity)) return true;
    totalPages = Math.max(1, Number(payload?.data?.pageInfo?.totalPage ?? 1) || 1);
    page += 1;
  } while (page <= totalPages);
  return false;
}

export async function readSupplierAccountProductFacts(
  role: SupplierAccountRole,
  lookupIdentity: string,
  options: { repo?: string; fetcher?: FetchLike; config?: SupplierAccountConfig } = {},
): Promise<SupplierAccountProductFacts> {
  const identity = lookupIdentity.trim();
  if (!identity) {
    throw new SupplierTargetedReadError('supplier_product_not_found', '供应商查询身份为空', role, 'product_detail');
  }
  const config = options.config ?? loadSupplierAccountConfig(role, options.repo ?? process.cwd());
  if (config.role !== role) {
    throw new SupplierTargetedReadError(accountReadCode(role), '供应商账号配置与目标账号不匹配', role, 'favorites');
  }
  const fetcher = options.fetcher ?? fetch;
  const favorite = await favoriteContains(config, identity, fetcher);
  if (!favorite) {
    throw new SupplierTargetedReadError('favorites_not_synchronized', `${role} Favorites 尚未包含目标商品`, role, 'favorites');
  }

  const detailPayload = await post(config, 'product_detail', { skus: [identity] }, fetcher);
  const detail = exactRow(detailPayload, identity);
  if (!detail) {
    throw new SupplierTargetedReadError('supplier_product_not_found', `${role} 商品详情未返回目标商品`, role, 'product_detail');
  }

  const pricePayload = await post(config, 'availability', { skus: [identity] }, fetcher);
  const priceRow = exactRow(pricePayload, identity);
  if (!priceRow) {
    throw new SupplierTargetedReadError('supplier_product_not_found', `${role} 价格接口未返回目标商品`, role, 'availability');
  }
  const available = booleanValue(priceRow.skuAvailable ?? detail.skuAvailable);
  const price = numericValue(
    priceRow.price,
    priceRow.salePrice,
    priceRow.sellingPrice,
    priceRow.wholesalePrice,
    priceRow.unitPrice,
  );
  if (available === null || price === null || price <= 0) {
    throw new SupplierTargetedReadError('availability_read_error', `${role} 可售或价格字段不可确认`, role, 'availability');
  }

  const inventoryPayload = await post(config, 'inventory', { skus: [identity] }, fetcher);
  const inventory = normalizeInventoryPayload(inventoryPayload, identity);
  if (!inventory) {
    throw new SupplierTargetedReadError('inventory_read_error', `${role} 库存结构不可确认`, role, 'inventory');
  }

  return {
    account: role,
    account_source: config.source,
    lookup_identity: identity,
    favorite: true,
    detail_found: true,
    available,
    price,
    total_available_qty: inventory.total_available_qty,
    warehouses: inventory.warehouses,
    checked_at: new Date().toISOString(),
  };
}
