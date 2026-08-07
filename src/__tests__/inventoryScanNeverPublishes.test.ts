/**
 * 库存扫描不得改变发布状态 —— 结构性断言，不碰网络、数据库、供应商。
 *
 * 背景：runAvailabilityScan.sh 曾在扫描成功后自动调用 applyInventoryLifecycleActions.ts，
 * 并硬编码 `--approve --approved-by=scheduler`。执行器要求的「明确人工意图」这道门因此
 * 被 shell 自己伪造了：48h 调度器与 XOne 的「刷新库存证据」按钮都走这个脚本，于是发布状态
 * 可以在无人参与的情况下变化 —— 而界面同时显示「资格变更等待批准」。
 *
 * 这套测试把三层分离钉死：
 *   扫描（自动）→ 建议 → 人工批准（唯一发布写门）→ 执行器（安全门仍然生效）
 *
 * 运行：npx tsx src/__tests__/inventoryScanNeverPublishes.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const RUNNER = fs.readFileSync('scripts/runAvailabilityScan.sh', 'utf8');
const SCANNER = fs.readFileSync('scripts/scanPublishedAvailability.ts', 'utf8');
const EXECUTOR = fs.readFileSync('scripts/applyInventoryLifecycleActions.ts', 'utf8');
const BRIDGE = fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8');

/** 去掉注释行，避免断言命中解释性文字而不是真正的代码。 */
function code(source: string, comment: '#' | '//'): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith(comment))
    .join('\n');
}

function main(): void {
  it('1 + 2. 扫描脚本（48h 调度器与 run-now 共用）不再调用发布执行器', () => {
    const runner = code(RUNNER, '#');
    assert.equal(
      /applyInventoryLifecycleActions/.test(runner), false,
      '扫描脚本不得调用发布执行器 —— 扫描只能产生建议',
    );
    // 关键：绝不能再出现被伪造的人工意图。
    assert.equal(/--approve\b/.test(runner), false, '扫描脚本不得传 --approve');
    assert.equal(/--approved-by/.test(runner), false, '扫描脚本不得伪造批准人');
    assert.equal(/approved-by=scheduler/.test(runner), false, 'scheduler 不是人');
  });

  it('扫描仍然自动：证据刷新与状态推进保留', () => {
    const runner = code(RUNNER, '#');
    // 扫描本体照跑，--live 仍在。
    assert.ok(/scanPublishedAvailability\.ts/.test(runner), '扫描本体必须保留');
    assert.ok(/--live/.test(runner), '证据写入必须保留');
    // 仍然报告有多少件成为候选，只是不再执行。
    assert.ok(/awaiting human approval/.test(runner), '必须明确说明在等人工批准');
    assert.ok(/eligible_for_delist|eligible_for_relist/.test(runner), '仍要统计候选');
  });

  it('8. 扫描失败时同样不产生任何发布写入', () => {
    const runner = code(RUNNER, '#');
    // 后续阶段仍然只在 code == 0 时进行，且那些阶段本身也不含执行器。
    assert.ok(/if \[ "\$code" -eq 0 \]/.test(runner), '失败时不得继续');
    const afterGate = runner.slice(runner.indexOf('if [ "$code" -eq 0 ]'));
    assert.equal(/applyInventoryLifecycleActions/.test(afterGate), false);
  });

  it('扫描器本身没有发布写入路径', () => {
    const scanner = code(SCANNER, '//');
    for (const forbidden of ['set_publication_from_availability', 'refresh_product_inventory_status']) {
      assert.equal(scanner.includes(forbidden), false, `扫描器不得调用 ${forbidden}`);
    }
    assert.equal(/from\('standardized_products'\)[\s\S]{0,80}\.update\(/.test(scanner), false,
      '扫描器不得直接更新 standardized_products');
  });

  it('3 + 4. 执行器仍然要求明确的人工批准与显式 SKU 白名单', () => {
    const executor = code(EXECUTOR, '//');
    assert.ok(/--approve/.test(EXECUTOR), '执行器必须保留 --approve 门');
    assert.ok(/approved-by/.test(EXECUTOR), '执行器必须记录批准人');
    assert.ok(/--only/.test(EXECUTOR), '执行器必须要求显式 SKU 白名单');
    // 发布变更仍然只经服务端函数，执行器自己不写 published。
    assert.ok(executor.includes('set_publication_from_availability'), '发布变更必须经服务端函数');
    assert.equal(/from\('standardized_products'\)[\s\S]{0,80}\.update\(/.test(executor), false,
      '执行器不得自己写 standardized_products');
  });

  it('4 + 6 + 7. 数量安全门与双向开关全部保留，作为批准之外的第二层', () => {
    for (const gate of [
      'maxDelistPerRun', 'maxDelistPercent', 'outOfStockConfirmations',
      'minConfirmationIntervalHours', 'maxFailurePercent', 'bulkChangeRequiresApproval',
    ]) {
      assert.ok(EXECUTOR.includes(gate) || /evaluateDelistBatchAllowed/.test(EXECUTOR),
        `安全门 ${gate} 不得被删除`);
    }
    // relist 与 delist 走同一条批准路径，不能只保护一个方向。
    assert.ok(/--action=/.test(EXECUTOR));
    assert.ok(/relist/.test(EXECUTOR) && /delist/.test(EXECUTOR));
  });

  it('5. XOne 桥接没有任何直接发布写入口', () => {
    const bridge = code(BRIDGE, '//');
    for (const forbidden of ['set_publication_from_availability', 'applyInventoryLifecycleActions']) {
      assert.equal(bridge.includes(forbidden), false, `桥接不得调用 ${forbidden}`);
    }
    // run-now 只能启动扫描脚本。
    assert.ok(/SCHEDULER_SCRIPT/.test(bridge), 'run-now 只应启动扫描脚本');
  });

  it('9. 收藏管理链完全不受影响', () => {
    const runner = code(RUNNER, '#');
    const scanner = code(SCANNER, '//');
    for (const table of [
      'supplier_favorite_memberships',
      'supplier_favorite_exception_resolutions',
      'supplier_portal_product_mappings',
      'delProductsFromWish',
    ]) {
      assert.equal(runner.includes(table), false, `扫描脚本不得触碰 ${table}`);
      assert.equal(scanner.includes(table), false, `扫描器不得触碰 ${table}`);
    }
  });

  console.log(`\n${passed} passed`);
}

main();
