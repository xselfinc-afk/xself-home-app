/**
 * XOne 「需要处理」决策组 + 人工跳过的退出机制（桥接协议 1.0 增量）。
 *
 * 背景：面板此前按 SKU 出卡，W1803 一组四件撞色被渲染成四张卡各列四个成员；
 * 「跳过」只把 planner 桶改成 SKIPPED_MANUAL，行仍是 candidate + ready=false，
 * 于是永远赖在「需要处理」。这里锁定三件事：
 *   1. SKIPPED_MANUAL → lifecycle='skipped'，不再算 blocked；
 *   2. decision_groups 按真实决策单位分组：撞色组一组、需合并各一组、其余 hold 各一组；
 *   3. manual-override 接受 unskip（撤销跳过）。
 * 全部纯计算，不碰任何文件与数据库。
 */
import assert from 'node:assert/strict';
import { buildPreviewRows, buildDecisionGroups, parseOnboardingRequest } from '../../scripts/xoneProductOnboardingBridge';

const normalize = (row: Record<string, any>) => ({
  product_title_display: `Title ${row.supplier_product_id}`,
  sku_custom: `XH-${row.supplier_product_id}`,
  category_label: 'Sofa',
  primary_image: `https://x/${row.supplier_product_id}.jpg`,
  gallery_images_json: [],
  specifications_json: { Color: row.color ?? 'Black', Material: 'Wood' },
  price: 259,
  original_price: null,
});
const reviewCount = () => ({ count: 5, avg: 4.6 });

function rowsFor(plan: Record<string, any>, ids: string[], colors: Record<string, string> = {}) {
  return buildPreviewRows({
    plan,
    supplierRows: ids.map((id) => ({ supplier_product_id: id, color: colors[id] })),
    normalize,
    reviewCount,
  });
}

// 真实数据形状（2026-09-05 预览）：W1803 四件互相撞色；W5568 两件撞色且各命中四个在售兄弟；
// W5271 单件命中在售兄弟；W1364 品类外；W1757 成本过低；W9999 已被人工跳过。
const PLAN = {
  proposed_batch: { skus: ['W2263P353529'] },
  candidates: [
    { id: 'W2263P353529', bucket: 'SAFE_SINGLETON', reasons: [] },
    ...['W1803S00109', 'W1803S00108', 'W1803S00106', 'W1803S00105'].map((id) => ({
      id, bucket: 'HOLD_PHASE2', reasons: ['duplicate_color'],
      dupGroupIds: ['W1803S00109', 'W1803S00108', 'W1803S00106', 'W1803S00105'], uncertainSiblingIds: ['L1', 'L2'],
    })),
    ...['W5568S00037', 'W5568S00040'].map((id) => ({
      id, bucket: 'HOLD_PHASE2', reasons: ['duplicate_color'],
      dupGroupIds: ['W5568S00037', 'W5568S00040'], liveSiblingIds: ['W5568S00044', 'W5568S00036'],
    })),
    { id: 'W5271S00007', bucket: 'HOLD_PHASE2', reasons: ['fragmented_cluster'], liveSiblingIds: ['W5271S00008'] },
    { id: 'W1364P268345', bucket: 'REJECT', reasons: ['junk_category'] },
    { id: 'W1757P336139', bucket: 'HOLD_QUALITY', reasons: ['low_price'] },
    { id: 'W9999S00001', bucket: 'SKIPPED_MANUAL', reasons: ['manual_skip'], overrideApplied: 'skip' },
  ],
};
const IDS = PLAN.candidates.map((c) => c.id);

function it(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

console.log('onboardingDecisionGroups');

it('SKIPPED_MANUAL → lifecycle=skipped，不再是 candidate，措辞说明已由人工跳过', () => {
  const rows = rowsFor(PLAN, IDS);
  const skipped = rows.find((r) => r.supplier_product_id === 'W9999S00001')!;
  assert.equal(skipped.lifecycle, 'skipped');
  assert.equal(skipped.ready, false);
  assert.match(String(skipped.blocked_reason), /人工跳过/);
  // 其余被拦的仍是 candidate。
  assert.equal(rows.find((r) => r.supplier_product_id === 'W1364P268345')!.lifecycle, 'candidate');
});

it('决策组：撞色成组（一组一次决定），需合并各一组，其余 hold 各一组；skipped/ready 不入组', () => {
  const rows = rowsFor(PLAN, IDS, { W1803S00109: 'Beige', W1803S00108: 'Beige' });
  const groups = buildDecisionGroups(rows);
  const kinds = groups.map((g) => g.kind);
  assert.deepEqual(kinds, ['duplicate_color', 'duplicate_color', 'merge_live', 'hold', 'hold']);

  const w1803 = groups.find((g) => g.id.includes('W1803S00105'))!;
  assert.equal(w1803.kind, 'duplicate_color');
  assert.deepEqual([...w1803.sku_ids].sort(), ['W1803S00105', 'W1803S00106', 'W1803S00108', 'W1803S00109']);
  assert.equal(w1803.members.length, 4);
  assert.deepEqual(w1803.actions, ['dup_keep', 'skip']);
  assert.equal(w1803.members.find((m) => m.supplier_product_id === 'W1803S00109')!.color, 'Beige');
  assert.deepEqual(w1803.members[0].uncertain_sibling_ids, ['L1', 'L2']);

  // 同时撞色又命中在售兄弟：只进撞色组，不再另开合并组（一个成员只进一组）。
  const w5568 = groups.find((g) => g.id.includes('W5568S00037'))!;
  assert.equal(w5568.kind, 'duplicate_color');
  assert.equal(groups.filter((g) => g.sku_ids.includes('W5568S00037')).length, 1);

  const merge = groups.find((g) => g.kind === 'merge_live')!;
  assert.deepEqual(merge.sku_ids, ['W5271S00007']);
  assert.deepEqual(merge.actions, ['merge', 'standalone', 'skip']);

  const holdIds = groups.filter((g) => g.kind === 'hold').flatMap((g) => g.sku_ids).sort();
  assert.deepEqual(holdIds, ['W1364P268345', 'W1757P336139']);
  assert.ok(groups.every((g) => g.actions.includes('skip')), '每个组都有「不再提醒」出口');

  const allGrouped = groups.flatMap((g) => g.sku_ids);
  assert.equal(allGrouped.includes('W9999S00001'), false, '跳过的不入组');
  assert.equal(allGrouped.includes('W2263P353529'), false, '可上架的不入组');
  assert.equal(new Set(allGrouped).size, allGrouped.length, '一个 SKU 只出现在一个组');
});

it('决策组是纯函数：同样的输入两次得到逐字节相同的结果', () => {
  const rows = rowsFor(PLAN, IDS);
  assert.equal(JSON.stringify(buildDecisionGroups(rows)), JSON.stringify(buildDecisionGroups(rows)));
});

it('manual-override 接受 unskip；其它字符串一律丢弃', () => {
  const base = { schema_version: '1.0', operation: 'manual-override', sku: 'W9999S00001', approved_by: '何流' };
  assert.equal(parseOnboardingRequest(JSON.stringify({ ...base, action: 'unskip' })).action, 'unskip');
  assert.equal(parseOnboardingRequest(JSON.stringify({ ...base, action: 'skip' })).action, 'skip');
  assert.equal(parseOnboardingRequest(JSON.stringify({ ...base, action: 'delete' })).action, undefined);
});

console.log('onboardingDecisionGroups: all passed');
