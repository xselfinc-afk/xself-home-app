/**
 * 新品首次上架 —— 纯单元测试，不碰网络、数据库、供应商、执行器。
 *
 * 守两件事：
 *   1. 只有真正准备好的候选才可能被批准，批准之外后台还要用最新事实重新判一遍；
 *   2. 候选期的收藏保护是系统簿记，**永远不得覆盖或删除用户手工设置的 keep_favorite**。
 *
 * 运行：npx tsx src/__tests__/productOnboarding.test.ts
 */
import assert from 'node:assert/strict';
import {
  deriveOnboardingState,
  canApproveFirstPublish,
  evaluateFirstPublish,
  decideProtection,
  verifyFirstPublishOutcome,
  isHumanApprover,
  ONBOARDING_PROTECTION_ACTOR,
  type OnboardingFacts,
} from '../services/productOnboarding';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

/** 一件完全准备好的新品候选。 */
const ready = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  supplier_product_id: 'NEW-SKU-1',
  in_pickup_favorites: true,
  in_supplier_products: true,
  in_standardized_products: true,
  published: false,
  in_sellable_products: false,
  has_unique_identity: true,
  product_title: 'Oak Dining Chair',
  primary_image: 'https://images.example.test/a.jpg',
  selling_price: 199,
  taxonomy_needs_review: false,
  stock_available: true,
  ...over,
});

function main(): void {
  // ── 候选状态 ───────────────────────────────────────────────────────────────

  it('1 + 2. 新收藏成为候选；Dropship 未收藏不影响', () => {
    // facts 里根本没有 dropship 维度 —— 首次上架不以 Dropship 为前置条件。
    assert.equal(deriveOnboardingState(ready()), 'ready_to_publish');
    assert.equal(Object.keys(ready()).some((k) => k.includes('dropship')), false);
  });

  it('3. 已发布的 SKU 不再是候选，按可见与否区分终态', () => {
    assert.equal(deriveOnboardingState(ready({ published: true, in_sellable_products: true })), 'published_visible');
    assert.equal(deriveOnboardingState(ready({ published: true, in_sellable_products: false })), 'published_not_visible');
  });

  it('11 + 12 + 13 + 14. 各类未就绪都有各自的业务状态，且都不可批准', () => {
    const cases: Array<[Partial<OnboardingFacts>, string]> = [
      [{ in_supplier_products: false }, 'preparing'],
      [{ has_unique_identity: false }, 'needs_identity'],
      [{ product_title: null }, 'incomplete_data'],
      [{ primary_image: '' }, 'incomplete_data'],
      [{ selling_price: 0 }, 'incomplete_data'],
      [{ selling_price: null }, 'incomplete_data'],
      [{ taxonomy_needs_review: true }, 'needs_taxonomy'],
      [{ stock_available: false }, 'insufficient_stock'],
      [{ stock_available: null }, 'insufficient_stock'],
    ];
    for (const [over, expected] of cases) {
      const state = deriveOnboardingState(ready(over));
      assert.equal(state, expected, `${JSON.stringify(over)} 应为 ${expected}，实际 ${state}`);
      assert.equal(canApproveFirstPublish(state), false, `${state} 不得允许批准`);
    }
  });

  it('15. 只有 ready_to_publish 允许出现「批准上架」', () => {
    assert.equal(canApproveFirstPublish('ready_to_publish'), true);
    for (const s of ['preparing', 'needs_identity', 'needs_taxonomy', 'incomplete_data',
      'insufficient_stock', 'publishing', 'published_visible', 'published_not_visible', 'publish_failed'] as const) {
      assert.equal(canApproveFirstPublish(s), false);
    }
  });

  // ── 发布前重新校验 ─────────────────────────────────────────────────────────

  const approve = (over: Partial<OnboardingFacts> = {}, approvedBy = '小何') =>
    evaluateFirstPublish({ supplier_product_id: 'NEW-SKU-1', approved_by: approvedBy, facts: ready(over) });

  it('18. 准备就绪且有真人批准时放行', () => {
    const v = approve();
    assert.equal(v.allowed, true, `应放行，实际被拦：${v.blocks.join()}`);
  });

  it('18. 后台逐条重新校验，任何一项失败都 0 publish writes', () => {
    const cases: Array<[Partial<OnboardingFacts>, string]> = [
      [{ in_pickup_favorites: false }, 'not_in_pickup_favorites'],
      [{ published: true }, 'already_published'],
      [{ published: null }, 'not_a_candidate'],
      [{ in_supplier_products: false }, 'supplier_row_missing'],
      [{ has_unique_identity: false }, 'identity_unverified'],
      [{ product_title: '  ' }, 'incomplete_product_data'],
      [{ primary_image: null }, 'incomplete_product_data'],
      [{ selling_price: -1 }, 'incomplete_product_data'],
      [{ taxonomy_needs_review: true }, 'taxonomy_unconfirmed'],
      [{ stock_available: null }, 'no_stock_evidence'],
      [{ stock_available: false }, 'zero_stock'],
    ];
    for (const [over, block] of cases) {
      const v = approve(over);
      assert.equal(v.allowed, false, `${block} 应当拦截`);
      assert.ok(v.blocks.includes(block as never), `应报出 ${block}，实际 ${v.blocks.join()}`);
    }
  });

  it('17. 缺少明确批准人 → 拒绝；自动化身份不是人', () => {
    // 直接调用，不走带默认值的 helper —— 否则 undefined 会被默认参数替换成合法姓名。
    for (const bad of ['', '   ', null, undefined, 'system', 'scheduler', 'xone', 'automation']) {
      const v = evaluateFirstPublish({
        supplier_product_id: 'NEW-SKU-1', approved_by: bad as never, facts: ready(),
      });
      assert.equal(v.allowed, false, `${String(bad)} 不得被当成批准人`);
      assert.ok(v.blocks.includes('approver_missing'));
    }
    assert.equal(isHumanApprover('小何'), true);
  });

  it('19. 只接受精确单件；all 与通配符永远拒绝', () => {
    for (const bad of ['all', 'ALL', '*', 'A,B', 'A B', '']) {
      const v = evaluateFirstPublish({ supplier_product_id: bad, approved_by: '小何', facts: ready() });
      assert.equal(v.allowed, false, `${bad} 不得被接受`);
      assert.ok(v.blocks.includes('scope_not_single_sku'));
    }
  });

  it('零库存与无证据分开报，用户才知道该等还是该放弃', () => {
    assert.ok(approve({ stock_available: false }).blocks.includes('zero_stock'));
    assert.ok(approve({ stock_available: null }).blocks.includes('no_stock_evidence'));
  });

  // ── 候选期收藏保护 ─────────────────────────────────────────────────────────

  it('7. 候选进入待上新时建立系统保护', () => {
    assert.equal(decideProtection({ needs_protection: true, existing: null }), 'create_protection');
  });

  it('7. 已有系统保护时不重复写', () => {
    assert.equal(decideProtection({
      needs_protection: true,
      existing: { resolution: 'keep_favorite', resolved_by: ONBOARDING_PROTECTION_ACTOR },
    }), 'noop');
  });

  it('8 + 26. 用户手工设置的裁决永远不被覆盖或删除', () => {
    for (const resolution of ['keep_favorite', 'remove_favorite', 'no_action']) {
      for (const needs of [true, false]) {
        const action = decideProtection({ needs_protection: needs, existing: { resolution, resolved_by: '你' } });
        assert.equal(action, 'keep_manual', `手工 ${resolution} 在 needs=${needs} 时必须保持不动`);
      }
    }
  });

  it('23 + 25. 只释放系统自己建的那条保护', () => {
    // 发布成功 / 候选放弃 → 释放系统保护
    assert.equal(decideProtection({
      needs_protection: false,
      existing: { resolution: 'keep_favorite', resolved_by: ONBOARDING_PROTECTION_ACTOR },
    }), 'release_protection');
    // 没有任何记录时不需要做事
    assert.equal(decideProtection({ needs_protection: false, existing: null }), 'noop');
  });

  it('24. 发布失败时仍然需要保护，不释放', () => {
    // 失败即 needs_protection 仍为 true —— 调用方据此保留保护。
    assert.equal(decideProtection({
      needs_protection: true,
      existing: { resolution: 'keep_favorite', resolved_by: ONBOARDING_PROTECTION_ACTOR },
    }), 'noop');
  });

  // ── 发布后双重回读 ─────────────────────────────────────────────────────────

  it('20 + 21. published 回读 + sellable 回读都通过才算已上架且可见', () => {
    const r = verifyFirstPublishOutcome({ published_before: false, published_after: true, in_sellable_after: true });
    assert.deepEqual(r, { outcome: 'published_visible', reason: null });
  });

  it('22. published=true 但 App 不可见 → partial state，并指出差在哪', () => {
    const r = verifyFirstPublishOutcome({
      published_before: false, published_after: true, in_sellable_after: false,
      facts_after: { stock_available: null, primary_image: 'https://x/a.jpg', selling_price: 199 },
    });
    assert.equal(r.outcome, 'published_not_visible');
    assert.match(r.reason ?? '', /缺少有效的在售库存证据/);
    // 绝不能把 published=true 当成 App 可见。
    assert.notEqual(r.outcome, 'published_visible');
  });

  it('20. 执行器说成功但 published 没变 → publish_failed', () => {
    const stuck = verifyFirstPublishOutcome({ published_before: false, published_after: false, in_sellable_after: false });
    assert.equal(stuck.outcome, 'publish_failed');
    assert.match(stuck.reason ?? '', /仍为 false/);
    // 执行前就已发布 → 不是首次上架
    const already = verifyFirstPublishOutcome({ published_before: true, published_after: true, in_sellable_after: true });
    assert.equal(already.outcome, 'publish_failed');
  });

  it('判定层不含任何执行语义', () => {
    const serialized = JSON.stringify(approve());
    for (const forbidden of ['update', 'upsert', 'rpc', 'spawn', 'exec', 'token', 'cookie', 'set_publication']) {
      assert.equal(serialized.toLowerCase().includes(forbidden), false, `不得出现 ${forbidden}`);
    }
  });

  console.log(`\n${passed} passed`);
}

main();
