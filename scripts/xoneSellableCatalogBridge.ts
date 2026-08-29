/**
 * XOne ← XSELF：可售商品目录只读桥。
 *
 * 只做一件事：把 `public.sellable_products` 分页读出来交给 XOne 的 Meta Commerce。
 *
 * ── 为什么要有这个桥 ────────────────────────────────────────────────────────
 * XOne 之前经由 `xoneInventoryLifecycleBridge` 的生命周期桶取商品，
 * 那是「库存生命周期在盯着谁」的集合，不是「App 上真正在卖什么」的集合。
 * App 的浏览/列表/详情读的都是 `sellable_products`，它才是权威可售集合。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────────
 * 只读。没有任何 insert/update/delete/rpc，也不碰视图定义、不碰生命周期规则、
 * 不碰供应商收藏。
 *
 * ── 为什么在这里做字段解析，而不是让 XOne 自己解析 ──────────────────────────
 * 标题与价格的口径由 `PRODUCT_DISPLAY_RULES.md` 规定，实现在
 * `src/services/productResolvers.ts`。这里**直接复用同一个 resolver**，
 * 好处是 Meta 上架的标题与价格与 App 里显示的逐字一致；
 * 若在 XOne 那边另写一套，两边迟早会分叉，而分叉表现为「Meta 上的标题和 App 不一样」。
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { resolveCustomerPrice, resolveProductTitle } from '../src/services/productResolvers';

loadEnv({ path: '.env.local' });
loadEnv({ path: '.env' });

export const XONE_SELLABLE_CATALOG_SCHEMA_VERSION = '1.0';

/**
 * Supabase Storage 公开镜像的基址。
 *
 * 构造规则与 App 的权威实现 `src/utils/imageSource.ts` 逐字一致：
 *   {SUPABASE_URL}/storage/v1/object/public/product-images/{mirror_path}
 *
 * ── 与 App 的一处**刻意**差异 ───────────────────────────────────────────────
 * App 的 `sourceUrl()` 受 `EXPO_PUBLIC_PREFER_MIRROR` 开关控制，关掉就回落到
 * 供应商 URL —— 那是 App 的显示偏好与回滚阀门。
 *
 * 这里**不继承那个开关**。供应商图是 GIGA 的带签名地址（?x-cc/x-cu/x-ct），会过期；
 * Meta 会定期重抓商品图，把会过期的地址当长期主图，过一阵子商品就变成没有图。
 * 所以镜像对 Meta 不是偏好而是硬要求：有镜像才给 URL，没有就给 null，
 * 由 XOne 判定为 blocker —— 宁可不上架，也不上架一张会烂掉的图。
 */
const MIRROR_STORAGE_BASE = (() => {
  const base = (process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '')
    .replace(/\/+$/, '');
  return base ? `${base}/storage/v1/object/public/product-images` : '';
})();

/** 相对镜像路径 → 长期公开 URL。没有镜像或没配置基址时返回 null，绝不回落到会过期的供应商图。 */
export function mirrorImageUrl(mirrorPath: string | null): string | null {
  if (!mirrorPath || !MIRROR_STORAGE_BASE) return null;
  return `${MIRROR_STORAGE_BASE}/${mirrorPath.replace(/^\/+/, '')}`;
}

/** 视图的 WHERE 已经保证 published/in_stock/qty>0/price>0/有图有标题，这里只取需要的列。 */
const SELECT_FIELDS = [
  'id',
  'supplier_product_id',
  'sku_custom',
  'supplier_sku',
  'product_title',
  'product_title_display',
  'optimized_title',
  'short_description',
  'price',
  'selling_price',
  'original_price',
  'total_available_qty',
  'inventory_status',
  'inventory_last_synced_at',
  'primary_image',
  'primary_image_mirror_path',
  'gallery_images_json',
  'category_code',
  'category_label',
  'category_display',
  'scene_code',
  'specifications_json',
  'key_features_json',
  'material',
  'dimensions',
  'weight',
  'color',
  'published',
  'updated_at',
].join(',');

/** 单页上限。视图目前几百行，500 一页足够，同时不给数据库压力。 */
const MAX_LIMIT = 500;

type BridgeRequest = {
  schema_version: '1.0';
  operation: 'sellable-catalog';
  limit?: number;
  cursor?: number;
};

type BridgeErrorCode = 'INVALID_REQUEST' | 'NOT_CONFIGURED' | 'READ_FAILED';

export type SellableCatalogItem = {
  supplier_product_id: string;
  sku_custom: string | null;
  supplier_sku: string | null;
  /** 与 App 完全一致的展示标题（resolveProductTitle）。 */
  title: string;
  /** 原始三个标题字段一并带出，便于排查两边不一致时定位。 */
  product_title: string | null;
  product_title_display: string | null;
  optimized_title: string | null;
  short_description: string | null;
  /** 与 App 完全一致的顾客价（resolveCustomerPrice）；单位为元。 */
  selling_price: number;
  raw_selling_price: number | null;
  raw_price: number | null;
  original_price: number | null;
  total_available_qty: number | null;
  inventory_status: string | null;
  inventory_last_synced_at: string | null;
  /** 上游供应商图（视图保证非空）。 */
  primary_image: string | null;
  /** Supabase 镜像相对路径。是否启用镜像是 App 侧配置，这里只如实带出。 */
  primary_image_mirror_path: string | null;
  /**
   * 主图的长期公开镜像 URL。null = 这件商品还没被镜像。
   *
   * XOne 的 Meta 投影只认这个字段当主图 —— `primary_image` 会过期，不能给 Meta。
   */
  primary_image_mirror_url: string | null;
  /** 已去重（剔除与主图相同的项），与 adaptStandardizedRow 同一规则。 */
  gallery_images: string[];
  category_code: string | null;
  category_label: string | null;
  category_display: string | null;
  /** App 用 specifications_json['Category'] || category_code 作为分类展示。 */
  category_resolved: string | null;
  scene_code: string | null;
  specifications: Record<string, string>;
  key_features: string[];
  material: string | null;
  dimensions: string | null;
  weight: string | null;
  color: string | null;
  published: boolean | null;
  updated_at: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' && raw.trim().length > 0) out[key] = raw;
  }
  return out;
}

export function mapSellableRow(row: Record<string, unknown>): SellableCatalogItem {
  const primaryImage = asString(row.primary_image);
  const gallery = asStringArray(row.gallery_images_json).filter((url) => url !== primaryImage);
  const specifications = asStringRecord(row.specifications_json);

  return {
    supplier_product_id: String(row.supplier_product_id ?? ''),
    sku_custom: asString(row.sku_custom),
    supplier_sku: asString(row.supplier_sku),
    // 与 App 同一个 resolver：optimized_title → product_title_display → product_title
    title: resolveProductTitle({
      optimized_title: asString(row.optimized_title) ?? undefined,
      product_title_display: asString(row.product_title_display) ?? undefined,
      product_title: asString(row.product_title) ?? undefined,
    }),
    product_title: asString(row.product_title),
    product_title_display: asString(row.product_title_display),
    optimized_title: asString(row.optimized_title),
    short_description: asString(row.short_description),
    // 与 App 同一个 resolver：selling_price 为正则用它，否则退回 price
    selling_price: resolveCustomerPrice({
      selling_price: asNumber(row.selling_price),
      price: asNumber(row.price),
    }),
    raw_selling_price: asNumber(row.selling_price),
    raw_price: asNumber(row.price),
    original_price: asNumber(row.original_price),
    total_available_qty: asNumber(row.total_available_qty),
    inventory_status: asString(row.inventory_status),
    inventory_last_synced_at: asString(row.inventory_last_synced_at),
    primary_image: primaryImage,
    primary_image_mirror_path: asString(row.primary_image_mirror_path),
    primary_image_mirror_url: mirrorImageUrl(asString(row.primary_image_mirror_path)),
    gallery_images: gallery,
    category_code: asString(row.category_code),
    category_label: asString(row.category_label),
    category_display: asString(row.category_display),
    category_resolved: specifications.Category ?? asString(row.category_code),
    scene_code: asString(row.scene_code),
    specifications,
    key_features: asStringArray(row.key_features_json),
    material: asString(row.material),
    dimensions: asString(row.dimensions),
    weight: asString(row.weight),
    color: asString(row.color),
    published: typeof row.published === 'boolean' ? row.published : null,
    updated_at: asString(row.updated_at),
  };
}

function failure(code: BridgeErrorCode, message: string): Record<string, unknown> {
  return {
    schema_version: XONE_SELLABLE_CATALOG_SCHEMA_VERSION,
    ok: false,
    operation: 'sellable-catalog',
    error: { code, message },
    platform_write_attempted: false,
  };
}

export async function executeSellableCatalog(
  request: BridgeRequest,
  client: SupabaseClient,
): Promise<Record<string, unknown>> {
  const limit = Math.min(Math.max(request.limit ?? MAX_LIMIT, 1), MAX_LIMIT);
  const cursor = Math.max(request.cursor ?? 0, 0);

  const { data, error, count } = await client
    .from('sellable_products')
    .select(SELECT_FIELDS, { count: 'exact' })
    .order('sku_custom', { ascending: true })
    .range(cursor, cursor + limit - 1);

  if (error) {
    return failure('READ_FAILED', error.message);
  }

  const rows = Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : [];
  const items = rows.map(mapSellableRow);
  const nextCursor = cursor + rows.length;
  const total = typeof count === 'number' ? count : null;

  return {
    schema_version: XONE_SELLABLE_CATALOG_SCHEMA_VERSION,
    ok: true,
    operation: 'sellable-catalog',
    total,
    cursor,
    next_cursor: total !== null && nextCursor < total ? nextCursor : null,
    items,
    source_observed_at: new Date().toISOString(),
    // 只读协议断言：这个桥永不写平台，XOne 侧会校验这个字段。
    platform_write_attempted: false,
  };
}

function parseRequest(raw: string): BridgeRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('INVALID_REQUEST');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('INVALID_REQUEST');
  const req = parsed as Record<string, unknown>;
  if (req.schema_version !== '1.0') throw new Error('INVALID_REQUEST');
  if (req.operation !== 'sellable-catalog') throw new Error('INVALID_REQUEST');
  const limit = typeof req.limit === 'number' && Number.isFinite(req.limit) ? req.limit : undefined;
  const cursor = typeof req.cursor === 'number' && Number.isFinite(req.cursor) ? req.cursor : undefined;
  return { schema_version: '1.0', operation: 'sellable-catalog', limit, cursor };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim() || raw.length > 16_384) throw new Error('INVALID_REQUEST');
  return raw;
}

async function main(): Promise<void> {
  let response: Record<string, unknown>;
  try {
    const request = parseRequest(await readStdin());
    const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      ?? process.env.SUPABASE_SERVICE_KEY
      ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
      ?? '';
    if (!url || !key) {
      response = failure('NOT_CONFIGURED', '可售商品目录读取器尚未配置');
    } else {
      const client = createClient(url, key, { auth: { persistSession: false } });
      response = await executeSellableCatalog(request, client);
    }
  } catch (error) {
    const code: BridgeErrorCode =
      error instanceof Error && error.message === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'READ_FAILED';
    response = failure(code, code === 'INVALID_REQUEST' ? '读取请求无效' : '可售商品目录读取失败');
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1]?.endsWith('xoneSellableCatalogBridge.ts')) {
  void main();
}
