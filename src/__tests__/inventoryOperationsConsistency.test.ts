/**
 * 商品可售管理与新品发现的口径一致性 —— 纯单元测试，不碰网络、数据库、供应商。
 *
 * 守的是「界面上的数字必须能被相信」这一件事。这一轮真实暴露的四个谎：
 *   有效证据覆盖率 35200%   分子取实时证据，分母取一次 1 件扫描报告
 *   读取失败 1              早已恢复的商品，因为报告里留着一条 failure 就长期报错
 *   上次成功扫描            失败率 100% 的 dry run 也叫「成功」
 *   自动48小时循环          用户手点的单件复检被标成调度器跑的全量扫描
 *
 * 运行：npx tsx src/__tests__/inventoryOperationsConsistency.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  computeAvailabilityCoverage,
  deriveInventoryHealth,
  describeRunKind,
  deriveRunTerminalStatus,
  diagnoseScheduler,
  isFullScanReport,
  parseLaunchctlPrint,
} from '../../scripts/xoneInventoryLifecycleBridge';
import { extractSavedSkusFromDelta } from '../../scripts/xoneProductOnboardingBridge';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

/** 去掉注释行，避免断言命中解释性文字而不是真正的代码。 */
function code(source: string, comment: '#' | '//'): string {
  return source.split('\n').filter((line) => !line.trim().startsWith(comment)).join('\n');
}

const NOW = new Date('2026-08-07T00:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const ids = (n: number, offset = 0) => Array.from({ length: n }, (_u, i) => `P${offset + i}`);
const evidence = (list: string[], at: string) => list.map((id) => ({ supplier_product_id: id, checked_at: at }));

function main(): void {
  // ── 16 + 17 + 18. 覆盖率口径 ───────────────────────────────────────────────

  it('16 + 17. 353 published / 352 covered → 99.7%，分子分母同源', () => {
    const r = computeAvailabilityCoverage(
      evidence(ids(352), hoursAgo(3)),
      new Set(ids(353)),
      NOW,
    );
    assert.deepEqual(r, { published: 353, covered: 352, percent: 99.7 });
  });

  it('16 + 17. 覆盖率永远不得超过 100% —— 这正是 35200% 的形状', () => {
    // 实时证据 352 条，分母若来自一次 1 件的 targeted 报告就会得到 35200%。
    const wrongDenominator = Number(((352 / 1) * 100).toFixed(1));
    assert.equal(wrongDenominator, 35200, '重现旧口径');

    // 正确口径：分母是当前已发布集合，分子还要落在这个集合里。
    const r = computeAvailabilityCoverage(
      [...evidence(ids(352), hoursAgo(3)), ...evidence(ids(900, 5_000), hoursAgo(3))],
      new Set(ids(353)),
      NOW,
    );
    assert.ok(r.percent <= 100, `覆盖率必须 ≤ 100%，实际 ${r.percent}`);
    assert.equal(r.covered, 352);
    assert.equal(r.published, 353);
  });

  it('18. targeted 报告不参与覆盖率计算 —— 分母只认实时已发布集合', () => {
    const bridge = code(fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8'), '//');
    assert.equal(
      /published_targets/.test(bridge), false,
      '概览不得再从扫描报告读取 published_targets',
    );
    assert.ok(/readPublishedIds/.test(bridge), '分母必须来自实时 standardized_products');
    // 分页读取：未分页会在 1000 行截断，分母变小、覆盖率虚高。
    const fn = bridge.slice(bridge.indexOf('async function readPublishedIds'));
    assert.ok(/\.range\(/.test(fn.slice(0, 800)), '已发布集合必须分页读取');
  });

  // ── 19. 当前读取失败取实时表 ───────────────────────────────────────────────

  it('19. 「当前读取失败」来自实时证据表，不来自扫描报告', () => {
    const bridge = code(fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8'), '//');
    const block = bridge.slice(bridge.indexOf('const stateCounts = groupStateCounts(workflows);'));
    const errorsLine = block.slice(0, block.indexOf('\n', block.indexOf('const errors =')) + 1);
    assert.ok(/consecutive_failures/.test(errorsLine), '必须数实时 consecutive_failures');
    assert.equal(
      /report\?\.totals\?\.failures/.test(errorsLine), false,
      '不得再用报告里的 failures 当作当前状态',
    );
  });

  // ── 23 + 25. 运行类型与「成功」的定义 ──────────────────────────────────────

  it('24. 全量扫描只认明确声明过范围的报告', () => {
    assert.equal(isFullScanReport({ report_kind: 'scheduled_inventory_scan', is_full_scan: true }), true);
    // 旧报告没有 is_full_scan 字段 —— 证明不了就不算，绝不默认为全量。
    assert.equal(isFullScanReport({ report_kind: 'scheduled_inventory_scan' }), false);
    assert.equal(isFullScanReport({ report_kind: 'targeted_sku_scan', is_full_scan: true }), false);
    assert.equal(isFullScanReport({ report_kind: 'xone_single_sku_recheck', is_full_scan: false }), false);
    assert.equal(isFullScanReport(null), false);
  });

  it('24. 每类运行有自己的名字，不是全部叫「自动48小时循环」', () => {
    assert.equal(describeRunKind({ report_kind: 'scheduled_inventory_scan', is_full_scan: true }).kind, 'full_scan');
    assert.equal(describeRunKind({ report_kind: 'targeted_sku_scan' }).kind, 'targeted_sku_scan');
    assert.equal(describeRunKind({ report_kind: 'partial_limited_scan' }).kind, 'partial_limited_scan');
    assert.equal(describeRunKind({ report_kind: 'xone_single_sku_recheck' }).kind, 'single_sku_recheck');
    assert.equal(describeRunKind(null).kind, 'unknown');
    // 声称是调度扫描却没有全量证明 → 明说范围未知，不冒充全量。
    assert.equal(describeRunKind({ report_kind: 'scheduled_inventory_scan' }).kind, 'unknown_scope_scan');
    for (const kind of ['targeted_sku_scan', 'xone_single_sku_recheck', 'partial_limited_scan']) {
      assert.notEqual(describeRunKind({ report_kind: kind }).label, '全量库存扫描');
    }
  });

  it('25. 失败率 100% 的 dry run 绝不算「成功」', () => {
    const allFailed = {
      totals: { total: 1, failures: 1, failurePercent: 100 },
      gates: { failureRate: { allowed: false, blocks: ['exceeds_max_failure_percent'] } },
    };
    assert.equal(deriveRunTerminalStatus(allFailed), 'failed');
    // 部分失败 → partial，不是 success 也不是 failed。
    assert.equal(deriveRunTerminalStatus({ totals: { total: 100, failures: 3 }, gates: {} }), 'partial');
    // 门被挡住也不算成功。
    assert.equal(deriveRunTerminalStatus({
      totals: { total: 100, failures: 0 },
      gates: { delistBatch: { allowed: false } },
    }), 'partial');
    assert.equal(deriveRunTerminalStatus({ totals: { total: 100, failures: 0 }, gates: {} }), 'success');
    // 什么都没扫到不是成功。
    assert.equal(deriveRunTerminalStatus({ totals: { total: 0, failures: 0 }, gates: {} }), 'failed');
    assert.equal(deriveRunTerminalStatus(null), 'unknown');
  });

  it('23. targeted 运行不得覆盖 latest 全量报告', () => {
    const scanner = code(fs.readFileSync('scripts/scanPublishedAvailability.ts', 'utf8'), '//');
    const idx = scanner.indexOf('const reportPath');
    const block = scanner.slice(idx, idx + 500);
    assert.ok(/isFullScan/.test(block), 'latest 文件名必须由 isFullScan 决定');
    assert.ok(/latest-availability-scan\.json/.test(block));
    // 只有全量才写 latest：任何窄化运行都落到自己的文件。
    assert.ok(/targeted-\$\{/.test(block), '窄化运行必须写到独立文件');
    assert.ok(
      /const isFullScan = !NARROWED && targets\.length === publishedTotal;/.test(scanner),
      '全量的定义必须是「真的看了全部已发布商品」',
    );
  });

  // ── 26 + 27 + 28. 调度器 ───────────────────────────────────────────────────

  it('26. launchctl 输出按字段解析，缺什么就是 null，不猜', () => {
    const sample = [
      'com.xselfhome.inventory-availability-scan = {',
      '\tstate = not running',
      '\truns = 0',
      '\tlast exit code = (never exited)',
      '\trun interval = 172800 seconds',
      '}',
    ].join('\n');
    const parsed = parseLaunchctlPrint(sample);
    assert.equal(parsed.runs, 0);
    assert.equal(parsed.intervalSeconds, 172_800);
    assert.equal(parsed.lastExitCode, null, '(never exited) 不是一个退出码');
    assert.equal(parsed.runAtLoad, null, '没打印就是未知');
    assert.equal(parseLaunchctlPrint('runs = 12\nlast exit code = 1').lastExitCode, 1);
  });

  it('26. 「已加载但一次没跑过」必须报出真实原因，而不是显示健康', () => {
    const stuck = diagnoseScheduler({
      installed: true, loaded: true, runs: 0, runAtLoad: false, intervalSeconds: 172_800,
    });
    assert.equal(stuck.status, 'never_ran');
    assert.match(stuck.reason ?? '', /重启/, '必须说清是重启把倒计时清零了');
    assert.equal(diagnoseScheduler({ installed: false, loaded: false, runs: null, runAtLoad: null, intervalSeconds: null }).status, 'not_installed');
    assert.equal(diagnoseScheduler({ installed: true, loaded: false, runs: null, runAtLoad: null, intervalSeconds: null }).status, 'not_loaded');
    assert.equal(diagnoseScheduler({ installed: true, loaded: true, runs: 5, runAtLoad: true, intervalSeconds: 172_800 }).status, 'active');
  });

  it('26. RunAtLoad 打开，同时脚本自带节奏门 —— 触发频繁不等于扫描频繁', () => {
    const installer = code(fs.readFileSync('scripts/installAvailabilityScanScheduler.sh', 'utf8'), '#');
    assert.ok(/<key>RunAtLoad<\/key><true\/>/.test(installer), 'RunAtLoad 必须为 true，否则每次重启都会把 48h 倒计时清零');
    assert.ok(/<key>StartInterval<\/key><integer>\$\{INTERVAL\}<\/integer>/.test(installer));

    const runner = code(fs.readFileSync('scripts/runAvailabilityScan.sh', 'utf8'), '#');
    assert.ok(/MIN_INTERVAL_HOURS/.test(runner), '必须有节奏门');
    assert.ok(/is_full_scan!==true/.test(runner), '节奏门只认全量扫描的时间');
    assert.ok(/availability-scan skipped/.test(runner), '被节奏门挡下时必须明说跳过');
    // 节奏门必须排在扫描之前。
    assert.ok(
      runner.indexOf('MIN_INTERVAL_HOURS') < runner.indexOf('scanPublishedAvailability.ts'),
      '节奏门必须在扫描之前生效',
    );
  });

  it('26. 一次都没跑过的调度器不得判为健康', () => {
    const base = { runLockActive: false, schedulerLoaded: true, errors: 0, coverageBelowMinimum: false };
    assert.equal(deriveInventoryHealth({ ...base, schedulerStatus: 'never_ran' }), 'attention_required',
      '证据现在够新，只是因为有人手动跑过 —— 自动化其实没在工作');
    assert.equal(deriveInventoryHealth({ ...base, schedulerStatus: 'active' }), 'healthy');
    // 既有优先级不变。
    assert.equal(deriveInventoryHealth({ ...base, runLockActive: true, schedulerStatus: 'never_ran' }), 'running');
    assert.equal(deriveInventoryHealth({ ...base, schedulerLoaded: false, schedulerStatus: 'never_ran' }), 'blocked');
  });

  it('27. 调度器仍然只扫描，永远不改发布状态', () => {
    const runner = code(fs.readFileSync('scripts/runAvailabilityScan.sh', 'utf8'), '#');
    assert.equal(/applyInventoryLifecycleActions/.test(runner), false);
    assert.equal(/--approve\b/.test(runner), false);
    assert.equal(/approved-by/.test(runner), false);
  });

  it('28. 单次运行锁保持不变', () => {
    const scanner = fs.readFileSync('scripts/scanPublishedAvailability.ts', 'utf8');
    assert.ok(/acquireLock/.test(scanner));
    assert.ok(/releaseLock/.test(scanner));
    assert.ok(/LOCK_STALE_MS/.test(scanner));
  });

  // ── 1 ~ 7. 新收藏发现 ──────────────────────────────────────────────────────

  it('1 + 3. 实时收藏集合能同时吃下两种元素形状', () => {
    const snapshot = extractSavedSkusFromDelta({
      timestamp: '2026-08-08T06:34:35.126Z',
      // newly 带标题，unchanged 是裸字符串 —— 真实报告就是这个混合形状。
      newly_saved_skus: [
        { sku: 'W5870P523988', title: 'Large single petal cloud…' },
        { sku: 'W5870P523987', title: 'Large single petal cloud…' },
        { sku: 'W5870P523986', title: 'Large single petal cloud…' },
      ],
      unchanged_saved_skus: ['N710P206904K', 'W409P327401'],
    });
    assert.ok(snapshot);
    assert.equal(snapshot!.skus.size, 5);
    for (const sku of ['W5870P523988', 'W5870P523987', 'W5870P523986']) {
      assert.ok(snapshot!.skus.has(sku), `${sku} 必须能被命中`);
    }
    assert.equal(snapshot!.capturedAt, '2026-08-08T06:34:35.126Z');
  });

  it('4. 已取消收藏的 SKU 不会留在集合里 —— 每次检查都重新实时抓取', () => {
    const before = extractSavedSkusFromDelta({
      newly_saved_skus: [{ sku: 'GONE-1' }], unchanged_saved_skus: ['KEEP-1'],
    });
    assert.equal(before!.skus.has('GONE-1'), true);
    // 下一次抓取里它进了 removed，就再也不出现在 newly/unchanged 里。
    const after = extractSavedSkusFromDelta({
      newly_saved_skus: [], unchanged_saved_skus: ['KEEP-1'], removed_saved_skus: ['GONE-1'],
    });
    assert.equal(after!.skus.has('GONE-1'), false, '取消收藏的商品不得继续显示为待上新');
    assert.equal(after!.skus.has('KEEP-1'), true);
  });

  it('形状不对时返回 null，绝不返回一个空集合冒充「没有收藏」', () => {
    assert.equal(extractSavedSkusFromDelta(null), null);
    assert.equal(extractSavedSkusFromDelta({ newly_saved_skus: 'nope' }), null);
    assert.equal(extractSavedSkusFromDelta({ newly_saved_skus: [], unchanged_saved_skus: [] }), null);
  });

  it('2 + 6. 检查新收藏走既有链条，不重写 diff，也不推进基线', () => {
    const bridge = code(fs.readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8'), '//');
    const start = bridge.indexOf('async function runCheckNewSaved');
    const block = bridge.slice(start, bridge.indexOf('export async function executeOnboardingBridge'));
    for (const script of ['giga-saved-baseline.ts', 'giga-saved-delta.ts', 'planGigaNewlySavedCandidates.ts']) {
      assert.ok(block.includes(script), `必须复用 ${script}`);
    }
    // 基线只在缺失时创建，永远不 --force 推进：推进基线会让未上架的候选凭空消失。
    assert.equal(/--force/.test(block), false, '不得推进收藏基线');
    assert.ok(/!fs\.existsSync\(BASELINE_FILE\)/.test(block), '基线只在缺失时创建');
    // 这一步不导入、不发布、不扫库存。
    for (const forbidden of ['syncGigaNewlySavedCandidates', 'onboardScopedSkus', 'runGigaAutoPublish',
      'scanPublishedAvailability', 'applyInventoryLifecycleActions', 'set_publication_from_availability']) {
      assert.equal(block.includes(forbidden), false, `检查新收藏不得触发 ${forbidden}`);
    }
  });

  it('7. 收藏保护绑定在候选成立那一刻，且默认只出计划', () => {
    const bridge = code(fs.readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8'), '//');
    const start = bridge.indexOf('async function runCheckNewSaved');
    const block = bridge.slice(start, bridge.indexOf('export async function executeOnboardingBridge'));
    // 保护对象是 candidates，不是全部 Pickup 收藏。
    assert.ok(/protectionPlan = candidates\.map/.test(block), '保护只覆盖正式候选');
    assert.equal(/pickupSaved\.forEach|for \(const sku of pickupSaved\)/.test(block), false,
      '不得给所有 Pickup 收藏都上保护');
    // 没有明确要求就不写生产。
    assert.ok(/if \(request\.apply_protection\)/.test(block));
    assert.ok(/只出计划/.test(block));
  });

  it('凭据键只按名字摘除，从不读取或打印其值', () => {
    const source = fs.readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8');
    assert.ok(/delete env\[key\]/.test(source), '必须摘除继承来的默认账号凭据');
    for (const key of ['SUPPLIER_CLIENT_ID', 'SUPPLIER_CLIENT_SECRET']) {
      assert.equal(
        new RegExp(`process\\.env\\.${key}`).test(source), false,
        `不得读取 ${key} 的值`,
      );
      assert.equal(new RegExp(`console\\.log\\([^)]*${key}`).test(source), false);
    }
  });

  console.log(`\n${passed} passed`);
}

main();
