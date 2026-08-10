/**
 * Focused tests: auto-publish planner base classification aligned with Commerce Taxonomy.
 * Pure/offline — importing planGigaAutoPublish does NOT run main() (direct-invocation guard).
 * Run: npx tsx src/__tests__/autoPublishPlanner.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baseBucketOf, fragmentedVerdict } from '../../scripts/planGigaAutoPublish';
import { classifyCommerce, NEEDS_REVIEW } from '../utils/commerceTaxonomy';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const canon = (name: string, category = '') => classifyCommerce({ name, category, categoryLabel: '' }).productType !== NEEDS_REVIEW;
// Realistic wrapper: commerceCanonical derived from the production classifier.
const bucket = (name: string, o: { img?: boolean; cost?: number; category?: string; normTitle?: string } = {}) =>
  baseBucketOf({ img: o.img ?? true, normCost: o.cost ?? 199, title: name, normTitle: o.normTitle ?? name, commerceCanonical: canon(name, o.category) }).bucket;

console.log('auto-publish planner taxonomy-alignment tests');

it('1. Outdoor Décor canonical (water fountain) is NOT rejected by HARD_JUNK', () => {
  assert.equal(bucket('Bear Outdoor Water Fountain with LED Lights, Garden Patio'), 'CLEAN');
});
it('2. Fitness & Sports canonical (step machine) is NOT rejected', () => {
  assert.equal(bucket('Stair Stepper Vertical Climber Workout Machine'), 'CLEAN');
});
it('3. Kids outdoor bike is NOT rejected merely for "kids"', () => {
  assert.equal(bucket('16 inch kids bike with training wheels, outdoor'), 'CLEAN');
});
it('4. Garden/outdoor words do NOT override canonical taxonomy (statue)', () => {
  const b = bucket('Large Garden Statue, Outdoor Sculpture, Solar');
  assert.notEqual(b, 'REJECT');
  assert.equal(b, 'CLEAN');
});
it('5. needs-review classification is HELD (not published), not rejected when no junk word', () => {
  assert.equal(canon('Mysterious Gadget XYZ'), false);
  assert.equal(bucket('Mysterious Gadget XYZ Contraption'), 'HOLD_QUALITY');
});
it('6. existing furniture behavior unchanged (canonical dresser → CLEAN)', () => {
  assert.equal(bucket('5-Drawer Chest of Drawers Dresser'), 'CLEAN');
  assert.equal(bucket('Linen Sofa Couch 3-Seat'), 'CLEAN');
});
it('7. missing price remains REJECT', () => {
  assert.equal(baseBucketOf({ img: true, normCost: 0, title: 'Garden Fountain', normTitle: 'Garden Fountain', commerceCanonical: true }).reason, 'no_price');
});
it('8. missing image remains REJECT', () => {
  assert.equal(baseBucketOf({ img: false, normCost: 199, title: 'Garden Fountain', normTitle: 'Garden Fountain', commerceCanonical: true }).reason, 'no_image');
});
it('9. safety exclusions enforced: pet treadmill & golf organizer never publish (held/rejected, not CLEAN)', () => {
  assert.equal(canon('Small Dog Treadmill Pet Exercise Machine'), false);          // excludeWord → needs-review
  assert.notEqual(bucket('Small Dog Treadmill Pet Exercise Machine'), 'CLEAN');     // held or rejected (junk 'dog')
  assert.equal(canon('Golf Bag Organizer Storage Rack for Garage'), false);         // excludeWord → needs-review
  assert.notEqual(bucket('Golf Bag Organizer Storage Rack for Garage'), 'CLEAN');
});
it('10. runGigaAutoPublish consumes the plan without a separate eligibility rule', () => {
  const src = readFileSync('scripts/runGigaAutoPublish.ts', 'utf8');
  assert.ok(src.includes('proposed_batch'), 'runner consumes plan.proposed_batch');
  assert.ok(!/HARD_JUNK/.test(src), 'runner has no separate HARD_JUNK eligibility rule');
  assert.ok(!/classifyCommerce/.test(src), 'runner does not re-classify (planner is authority)');
});

// ── 碎片家族的放行规则（2026-08-09 业务规则变更）────────────────────────────────
//
// Pickup 收藏 = 明确决定销售这个 SKU。未收藏的同系列兄弟不代表要卖，因此不得成为上架前提。
// 此前 cfgMissing 会让唯一在场成员被扣留（cfgmissing_fragmented），等于逼运营把整个供应商
// family 收藏进来才能卖一件。现在只剩两条真正的扣留理由：兄弟已在售、以及本商品宽度未知。

const frag = (o: Partial<Parameters<typeof fragmentedVerdict>[0]> = {}) =>
  fragmentedVerdict({ hasLiveSibling: false, widthMissing: false, cfgMissing: false, noConfigAxis: false, ...o });

it('未收藏的兄弟不再阻止上架：cfgMissing 也放行为独立商品', () => {
  const v = frag({ cfgMissing: true });
  assert.equal(v.bucket, 'SAFE_SINGLETON');
  assert.equal(v.reason, 'unresolved_axis_standalone');
});

it('区分「本来就没有配置轴」与「应有轴但没解析出来」', () => {
  // 沙发/椅子这类品类天生没有门抽轴 —— 哨兵整族一致，键是稳定的。
  assert.equal(frag({ cfgMissing: true, noConfigAxis: true }).reason, 'no_config_axis_standalone');
  // 柜类本该有轴，只是没解析出来 —— 同样放行，但原因码不同，便于日后按它定位受影响商品。
  assert.equal(frag({ cfgMissing: true, noConfigAxis: false }).reason, 'unresolved_axis_standalone');
});

it('兄弟已在售 → 仍然扣留，必须走合并路径', () => {
  const v = frag({ hasLiveSibling: true, cfgMissing: true });
  assert.equal(v.bucket, 'HOLD_PHASE2');
  assert.equal(v.reason, 'fragmented_cluster');
  // 在售兄弟优先于其它一切判定。
  assert.equal(frag({ hasLiveSibling: true, widthMissing: true }).reason, 'fragmented_cluster');
});

it('宽度未知 → 仍然扣留（这是本商品自身的数据缺失，与兄弟无关）', () => {
  const v = frag({ widthMissing: true, cfgMissing: true });
  assert.equal(v.bucket, 'HOLD_PHASE2');
  assert.equal(v.reason, 'wmissing_fragmented');
});

it('配置与宽度都齐全 → 独立上架', () => {
  assert.equal(frag().bucket, 'SAFE_SINGLETON');
  assert.equal(frag().reason, 'no_live_sibling_standalone');
});

it('cfgmissing_fragmented 这个扣留码已经不再产生', () => {
  const src = readFileSync('scripts/planGigaAutoPublish.ts', 'utf8');
  const emitted = [...src.matchAll(/reasons\.push\(([^)]*)\)/g)].map(m => m[1]).join(' ')
    + [...src.matchAll(/reason: '([a-z_]+)'/g)].map(m => m[1]).join(' ');
  assert.equal(/cfgmissing_fragmented/.test(emitted), false, '不得再产出 cfgmissing_fragmented');
});


// ── 家族内成本可以不同（2026-08-09 批准的业务语义变更）──────────────────────
//
// 同一 Family 的不同 SKU 允许各自不同的 supplier cost / selling price / inventory /
// Delivery Fee。成本相等从来不是安全属性，只是对「from $X」单卡展示的担心；
// 每个 SKU 仍由 Stage 4 按自己的成本单独定价。

it('per-color 成本不一致不再扣留：HOLD_PRICE 不再被赋给任何商品', () => {
  const src = readFileSync('scripts/planGigaAutoPublish.ts', 'utf8');
  assert.equal(/bucket = 'HOLD_PRICE'/.test(src), false, '不得再把商品判进 HOLD_PRICE');
  assert.equal(/per_color_cost_mismatch/.test(src), false, '不得再产出 per_color_cost_mismatch');
  // 差异本身仍然记在原因码里，报告上看得见。
  assert.ok(/per_color_cost_differs/.test(src), '成本差异必须仍然可见');
});

it('其余家族安全门一条都没松：重复颜色 / 配置 / 尺寸仍然扣留', () => {
  const src = readFileSync('scripts/planGigaAutoPublish.ts', 'utf8');
  assert.ok(/dupColor \? 'duplicate_color' : 'config_mismatch'/.test(src), '重复颜色与配置不符必须仍然扣留');
  // sameConfig 同时管类目、尺寸、抽屉、门数 —— 尺寸不一致照样进 HOLD_PHASE2。
  assert.ok(/const sameConfig = cats\.size === 1 && dims\.size <= 1 && draw\.size <= 1 && door\.size <= 1/.test(src));
});

it('每个 SKU 自己的成本仍然是硬门槛：缺失或 <= 0 直接 REJECT', () => {
  const withCost = (normCost: number) => baseBucketOf({
    img: true, normCost, title: '5-Drawer Chest of Drawers Dresser',
    normTitle: '5-Drawer Chest of Drawers Dresser', commerceCanonical: true,
  });
  assert.deepEqual(withCost(0), { bucket: 'REJECT', reason: 'no_price' });
  assert.deepEqual(withCost(-1), { bucket: 'REJECT', reason: 'no_price' });
  assert.deepEqual(withCost(Number.NaN), { bucket: 'REJECT', reason: 'no_price' });
  // 于是家族永远不可能由一个没有有效成本的 SKU 组成 —— 它在分组之前就被踢掉了。
});

it('家族的 cost 字段只进报告，执行器不读它，定价仍然逐 SKU', () => {
  const runner = readFileSync('scripts/runGigaAutoPublish.ts', 'utf8');
  const line = runner.split('\n').find((l) => l.includes('safe_variant_families')) ?? '';
  assert.ok(/\{ key: string; skus: string\[\] \}/.test(line), '执行器只认 key + skus');
  assert.equal(/cost/.test(line), false, '执行器不得读家族层面的 cost');
});


// ── 执行器：dry-run 必须与 apply 同语义；scope 必须锁死 ──────────────────────

it('dry-run 不再有家族成本门禁 —— 它曾是 apply 从来没有的一条陈旧规则', () => {
  const runner = readFileSync('scripts/runGigaAutoPublish.ts', 'utf8');
  // 只查真正会产出的字符串字面量：注释里保留这段历史是刻意的，不能被断言误伤。
  assert.equal(/'within_family_cost_mismatch'/.test(runner), false, '不得再产出这个扣留码');
  assert.equal(/costWithinTol/.test(runner), false, '不得再保留这条门禁的实现');
  assert.equal(/COST_TOL_ABS|COST_TOL_PCT/.test(runner), false, '不得再保留它的容差常量');
});

it('执行器的其余门禁一条没动', () => {
  const runner = readFileSync('scripts/runGigaAutoPublish.ts', 'utf8');
  // dry-run 的逐 SKU 门禁。
  for (const gate of ['missing_supplier_row', 'normalize_error', 'normalize_incomplete', 'title_not_ready', 'below_cost', 'no_image_source']) {
    assert.ok(runner.includes(gate), `${gate} 必须仍在`);
  }
  // apply 的硬门禁：非 SAFE 桶拒绝、逐阶段数量校验、below_cost 中止。
  assert.ok(/non_safe_skus/.test(runner), 'apply 必须仍拒绝非 SAFE 桶');
  assert.ok(/fail\('pricing', `below_cost/.test(runner), 'apply 必须仍在 below_cost 时中止');
  assert.ok(/results\.published !== planned\.length/.test(runner), '逐阶段数量校验必须仍在');
});

it('scope 锁：调用方说了 N 件，计划就必须恰好是这 N 件，否则停机', () => {
  const runner = readFileSync('scripts/runGigaAutoPublish.ts', 'utf8');
  assert.ok(/--only=/.test(runner), 'runner 必须支持 --only');
  assert.ok(/SCOPE_MISMATCH/.test(runner), '不匹配时必须明确报错');
  // 必须是「断言后停机」，不是「过滤后继续」—— 过滤会把陈旧计划悄悄用下去。
  const lock = runner.slice(runner.indexOf('if (EXPECT_SKUS)'), runner.indexOf('const famInBatch'));
  assert.ok(/process\.exit\(1\)/.test(lock), 'scope 不符必须退出，不能降级继续');
  assert.equal(/planned = planned\.filter/.test(lock), false, '不得把计划过滤成子集');
  // 校验发生在 loadPlan 里，因此 dry-run 与 apply 共用，且早于任何写入。
  assert.ok(runner.indexOf('if (EXPECT_SKUS)') < runner.indexOf('async function runDryRun'), '必须在两条路径之前');
});

it('XOne 两条执行路径都把自己的名单交给执行器校验', () => {
  const bridge = readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8');
  assert.ok(/`--only=\$\{readySkus\.join\(','\)\}`/.test(bridge), '批量上架必须带 --only');
  assert.ok(/`--only=\$\{resumeScope\.join\(','\)\}`/.test(bridge), '续跑必须带 --only');
});

console.log(`\n${passed} passed`);