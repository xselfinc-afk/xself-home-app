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
  /** 用于确认导航是否真的生效。navigationRef 原生具备，可选是为了让测试替身从简。 */
  getCurrentRoute?: () => { name: string } | undefined;
}

/**
 * 冷启动时若顾客尚未登录也未选择访客，App 渲染的是 AuthGate 导航器 —— 它只有
 * LoginEntry，Main 路由并不存在，navigate 会静默失败。等顾客过了这道门，RootStack
 * 才挂载并落在 initialRouteName='Main'，于是购物车虽已还原却停在首页。
 *
 * 所以这里重试到购物车真正打开为止。
 *
 * 上限 180 秒，是真机测出来的：把它压到 30 秒时，在登录页停留约 50 秒再点
 * 「Continue as Guest」就会错过窗口 —— 购物车已还原，人却留在首页。真实买家
 * 在登录页读条款、犹豫、切出去查收验证码，超过半分钟太常见。
 *
 * 之所以敢给这么长的窗口：落地目标是购物车而不是结账。迟到的跳转只是切个标签页，
 * 不会像突然弹进收款页那样打断人，所以宁可等久一点，也不要让人对着空首页发愣。
 */
const NAV_RETRY_INTERVAL_MS = 400;
const NAV_RETRY_TIMEOUT_MS = 180_000;

/** 购物车标签内层的实际路由名。getCurrentRoute 返回的是最内层，不是标签名 'Cart'。 */
const CART_ROUTE_NAME = 'CartMain';

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
  /** 待重试的导航定时器，卸载时清理。 */
  const navTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const navigateToCart = useCallback(() => {
    const deadline = Date.now() + NAV_RETRY_TIMEOUT_MS;
    const attempt = () => {
      navTimer.current = null;
      if (navigator.isReady()) {
        navigator.navigate('Main', { screen: 'Cart' });
        // 路由不存在时 navigate 不报错也不生效，只能回读当前路由确认。
        // 拿不到 getCurrentRoute 就视作已生效，避免无谓地反复跳转。
        const current = navigator.getCurrentRoute?.();
        if (!navigator.getCurrentRoute || current?.name === CART_ROUTE_NAME) return;
      }
      if (Date.now() >= deadline) return;
      navTimer.current = setTimeout(attempt, NAV_RETRY_INTERVAL_MS);
    };
    attempt();
  }, [navigator]);

  useEffect(() => () => {
    if (navTimer.current) clearTimeout(navTimer.current);
  }, []);

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
          return { id: p.id, name: p.name, price: p.price, originalPrice: p.originalPrice, image: p.image, images: p.images };
        },
      );

      if (!outcome.ok) {
        // 任何一件失败都不进入结账 —— 绝不静默少买或换货。
        const first = outcome.failures[0];
        Alert.alert(
          '部分商品无法购买',
          `${first?.message ?? '这些商品目前无法购买。'}\n\n您可以浏览其它商品。`,
          // 'MainTabs' 从来不是真实路由名（RootStack 里叫 'Main'），所以这个跳转
          // 一直是静默失效的死代码。改成 'Main' 让它按本意把人送回首页 —— 失败时
          // 既不进结账也不进购物车。
          [{ text: '好', onPress: () => { if (navigator.isReady()) navigator.navigate('Main'); } }],
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

      // 落在购物车，不自动进结账：让买家先核对 Meta 上看到的商品、数量与小计，
      // 由他自己点 Checkout。整车替换因此变得可见且可挽回。
      navigateToCart();
    } catch (e) {
      console.warn('[MetaCheckout] 还原失败', e instanceof Error ? e.message : e);
      Alert.alert('无法打开结账', '读取商品信息时出了点问题，请稍后再试。');
    } finally {
      inFlight.current = false;
      setRestoring(false);
    }
  }, [addItem, clearCart, navigator, navigateToCart]);

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
