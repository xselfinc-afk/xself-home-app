/**
 * 上架未完成商品的续跑判定 —— 纯单元测试，不碰网络、数据库、供应商。
 *
 * fixture 用的是 2026-08-08 三次真实执行留下的状态：
 *   14:00  死在 normalize（GUI 没有 node 工具链）
 *   14:21  死在 inventory（默认账号覆盖了 alt 账号 → no_giga_creds）
 *   14:40  八个阶段全过，却仍然不在 sellable_products
 *
 * 最后那一次最容易被误读成失败。它没有失败 —— 缺的是库存证据，而那属于库存扫描链。
 *
 * 运行：npx tsx src/__tests__/onboardingRecovery.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  buildRecoveryPlan,
  deriveRecoveryState,
  isResumable,
  stageCompletion,
  type OnboardingProgressFacts,
} from '../services/onboardingRecovery';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

/** 2026-08-08 14:40 那次跑完之后，三件的真实状态。 */
const afterFullPipeline = (over: Partial<OnboardingProgressFacts> = {}): OnboardingProgressFacts => ({
  supplier_product_id: 'W5870P523986',
  supplier_published: true,
  in_standardized: true,
  standardized_published: true,
  normalization_status: 'done',
  optimized_title: 'Large single petal cloud comfortable lazy sofa chair',
  selling_price: 139,
  primary_image_mirror_status: 'mirrored',
  primary_image_blurhash: 'LYOL=V?wJW-n^*%ht,xZXRR*R.t7',
  inventory_status: 'in_stock',
  total_available_qty: 100,
  active_review_count: 5,
  has_availability_evidence: false,
  in_sellable: false,
  ...over,
});

function main(): void {
  // ── 1 + 2 + 3. 识别为 partial，而不是新候选、也不是失败 ────────────────────

  it('1 + 3. 八阶段跑完但不可售 → 上架未完成，不是失败，也不该消失', () => {
    const verdict = deriveRecoveryState(afterFullPipeline());
    assert.equal(verdict.state, 'awaiting_evidence');
    assert.deepEqual(verdict.missing, ['visibility']);
    assert.equal(verdict.nextAction, 'refresh_availability');
    assert.equal(isResumable(verdict.state), true, '必须留在续跑清单里');
  });

  it('1. 死在 normalize 的那一次 → 续跑流水线', () => {
    // 14:00 的状态：发布位翻了，standardized 还没建。
    const verdict = deriveRecoveryState(afterFullPipeline({
      in_standardized: false, standardized_published: null, normalization_status: null,
      optimized_title: null, selling_price: null, primary_image_mirror_status: null,
      primary_image_blurhash: null, inventory_status: null, total_available_qty: null,
      active_review_count: 0,
    }));
    assert.equal(verdict.state, 'pipeline_incomplete');
    assert.equal(verdict.nextAction, 'resume_pipeline');
    assert.ok(verdict.missing.includes('data'));
    assert.ok(verdict.missing.includes('inventory'));
  });

  it('1. 死在 inventory 的那一次 → 前六阶段保留，只差库存与评价', () => {
    // 14:21 的状态：资料/标题/定价/图片都好了，库存还是 unknown。
    const verdict = deriveRecoveryState(afterFullPipeline({
      standardized_published: false,
      inventory_status: 'unknown', total_available_qty: 0, active_review_count: 0,
    }));
    assert.equal(verdict.state, 'pipeline_incomplete');
    assert.deepEqual(verdict.missing, ['inventory', 'reviews', 'visibility']);
    // 已完成的阶段必须被认出来，不能重头再来。
    const done = stageCompletion(afterFullPipeline({
      standardized_published: false, inventory_status: 'unknown', total_available_qty: 0, active_review_count: 0,
    }));
    assert.equal(done.data, true);
    assert.equal(done.title, true);
    assert.equal(done.pricing, true);
    assert.equal(done.media, true);
  });

  it('2. 从没开始的商品不算续跑对象', () => {
    const verdict = deriveRecoveryState(afterFullPipeline({
      supplier_published: false, in_standardized: false, standardized_published: null,
      normalization_status: null, optimized_title: null, selling_price: null,
      primary_image_mirror_status: null, primary_image_blurhash: null,
      inventory_status: null, total_available_qty: null, active_review_count: 0,
    }));
    assert.equal(verdict.state, 'not_started');
    assert.equal(isResumable(verdict.state), false);
  });

  it('8 + 9. 只有真的进了 sellable 才算完成', () => {
    const complete = deriveRecoveryState(afterFullPipeline({ has_availability_evidence: true, in_sellable: true }));
    assert.equal(complete.state, 'complete');
    assert.equal(complete.nextAction, 'none');
    assert.equal(isResumable(complete.state), false);

    // standardized published=true 单独不算数 —— 这正是当前这三件的处境。
    const notVisible = deriveRecoveryState(afterFullPipeline({ standardized_published: true, in_sellable: false }));
    assert.notEqual(notVisible.state, 'complete');
  });

  it('有证据却仍不可售 → 交给人看，不自动重试', () => {
    const verdict = deriveRecoveryState(afterFullPipeline({ has_availability_evidence: true, in_sellable: false }));
    assert.equal(verdict.state, 'published_not_visible');
    assert.equal(verdict.nextAction, 'needs_review');
    // 这种情况不该混进「继续完成」的批次里，重跑解决不了。
    assert.equal(isResumable(verdict.state), false);
  });

  // ── 4 + 5. 续跑计划：回放 planner 的决定，不重新规划 ────────────────────────

  const realPlan = JSON.parse(
    fs.readFileSync('reports/giga-auto-publish/xone-onboarding-plan.json', 'utf8'),
  ) as Record<string, unknown>;

  it('4. 续跑计划精确覆盖这三件，且 schema 与执行器一致', () => {
    const plan = buildRecoveryPlan(realPlan, ['W5870P523986']);
    assert.ok(plan);
    const batch = plan!.proposed_batch as { skus: string[]; sku_count: number; families: unknown[] };
    // 整族带上 —— 库存阶段是整族门禁，拆开门禁就失去意义。
    assert.deepEqual([...batch.skus].sort(), ['W5870P523986', 'W5870P523987', 'W5870P523988']);
    assert.equal(batch.sku_count, 3);
    assert.equal(batch.families.length, 1);
    // 执行器的 guardrail 只认 SAFE 桶，候选必须原样带过来。
    const candidates = plan!.candidates as Array<{ id: string; bucket: string }>;
    assert.equal(candidates.length, 3);
    for (const c of candidates) assert.match(c.bucket, /^SAFE/);
  });

  it('5. 续跑计划是回放，不是重新规划 —— 家族分组原样保留', () => {
    const plan = buildRecoveryPlan(realPlan, ['W5870P523987']);
    const families = plan!.safe_variant_families as Array<{ key: string; skus: string[] }>;
    const original = realPlan.safe_variant_families as Array<{ key: string; skus: string[] }>;
    assert.deepEqual(families, original, '家族分组必须与 planner 当时的判断一致');
    // 记录它是从哪一份计划恢复来的，便于追溯。
    assert.equal(plan!.recovery_of, realPlan.generated);
  });

  it('没有可续跑的商品时不产出计划', () => {
    assert.equal(buildRecoveryPlan(realPlan, []), null);
    assert.equal(buildRecoveryPlan(null, ['W5870P523986']), null);
  });

  it('12. 续跑不发明任何新阶段，只复用既有八阶段的产物判定', () => {
    const source = fs.readFileSync('src/services/onboardingRecovery.ts', 'utf8');
    // 这个模块只做判断，不执行。
    for (const forbidden of ['spawnSync', 'createClient', 'fetch(', 'supabase', 'update(', 'upsert(']) {
      assert.equal(source.includes(forbidden), false, `续跑判定层不得出现 ${forbidden}`);
    }
  });

  console.log(`\n${passed} passed`);
}

main();
