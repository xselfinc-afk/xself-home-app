/**
 * Meta checkout Universal Link 的消费端。
 *
 * 为什么不改 AuthContext
 * ---------------------
 * AuthContext 的 handleMagicLink 只在 URL 带 `#access_token` 且同时带 `refresh_token` 时
 * 才动作，其余一律静默 return（见 AuthContext.tsx 的 handleMagicLink）。而 checkout 链接
 * 是 https://xselfhome.com/checkout?products=... —— 没有 fragment，也就永远走不到那个分支。
 * 两个监听器的判定条件互斥，因此可以共存，不存在“竞争消费同一 URL”。
 *
 * 反过来同样成立：本组件只认 /checkout 路径（isMetaCheckoutUrl 做了极窄判定并有测试覆盖），
 * magic link 不会被它吞掉。把 auth 逻辑搬进来反而会让一条已经在线上工作的登录链路承担
 * 不必要的回归风险，所以这里选择新增一个独立分支，而不是重构既有监听。
 *
 * 本组件不做任何金额计算：价格在 CheckoutScreen → create-checkout-order 由服务端重读，
 * Pickup/Delivery 费用由 plan-fulfillment 决定。这里只负责“把正确的商品放进现有购物车”。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { useCart } from '../context/CartContext';
import { isMetaCheckoutUrl, isParseFailure, parseMetaCheckoutUrl } from '../services/metaCheckoutLink';
import { restoreMetaCheckout, type SellableIdentityRow } from '../services/metaCartRestore';

/** 由 App.tsx 注入，避免本组件反向依赖 App.tsx（会形成循环 import）。 */
export interface MetaCheckoutNavigator {
  isReady: () => boolean;
  navigate: (screen: string, params?: object) => void;
}

interface Props {
  navigator: MetaCheckoutNavigator;
}

/** 解析失败时面向用户的说明。措辞保持中性，不暴露内部原因码。 */
const PARSE_MESSAGES: Record<string, string> = {
  missing_products: '这个结账链接似乎不完整。',
  no_valid_items: '这个结账链接里没有可购买的商品。',
  too_many_items: '这个结账链接包含的商品过多。',
  malformed_url: '这个结账链接无法识别。',
  not_checkout_path: '这个链接不是结账链接。',
};

export default function MetaCheckoutLinkHandler({ navigator }: Props): React.ReactElement | null {
  const { addItem, clearCart } = useCart();
  const [restoring, setRestoring] = useState(false);
  /** 已处理过的 URL，防止 cold-start 与 foreground 事件对同一链接重复还原。 */
  const handledUrls = useRef<Set<string>>(new Set());
  /** 防止两条链接并发还原互相覆盖购物车。 */
  const inFlight = useRef(false);

  const handleUrl = useCallback(async (url: string) => {
    // 极窄判定：不是 /checkout 就原样放过，交给 AuthContext 等其它消费者。
    if (!isMetaCheckoutUrl(url)) return;
    if (handledUrls.current.has(url) || inFlight.current) return;
    handledUrls.current.add(url);
    inFlight.current = true;
    setRestoring(true);

    try {
      const parsed = parseMetaCheckoutUrl(url);
      if (isParseFailure(parsed)) {
        Alert.alert('无法打开结账', PARSE_MESSAGES[parsed.error] ?? '这个结账链接无法识别。');
        return;
      }

      const { supabase } = await import('../lib/supabase');
      const { loadProductDetail } = await import('../services/productFamilyService');

      const outcome = await restoreMetaCheckout(
        parsed.request,
        // 身份解析只查在售集合。已下架商品自然查不到 → unknown_retailer_id。
        async (retailerIds): Promise<SellableIdentityRow[]> => {
          const { data, error } = await supabase
            .from('sellable_products')
            .select('sku_custom, supplier_product_id')
            .in('sku_custom', retailerIds);
          if (error) throw error;
          return (data ?? []) as SellableIdentityRow[];
        },
        // 权威商品事实：复用既有 PDP 的加载路径，不另起一套读取逻辑。
        async (supplierProductId) => {
          const p = await loadProductDetail(supplierProductId);
          if (!p) return null;
          // Product 只有 id/name/price/images/image。sku、color、size 不是 Product 的字段
          // （它们属于 ProductVariant），因此这里不伪造：还原层会填空串，与既有
          // 「加入购物车」在无变体时的行为一致。
          return { id: p.id, name: p.name, price: p.price, image: p.image, images: p.images };
        },
      );

      if (!outcome.ok) {
        // 任何一件失败都不进入结账 —— 绝不静默少买或换货。
        const first = outcome.failures[0];
        Alert.alert(
          '部分商品无法购买',
          `${first?.message ?? '这些商品目前无法购买。'}\n\n您可以浏览其它商品。`,
          [{ text: '好', onPress: () => { if (navigator.isReady()) navigator.navigate('MainTabs'); } }],
        );
        return;
      }

      // 用 Meta 的购物车替换当前购物车：顾客的意图是“买 Meta 上看到的那些”，
      // 把本地遗留商品混进来会让结账金额与他的预期不符。
      clearCart();
      for (const line of outcome.lines) {
        const { qty, ...rest } = line;
        addItem(rest, qty);
      }

      if (navigator.isReady()) {
        // 复用既有 cart 模式的 Checkout，不新建第二套结账状态机。
        navigator.navigate('Checkout', { mode: 'cart' });
      }
    } catch (e) {
      console.warn('[MetaCheckout] 还原失败', e instanceof Error ? e.message : e);
      Alert.alert('无法打开结账', '读取商品信息时出了点问题，请稍后再试。');
    } finally {
      inFlight.current = false;
      setRestoring(false);
    }
  }, [addItem, clearCart, navigator]);

  useEffect(() => {
    // 冷启动：App 被这条链接唤起。
    Linking.getInitialURL().then(url => { if (url) void handleUrl(url); }).catch(() => {});
    // 前台/后台：App 已在运行时收到新链接。
    const sub = Linking.addEventListener('url', ({ url }) => { void handleUrl(url); });
    return () => sub.remove();
  }, [handleUrl]);

  if (!restoring) return null;
  return (
    <View style={styles.overlay} pointerEvents="auto">
      <ActivityIndicator size="large" color="#CA8A04" />
      <Text style={styles.text}>正在准备您的订单…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(243, 241, 235, 0.96)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  text: { marginTop: 14, fontSize: 15, color: '#1C1917' },
});
