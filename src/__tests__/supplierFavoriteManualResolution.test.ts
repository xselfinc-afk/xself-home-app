/**
 * 收藏异常的人工裁决 —— 纯单元测试，不碰网络、数据库、浏览器。
 *
 * 守住两件事：
 *   1. 人工裁决确实改变下一次同步的计划（保留不删、指定取消进入流程、无需处理关闭异常）。
 *   2. 人工裁决**绕不过**任何安全门 —— published=true 永远保留，身份不唯一永远不猜着删。
 *
 * 运行：npx tsx src/__tests__/supplierFavoriteManualResolution.test.ts
 */
import assert from 'node:assert/strict';
import {
  applyManualResolutions,
  planFavoriteCleanup,
  type ManualResolutionRecord,
} from '../services/supplierFavoriteCleanupExecutor';
import type { ProductIdMapping } from '../services/supplierFavoriteProductId';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

/** 唯一且反查确认的映射；其余一律不可用。 */
function mappingsFrom(unique: Record<string, number>): (sku: string) => ProductIdMapping {
  return (sku) => (sku in unique
    ? { product_id: unique[sku], verified_sku: sku, status: 'unique' }
    : { product_id: null, verified_sku: null, status: 'not_mapped' });
}

/** 造一个计划：TARGET + 两账号收藏 + 已知映射。 */
function makePlan(
  target: string[],
  favorites: { pickup: string[]; dropship: string[] },
  unique: Record<string, number> = {},
) {
  const mappingFor = mappingsFrom(unique);
  return { plan: planFavoriteCleanup(target, favorites, mappingFor), mappingFor, target };
}

const PUBLISHED = 'PUB-1';

function main(): void {
  it('1. 没有任何裁决时，异常默认就是未处理', () => {
    // NO-MAP 无映射 → 异常；MAPPED 有映射 → 自动待取消。
    const { plan, mappingFor, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED, 'NO-MAP', 'MAPPED'], dropship: [] }, { MAPPED: 111 },
    );
    const out = applyManualResolutions(plan, [], target, mappingFor);
    assert.equal(out.manual.unresolved_exceptions, 1);
    assert.equal(out.manual.manual_keep, 0);
    assert.equal(out.manual.manual_no_action, 0);
    assert.equal(out.exceptions.pickup.map((e) => e.supplier_product_id).join(), 'NO-MAP');
    assert.equal(out.removals.pickup.map((i) => i.supplier_product_id).join(), 'MAPPED');
  });

  it('2. 保留收藏 → 不进入删除计划', () => {
    const { plan, mappingFor, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED, 'KEEP-ME'], dropship: [] }, { 'KEEP-ME': 222 },
    );
    // 本来是自动待取消的一条，人工保留后必须消失在 removals 里。
    assert.equal(plan.removals.pickup.length, 1);
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'KEEP-ME', resolution: 'keep_favorite' },
    ], target, mappingFor);
    assert.equal(out.removals.pickup.length, 0, '保留收藏不得进入删除计划');
    assert.equal(out.manual.manual_keep, 1);
    assert.equal(out.manual.auto_removals, 0);
  });

  it('3. 取消收藏 + 身份唯一 → 进入删除候选', () => {
    const { plan, mappingFor, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED, 'AMBIG'], dropship: [] },
    );
    // AMBIG 没映射，先是异常。
    assert.equal(plan.exceptions.pickup.length, 1);
    // 人工点取消，且此时身份已能唯一确认。
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'AMBIG', resolution: 'remove_favorite' },
    ], target, mappingsFrom({ AMBIG: 333 }));
    assert.equal(out.removals.pickup.length, 1);
    assert.equal(out.removals.pickup[0].product_id, 333);
    assert.equal(out.removals.pickup[0].verified_sku, 'AMBIG');
    assert.equal(out.manual.manual_remove, 1);
    assert.equal(out.exceptions.pickup.length, 0);
  });

  it('4. 无需处理 → 不再算作未处理异常', () => {
    const { plan, mappingFor, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED, 'DONE-ALREADY'], dropship: [] },
    );
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'DONE-ALREADY', resolution: 'no_action' },
    ], target, mappingFor);
    assert.equal(out.manual.unresolved_exceptions, 0, '已确认无需操作不得再算未处理');
    assert.equal(out.manual.manual_no_action, 1);
    assert.equal(out.exceptions.pickup.length, 0);
    assert.equal(out.removals.pickup.length, 0, '无需处理不得发送任何请求');
  });

  it('5. published=true 无论人工怎么点都不删', () => {
    const { plan, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED], dropship: [PUBLISHED] }, { [PUBLISHED]: 999 },
    );
    // 已上线商品本就不在 extra 里。
    assert.equal(plan.removals.pickup.length, 0);
    // 就算有人给它写了 remove_favorite，也不得出现在删除计划里。
    const evil: ManualResolutionRecord[] = [
      { supplier_account: 'pickup', supplier_product_id: PUBLISHED, resolution: 'remove_favorite' },
      { supplier_account: 'dropship', supplier_product_id: PUBLISHED, resolution: 'remove_favorite' },
    ];
    const out = applyManualResolutions(plan, evil, target, mappingsFrom({ [PUBLISHED]: 999 }));
    assert.equal(out.removals.pickup.length, 0, 'published=true 永远不得被取消');
    assert.equal(out.removals.dropship.length, 0);
  });

  it('6 + 7. 取消收藏仍需唯一身份 —— 没有就不猜着删', () => {
    const { plan, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED, 'STILL-AMBIG'], dropship: [] },
    );
    // 人工点了取消，但身份依旧无法唯一确认。
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'STILL-AMBIG', resolution: 'remove_favorite' },
    ], target, mappingsFrom({}));
    assert.equal(out.removals.pickup.length, 0, '身份不唯一时人工点击也不得删除');
    assert.equal(out.manual.manual_remove, 0);
    assert.equal(out.manual.manual_remove_blocked, 1);
    assert.equal(out.exceptions.pickup.length, 1, '仍然留在异常里等身份补齐');

    // 反查不一致（product_id 指向别的 SKU）同样不得放行。
    const mismatched = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'STILL-AMBIG', resolution: 'remove_favorite' },
    ], target, () => ({ product_id: 777, verified_sku: 'SOMEONE-ELSE', status: 'unique' }));
    assert.equal(mismatched.removals.pickup.length, 0, '反查 SKU 不一致不得删除');
    assert.equal(mismatched.manual.manual_remove_blocked, 1);
  });

  it('8 + 9. 账号隔离：同一 SKU 两账号可以有不同裁决', () => {
    const sku = 'BOTH-ACCOUNTS';
    const { plan, target } = makePlan(
      [PUBLISHED], { pickup: [PUBLISHED, sku], dropship: [PUBLISHED, sku] }, { [sku]: 444 },
    );
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: sku, resolution: 'keep_favorite' },
      { supplier_account: 'dropship', supplier_product_id: sku, resolution: 'remove_favorite' },
    ], target, mappingsFrom({ [sku]: 444 }));
    // Pickup 保留，Dropship 取消 —— 两个账号互不影响。
    assert.equal(out.removals.pickup.length, 0, 'pickup 的保留不得被 dropship 的取消覆盖');
    assert.equal(out.removals.dropship.length, 1);
    assert.equal(out.removals.dropship[0].supplier_product_id, sku);
    assert.equal(out.manual.manual_keep, 1);
    assert.equal(out.manual.auto_removals, 1);
  });

  it('10 + 11. 真实案例：N721S000064K 保留、N721S000044K-1 无需处理', () => {
    const keep = 'N721S000064K';
    const noop = 'N721S000044K-1';
    // 两者当前都在 Pickup 收藏里，都不在 TARGET，都没有唯一映射（正是现实中的异常形态）。
    const { plan, target } = makePlan([PUBLISHED], { pickup: [PUBLISHED, keep, noop], dropship: [] });
    assert.equal(plan.exceptions.pickup.length, 2);

    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: keep, resolution: 'keep_favorite' },
      { supplier_account: 'pickup', supplier_product_id: noop, resolution: 'no_action' },
    ], target, mappingsFrom({}));

    // 保留的不得进入删除计划。
    assert.equal(out.removals.pickup.some((i) => i.supplier_product_id === keep), false);
    // 无需处理的不再是待处理异常。
    assert.equal(out.exceptions.pickup.some((e) => e.supplier_product_id === noop), false);
    // 两者都不再计入未处理。
    assert.equal(out.manual.unresolved_exceptions, 0);
    assert.equal(out.manual.manual_keep, 1);
    assert.equal(out.manual.manual_no_action, 1);
    // 关键：不得因为两者是同一件商品就擅自给谁建映射。
    assert.equal(out.removals.pickup.length, 0, '不得擅自建立 product_id 映射后删除');
  });

  it('12. 36 条异常处理 2 条后，未处理计数变 34', () => {
    const skus = Array.from({ length: 36 }, (_, i) => `EXC-${String(i).padStart(2, '0')}`);
    const { plan, target } = makePlan([PUBLISHED], { pickup: [PUBLISHED, ...skus], dropship: [] });
    assert.equal(plan.exceptions.pickup.length, 36);

    const before = applyManualResolutions(plan, [], target, mappingsFrom({}));
    assert.equal(before.manual.unresolved_exceptions, 36);

    const after = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: skus[0], resolution: 'keep_favorite' },
      { supplier_account: 'pickup', supplier_product_id: skus[1], resolution: 'no_action' },
    ], target, mappingsFrom({}));
    assert.equal(after.manual.unresolved_exceptions, 34, '处理 2 条后未处理必须是 34');
    assert.equal(after.manual.manual_keep + after.manual.manual_no_action, 2);
  });

  it('14. plan 同时给出自动与人工各项计数，供确认页展示', () => {
    const { plan, target } = makePlan(
      [PUBLISHED],
      { pickup: [PUBLISHED, 'AUTO-1', 'KEEP-1', 'RM-1', 'NOOP-1', 'OPEN-1'], dropship: [] },
      { 'AUTO-1': 1, 'KEEP-1': 2 },
    );
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'KEEP-1', resolution: 'keep_favorite' },
      { supplier_account: 'pickup', supplier_product_id: 'RM-1', resolution: 'remove_favorite' },
      { supplier_account: 'pickup', supplier_product_id: 'NOOP-1', resolution: 'no_action' },
    ], target, mappingsFrom({ 'AUTO-1': 1, 'KEEP-1': 2, 'RM-1': 3 }));

    assert.deepEqual(out.manual, {
      auto_removals: 1,          // AUTO-1
      manual_keep: 1,            // KEEP-1
      manual_remove: 1,          // RM-1（身份已唯一）
      manual_remove_blocked: 0,
      manual_no_action: 1,       // NOOP-1
      unresolved_exceptions: 1,  // OPEN-1
    });
  });

  it('裁决只影响同步计划，不产生任何发布/下架语义', () => {
    // 结构性断言：这一层的输出只有 removals / exceptions / 计数，没有任何 published 字段。
    const { plan, target } = makePlan([PUBLISHED], { pickup: [PUBLISHED, 'X-1'], dropship: [] });
    const out = applyManualResolutions(plan, [
      { supplier_account: 'pickup', supplier_product_id: 'X-1', resolution: 'keep_favorite' },
    ], target, mappingsFrom({}));
    const serialized = JSON.stringify(out);
    for (const forbidden of ['published', 'inventory', 'sellable', 'availability', 'delist', 'relist']) {
      assert.equal(serialized.includes(forbidden), false, `计划输出不得出现 ${forbidden}`);
    }
  });

  console.log(`\n${passed} passed`);
}

main();
