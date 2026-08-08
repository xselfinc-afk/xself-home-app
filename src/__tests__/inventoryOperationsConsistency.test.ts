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

  it('19. 「当前读取失败」来自实时证据，不来自扫描报告', () => {
    const bridge = code(fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8'), '//');
    const block = bridge.slice(bridge.indexOf('const stateCounts = groupStateCounts(workflows);'));
    const errorsLine = block.slice(0, block.indexOf('\n', block.indexOf('const errors =')) + 1);
    assert.equal(
      /report\?\.totals\?\.failures/.test(errorsLine), false,
      '不得用报告里的 failures 当作当前状态 —— 那属于「最近运行」',
    );
    // 也不能用 consecutive_failures：一次 malformed 探测不会创建 product_availability_current
    // 行，所以这个字段结构上永远看不到 N710P206904C 那类商品（已发布、最近一次读取失败、
    // 却完全不在那张表里）。计数因此恒为 0，而队列列表却有 1 条。
    assert.equal(/consecutive_failures/.test(errorsLine), false);
    assert.ok(/readFailures\.size/.test(errorsLine), '必须与队列列表共用同一个判定');
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

  it('Hotfix 1. 跑完了不等于正在跑 —— 五种调度器状态各归各位', () => {
    const base = { installed: true, loaded: true, runAtLoad: true, intervalSeconds: 172_800 };
    // 生产真实形状：state = not running, runs = 1, last exit code = 0。
    assert.equal(diagnoseScheduler({ ...base, running: false, runs: 1, lastExitCode: 0 }).status, 'waiting',
      '任务已经结束，界面不得再显示运行中');
    assert.equal(diagnoseScheduler({ ...base, running: true, runs: 1, lastExitCode: 0 }).status, 'running');
    assert.equal(diagnoseScheduler({ ...base, running: false, runs: 1, lastExitCode: 1 }).status, 'last_run_failed');
    assert.equal(diagnoseScheduler({ ...base, running: false, runs: 0, lastExitCode: null }).status, 'never_ran');
    assert.equal(diagnoseScheduler({ ...base, installed: false, running: null, runs: null, lastExitCode: null }).status, 'not_installed');
    assert.equal(diagnoseScheduler({ ...base, loaded: false, running: null, runs: null, lastExitCode: null }).status, 'not_loaded');
    // 读不到 state 时绝不当成在跑。
    assert.notEqual(diagnoseScheduler({ ...base, running: null, runs: 1, lastExitCode: 0 }).status, 'running');
  });

  it('Hotfix 1. state 解析必须先判 not running，否则会被 running 的子串骗过去', () => {
    const print = (state: string) => parseLaunchctlPrint(`\tstate = ${state}\n\truns = 1\n\tlast exit code = 0\n`);
    assert.equal(print('not running').running, false);
    assert.equal(print('running').running, true);
    assert.equal(parseLaunchctlPrint('runs = 1\n').running, null, '没打印 state 就是未知');
    assert.equal(print('not running').lastExitCode, 0);
  });

  it('Hotfix 1. 上次运行失败必须让人看见，不能算健康', () => {
    const base = { runLockActive: false, schedulerLoaded: true, errors: 0, coverageBelowMinimum: false };
    assert.equal(deriveInventoryHealth({ ...base, schedulerStatus: 'last_run_failed' }), 'attention_required');
    assert.equal(deriveInventoryHealth({ ...base, schedulerStatus: 'waiting' }), 'healthy');
  });

  it('Hotfix 3. 没有报告文件的运行也要能分类，不再一律「未知类型」', () => {
    // 商品身份复检根本不写扫描报告 —— 这正是运行记录里大量「未知类型」的来源。
    assert.equal(describeRunKind(null, { runId: 'xone-targeted-identity-abc-123' }).kind, 'identity_recheck');
    assert.equal(describeRunKind(null, { runId: 'xone-targeted-identity-abc' }).label, '商品身份复检');
    assert.equal(describeRunKind(null, { runId: 'xone-targeted-1785809509600-34187' }).kind, 'single_sku_recheck');
    // 历史 avail-* 运行只剩数据库行：按实际检查数判定。
    assert.equal(describeRunKind(null, { runId: 'avail-2026-08-04', checkedCount: 1, publishedTotal: 353 }).kind, 'targeted_sku_scan');
    assert.equal(describeRunKind(null, { runId: 'avail-2026-08-04', checkedCount: 353, publishedTotal: 353 }).kind, 'full_scan');
    // 期间有商品上下架，覆盖九成以上仍算全量。
    assert.equal(describeRunKind(null, { runId: 'avail-x', checkedCount: 340, publishedTotal: 353 }).kind, 'full_scan');
    assert.equal(describeRunKind(null, { runId: 'avail-x', checkedCount: 50, publishedTotal: 353 }).kind, 'partial_limited_scan');
    // 只推进状态、从不查库存的运行也是一类真实运行，不是证据不足。
    assert.equal(describeRunKind(null, { runId: '5a83a797-dd31-4188', runner: 'inventoryWorkflowRun', checkedCount: 0 }).kind, 'workflow_state_run');
    // 真正什么证据都没有的才叫未知。
    assert.equal(describeRunKind(null, { runId: 'avail-x', checkedCount: 0, publishedTotal: 353 }).kind, 'unknown');
    assert.equal(describeRunKind(null).kind, 'unknown');
  });

  it('Hotfix 3. 有报告时仍以报告为准，历史文件一个字不改', () => {
    assert.equal(describeRunKind({ report_kind: 'scheduled_inventory_scan', is_full_scan: true }, { runId: 'avail-1' }).kind, 'full_scan');
    assert.equal(describeRunKind({ report_kind: 'xone_single_sku_recheck' }, { runId: 'avail-1' }).kind, 'single_sku_recheck');
    // 声称调度扫描但证明不了范围，且没有别的证据 → 明说范围未记录。
    assert.equal(describeRunKind({ report_kind: 'scheduled_inventory_scan' }, { runId: 'avail-1', checkedCount: 0 }).kind, 'unknown_scope_scan');
    // 分类是只读判断：不得出现任何写文件的动作。
    const bridge = fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8');
    const fn = bridge.slice(bridge.indexOf('export function describeRunKind'), bridge.indexOf('export function readLatestFullScanReport'));
    assert.equal(/writeFileSync|appendFileSync|unlinkSync/.test(fn), false, '分类不得改动历史报告');
  });

  it('Hotfix 4. 安装脚本的 plist heredoc 里不得有反引号或命令替换', () => {
    const installer = fs.readFileSync('scripts/installAvailabilityScanScheduler.sh', 'utf8');
    const start = installer.indexOf('<<PLISTEOF');
    const end = installer.indexOf('PLISTEOF', start + 10);
    assert.ok(start > 0 && end > start, '找不到 plist heredoc');
    const heredoc = installer.slice(start, end);
    // heredoc 未加引号（需要展开 ${LABEL} 等），所以反引号会被当成命令执行 ——
    // 这正是 "line 36: runs: command not found" 的来源。
    assert.equal(heredoc.includes('`'), false, 'heredoc 内不得出现反引号');
    assert.equal(/\$\(/.test(heredoc), false, 'heredoc 内不得出现命令替换');
    // 只允许这几个有意的变量展开。
    const vars = [...heredoc.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
    for (const name of vars) {
      assert.ok(['LABEL', 'RUNNER', 'REPO', 'INTERVAL', 'LOG_DIR'].includes(name), `意外的变量展开 ${name}`);
    }
    // 裸 $ 也不允许（除了上面这些 ${...}）。
    assert.equal(/\$(?!\{)/.test(heredoc), false, 'heredoc 内不得出现裸 $');
  });

  it('自检 A. 「错误」的计数与列表必须同一个来源', () => {
    const bridge = code(fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8'), '//');
    // 概览的 errors 和队列的 errors 列表都必须走 readCurrentReadFailures。
    assert.ok(/const errors = readFailures\.size;/.test(bridge), '概览计数必须来自共享判定');
    const itemsErrors = bridge.slice(bridge.indexOf("request.bucket === 'errors'"));
    assert.ok(/readCurrentReadFailures\(client\)/.test(itemsErrors.slice(0, 600)), '列表必须来自同一个共享判定');
    // consecutive_failures 结构上看不到「没有 current 行」的商品，不能再拿它当计数。
    const summaryBlock = bridge.slice(bridge.indexOf('const stateCounts = groupStateCounts(workflows);'));
    const errorsLine = summaryBlock.slice(0, summaryBlock.indexOf('\n', summaryBlock.indexOf('const errors =')) + 1);
    assert.equal(/consecutive_failures/.test(errorsLine), false);
    // 判定本身按「每个商品最新一次检查」，与是哪一次运行无关。
    const fn = bridge.slice(bridge.indexOf('async function readCurrentReadFailures'));
    const body = fn.slice(0, fn.indexOf('async function readPublishedIds'));
    assert.ok(/newest\.has\(check\.supplier_product_id\)/.test(body), '必须按 SKU 取最新一次');
    assert.equal(/run_id === /.test(body), false, '不得再绑定到某一次 run');
  });

  it('自检 B. 商品 id 必须显式传入，不能从行对象反推', () => {
    const bridge = code(fs.readFileSync('scripts/xoneInventoryLifecycleBridge.ts', 'utf8'), '//');
    const fn = bridge.slice(bridge.indexOf('function itemFromFacts('));
    const sig = fn.slice(0, fn.indexOf('): Record<string, unknown> {'));
    assert.ok(/supplierProductId: string,/.test(sig), 'id 必须是显式参数');
    // 反推写法在「既无 workflow 行、也无 availability_current 行」时会落到空串 ——
    // 真实生产里 N710P206904C 就是这样：已发布、最近一次读取失败、两张表都没有它。
    assert.ok(
      /const id = supplierProductId\s*\n?\s*\|\|/.test(fn.slice(0, fn.indexOf('return {'))),
      '必须优先使用显式传入的 id',
    );
    // 两个调用点都要把 id 传进去。
    const calls = [...bridge.matchAll(/itemFromFacts\(\s*\n\s*([A-Za-z_.?\[\]]+)/g)].map((m) => m[1]);
    assert.equal(calls.length >= 2, true, `应有至少两个调用点，实际 ${calls.length}`);
    for (const first of calls) {
      assert.equal(/^(wfById|avById|products|holdById)/.test(first), false, `第一个实参不该是行对象：${first}`);
    }
  });

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
    // 跑过 5 次、此刻没在跑、上次成功 → 等待下次，不是「运行中」。
    assert.equal(diagnoseScheduler({
      installed: true, loaded: true, running: false, runs: 5, lastExitCode: 0,
      runAtLoad: true, intervalSeconds: 172_800,
    }).status, 'waiting');
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
    assert.equal(deriveInventoryHealth({ ...base, schedulerStatus: 'waiting' }), 'healthy');
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
    // 只切 runCheckNewSaved 本身。它后面是上架预览 —— 那条路径允许导入草稿，不适用这条断言。
    // 用代码锚点而不是注释：code() 会把注释行剥掉。
    const nextDecl = bridge.indexOf('interface PreviewRow', start);
    const block = bridge.slice(start, nextDecl > start ? nextDecl : bridge.indexOf('export async function executeOnboardingBridge'));
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
    // 只切 runCheckNewSaved 本身。它后面是上架预览 —— 那条路径允许导入草稿，不适用这条断言。
    // 用代码锚点而不是注释：code() 会把注释行剥掉。
    const nextDecl = bridge.indexOf('interface PreviewRow', start);
    const block = bridge.slice(start, nextDecl > start ? nextDecl : bridge.indexOf('export async function executeOnboardingBridge'));
    // 保护对象是 candidates，不是全部 Pickup 收藏。
    assert.ok(/protectionPlan = candidates\.map/.test(block), '保护只覆盖正式候选');
    assert.equal(/pickupSaved\.forEach|for \(const sku of pickupSaved\)/.test(block), false,
      '不得给所有 Pickup 收藏都上保护');
    // 没有明确要求就不写生产。
    assert.ok(/if \(request\.apply_protection\)/.test(block));
    assert.ok(/只出计划/.test(block));
  });

  it('预览 B. 最终成品字段全部来自既有纯函数，售价拿不到就留空', () => {
    const { buildPreviewRows } = require('../../scripts/xoneProductOnboardingBridge');
    const rows = buildPreviewRows({
      plan: {
        proposed_batch: { skus: ['R1'] },
        candidates: [
          { id: 'R1', bucket: 'SAFE_SINGLETON', reasons: [] },
          { id: 'B1', bucket: 'HOLD_PHASE2', reasons: ['cfgmissing_fragmented'] },
        ],
      },
      supplierRows: [{ supplier_product_id: 'R1' }, { supplier_product_id: 'B1' }],
      normalize: () => ({
        product_title_display: 'Large Petal Cloud Sofa Chair',
        sku_custom: 'XH-SF-LR-523988',
        category_label: 'Sofa',
        primary_image: 'https://x/a.jpg',
        gallery_images_json: ['b', 'c', 'd', 'e', 'f', 'g', 'h'],
        specifications_json: { Color: 'Antique Grey', Material: 'Microsuede' },
        price: 48,
        original_price: 109,
      }),
      reviewCount: () => ({ count: 5, avg: 4.6 }),
    });

    const ready = rows.find((r: any) => r.supplier_product_id === 'R1');
    assert.equal(ready.ready, true);
    assert.equal(ready.title, 'Large Petal Cloud Sofa Chair');
    assert.equal(ready.sku_custom, 'XH-SF-LR-523988');
    assert.equal(ready.category, 'Sofa');
    assert.equal(ready.image_count, 8, '主图 + 7 张画廊图');
    assert.equal(ready.cost, 48);
    assert.equal(ready.anchor_price, 109);
    // 售价在发布前拿不到 —— 必须留空并标记，绝不编造。
    assert.equal(ready.selling_price, null);
    assert.equal(ready.selling_price_pending, true);
    // 冷启动评价必须标明是生成的。
    assert.equal(ready.review_kind, 'generated');
    assert.equal(ready.review_count, 5);

    // Ready 名单只认 proposed_batch；其余进「需要处理」并给出人话原因。
    const blocked = rows.find((r: any) => r.supplier_product_id === 'B1');
    assert.equal(blocked.ready, false);
    assert.match(blocked.blocked_reason, /配置不完整/);
  });

  it('预览 B. 一件异常不得把其余 Ready 商品拖下水', () => {
    const { buildPreviewRows } = require('../../scripts/xoneProductOnboardingBridge');
    const ids = ['R1', 'R2', 'R3', 'B1'];
    const rows = buildPreviewRows({
      plan: {
        proposed_batch: { skus: ['R1', 'R2', 'R3'] },
        candidates: ids.map((id) => ({
          id, bucket: id.startsWith('R') ? 'SAFE_SINGLETON' : 'HOLD_INVENTORY', reasons: [],
        })),
      },
      supplierRows: ids.map((id) => ({ supplier_product_id: id })),
      normalize: () => ({ product_title_display: 't', sku_custom: 's', primary_image: 'i', price: 1 }),
      reviewCount: () => ({ count: 5, avg: 4.6 }),
    });
    assert.equal(rows.filter((r: any) => r.ready).length, 3);
    assert.equal(rows.filter((r: any) => !r.ready).length, 1);
    assert.match(rows.find((r: any) => r.supplier_product_id === 'B1').blocked_reason, /无库存/);
  });

  it('故障 1. GUI 最小 PATH 起不了工具链；注入后可用', () => {
    const { toolchainPath, preflightToolchain } = require('../../scripts/xoneProductOnboardingBridge');
    // XOne 是 GUI 启动的 .app，PATH 只有这四个目录 —— npx（在 nvm 下）根本看不到。
    const guiPath = '/usr/bin:/bin:/usr/sbin:/sbin';
    assert.equal(preflightToolchain({ ...process.env, PATH: guiPath }).ok, false, 'GUI 最小 PATH 必须探测失败');

    const fixed = toolchainPath(process.execPath, guiPath);
    // 当前进程自己的 node 目录排在最前 —— nvm 换版本也不会失效。
    assert.equal(fixed.split(':')[0], require('node:path').dirname(process.execPath));
    assert.ok(fixed.includes('/opt/homebrew/bin'));
    assert.equal(preflightToolchain({ ...process.env, PATH: fixed }).ok, true, '注入后必须能起工具链');
    // 不重复、不丢原有目录。
    const parts = fixed.split(':');
    assert.equal(new Set(parts).size, parts.length, 'PATH 不得有重复项');
    for (const dir of guiPath.split(':')) assert.ok(parts.includes(dir));
  });

  it('故障 1. 执行器启动前先自检工具链，避免留下半成品', () => {
    const bridge = code(fs.readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8'), '//');
    const start = bridge.indexOf('async function runBatchPublish');
    const block = bridge.slice(start, bridge.indexOf('async function readPublishState'));
    // 自检必须排在读取计划快照与启动执行器之前。
    assert.ok(/preflightToolchain/.test(block), '批量上架前必须自检工具链');
    assert.ok(block.indexOf('preflightToolchain') < block.indexOf('runGigaAutoPublish'), '自检必须在执行器之前');
    assert.ok(/TOOLCHAIN_UNAVAILABLE/.test(block));
    // 子进程环境必须带上工具链 PATH。
    assert.ok(/env\.PATH = toolchainPath/.test(bridge), '子进程必须拿到工具链 PATH');
  });

  it('故障 2. 用真实失败报告还原「死在哪一阶段、为什么」', () => {
    const { describeApplyFailure } = require('../../scripts/xoneProductOnboardingBridge');
    // 2026-08-08 首次真实批量上架 3/3 失败的原始报告（已脱敏）。
    const report = JSON.parse(fs.readFileSync('src/__tests__/fixtures/xone-batch-failure-2026-08-08.json', 'utf8'));
    const described = describeApplyFailure(report);
    assert.equal(described.stage, 'normalize');
    assert.match(described.reason, /资料整理阶段失败/);
    // 关键：必须说清是「脚本没起来」，而不是笼统的一句流水线未完成。
    assert.match(described.reason, /脚本没有启动/);
    assert.equal(/上架流水线未完成/.test(described.reason), false);

    // 这份报告同时证明 Stage 1 已经翻了发布批准位 —— 半成品的来源。
    assert.equal(report.results.published, 3);
    assert.equal(report.results.normalized, 0);
    // 而顾客侧毫无影响：sellable 前后一致。
    assert.equal(report.catalog.sellable_before, report.catalog.sellable_after);
  });

  it('故障 2. 其它阶段失败也各有各的业务说法', () => {
    const { describeApplyFailure } = require('../../scripts/xoneProductOnboardingBridge');
    const cases: Array<[string, RegExp]> = [
      ['pricing', /定价阶段失败/],
      ['inventory', /库存阶段失败/],
      ['mirror', /图片转存阶段失败/],
      ['guardrail', /安全门拦截/],
      ['reviews', /评价初始化阶段失败/],
    ];
    for (const [stage, expected] of cases) {
      const r = describeApplyFailure({ reached_stage: stage, stage_failures: { [stage]: 'boom' }, log: [] });
      assert.equal(r.stage, stage);
      assert.match(r.reason, expected);
    }
    assert.deepEqual(describeApplyFailure(null), { stage: null, reason: null });
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
