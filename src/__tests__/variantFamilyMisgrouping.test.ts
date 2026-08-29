/**
 * 变体分族误判修复的定点测试。纯离线 —— import planGigaAutoPublish 不会执行 main()。
 * Run: npx tsx src/__tests__/variantFamilyMisgrouping.test.ts
 *
 * 三个被修的缺陷，全部有 2026-08-29 的真实候选做依据：
 *   ① 尺寸解析失败时 dim 是字符串 'NaNxNaNxNaN'，它 truthy，于是「三件都解析失败」
 *      被当成「三件尺寸相同」。13 件不同形态的沙发因此并成一族。
 *   ② duplicate_color 整族连坐：7 件里 2 件撞色，另外 5 个唯一颜色被一起扣下。
 *   ③ 尺寸精确相等比较：同款黑白两色量出 14.65 与 14.76 英寸就判 config_mismatch。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDim, dimsCompatible, costSubgroups, duplicateColorIds,
  deriveFallbackSpec, fallbackSpecGroups, fragmentedVerdict,
} from '../../scripts/planGigaAutoPublish';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('parseDim —— 解析失败必须归为未知');
it('NaNxNaNxNaN 是未知，不是一个有效尺寸', () => {
  assert.equal(parseDim('NaNxNaNxNaN'), null);
});
it('正常三维解析成数字', () => {
  assert.deepEqual(parseDim('71.00x50.00x34.00'), [71, 50, 34]);
});
it('空串、缺维、零值都算未知', () => {
  for (const bad of ['', '71x50', '71x50x0', '71x50x34x12']) assert.equal(parseDim(bad), null, bad);
});

console.log('dimsCompatible —— 容差要够吸收量测噪声，又要挡住真实规格差');
it('0.11 英寸的量测差算同规格（原来判 config_mismatch 的那两件文件柜）', () => {
  assert.equal(dimsCompatible(['14.65x17.71x52.36', '14.76x17.71x52.36']), true);
});
it('3.64 英寸的真实差仍算不同规格（32" 与 24" 两个酒柜）', () => {
  assert.equal(dimsCompatible(['17.80x19.59x35.43', '17.80x15.95x35.43']), false);
});
it('全部解析失败不再等于「尺寸一致」—— 它们只是未知', () => {
  // 修复前：三个相同字符串 → Set.size === 1 → sameConfig 成立。
  // 修复后：三个都解析不出来 → 不参与比较 → 不产生「规格相同」这个正面证据。
  assert.deepEqual(['NaNxNaNxNaN', 'NaNxNaNxNaN', 'NaNxNaNxNaN'].map(parseDim), [null, null, null]);
});
it('未知与已知混在一起时，未知不算冲突', () => {
  assert.equal(dimsCompatible(['71.00x50.00x34.00', '', '71.00x50.00x34.00']), true);
});

console.log('costSubgroups —— 退化族键下按成本还原真实商品');
it('13 件 Chenille Cloud 沙发按成本还原成 9 个真实商品', () => {
  const costs = [212.5, 278.8, 297.5, 345.1, 363.8, 382.5, 430.1, 448.8, 515.1, 212.5, 278.8, 297.5, 345.1];
  const groups = costSubgroups(costs.map((normCost, i) => ({ id: `S${i}`, normCost })));
  assert.equal(groups.length, 9);
  assert.deepEqual(groups.map(g => g.length).sort(), [1, 1, 1, 1, 1, 2, 2, 2, 2]);
});
it('同款换色成本一致，绝不被拆散（7 件全部 $259）', () => {
  const groups = costSubgroups(Array.from({ length: 7 }, (_, i) => ({ id: `S${i}`, normCost: 259 })));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 7);
});
it('取整噪声在容差内不拆族', () => {
  assert.equal(costSubgroups([{ id: 'a', normCost: 259 }, { id: 'b', normCost: 259.5 }]).length, 1);
});
it('分组结果与输入顺序无关', () => {
  const a = costSubgroups([{ id: 'x', normCost: 100 }, { id: 'y', normCost: 400 }]);
  const b = costSubgroups([{ id: 'y', normCost: 400 }, { id: 'x', normCost: 100 }]);
  assert.deepEqual(a.map(g => g.map(m => m.id)), b.map(g => g.map(m => m.id)));
});
it('一件不丢、不重复', () => {
  const members = Array.from({ length: 20 }, (_, i) => ({ id: `S${i}`, normCost: i * 37 }));
  const flat = costSubgroups(members).flat();
  assert.equal(flat.length, 20);
  assert.equal(new Set(flat.map(m => m.id)).size, 20);
});

console.log('duplicateColorIds —— 只拦真正撞色的那几件');
it('7 件里 2 件 Black 撞色，只返回这 2 件', () => {
  const members = [
    { id: 'W5568S00037', color: 'Black' }, { id: 'W5568S00040', color: 'Black' },
    { id: 'W5568S00036', color: 'Olive Green' }, { id: 'W5568S00041', color: 'Dark Green' },
    { id: 'W5568S00042', color: 'Coffee' }, { id: 'W5568S00043', color: 'Camel' },
    { id: 'W5568S00044', color: 'Light Brown' },
  ];
  assert.deepEqual([...duplicateColorIds(members)].sort(), ['W5568S00037', 'W5568S00040']);
});
it('颜色全唯一时一件都不拦', () => {
  assert.equal(duplicateColorIds([{ id: 'a', color: 'Orange' }, { id: 'b', color: 'Cream Beige' }]).size, 0);
});
it('大小写与空格不同不算两种颜色', () => {
  assert.equal(duplicateColorIds([{ id: 'a', color: 'Black' }, { id: 'b', color: ' black ' }]).size, 2);
});
it('颜色为空不算「重复」—— 它是缺数据，走 missing_color', () => {
  const out = duplicateColorIds([{ id: 'a', color: '' }, { id: 'b', color: '' }, { id: 'c', color: 'Black' }]);
  assert.equal(out.size, 0);
});

console.log('deriveFallbackSpec —— 成品尺寸缺失时的备用规格轴');
// 真实 payload：assembledLength/Width/Height 全是字符串 "Not Applicable"，
// 裸 length/width/height 全为 null；但 attributes.Seats 与 comboInfo 齐全。
const chenille = (seats: string, pieces: number) => ({
  assembledLength: 'Not Applicable', assembledWidth: 'Not Applicable', assembledHeight: 'Not Applicable',
  length: null, width: null, height: null,
  attributes: { Seats: seats, 'Main Color': 'Cream Beige', 'Main Material': 'Chenille' },
  comboInfo: Array.from({ length: pieces }, () => ({ qty: 1, length: 31.1, width: 29.5, height: 10.4 })),
});
it('Seats + 件数 组成规格轴', () => {
  assert.equal(deriveFallbackSpec(chenille('2 Seat', 2)), '2 seat|p2');
  assert.equal(deriveFallbackSpec(chenille('4 Seat', 6)), '4 seat|p6');
});
it('件数按 qty 求和，不是数组长度', () => {
  const raw = { attributes: { Seats: '3 Seat' }, comboInfo: [{ qty: 2 }, { qty: 3 }] };
  assert.equal(deriveFallbackSpec(raw), '3 seat|p5');
});
it('缺 Seats、缺 comboInfo、qty 不合法 —— 一律返回 null，绝不猜', () => {
  assert.equal(deriveFallbackSpec({ comboInfo: [{ qty: 1 }] }), null);
  assert.equal(deriveFallbackSpec({ attributes: { Seats: '2 Seat' } }), null);
  assert.equal(deriveFallbackSpec({ attributes: { Seats: '2 Seat' }, comboInfo: [] }), null);
  assert.equal(deriveFallbackSpec({ attributes: { Seats: '2 Seat' }, comboInfo: [{ qty: 0 }] }), null);
  assert.equal(deriveFallbackSpec(null), null);
});
it('绝不把包装箱长宽高当成品尺寸 —— 轴里只有座位数与件数', () => {
  const spec = deriveFallbackSpec(chenille('2 Seat', 2))!;
  for (const n of ['31.1', '29.5', '10.4']) assert.ok(!spec.includes(n), `箱规 ${n} 不得进入规格轴`);
});

console.log('fallbackSpecGroups —— 分不清就不分');
it('18 件 Chenille 还原成 9 个真实商品', () => {
  const combos: Array<[string, number]> = [
    ['2 Seat', 2], ['2 Seat', 3], ['2 Seat', 4], ['3 Seat', 3], ['3 Seat', 4],
    ['3 Seat', 5], ['4 Seat', 4], ['4 Seat', 5], ['4 Seat', 6],
  ];
  const members = combos.flatMap(([s, p], i) => ['Cream Beige', 'Orange'].map(color => ({
    id: `S${i}-${color}`, color, fallbackSpec: deriveFallbackSpec(chenille(s, p)),
  })));
  const groups = fallbackSpecGroups(members)!;
  assert.equal(groups.length, 9);
  assert.ok(groups.every(g => g.length === 2));
  assert.ok(groups.every(g => new Set(g.map(m => m.color)).size === 2), '每组两个颜色必须唯一');
});
it('任何一个成员取不到轴，整族都不用它 —— 半份证据不足以分族', () => {
  assert.equal(fallbackSpecGroups([{ fallbackSpec: '2 seat|p2' }, { fallbackSpec: null }]), null);
});
it('分组结果与输入顺序无关', () => {
  const a = [{ fallbackSpec: 'x' }, { fallbackSpec: 'y' }];
  assert.deepEqual(fallbackSpecGroups(a)!.map(g => g.length), fallbackSpecGroups([...a].reverse())!.map(g => g.length));
});

console.log('fragmentedVerdict —— 安全门禁一条都没松');
it('在售兄弟的合并保护优先于任何 fallback', () => {
  assert.deepEqual(
    fragmentedVerdict({ hasLiveSibling: true, widthMissing: true, cfgMissing: true, noConfigAxis: false, specResolved: true }),
    { bucket: 'HOLD_PHASE2', reason: 'fragmented_cluster' });
});
it('备用轴读不出来时，wmissing 照旧扣留', () => {
  assert.deepEqual(
    fragmentedVerdict({ hasLiveSibling: false, widthMissing: true, cfgMissing: true, noConfigAxis: false, specResolved: false }),
    { bucket: 'HOLD_PHASE2', reason: 'wmissing_fragmented' });
});
it('不传 specResolved 就是改动前的行为', () => {
  assert.deepEqual(
    fragmentedVerdict({ hasLiveSibling: false, widthMissing: true, cfgMissing: true, noConfigAxis: false }),
    { bucket: 'HOLD_PHASE2', reason: 'wmissing_fragmented' });
});
it('备用轴确定规格后，孤件可独立上架', () => {
  assert.deepEqual(
    fragmentedVerdict({ hasLiveSibling: false, widthMissing: true, cfgMissing: true, noConfigAxis: false, specResolved: true }),
    { bucket: 'SAFE_SINGLETON', reason: 'spec_from_attributes_standalone' });
});

console.log('源码守卫 —— 修复不能被悄悄改回去');
const src = readFileSync('scripts/planGigaAutoPublish.ts', 'utf8');
it('不再有整族连坐的那一行', () => {
  assert.ok(!/members\.forEach\(m => \{ m\.bucket = 'HOLD_PHASE2'; m\.reasons\.push\(dupColor/.test(src),
    'duplicate_color 又变回整族一刀切了');
});
it('尺寸不再用精确相等比较', () => {
  assert.ok(!src.includes('dims.size <= 1'), '尺寸比较又退回到精确相等，0.11 英寸会再次误判');
  assert.ok(src.includes('dimsCompatible('), '尺寸比较必须走带容差的 dimsCompatible');
});
it('备用轴分不清的族仍然扣留，且原因如实记为尺寸缺失', () => {
  assert.ok(/if \(widthMissingUnresolved && duplicateColorIds\(group\)\.size > 0\)/.test(src),
    '备用轴分不清时必须维持人工确认');
  assert.ok(/widthMissingUnresolved[\s\S]{0,400}reasons\.push\('wmissing_fragmented'\)/.test(src),
    '分不清的原因必须记为尺寸缺失，不得冒充 duplicate_color');
});
it('备用轴读不出来时走原路，不猜', () => {
  assert.ok(src.includes('if (!fallbackGroups) {'), '备用轴不可用时必须回到原有扣留路径');
});
it('包装箱尺寸没有被当成成品尺寸 —— deriveWidth 仍只读 assembled/裸尺寸', () => {
  const fk = readFileSync('src/services/familyKeyGenerator.ts', 'utf8');
  const body = fk.slice(fk.indexOf('export function deriveWidth'));
  const fn = body.slice(0, body.indexOf('\n}') + 2);
  assert.ok(fn.includes('assembledLength'), 'deriveWidth 必须仍以成品尺寸为准');
  assert.ok(!fn.includes('comboInfo'), 'comboInfo 的箱规不得进入宽度推导');
});
it('子分组的族键唯一，避免 apply runner 把两族算成一张卡', () => {
  assert.ok(src.includes('groups.length > 1 ? `${key}#${group[0].id}` : key'));
});

console.log(`\n${passed} passed`);
