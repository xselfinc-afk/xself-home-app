/**
 * Terminal Golden Path 冻结。
 *
 * 这两条命令是生产保底：
 *   npm run giga:saved-to-live:plan
 *   npm run giga:saved-to-live:apply
 *
 * 即使 XOne 完全打不开，它们也必须按原方式独立工作。所以 XOne 的产品化只能**新增薄层**，
 * 不能改这条链的业务语义、CLI 契约或安全门，更不能让它反过来依赖 XOne。
 *
 * 这套测试守的就是这一条：把契约钉死，任何为了 UI 而动 CLI 的改动都会在这里失败。
 *
 * 运行：npx tsx src/__tests__/goldenPathFreeze.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const ORCHESTRATOR = 'scripts/gigaSavedToLiveOrchestrator.ts';
const PLANNER = 'scripts/planGigaAutoPublish.ts';
const RUNNER = 'scripts/runGigaAutoPublish.ts';
const IMPORTER = 'scripts/syncGigaNewlySavedCandidates.ts';

/** Golden Path 上不允许出现 XOne 痕迹的文件。 */
const FROZEN = [
  ORCHESTRATOR, PLANNER, RUNNER, IMPORTER,
  'scripts/normalizeProducts.ts',
  'scripts/generateOptimizedTitles.ts',
  'scripts/seedGeneratedReviews.ts',
  'scripts/mirrorImagesToStorage.ts',
  'scripts/seedPilotInventory.ts',
  'src/services/normalizationPipeline.ts',
  'src/services/supplierPickupService.ts',
  'src/services/reviewGenerator.ts',
];

const read = (file: string) => fs.readFileSync(file, 'utf8');

function main(): void {
  // ── 1 + 2. CLI 契约 ────────────────────────────────────────────────────────

  it('1. plan 仍是默认只读，apply 仍需显式 --apply', () => {
    const src = read(ORCHESTRATOR);
    assert.ok(/const APPLY = argv\.includes\('--apply'\);/.test(src), 'APPLY 必须由 --apply 决定');
    assert.ok(/DEFAULT MODE IS PLAN/.test(src), 'PLAN 必须仍是默认模式');
    // PLAN 不得写库、不得推进基线、不得发布。
    assert.ok(/PLAN does NOT write the DB/.test(src));
  });

  it('1. package.json 的两条命令原样保留', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts['giga:saved-to-live:plan'], 'tsx scripts/gigaSavedToLiveOrchestrator.ts');
    assert.equal(pkg.scripts['giga:saved-to-live:apply'], 'tsx scripts/gigaSavedToLiveOrchestrator.ts --apply');
  });

  it('2. planner 与 runner 的参数契约不变', () => {
    const planner = read(PLANNER);
    assert.ok(/--only=/.test(planner), 'planner 必须保留 --only');
    assert.ok(/--max-skus=/.test(planner), 'planner 必须保留 --max-skus');

    const runner = read(RUNNER);
    assert.ok(/--plan/.test(runner), 'runner 必须保留 --plan');
    assert.ok(/--dry-run/.test(runner) && /--apply/.test(runner));
    // 唯一执行名单仍然只能是 plan.proposed_batch。
    assert.ok(/APPLY processes only plan\.proposed_batch SKUs/.test(runner));
  });

  it('2. 导入仍然只 insert 新行，且不发布', () => {
    const importer = read(IMPORTER);
    assert.ok(/insertNewOnly: true/.test(importer), '必须仍走 insertNewOnly');
    assert.ok(/upsertPickupProducts/.test(importer), '必须仍走既有导入入口');
    const service = read('src/services/supplierPickupService.ts');
    assert.ok(/published=false/.test(service), '新行必须保持未发布');
  });

  // ── 3 + 4. CLI 不得依赖 XOne ───────────────────────────────────────────────

  it('3. Golden Path 上没有任何一处提到 XOne', () => {
    for (const file of FROZEN) {
      const src = read(file);
      assert.equal(
        /\bXOne\b|xone-onboarding|xoneProductOnboardingBridge/.test(src), false,
        `${file} 不得出现 XOne 痕迹 —— 终端链必须能独立工作`,
      );
    }
  });

  it('3. Golden Path 不 import XOne 侧的任何东西', () => {
    for (const file of FROZEN) {
      const src = read(file);
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const spec of imports) {
        assert.equal(/xone/i.test(spec), false, `${file} 不得 import ${spec}`);
      }
    }
  });

  it('4. 终端链的报告文件与 XOne 的产物互不覆盖', () => {
    const orchestrator = read(ORCHESTRATOR);
    // 终端链写自己的 latest-saved-to-live-*；XOne 的快照与预览是另外的文件名。
    assert.ok(/latest-saved-to-live-plan/.test(orchestrator));
    assert.ok(/latest-saved-to-live-apply/.test(orchestrator));
    assert.equal(/xone-onboarding-plan|xone-onboarding-preview/.test(orchestrator), false);

    // XOne 桥接读完 planner 的固定输出后立刻快照，之后只认快照。
    const bridge = read('scripts/xoneProductOnboardingBridge.ts');
    assert.ok(/XONE_PLAN_SNAPSHOT/.test(bridge), 'XOne 必须使用自己的计划快照');
    assert.ok(/fs\.writeFileSync\(XONE_PLAN_SNAPSHOT, raw\)/.test(bridge));
  });

  // ── XOne 侧只能薄调用，不得重造 ────────────────────────────────────────────

  it('XOne 桥接不含任何商品生成逻辑，只调既有能力', () => {
    const bridge = read('scripts/xoneProductOnboardingBridge.ts');
    // 复用而非重写：这几个必须是 import / spawn 既有实现。
    assert.ok(/from '\.\.\/src\/services\/normalizationPipeline'/.test(bridge)
      || /import\('\.\.\/src\/services\/normalizationPipeline'\)/.test(bridge), '必须复用 normalizeProduct');
    assert.ok(/from '\.\.\/src\/services\/reviewGenerator'/.test(bridge)
      || /import\('\.\.\/src\/services\/reviewGenerator'\)/.test(bridge), '必须复用 generateReviewSet');
    assert.ok(/scripts\/planGigaAutoPublish\.ts/.test(bridge), '必须调既有 planner');
    assert.ok(/scripts\/runGigaAutoPublish\.ts/.test(bridge), '必须调既有 runner');
    assert.ok(/scripts\/syncGigaNewlySavedCandidates\.ts/.test(bridge), '必须调既有导入');

    // 绝不能自己算价、自己拼标题、自己发 SKU。
    for (const forbidden of ['psychologicalRound', 'baseRetailPrice', 'buildDisplayTitle', 'skuSuffix']) {
      assert.equal(bridge.includes(forbidden), false, `不得自行实现 ${forbidden}`);
    }
    // 售价预览不得凭空捏造。
    assert.ok(/selling_price: null/.test(bridge), '拿不到最终售价时必须留空，不得编造');
  });

  it('批量上架执行的名单就是界面展示的那一份', () => {
    const bridge = read('scripts/xoneProductOnboardingBridge.ts');
    const start = bridge.indexOf('async function runBatchPublish');
    const block = bridge.slice(start, bridge.indexOf('async function readPublishState'));
    // 名单来自快照的 proposed_batch，执行也用同一个文件。
    assert.ok(/proposed_batch\?\.skus/.test(block), 'Ready 名单只能来自 proposed_batch');
    assert.ok(/'--plan', XONE_PLAN_SNAPSHOT/.test(block), '执行必须用同一份快照');
    // 界面数量与计划不一致时拒绝执行。
    assert.ok(/PLAN_CHANGED/.test(block));
    // 不得自己挑 SKU。
    assert.equal(/--only=/.test(block), false, '批量上架不得绕开 proposed_batch 自己指定 SKU');
  });

  console.log(`\n${passed} passed`);
}

main();
