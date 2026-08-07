/**
 * 人工批准发布变更 —— 纯单元测试，不碰网络、数据库、供应商、执行器。
 *
 * 守的是同一条线：人工批准是安全门**之外**额外必须具备的一项，不是绕过它的钥匙。
 *
 *     人工明确批准  AND  系统安全门通过  AND  后台最新事实仍支持该动作
 *
 * 运行：npx tsx src/__tests__/inventoryPublicationApproval.test.ts
 */
import assert from 'node:assert/strict';
import {
  evaluatePublicationApproval,
  verifyPublicationOutcome,
  isHumanApprover,
  type ApprovalFacts,
} from '../services/inventoryPublicationApproval';
import { INVENTORY_AUTOMATION_DEFAULTS, type InventoryAutomationConfig } from '../services/inventoryAutomationConfig';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const RUN = 'avail-2026-08-07T00:00:00.000Z-1';

const cfg = (over: Partial<InventoryAutomationConfig> = {}): InventoryAutomationConfig => ({
  ...INVENTORY_AUTOMATION_DEFAULTS,
  automationEnabled: true,
  autoDelistEnabled: true,
  autoRelistEnabled: true,
  outOfStockConfirmations: 2,
  relistConfirmations: 2,
  maxDelistPerRun: 5,
  maxDelistPercent: 5,
  ...over,
});

/** 一件「确实该下架」的商品：已发布、缺货、确认两次、状态 eligible。 */
const delistFacts = (over: Partial<ApprovalFacts> = {}): ApprovalFacts => ({
  workflow_state: 'eligible_for_delist',
  published: true,
  available: false,
  checked_at: '2026-08-07T00:00:00.000Z',
  consecutive_out_of_stock: 2,
  consecutive_in_stock: 0,
  current_source_run_id: RUN,
  ...over,
});

/** 一件「确实该恢复」的商品：未发布、有货、确认两次、状态 eligible。 */
const relistFacts = (over: Partial<ApprovalFacts> = {}): ApprovalFacts => ({
  workflow_state: 'eligible_for_relist',
  published: false,
  available: true,
  checked_at: '2026-08-07T00:00:00.000Z',
  consecutive_out_of_stock: 0,
  consecutive_in_stock: 2,
  current_source_run_id: RUN,
  ...over,
});

const approve = (over: Partial<Parameters<typeof evaluatePublicationApproval>[0]> = {}) =>
  evaluatePublicationApproval({
    supplier_product_id: 'SKU-1',
    action: 'delist',
    approved_by: '小何',
    source_run_id: RUN,
    facts: delistFacts(),
    config: cfg(),
    total_published: 353,
    ...over,
  });

function main(): void {
  it('20. delist 与 relist 双向的正常放行', () => {
    const d = approve();
    assert.equal(d.allowed, true, `delist 应放行，实际被拦：${d.blocks.join()}`);
    const r = approve({ action: 'relist', facts: relistFacts() });
    assert.equal(r.allowed, true, `relist 应放行，实际被拦：${r.blocks.join()}`);
  });

  it('8. 前端说 eligible，后台已不 eligible → 拒绝', () => {
    const v = approve({ facts: delistFacts({ workflow_state: 'published_in_stock' }) });
    assert.equal(v.allowed, false);
    assert.ok(v.blocks.includes('not_eligible'));
  });

  it('9. delist 时商品当前已经不在架上 → 拒绝', () => {
    const v = approve({ facts: delistFacts({ published: false }) });
    assert.equal(v.allowed, false);
    assert.ok(v.blocks.includes('published_state_mismatch'));
  });

  it('10. relist 时商品当前已经在架上 → 拒绝', () => {
    const v = approve({ action: 'relist', facts: relistFacts({ published: true }) });
    assert.equal(v.allowed, false);
    assert.ok(v.blocks.includes('published_state_mismatch'));
  });

  it('7. 最新证据不再支持该动作 → 拒绝', () => {
    // 缺货变回有货。
    const back = approve({ facts: delistFacts({ available: true }) });
    assert.ok(back.blocks.includes('evidence_not_supporting'));
    // 确认次数不够。
    const once = approve({ facts: delistFacts({ consecutive_out_of_stock: 1 }) });
    assert.ok(once.blocks.includes('evidence_not_supporting'));
    // relist 方向同理。
    const r = approve({ action: 'relist', facts: relistFacts({ consecutive_in_stock: 1 }) });
    assert.ok(r.blocks.includes('evidence_not_supporting'));
  });

  it('12. 建议 / source run 已失效 → 拒绝', () => {
    assert.ok(approve({ source_run_id: 'avail-old-run' }).blocks.includes('stale_proposal'));
    assert.ok(approve({ source_run_id: '' }).blocks.includes('stale_proposal'));
    assert.ok(approve({ facts: delistFacts({ current_source_run_id: null }) }).blocks.includes('stale_proposal'));
  });

  it('11. 缺少明确人工批准人 → 拒绝；调度器不是人', () => {
    for (const bad of ['', '   ', null, undefined, 'scheduler', 'system', 'automation', 'cron', 'launchd', 'xone', 'SCHEDULER']) {
      const v = approve({ approved_by: bad as never });
      assert.equal(v.allowed, false, `${String(bad)} 不得被当成批准人`);
      assert.ok(v.blocks.includes('approver_missing'));
    }
    assert.equal(isHumanApprover('小何'), true);
    assert.equal(isHumanApprover('x'.repeat(41)), false, '过长的名字同样拒绝');
  });

  it('13. 安全门失败 → 即使人工批准也拒绝', () => {
    // 全局开关关闭。
    assert.ok(approve({ config: cfg({ automationEnabled: false }) }).blocks.includes('safety_blocked'));
    // 方向开关关闭：delist 与 relist 各自独立。
    assert.ok(approve({ config: cfg({ autoDelistEnabled: false }) }).blocks.includes('safety_blocked'));
    const r = approve({ action: 'relist', facts: relistFacts(), config: cfg({ autoRelistEnabled: false }) });
    assert.ok(r.blocks.includes('safety_blocked'));
    // 比例上限：published 很少时，单件也会超过百分比门。
    const pct = approve({ total_published: 5, config: cfg({ maxDelistPercent: 1 }) });
    assert.ok(pct.blocks.includes('safety_blocked'));
    assert.ok(pct.safety_blocks.includes('exceeds_max_delist_percent'), '应如实透出安全门原因码');
  });

  it('14 + 15. 只接受精确单件；"all" 与通配符永远拒绝', () => {
    for (const bad of ['all', 'ALL', '*', 'SKU-1,SKU-2', 'SKU 1', '']) {
      const v = approve({ supplier_product_id: bad });
      assert.equal(v.allowed, false, `${bad} 不得被接受`);
      assert.ok(v.blocks.includes('scope_not_single_sku'));
    }
    assert.equal(approve({ supplier_product_id: 'SKU-1' }).allowed, true);
  });

  it('多道门同时不过时，全部原因都要报出来', () => {
    const v = approve({
      approved_by: 'scheduler',
      source_run_id: 'old',
      facts: delistFacts({ workflow_state: 'published_in_stock', published: false, available: true }),
      config: cfg({ automationEnabled: false }),
    });
    assert.equal(v.allowed, false);
    for (const b of ['approver_missing', 'stale_proposal', 'not_eligible', 'published_state_mismatch', 'evidence_not_supporting', 'safety_blocked']) {
      assert.ok(v.blocks.includes(b as never), `应报出 ${b}`);
    }
  });

  it('16 + 17. 执行后必须回读；published 未按预期变化 → verification_failed', () => {
    // 正常：true → false
    assert.deepEqual(
      verifyPublicationOutcome({ action: 'delist', published_before: true, published_after: false, sellable_after: false }),
      { verified: true, reason: null },
    );
    // RPC 说成功，但回读仍是 true。
    const stuck = verifyPublicationOutcome({ action: 'delist', published_before: true, published_after: true });
    assert.equal(stuck.verified, false);
    assert.match(stuck.reason ?? '', /仍为 true/);
    // 没有发生任何变化。
    const nochange = verifyPublicationOutcome({ action: 'relist', published_before: true, published_after: true });
    assert.equal(nochange.verified, false);
    // 已下架但仍在 App 可见集合里 —— 矛盾必须报出来。
    const visible = verifyPublicationOutcome({ action: 'delist', published_before: true, published_after: false, sellable_after: true });
    assert.equal(visible.verified, false);
    assert.match(visible.reason ?? '', /仍出现在 App 可见/);
    // relist 正常：false → true
    assert.equal(
      verifyPublicationOutcome({ action: 'relist', published_before: false, published_after: true }).verified,
      true,
    );
  });

  it('判定本身不执行任何动作 —— 输出里没有任何写入语义', () => {
    const v = approve();
    const serialized = JSON.stringify(v);
    for (const forbidden of ['update', 'upsert', 'rpc', 'spawn', 'exec', 'token', 'cookie']) {
      assert.equal(serialized.toLowerCase().includes(forbidden), false, `判定输出不得出现 ${forbidden}`);
    }
    assert.deepEqual(Object.keys(v).sort(), ['action', 'allowed', 'blocks', 'safety_blocks', 'supplier_product_id']);
  });

  console.log(`\n${passed} passed`);
}

main();
