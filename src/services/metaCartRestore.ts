/**
 * 把 Meta checkout 链接还原成 XSELF 自己的购物车行 —— 纯逻辑层，依赖注入，可完整单测。
 *
 * 这一层只做一件事：把「Meta 说的 retailer_id + 数量」翻译成「XSELF 认可的商品 + 数量」。
 * 它不碰价格、不碰运费、不碰履约、不碰支付 —— 那些各自已有权威实现：
 *
 *   商品售价   → create-checkout-order 结账时重读 selling_price（客户端价只是展示快照）
 *   Pickup/Delivery 费用 → plan-fulfillment（Pickup 恒为 $0，Delivery 动态计算）
 *   最终收费   → create-checkout-order 的 subtotal + shipping + tax
 *
 * 因此本文件刻意不导出任何计算金额的函数。它产出的 price 字段仅供购物车 UI 展示，
 * 与既有「加入购物车」路径完全一致。
 *
 * fail-closed 的三种情况，都会让整条链接失败而不是悄悄换一个商品：
 *   1. retailer_id 匹配到多于一个商品（sku_custom 已证实不唯一，例如 XH-SF-LR-S00039）
 *   2. retailer_id 匹配不到任何在售商品
 *   3. 商品已下架 / 缺货 / 不可售
 */
import type { MetaCheckoutItem, MetaCheckoutRequest } from './metaCheckoutLink';

/** sellable_products 里用于解析身份的最小投影。 */
export interface SellableIdentityRow {
  sku_custom: string;
  supplier_product_id: string;
}

/** 还原成功的一行，字段与既有 CartItem（去掉 qty）保持一致。 */
export interface RestoredLine {
  sku: string;
  productId: string;
  name: string;
  price: number;
  img: string;
  qty: number;
  color: string;
  size: string;
}

export type RestoreFailureReason =
  /** sku_custom 命中多行 —— 无法确定是哪一个商品，必须停下。 */
  | 'ambiguous_retailer_id'
  /** 在当前在售集合里找不到。可能已下架，或 Meta Catalog 落后于 XSELF。 */
  | 'unknown_retailer_id'
  /** 找到了身份，但权威商品事实读不出来（已不可售 / 已删除）。 */
  | 'product_unavailable'
  /** 商品事实读取过程本身失败（网络 / 数据库），与「商品不存在」区分开。 */
  | 'lookup_failed';

export interface RestoreFailure {
  retailerId: string;
  reason: RestoreFailureReason;
  /** 面向用户的中性说明，不泄漏内部细节。 */
  message: string;
}

export interface RestoreOutcome {
  lines: RestoredLine[];
  failures: RestoreFailure[];
  /** 只要有任何一件商品失败就为 false —— 绝不静默少买或换货。 */
  ok: boolean;
  /** 原样透传，未经验证；是否生效由既有服务端折扣体系决定。 */
  couponCode: string | null;
}

/** 注入的商品事实读取器。生产实现应为 productFamilyService.loadProductDetail。 */
export interface ProductFactsLoader {
  (supplierProductId: string): Promise<{
    id: string;
    sku?: string;
    name: string;
    price: number;
    image?: string;
    images?: string[];
    color?: string;
    size?: string;
  } | null>;
}

/** 注入的身份解析器：一次性查出所有 retailer_id 在当前在售集合里的对应行。 */
export interface SellableIdentityLookup {
  (retailerIds: string[]): Promise<SellableIdentityRow[]>;
}

const MESSAGES: Record<RestoreFailureReason, string> = {
  ambiguous_retailer_id: '这件商品在我们系统中存在多个版本，暂时无法自动加入购物车。',
  unknown_retailer_id: '这件商品目前无法购买，可能已经下架。',
  product_unavailable: '这件商品目前缺货或已停售。',
  lookup_failed: '读取商品信息时出了点问题，请稍后再试。',
};

/**
 * 把 retailer_id 解析成唯一的 supplier_product_id。
 *
 * 纯函数，便于对「重复 / 缺失」这两个关键分支做穷举测试。
 * 命中多行时返回 ambiguous 而不是随便挑一行 —— 挑错会让顾客买到不是他看到的东西。
 */
export function resolveIdentity(
  retailerIds: readonly string[],
  rows: readonly SellableIdentityRow[],
): { resolved: Map<string, string>; failures: RestoreFailure[] } {
  const bySku = new Map<string, string[]>();
  for (const r of rows) {
    const list = bySku.get(r.sku_custom) ?? [];
    list.push(r.supplier_product_id);
    bySku.set(r.sku_custom, list);
  }

  const resolved = new Map<string, string>();
  const failures: RestoreFailure[] = [];

  for (const rid of retailerIds) {
    const matches = bySku.get(rid);
    if (!matches || matches.length === 0) {
      failures.push({ retailerId: rid, reason: 'unknown_retailer_id', message: MESSAGES.unknown_retailer_id });
      continue;
    }
    // 去重后仍多于一个 → 同一个 sku_custom 对应不同实体商品，无法判定。
    const distinct = [...new Set(matches)];
    if (distinct.length > 1) {
      failures.push({ retailerId: rid, reason: 'ambiguous_retailer_id', message: MESSAGES.ambiguous_retailer_id });
      continue;
    }
    resolved.set(rid, distinct[0]);
  }

  return { resolved, failures };
}

/**
 * 完整还原流程。任何一件失败即整体 ok=false，由调用方决定如何提示用户。
 *
 * 数量取自 URL（已在解析层校验为 1..MAX 的整数），商品其余一切事实取自 loader。
 */
export async function restoreMetaCheckout(
  request: MetaCheckoutRequest,
  lookupIdentity: SellableIdentityLookup,
  loadFacts: ProductFactsLoader,
): Promise<RestoreOutcome> {
  const retailerIds = request.items.map(i => i.retailerId);

  let rows: SellableIdentityRow[];
  try {
    rows = await lookupIdentity(retailerIds);
  } catch {
    return {
      lines: [],
      ok: false,
      couponCode: request.couponCode,
      failures: retailerIds.map(rid => ({ retailerId: rid, reason: 'lookup_failed' as const, message: MESSAGES.lookup_failed })),
    };
  }

  const { resolved, failures } = resolveIdentity(retailerIds, rows);
  const lines: RestoredLine[] = [];

  for (const item of request.items) {
    const supplierProductId = resolved.get(item.retailerId);
    if (!supplierProductId) continue; // 已在 resolveIdentity 记录失败

    let facts: Awaited<ReturnType<ProductFactsLoader>>;
    try {
      facts = await loadFacts(supplierProductId);
    } catch {
      failures.push({ retailerId: item.retailerId, reason: 'lookup_failed', message: MESSAGES.lookup_failed });
      continue;
    }

    // loader 返回 null = 该商品已不可售。身份存在但事实读不出来，同样 fail-closed。
    if (!facts) {
      failures.push({ retailerId: item.retailerId, reason: 'product_unavailable', message: MESSAGES.product_unavailable });
      continue;
    }

    lines.push(toRestoredLine(facts, item));
  }

  return { lines, failures, ok: failures.length === 0 && lines.length > 0, couponCode: request.couponCode };
}

/** 由权威商品事实构造购物车行。URL 只贡献 qty，其余全部来自 loader。 */
function toRestoredLine(
  facts: NonNullable<Awaited<ReturnType<ProductFactsLoader>>>,
  item: MetaCheckoutItem,
): RestoredLine {
  return {
    sku: facts.sku ?? facts.id,
    productId: facts.id,          // = supplier_product_id，购物车的身份
    name: facts.name,
    price: facts.price,           // 权威售价；结账时服务端仍会重读并覆盖
    img: facts.image ?? facts.images?.[0] ?? '',
    qty: item.quantity,           // URL 唯一被采信的字段
    color: facts.color ?? '',
    size: facts.size ?? '',
  };
}
