/**
 * Checkout 的配送时效文案：服务端优先，客户端兜底。纯函数，无 React / 网络 / 数据库。
 *
 * 归属很重要。这句话由 plan-fulfillment 通过 `group.estimatedDelivery` 返回，客户端渲染服务端
 * 的值 —— 所以改文案是一次 function 部署，不需要发版。常量只在服务端没给出可用值时兜底
 * （离线计划、旧 function、空字符串）。
 *
 * 它是运营承诺，不是算出来的：系统里没有任何配送时效数据（2026-08-09 审计，GIGA 的
 * price / detailInfo / inventory / warehouse 只返回费用、入仓日期与地址）。
 * 与 supabase/functions/plan-fulfillment/index.ts 保持同一字符串。
 */

export const DELIVERY_TIMING_COPY = 'Local warehouse · Fastest delivery: 2 BUSINESS DAYS';

/** XSELF Local Delivery（免费自营配送）的时效文案。与 plan-fulfillment 的 LOCAL_DELIVERY_TIMING_COPY
 *  保持同一字符串；同样只是运营承诺，绝不提及后台的资格半径。 */
export const LOCAL_DELIVERY_TIMING_COPY = 'Local delivery · Delivered within 2 BUSINESS DAYS';

/** 渲染用得到的最小分组形状。 */
export interface DeliveryTimingGroup {
  isPickup: boolean;
  /** 自营 Local Delivery 组：它的 estimatedDelivery 描述的是本地配送，不是第三方 Shipping。 */
  isLocalDelivery?: boolean;
  estimatedDelivery?: string | null;
}

/** Local Delivery 卡片该显示的时效：服务端为本地配送给出的值优先，否则常量兜底。 */
export function localDeliveryTimingCopy(group?: DeliveryTimingGroup | null): string {
  const fromServer = group && group.isLocalDelivery ? (group.estimatedDelivery ?? '').trim() : '';
  return fromServer || LOCAL_DELIVERY_TIMING_COPY;
}

/**
 * 取这一组该显示的配送时效文案。
 *
 * `isPickup` 是判定的一部分，不是可省略的细节：自提组的 estimatedDelivery 装的是**自提窗口**
 * （"Pickup available in 2–5 days…"），把它渲染到 Delivery 下面比用兜底文案更糟。
 * 所以只有当服务端的值确实描述配送时才采信。
 */
export function deliveryTimingCopy(group?: DeliveryTimingGroup | null): string {
  const fromServer = group && !group.isPickup && !group.isLocalDelivery ? (group.estimatedDelivery ?? '').trim() : '';
  return fromServer || DELIVERY_TIMING_COPY;
}

/**
 * 一份计划里服务端已经给出的配送文案（若有）。
 *
 * 把自提组转成配送组时用它 —— 绝不能让自提窗口跟着转过去，也绝不覆盖服务端已有的配送值。
 */
export function serverDeliveryCopyOf(groups: readonly DeliveryTimingGroup[]): string | null {
  const found = groups
    .map((g) => (!g.isPickup && !g.isLocalDelivery ? (g.estimatedDelivery ?? '').trim() : ''))
    .find(Boolean);
  return found ?? null;
}
