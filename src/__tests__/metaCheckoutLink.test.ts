/**
 * Meta checkout 链接解析 + 购物车还原测试（纯函数，无网络、无数据库）。
 *
 * 最要紧的两条性质：
 *   1. URL 里除了「买哪个、买几件」之外的一切都不可信 —— 价格/运费/库存/标题一律不采信。
 *   2. sku_custom 已证实不唯一（生产中 XH-SF-LR-S00039 对应 2 行），命中多行必须
 *      fail-closed，绝不能随便挑一个卖给顾客。
 *
 * 运行：npx tsx src/__tests__/metaCheckoutLink.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IGNORED_UNTRUSTED_PARAMS,
  MAX_ITEMS,
  MAX_QUANTITY_PER_ITEM,
  isMetaCheckoutUrl,
  isParseFailure,
  parseMetaCheckoutUrl,
  type MetaCheckoutParseError,
} from '../services/metaCheckoutLink';
import {
  resolveIdentity,
  restoreMetaCheckout,
  type ProductFactsLoader,
  type SellableIdentityRow,
} from '../services/metaCartRestore';

let passed = 0;
/** 顺序执行并等待，保证 async 用例也计入总数，且输出顺序与定义顺序一致。 */
async function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed++; console.log(`  ✓ ${name}`);
}

const readSrc = (p: string) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const BASE = 'https://xselfhome.com/checkout';
const ok = (u: string) => { const r = parseMetaCheckoutUrl(u); assert.ok(r.ok, `期望解析成功: ${u}`); return r.request; };
/** 断言解析失败并取出错误码，用源码提供的类型守卫收窄。 */
const err = (u: string): MetaCheckoutParseError => {
  const r = parseMetaCheckoutUrl(u);
  assert.ok(isParseFailure(r), `期望解析失败: ${u}`);
  return r.error;
};

const row = (sku: string, spid: string): SellableIdentityRow => ({ sku_custom: sku, supplier_product_id: spid });
const facts = (over: Record<string, unknown> = {}) => ({
  id: 'W244P172637', sku: 'W244P172637', name: 'Accent Chair', price: 349,
  image: 'https://img/x.jpg', color: 'Grey', size: 'Standard', ...over,
});

async function main(): Promise<void> {
  // ── 1. 契约本身 ─────────────────────────────────────────────────────────────

  await it('1. 单件商品', () => {
    const r = ok(`${BASE}?products=XH-SF-LR-172637:1`);
    assert.deepEqual(r.items, [{ retailerId: 'XH-SF-LR-172637', quantity: 1 }]);
    assert.equal(r.couponCode, null);
  });

  await it('2. 多件商品 + coupon', () => {
    const r = ok(`${BASE}?products=XH-A:2,XH-B:1,XH-C:3&coupon=SAVE10`);
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items.map(i => i.quantity), [2, 1, 3]);
    assert.equal(r.couponCode, 'SAVE10');
  });

  await it('3. 百分号编码由 URLSearchParams 解码，不重复解码', () => {
    const r = ok(`${BASE}?products=${encodeURIComponent('XH-SF-LR-172637:2,XH-DR-HM-029AAE:1')}`);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].retailerId, 'XH-SF-LR-172637');
  });

  await it('4. 数量：只接受正整数，其余丢弃', () => {
    for (const bad of ['0', '-1', '2.5', 'abc', '1e3', '']) {
      const r = parseMetaCheckoutUrl(`${BASE}?products=XH-A:${bad}`);
      assert.ok(!r.ok, `数量 "${bad}" 不应被接受`);
    }
    assert.equal(ok(`${BASE}?products=XH-A:${MAX_QUANTITY_PER_ITEM}`).items[0].quantity, MAX_QUANTITY_PER_ITEM);
    // 超过上限的整条片段被丢弃 → 没有有效商品
    assert.equal(err(`${BASE}?products=XH-A:${MAX_QUANTITY_PER_ITEM + 1}`), 'no_valid_items');
  });

  await it('5. 坏片段被丢弃，好片段仍然生效', () => {
    const r = ok(`${BASE}?products=XH-A:2,GARBAGE,XH-B:1,:5,XH-C:`);
    assert.deepEqual(r.items.map(i => i.retailerId), ['XH-A', 'XH-B']);
    assert.ok(r.droppedTokens.length >= 3);
  });

  await it('6. 重复 retailerId 合并数量', () => {
    const r = ok(`${BASE}?products=XH-A:2,XH-A:3`);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].quantity, 5);
  });

  await it('7. 缺 products / 全部无效 / 过多商品', () => {
    assert.equal(err(`${BASE}`), 'missing_products');
    assert.equal(err(`${BASE}?products=`), 'missing_products');
    assert.equal(err(`${BASE}?products=,,,`), 'no_valid_items');
    const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => `SKU${i}:1`).join(',');
    assert.equal(err(`${BASE}?products=${many}`), 'too_many_items');
  });

  await it('8. 路径识别极窄 —— magic link 绝不会被当成 checkout', () => {
    assert.ok(isMetaCheckoutUrl(`${BASE}?products=A:1`));
    assert.ok(isMetaCheckoutUrl('xselfhome://checkout?products=A:1'));
    // Supabase auth 回调必须被放过
    assert.ok(!isMetaCheckoutUrl('xselfhome://auth/callback#access_token=abc'));
    assert.ok(!isMetaCheckoutUrl('https://xselfhome.com/#access_token=abc&type=magiclink'));
    assert.ok(!isMetaCheckoutUrl('https://xselfhome.com/products/W244P172637'));
    assert.ok(!isMetaCheckoutUrl('not a url'));
    assert.equal(err('https://xselfhome.com/privacy?products=A:1'), 'not_checkout_path');
  });

  // ── 2. URL 里的钱一律不采信 ─────────────────────────────────────────────────

  await it('9. 价格/运费/库存/标题即使出现在 URL 也完全不被解析', () => {
    const hostile = `${BASE}?products=XH-A:1&price=1&amount=1&total=1&shipping=0`
      + `&shipping_fee=0&delivery_fee=0&tax=0&availability=in%20stock&title=Free&image=http://x/y.jpg`;
    const r = ok(hostile);
    // 解析结果里只有标识与数量两个字段，结构上就没有放金额的地方。
    assert.deepEqual(Object.keys(r.items[0]).sort(), ['quantity', 'retailerId']);
    const serialized = JSON.stringify(r);
    for (const p of IGNORED_UNTRUSTED_PARAMS) {
      assert.ok(!serialized.includes(`"${p}"`), `解析结果不应包含不可信字段 ${p}`);
    }
  });

  // ── 3. 身份解析：重复必须 fail-closed ───────────────────────────────────────

  await it('10. 生产真实重复 XH-SF-LR-S00039 → ambiguous，绝不挑一个', () => {
    const { resolved, failures } = resolveIdentity(
      ['XH-SF-LR-S00039'],
      [row('XH-SF-LR-S00039', 'W2817S00021'), row('XH-SF-LR-S00039', 'W2817S00039')],
    );
    assert.equal(resolved.size, 0);
    assert.equal(failures[0].reason, 'ambiguous_retailer_id');
  });

  await it('11. 同一 supplier_product_id 出现多行不算歧义', () => {
    const { resolved, failures } = resolveIdentity(['XH-A'], [row('XH-A', 'SPID1'), row('XH-A', 'SPID1')]);
    assert.equal(resolved.get('XH-A'), 'SPID1');
    assert.equal(failures.length, 0);
  });

  await it('12. 未知 retailerId → unknown', () => {
    const { failures } = resolveIdentity(['XH-NOPE'], [row('XH-A', 'SPID1')]);
    assert.equal(failures[0].reason, 'unknown_retailer_id');
  });

  // ── 4. 完整还原 ─────────────────────────────────────────────────────────────

  await it('13. 还原成功：数量取自 URL，其余全部取自权威事实', async () => {
    const req = ok(`${BASE}?products=XH-SF-LR-172637:3&price=1`);
    const out = await restoreMetaCheckout(
      req,
      async () => [row('XH-SF-LR-172637', 'W244P172637')],
      (async () => facts()) as ProductFactsLoader,
    );
    assert.equal(out.ok, true);
    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0].qty, 3);                 // 来自 URL
    assert.equal(out.lines[0].price, 349);             // 来自权威事实，不是 URL 的 1
    assert.equal(out.lines[0].productId, 'W244P172637');
  });

  await it('14. 商品已不可售（loader 返回 null）→ fail-closed', async () => {
    const req = ok(`${BASE}?products=XH-A:1`);
    const out = await restoreMetaCheckout(
      req, async () => [row('XH-A', 'SPID1')], (async () => null) as ProductFactsLoader,
    );
    assert.equal(out.ok, false);
    assert.equal(out.lines.length, 0);
    assert.equal(out.failures[0].reason, 'product_unavailable');
  });

  await it('15. 部分失败 → 整体 ok=false，绝不静默少买', async () => {
    const req = ok(`${BASE}?products=XH-A:1,XH-MISSING:1`);
    const out = await restoreMetaCheckout(
      req, async () => [row('XH-A', 'SPID1')], (async () => facts({ id: 'SPID1' })) as ProductFactsLoader,
    );
    assert.equal(out.ok, false, '有任何一件失败就不能算成功');
    assert.equal(out.lines.length, 1);
    assert.equal(out.failures.length, 1);
  });

  await it('16. 身份查询抛错 → lookup_failed，与「商品不存在」区分', async () => {
    const req = ok(`${BASE}?products=XH-A:1`);
    const out = await restoreMetaCheckout(
      req, async () => { throw new Error('network'); }, (async () => facts()) as ProductFactsLoader,
    );
    assert.equal(out.ok, false);
    assert.equal(out.failures[0].reason, 'lookup_failed');
  });

  await it('17. coupon 原样透传，不参与任何金额计算', async () => {
    const req = ok(`${BASE}?products=XH-A:1&coupon=SAVE10`);
    const out = await restoreMetaCheckout(
      req, async () => [row('XH-A', 'SPID1')], (async () => facts({ id: 'SPID1' })) as ProductFactsLoader,
    );
    assert.equal(out.couponCode, 'SAVE10');
    // 还原行里没有任何折扣字段 —— 折扣只能由既有服务端体系决定。
    for (const k of ['discount', 'couponCode', 'quoteToken']) {
      assert.ok(!(k in out.lines[0]), `还原行不应带 ${k}`);
    }
  });

  // ── 5. Dispatcher 接线（静态源码断言，不渲染 RN 组件）────────────────────

  await it('18. dispatcher 已挂在 CartProvider 内并复用既有 navigationRef', () => {
    const app = readSrc('App.tsx');
    assert.match(app, /import MetaCheckoutLinkHandler from '\.\/src\/components\/MetaCheckoutLinkHandler'/);
    assert.match(app, /<MetaCheckoutLinkHandler navigator=\{navigationRef\} \/>/);
    // 必须在 CartProvider 内部，否则 useCart 会抛错。
    const inside = app.slice(app.indexOf('<CartProvider>'), app.indexOf('</CartProvider>'));
    assert.ok(inside.includes('<MetaCheckoutLinkHandler'), 'dispatcher 必须位于 CartProvider 内');
  });

  await it('19. AuthContext 未被本次改动触碰 —— magic-link 行为原样保留', () => {
    const auth = readSrc('src/context/AuthContext.tsx');
    // 既有两条监听与判定条件必须完好。
    assert.match(auth, /Linking\.getInitialURL\(\)\.then\(url => \{ if \(url\) handleMagicLink\(url\); \}\)/);
    assert.match(auth, /Linking\.addEventListener\('url', \(\{ url \}\) => handleMagicLink\(url\)\)/);
    // 关键：只在有 fragment 且含双 token 时才动作 —— 这正是它对 checkout URL 无害的原因。
    assert.match(auth, /const hash = url\.split\('#'\)\[1\];\s*\n\s*if \(!hash\) return;/);
    assert.match(auth, /if \(params\.access_token && params\.refresh_token\)/);
    // AuthContext 不得引用 checkout 相关模块。
    assert.ok(!/metaCheckout|metaCartRestore/i.test(auth), 'auth 不应耦合 checkout 逻辑');
  });

  await it('20. dispatcher 只认 checkout，且不自行计算任何金额', () => {
    const h = readSrc('src/components/MetaCheckoutLinkHandler.tsx');
    assert.match(h, /if \(!isMetaCheckoutUrl\(url\)\) return;/);
    // 冷启动 + 前台两条路径都要有。
    assert.match(h, /Linking\.getInitialURL\(\)/);
    assert.match(h, /Linking\.addEventListener\('url'/);
    // 失败即不进结账。
    assert.match(h, /if \(!outcome\.ok\)/);
    // 不得出现任何自算金额/运费的痕迹。
    for (const bad of ['deliveryFee', 'shippingCents', 'subtotal', 'totalCents', 'unitPriceCents']) {
      assert.ok(!h.includes(bad), `dispatcher 不应涉及金额计算: ${bad}`);
    }
  });

  await it('21. 还原成功后落在购物车，绝不自动进入结账', () => {
    const h = readSrc('src/components/MetaCheckoutLinkHandler.tsx');
    // 目标是 Main → Cart 标签。
    assert.match(h, /navigate\('Main', \{ screen: 'Cart' \}\)/);
    assert.match(h, /navigateToCart\(\)/);
    // 整个 dispatcher 里不得再有任何跳向 Checkout 的导航 —— 买家必须自己点。
    assert.ok(!/navigate\(\s*'Checkout'/.test(h), 'dispatcher 不应导航到 Checkout');
    assert.ok(!h.includes('navigateToCheckout'), '旧的 navigateToCheckout 应已移除');
  });

  await it('22. 冷启动/AuthGate 时序：重试保留，终止于最内层路由 CartMain', () => {
    const h = readSrc('src/components/MetaCheckoutLinkHandler.tsx');
    // AuthGate 期间 Main 尚不存在，navigate 静默失效，所以重试不可移除。
    assert.match(h, /const CART_ROUTE_NAME = 'CartMain';/);
    assert.match(h, /current\?\.name === CART_ROUTE_NAME/);
    assert.match(h, /setTimeout\(attempt, NAV_RETRY_INTERVAL_MS\)/);
    // 窗口必须覆盖真实的登录停留时长（真机实测 30 秒不够），且卸载时清理定时器。
    assert.match(h, /NAV_RETRY_TIMEOUT_MS = 180_000/);
    assert.match(h, /clearTimeout\(navTimer\.current\)/);
    // 终止条件必须是最内层路由名，写成标签名 'Cart' 会导致重试永不结束。
    assert.ok(!/current\?\.name === 'Cart'/.test(h), '终止条件不能用标签名 Cart');
  });

  await it('23. 还原失败：既不进购物车也不进结账，且不重复还原同一链接', () => {
    const h = readSrc('src/components/MetaCheckoutLinkHandler.tsx');
    // 只看真实代码：注释里提到旧路由名不该让断言失败。
    const stripComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const failBlock = stripComments(h.slice(h.indexOf('if (!outcome.ok)'), h.indexOf('clearCart();')));
    assert.ok(failBlock.length > 0, '未定位到失败分支');
    // 失败分支里唯一的导航是回首页 —— 'MainTabs' 是不存在的路由名，已修正为 'Main'。
    assert.match(failBlock, /navigate\('Main'\)/);
    assert.ok(!failBlock.includes("'MainTabs'"), "'MainTabs' 不是真实路由名");
    assert.ok(!/navigateToCart|screen: 'Cart'|'Checkout'/.test(failBlock), '失败时不得跳购物车或结账');
    // 失败早于 clearCart 返回，既有购物车不被改动。
    assert.ok(h.indexOf('if (!outcome.ok)') < h.indexOf('clearCart();'), '失败分支必须在 clearCart 之前返回');
    // 冷启动与前台事件对同一 URL 只还原一次。
    assert.match(h, /handledUrls\.current\.has\(url\) \|\| inFlight\.current/);
  });

  console.log(`\n${passed} passed`);
}
void main();
