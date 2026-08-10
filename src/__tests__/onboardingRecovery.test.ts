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
  isPickupOnly,
  isResumable,
  PICKUP_ONLY_MIN_FAILURES,
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
  has_delivery_fee: false,
  // 默认「已在 Dropship 收藏、运费没失败过」—— 既有用例的含义因此完全不变。
  saved_in_dropship: true,
  delivery_fee_failures: 0,
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
    const complete = deriveRecoveryState(afterFullPipeline({ has_availability_evidence: true, in_sellable: true, has_delivery_fee: true }));
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

  it('现场 3. App 可见但没有运费 → 上架未完成，不是完成', () => {
    // 这三件的真实处境：published、sellable 都有了，Checkout 却显示 Quote required。
    const live = afterFullPipeline({ has_availability_evidence: true, in_sellable: true, has_delivery_fee: false });
    const verdict = deriveRecoveryState(live);
    assert.equal(verdict.state, 'awaiting_delivery_fee');
    assert.deepEqual(verdict.missing, ['delivery']);
    assert.equal(verdict.nextAction, 'refresh_delivery_fee');
    // 必须留在续跑清单里，否则用户永远看不到它缺什么。
    assert.equal(isResumable(verdict.state), true);
    // 阶段清单里运费单独成一项。
    assert.equal(stageCompletion(live).delivery, false);
    assert.equal(stageCompletion(live).visibility, true);
  });

  it('现场 3. 运费到位之后才算真正完成', () => {
    const done = deriveRecoveryState(afterFullPipeline({
      has_availability_evidence: true, in_sellable: true, has_delivery_fee: true,
    }));
    assert.equal(done.state, 'complete');
    assert.equal(done.nextAction, 'none');
    assert.equal(isResumable(done.state), false);
  });

  // ── 4 + 5. 续跑计划：回放 planner 的决定，不重新规划 ────────────────────────

  // 计划用 fixture，不读 reports/ 下的实时产物 —— 那份文件每次预览都会被覆盖，
  // 测试跟着它走就成了「今天点过哪个按钮」的函数，而不是对 buildRecoveryPlan 的检验。
  const realPlan = JSON.parse(
    fs.readFileSync('src/__tests__/fixtures/xone-onboarding-plan-2026-08-08.json', 'utf8'),
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

  
// ── 供应商只开放自提的商品：终态，不进续跑 ──────────────────────────────────
//
// 真实案例 W1826P308991：已 published + sellable，portal 身份也解出来了（1096253），
// 但供应商拒绝把它加入 Dropship 收藏（业务码 0），于是 price/v1 永远报不出运费。
// 落库的事实是：sellable=true、charged_fee_cents=null、没有 dropship 收藏行、
// consecutive_failures=4。

const pickupOnlyFacts = (over: Partial<OnboardingProgressFacts> = {}) => afterFullPipeline({
  supplier_product_id: 'W1826P308991',
  has_availability_evidence: true,
  in_sellable: true,
  has_delivery_fee: false,
  saved_in_dropship: false,
  delivery_fee_failures: 4,
  ...over,
});

it('只支持自提 → 终态 pickup_only，不再重试，也不下架', () => {
  const facts = pickupOnlyFacts();
  assert.equal(isPickupOnly(facts), true);

  const verdict = deriveRecoveryState(facts);
  assert.equal(verdict.state, 'pickup_only');
  // 不再有下一步动作：既不补收藏，也不再取运费。
  assert.equal(verdict.nextAction, 'none');
  // 运费不是「缺口」，是供应商不提供 —— 不能列进 missing。
  assert.deepEqual(verdict.missing, []);
  // 终态不属于「上架未完成」。
  assert.equal(isResumable(verdict.state), false);
  // 商品仍然可售，判定没有碰发布位。
  assert.equal(facts.in_sellable, true);
  assert.equal(facts.supplier_published, true);
});

it('失败次数不够时仍然是「等运费」，不提前下结论', () => {
  const flaky = pickupOnlyFacts({ delivery_fee_failures: PICKUP_ONLY_MIN_FAILURES - 1 });
  assert.equal(isPickupOnly(flaky), false);
  assert.equal(deriveRecoveryState(flaky).state, 'awaiting_delivery_fee');
  assert.equal(deriveRecoveryState(flaky).nextAction, 'refresh_delivery_fee');
});

it('已经在 Dropship 收藏里的商品永远不算「只支持自提」', () => {
  // 收藏进去了却还没运费 —— 那是还没取到，不是渠道不支持，必须继续重试。
  const saved = pickupOnlyFacts({ saved_in_dropship: true, delivery_fee_failures: 9 });
  assert.equal(isPickupOnly(saved), false);
  assert.equal(deriveRecoveryState(saved).state, 'awaiting_delivery_fee');
});

it('有运费的商品是 complete，与自提终态互斥', () => {
  const withFee = pickupOnlyFacts({ has_delivery_fee: true });
  assert.equal(isPickupOnly(withFee), false);
  assert.equal(deriveRecoveryState(withFee).state, 'complete');
});

it('还没可售的商品不会被判成自提终态 —— 先解决可见性', () => {
  const notSellable = pickupOnlyFacts({ in_sellable: false, has_availability_evidence: false });
  assert.equal(isPickupOnly(notSellable), false);
  assert.equal(deriveRecoveryState(notSellable).state, 'awaiting_evidence');
});

it('续跑清单与结果映射都认得这个终态', () => {
  const bridge = fs.readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8');
  // 清单里过滤掉终态，并单独报出来，界面才能显示「已上线 · 仅支持自提」。
  assert.ok(/row\.state !== 'pickup_only'/.test(bridge), '续跑清单必须排除 pickup_only');
  assert.ok(/pickup_only_count/.test(bridge) && /pickup_only_skus/.test(bridge), '终态必须单独报出');
  // 结果映射：已上线，不是失败。
  assert.ok(
    /verdict\.state === 'pickup_only'[\s\S]{0,200}?verified_visible[\s\S]{0,80}?PICKUP_ONLY_LABEL/.test(bridge),
    'pickup_only 必须映射成 verified_visible + 自提文案',
  );
  // 事实必须真的从库里读出来，不能凭空造。
  assert.ok(/consecutive_failures/.test(bridge), '必须读运费连续失败次数');
  assert.ok(/supplier_favorite_memberships[\s\S]{0,200}?'dropship'/.test(bridge), '必须读 Dropship 收藏');
});

console.log(`\n${passed} passed`);
}

main();