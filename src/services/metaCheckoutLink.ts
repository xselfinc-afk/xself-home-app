/**
 * Meta Shop checkout-link 解析 —— 纯函数，无 I/O、无网络、无数据库。
 *
 * 这是整个集成里唯一知道「Meta 的 URL 长什么样」的地方。把它单独隔离，是因为这个契约
 * 我们无法从 Meta 官方原文逐字证实：
 *
 *   已确认（多个独立第三方实现文档一致）：
 *     https://<host>/checkout?products=CONTENT_ID:QUANTITY,CONTENT_ID:QUANTITY&coupon=CODE
 *     ':' 分隔 id 与数量，',' 分隔多个商品，coupon 可选
 *
 *   未从 Meta 官方文档逐字证实。若日后发现真实格式不同，只需改这一个文件，
 *   还原逻辑（metaCartRestore.ts）与 UI 都不用动。
 *
 * CONTENT_ID 即 Meta Catalog 的 retailer_id，当前生产映射为 XSELF 的 `sku_custom`。
 *
 * 安全立场：URL 里除了「买哪个、买几件」之外的一切都不可信。价格、运费、库存、
 * 标题、图片一律不解析、不接受 —— 即使 Meta 传了也丢弃。真实商品事实一律回源。
 */

/** 单件商品的还原意图。注意这里只有标识与数量，没有任何金额。 */
export interface MetaCheckoutItem {
  /** Meta 的 CONTENT_ID / retailer_id，在当前生产中等于 sku_custom。 */
  retailerId: string;
  quantity: number;
}

export interface MetaCheckoutRequest {
  items: MetaCheckoutItem[];
  /** 原样携带，未经验证。绝不据此计算折扣 —— 见 metaCartRestore 的说明。 */
  couponCode: string | null;
  /** 解析过程中被丢弃的片段，用于诊断与测试断言，不面向用户。 */
  droppedTokens: string[];
}

export type MetaCheckoutParseError =
  | 'not_checkout_path'
  | 'missing_products'
  | 'no_valid_items'
  | 'too_many_items'
  | 'malformed_url';

export type MetaCheckoutParseResult =
  | { ok: true; request: MetaCheckoutRequest }
  | { ok: false; error: MetaCheckoutParseError };

/** 单件最大数量。防止 URL 传入荒谬数量拖垮还原与履约计算。 */
export const MAX_QUANTITY_PER_ITEM = 99;
/** 单次最多还原多少个 SKU。Meta 购物车不会很大，超出即视为异常输入。 */
export const MAX_ITEMS = 20;
/** retailer_id 的合理长度上限，防御超长 URL。 */
export const MAX_RETAILER_ID_LENGTH = 128;

/** 本 App 接受的 checkout 路径。同时支持 https 与内部测试用的自定义 scheme。 */
const CHECKOUT_PATHS = new Set(['/checkout', 'checkout', '/checkout/']);

/**
 * 判断一个 URL 是否是 Meta checkout 链接。
 * 刻意做得极窄：任何不是 /checkout 的链接都必须原样交还给别的处理器
 * （尤其是 Supabase 的 magic link，绝不能被这里吞掉）。
 */
export function isMetaCheckoutUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname || '';
    // 自定义 scheme 形如 xselfhome://checkout?... 时，host 才是 'checkout'
    return CHECKOUT_PATHS.has(path) || CHECKOUT_PATHS.has(u.hostname);
  } catch {
    return false;
  }
}

/** 解析单个 "id:qty" 片段。返回 null 表示该片段无效，应被丢弃而非让整条链接失败。 */
function parseToken(token: string): MetaCheckoutItem | null {
  const trimmed = token.trim();
  if (!trimmed) return null;

  // 只在最后一个冒号处切分：retailer_id 本身可能含冒号，数量不会。
  const sep = trimmed.lastIndexOf(':');
  if (sep <= 0 || sep === trimmed.length - 1) return null;

  const retailerId = trimmed.slice(0, sep).trim();
  const qtyRaw = trimmed.slice(sep + 1).trim();

  if (!retailerId || retailerId.length > MAX_RETAILER_ID_LENGTH) return null;
  // 只接受纯数字数量。'2.5'、'1e3'、'-1'、'abc' 全部拒绝。
  if (!/^\d+$/.test(qtyRaw)) return null;

  const quantity = Number.parseInt(qtyRaw, 10);
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) return null;

  return { retailerId, quantity };
}

/**
 * 解析 Meta checkout URL。
 *
 * 部分片段无效时不整条失败 —— 丢弃坏片段、保留好片段，并把丢弃内容记录在
 * droppedTokens 里。全部无效才返回错误。这样一个畸形片段不会让顾客完全无法结账。
 *
 * 重复的 retailerId 会被合并数量（Meta 理论上不该这么传，但合并比报错更贴近用户意图）。
 * 注意：这与「同一个 sku_custom 对应多个商品」是两回事，后者在还原层 fail-closed。
 */
export function parseMetaCheckoutUrl(rawUrl: string): MetaCheckoutParseResult {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'malformed_url' };
  }

  if (!isMetaCheckoutUrl(rawUrl)) return { ok: false, error: 'not_checkout_path' };

  // URLSearchParams 已完成百分号解码，无需也不应再手工 decodeURIComponent。
  const productsRaw = u.searchParams.get('products');
  if (productsRaw === null || productsRaw.trim() === '') {
    return { ok: false, error: 'missing_products' };
  }

  const tokens = productsRaw.split(',');
  if (tokens.length > MAX_ITEMS * 4) return { ok: false, error: 'too_many_items' };

  const merged = new Map<string, number>();
  const droppedTokens: string[] = [];

  for (const token of tokens) {
    const item = parseToken(token);
    if (!item) {
      if (token.trim()) droppedTokens.push(token.trim().slice(0, MAX_RETAILER_ID_LENGTH));
      continue;
    }
    const prev = merged.get(item.retailerId) ?? 0;
    merged.set(item.retailerId, Math.min(prev + item.quantity, MAX_QUANTITY_PER_ITEM));
  }

  if (merged.size === 0) return { ok: false, error: 'no_valid_items' };
  if (merged.size > MAX_ITEMS) return { ok: false, error: 'too_many_items' };

  const couponRaw = u.searchParams.get('coupon');
  const couponCode = couponRaw && couponRaw.trim() ? couponRaw.trim().slice(0, 64) : null;

  return {
    ok: true,
    request: {
      items: [...merged.entries()].map(([retailerId, quantity]) => ({ retailerId, quantity })),
      couponCode,
      droppedTokens,
    },
  };
}

/**
 * URL 里出现即被忽略的参数名。存在于此仅为让「我们确实丢弃了这些」可被测试断言，
 * 解析器本身从不读取它们。
 */
export const IGNORED_UNTRUSTED_PARAMS: readonly string[] = [
  'price', 'prices', 'amount', 'total', 'subtotal', 'currency',
  'shipping', 'shipping_fee', 'delivery_fee', 'tax',
  'availability', 'in_stock', 'title', 'name', 'image', 'image_link',
];
