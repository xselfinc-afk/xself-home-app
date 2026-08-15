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
import {
  IGNORED_UNTRUSTED_PARAMS,
  MAX_ITEMS,
  MAX_QUANTITY_PER_ITEM,
  isMetaCheckoutUrl,
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

const BASE = 'https://xselfhome.com/checkout';
const ok = (u: string) => { const r = parseMetaCheckoutUrl(u); assert.ok(r.ok, `期望解析成功: ${u}`); return r.request; };
/** 断言解析失败并取出错误码。显式标注失败分支类型，不依赖控制流收窄。 */
const err = (u: string): MetaCheckoutParseError => {
  const r = parseMetaCheckoutUrl(u) as { ok: boolean; error?: MetaCheckoutParseError };
  assert.equal(r.ok, false, `期望解析失败: ${u}`);
  assert.ok(r.error, `失败结果必须带错误码: ${u}`);
  return r.error!;
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

  console.log(`\n${passed} passed`);
}
void main();
