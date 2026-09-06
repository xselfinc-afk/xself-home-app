/**
 * 颜色变体分辨率 —— 2026-09-06 W1803 撞色误判的修复契约。
 *
 * 事故：同一把电动升降椅的四个颜色变体（深灰 / 浅灰 / 灰蓝 / 藏青），供应商 mainColor 只给
 * 「Grey / Blue」两个色系，planner 按色名判撞色，把四件真实变体扣成两组「重复颜色」。
 * 修复分三处，这里逐条锁定：
 *   1. normalizeProduct 的 color 优先取标题末尾的颜色短语（"Light Grey"），取不到才退回 mainColor；
 *      同一份色名同时进 specifications.Color 与 color_options_json。
 *   2. 同色名但 MPN 色码不同（-10BLU / -11BLU）不再是 duplicate_color，而是 color_name_ambiguous。
 *   3. 没有 MPN、MPN 前缀不一致、或 MPN 相同 → 仍按撞色处理（不猜）。
 * 纯计算，不碰数据库。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeProduct, resolveVariantColor } from '../services/normalizationPipeline';
import { colorNameAmbiguousIds, duplicateColorIds, splitMpnColorCode } from '../../scripts/planGigaAutoPublish';

let passed = 0;
function it(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

const TITLE = 'Up to 350 LBS Chenille Power Lift Recliner Chair, Heavy Duty Motion Mechanism with 8-Point Vibration Massage and Lumbar Heating, USB and Type-C Ports, Stainless Steel Cup Holders';

console.log('resolveVariantColor —— 标题末尾颜色短语优先，取不到退回 mainColor');

it('标题末尾是颜色短语 → 用它（Title Case），mainColor 只是色系', () => {
  assert.equal(resolveVariantColor(`${TITLE}, Grey`, 'Grey'), 'Grey');
  assert.equal(resolveVariantColor(`${TITLE},Light Grey`, 'Grey'), 'Light Grey');
  assert.equal(resolveVariantColor(`${TITLE}, light grey`, 'Grey'), 'Light Grey');
  assert.equal(resolveVariantColor(`${TITLE}, NAVY BLUE`, 'Blue'), 'Navy Blue');
  assert.equal(resolveVariantColor('Sideboard Buffet Cabinet, Dark Walnut', 'Brown'), 'Dark Walnut');
  assert.equal(resolveVariantColor('Vanity, Off-White', 'White'), 'Off-White');
});

it('标题末尾不是颜色短语 → 原样退回 mainColor（Stainless Steel Cup Holders 不是颜色）', () => {
  assert.equal(resolveVariantColor(TITLE, 'Grey'), 'Grey');
  assert.equal(resolveVariantColor('Sleeper Sofa with Pull-Out Bed', 'Blue'), 'Blue');
  assert.equal(resolveVariantColor('Cabinet, 4 Door 60 inch', 'Black'), 'Black');
  assert.equal(resolveVariantColor('Cabinet, Metal & Wood', 'Black'), 'Black');
  // 超过三个词、或只有修饰词没有颜色词，都不算颜色短语。
  assert.equal(resolveVariantColor('Sofa, Very Light Soft Blue Fabric', 'Blue'), 'Blue');
  assert.equal(resolveVariantColor('Sofa, Light', 'Blue'), 'Blue');
  assert.equal(resolveVariantColor('', 'Blue'), 'Blue');
  assert.equal(resolveVariantColor('Sofa, Light Grey', ''), 'Light Grey');
});

console.log('normalizeProduct —— color / specifications.Color / color_options_json 用同一份精确色名');

function row(id: string, colorSuffix: string, mainColor: string, mpn: string) {
  return {
    id,
    supplier_product_id: id,
    title: `${TITLE}, ${colorSuffix}`,
    price: 279,
    images: ['https://x/a.jpg'],
    description: 'POWER LIFT ASSISTANCE: counter-balanced lift mechanism.',
    raw_payload: {
      sku: id, mpn, mainColor, mainMaterial: 'Metal & Wood', category: 'Recliners & Massage Chairs',
      assembledLength: '37.40', assembledWidth: '39.00', assembledHeight: '42.52', assembledWeight: '110.00',
      imageUrls: ['https://x/a.jpg'], mainImageUrl: 'https://x/a.jpg', price: 279, srpPrice: 499, characteristics: [],
      sellerInfo: { sellerCode: 'W1803' },
      associateProductList: ['W1803S00105', 'W1803S00106', 'W1803S00108', 'W1803S00109'],
    },
  } as any;
}

it('W1803S00109「Light Grey」不再被压成 Grey；三个字段一致', () => {
  const n: any = normalizeProduct(row('W1803S00109', 'Light Grey', 'Grey', 'LC55172YD445-8LGRY'));
  assert.equal(n.color, 'Light Grey');
  assert.equal(n.specifications_json.Color, 'Light Grey');
  assert.deepEqual(n.color_options_json, ['Light Grey']);
  const g: any = normalizeProduct(row('W1803S00105', 'Grey', 'Grey', 'LC55172YD445-14GRY'));
  assert.equal(g.color, 'Grey');
  assert.notEqual(n.color.toLowerCase(), g.color.toLowerCase(), '深灰与浅灰必须是两个色名');
});

it('标题没有颜色短语时行为与改动前一致：color = mainColor', () => {
  const n: any = normalizeProduct({ ...row('X1', 'Grey', 'Grey', 'M-1'), title: TITLE });
  assert.equal(n.color, 'Grey');
  assert.deepEqual(n.color_options_json, ['Grey']);
});

console.log('duplicateColorIds / colorNameAmbiguousIds —— MPN 色码把真实变体从撞色里救出来');

it('splitMpnColorCode：只认 `-` 后缀为色码', () => {
  assert.deepEqual(splitMpnColorCode('LC55172YD445-10BLU'), { base: 'LC55172YD445', code: '10BLU' });
  assert.deepEqual(splitMpnColorCode(' lc55172yd445-8lgry '), { base: 'LC55172YD445', code: '8LGRY' });
  assert.equal(splitMpnColorCode('LC55172YD445'), null);
  assert.equal(splitMpnColorCode(''), null);
  assert.equal(splitMpnColorCode(null), null);
});

it('W1803 真实形状：两个 Blue 的 MPN 色码不同 → 不是重复，是色名待命名；两个灰已由色名分开', () => {
  const members = [
    { id: 'W1803S00105', color: 'Grey', mpn: 'LC55172YD445-14GRY' },
    { id: 'W1803S00109', color: 'Light Grey', mpn: 'LC55172YD445-8LGRY' },
    { id: 'W1803S00106', color: 'Blue', mpn: 'LC55172YD445-10BLU' },
    { id: 'W1803S00108', color: 'Blue', mpn: 'LC55172YD445-11BLU' },
    { id: 'W1803S00107', color: 'Brown', mpn: 'LC55172YD445-9BRW' },
  ];
  assert.equal(duplicateColorIds(members).size, 0, '四件里没有一件是重复商品');
  assert.deepEqual([...colorNameAmbiguousIds(members)].sort(), ['W1803S00106', 'W1803S00108']);
});

it('没有 MPN → 仍按撞色（行为与改动前一致，不猜）', () => {
  const members = [{ id: 'a', color: 'Blue' }, { id: 'b', color: 'Blue' }, { id: 'c', color: 'Black' }];
  assert.deepEqual([...duplicateColorIds(members)].sort(), ['a', 'b']);
  assert.equal(colorNameAmbiguousIds(members).size, 0);
});

it('MPN 相同、或只有一件有 MPN、或 MPN 前缀不同 → 仍按撞色', () => {
  assert.equal(duplicateColorIds([{ id: 'a', color: 'Blue', mpn: 'M-1BLU' }, { id: 'b', color: 'Blue', mpn: 'M-1BLU' }]).size, 2);
  assert.equal(duplicateColorIds([{ id: 'a', color: 'Blue', mpn: 'M-1BLU' }, { id: 'b', color: 'Blue', mpn: null }]).size, 2);
  assert.equal(duplicateColorIds([{ id: 'a', color: 'Blue', mpn: 'M1-1BLU' }, { id: 'b', color: 'Blue', mpn: 'M2-2BLU' }]).size, 2);
  assert.equal(colorNameAmbiguousIds([{ id: 'a', color: 'Blue', mpn: 'M1-1BLU' }, { id: 'b', color: 'Blue', mpn: 'M2-2BLU' }]).size, 0);
});

it('三件同色：两件 MPN 色码互不相同但第三件与其中一件相同 → 整组仍按撞色（码不是唯一的就不是变体证据）', () => {
  const members = [
    { id: 'a', color: 'Blue', mpn: 'M-1BLU' }, { id: 'b', color: 'Blue', mpn: 'M-2BLU' }, { id: 'c', color: 'Blue', mpn: 'M-2BLU' },
  ];
  assert.equal(duplicateColorIds(members).size, 3);
  assert.equal(colorNameAmbiguousIds(members).size, 0);
});

it('原有语义不变：大小写 / 空白不敏感，空色名不参与', () => {
  assert.equal(duplicateColorIds([{ id: 'a', color: 'Black' }, { id: 'b', color: ' black ' }]).size, 2);
  assert.equal(duplicateColorIds([{ id: 'a', color: '' }, { id: 'b', color: '' }, { id: 'c', color: 'Black' }]).size, 0);
});

console.log('planner / 桥接源码契约');

it('planner 撞色分支同时消费 colorNameAmbiguousIds，父级与配置子组都不再把它们当 duplicate_color', () => {
  const src = readFileSync('scripts/planGigaAutoPublish.ts', 'utf8');
  assert.ok(/const ambiguousIds = colorNameAmbiguousIds\(group\)/.test(src));
  // 配置子组分支（configSubgroups）目前只在工作区里、尚未提交；存在时它也必须走同一条规则。
  if (/configSubgroups\(rest\)/.test(src)) assert.ok(/const subAmbiguous = colorNameAmbiguousIds\(sub\)/.test(src));
  assert.ok(/!dupIds\.has\(m\.id\) && !ambiguousIds\.has\(m\.id\)/.test(src), '色名待命名的不进后续配置评估');
  assert.ok(/m\.reasons\.push\('color_name_ambiguous'\)/.test(src));
  assert.ok(/mpn: typeof raw\.mpn === 'string'/.test(src), '候选必须带上供应商 MPN');
});

it('桥接把 color_name_ambiguous 翻成运营看得懂的话', () => {
  const bridge = readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8');
  assert.ok(/color_name_ambiguous: '[^']*不同颜色变体[^']*'/.test(bridge));
});

console.log(`\n${passed} passed`);
