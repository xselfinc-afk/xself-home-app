/**
 * 人工对外色名（product_variant_color_names）—— 2026-09-06 W1803 两个 Blue 的命名闭环契约。
 *
 * 链路：面板 → 桥接 manual-override rename_color → 表 → 三个消费点各自查表并挂到行上 →
 * normalizeProduct 用人工名压过标题色名 / mainColor → color / specifications.Color /
 * color_options_json 一致 → planner 同色名撞车消失 → 商品回到可上架队列。
 * 这里锁定纯函数与源码契约；数据库读写不在单测里。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalizeProduct, sanitizeVariantColorName } from '../services/normalizationPipeline';
import { colorNameAmbiguousIds, duplicateColorIds } from '../../scripts/planGigaAutoPublish';
import { buildDecisionGroups, buildPreviewRows, parseOnboardingRequest } from '../../scripts/xoneProductOnboardingBridge';

let passed = 0;
function it(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}`); throw e; }
}

const TITLE = 'Up to 350 LBS Chenille Power Lift Recliner Chair, Heavy Duty Motion Mechanism, Stainless Steel Cup Holders';

console.log('sanitizeVariantColorName —— 桥接与 normalization 共用一套净化');

it('合规名字：去空白、折叠空格；不合规（空 / 超长 / 非法字符）→ 空串', () => {
  assert.equal(sanitizeVariantColorName('  Navy   Blue '), 'Navy Blue');
  assert.equal(sanitizeVariantColorName('Off-White & Oak'), 'Off-White & Oak');
  assert.equal(sanitizeVariantColorName(''), '');
  assert.equal(sanitizeVariantColorName(null), '');
  assert.equal(sanitizeVariantColorName('x'.repeat(41)), '');
  assert.equal(sanitizeVariantColorName('Blue<script>'), '');
  assert.equal(sanitizeVariantColorName('蓝色'), '');
});

console.log('normalizeProduct —— 人工名 > 标题色名 > mainColor，三个字段一致');

function row(id: string, mainColor: string, mpn: string, variantColorName: string | null) {
  return {
    id, supplier_product_id: id, title: `${TITLE}, ${mainColor}`, price: 279, images: ['https://x/a.jpg'],
    description: 'POWER LIFT ASSISTANCE.', variant_color_name: variantColorName,
    raw_payload: {
      sku: id, mpn, mainColor, mainMaterial: 'Metal & Wood', category: 'Recliners & Massage Chairs',
      assembledLength: '37.40', assembledWidth: '39.00', assembledHeight: '42.52', assembledWeight: '110.00',
      imageUrls: ['https://x/a.jpg'], mainImageUrl: 'https://x/a.jpg', price: 279, srpPrice: 499, characteristics: [],
      sellerInfo: { sellerCode: 'W1803' }, associateProductList: ['W1803S00106', 'W1803S00108'],
    },
  } as any;
}

it('W1803S00108 命名为 Navy Blue → color / specifications.Color / color_options_json 都是 Navy Blue', () => {
  const n: any = normalizeProduct(row('W1803S00108', 'Blue', 'LC55172YD445-11BLU', 'Navy Blue'));
  assert.equal(n.color, 'Navy Blue');
  assert.equal(n.specifications_json.Color, 'Navy Blue');
  assert.deepEqual(n.color_options_json, ['Navy Blue']);
});

it('没有人工名 / 人工名不合规 → 回退到标题色名（行为与上一轮修复一致）', () => {
  assert.equal((normalizeProduct(row('W1803S00106', 'Blue', 'LC55172YD445-10BLU', null)) as any).color, 'Blue');
  assert.equal((normalizeProduct(row('W1803S00106', 'Blue', 'LC55172YD445-10BLU', '   ')) as any).color, 'Blue');
  assert.equal((normalizeProduct(row('W1803S00106', 'Blue', 'LC55172YD445-10BLU', 'Blue<script>')) as any).color, 'Blue');
});

console.log('planner —— 命名后同色名撞车消失，两件回到正常评估');

it('Slate Blue / Navy Blue：既不是 duplicate_color，也不再 color_name_ambiguous', () => {
  const members = [
    { id: 'W1803S00106', color: 'Slate Blue', mpn: 'LC55172YD445-10BLU' },
    { id: 'W1803S00108', color: 'Navy Blue', mpn: 'LC55172YD445-11BLU' },
    { id: 'W1803S00105', color: 'Grey', mpn: 'LC55172YD445-14GRY' },
    { id: 'W1803S00109', color: 'Light Grey', mpn: 'LC55172YD445-8LGRY' },
  ];
  assert.equal(duplicateColorIds(members).size, 0);
  assert.equal(colorNameAmbiguousIds(members).size, 0);
});

it('只命名了一件（Navy Blue 与 Blue）→ 同样不再撞车；命名成已有色名（Light Grey）→ 变成真撞色，planner 兜底', () => {
  assert.equal(colorNameAmbiguousIds([
    { id: 'a', color: 'Navy Blue', mpn: 'M-11BLU' }, { id: 'b', color: 'Blue', mpn: 'M-10BLU' },
  ]).size, 0);
  assert.deepEqual([...duplicateColorIds([
    { id: 'a', color: 'Light Grey', mpn: 'M-11BLU' }, { id: 'b', color: 'Light Grey', mpn: 'M-8LGRY' },
  ])].sort(), []);
  // 同前缀、色码不同 → 仍按「变体、色名撞车」处理，而不是重复：命名错了会再次回到命名组。
  assert.deepEqual([...colorNameAmbiguousIds([
    { id: 'a', color: 'Light Grey', mpn: 'M-11BLU' }, { id: 'b', color: 'Light Grey', mpn: 'M-8LGRY' },
  ])].sort(), ['a', 'b']);
});

console.log('桥接 —— 请求白名单、预览事实、决策组');

it('manual-override 接受 rename_color + color_name（净化后）与 clear_color_name；脏名字被丢弃', () => {
  const base = { schema_version: '1.0', operation: 'manual-override', sku: 'W1803S00108', approved_by: '何流' };
  const r1 = parseOnboardingRequest(JSON.stringify({ ...base, action: 'rename_color', color_name: '  Navy  Blue ' }));
  assert.equal(r1.action, 'rename_color');
  assert.equal(r1.color_name, 'Navy Blue');
  const r2 = parseOnboardingRequest(JSON.stringify({ ...base, action: 'rename_color', color_name: 'Blue<script>' }));
  assert.equal(r2.color_name, undefined);
  assert.equal(parseOnboardingRequest(JSON.stringify({ ...base, action: 'clear_color_name' })).action, 'clear_color_name');
  assert.equal(parseOnboardingRequest(JSON.stringify({ ...base, action: 'paint' })).action, undefined);
});

const PLAN = {
  proposed_batch: { skus: [] },
  candidates: [
    { id: 'W1803S00106', bucket: 'HOLD_PHASE2', reasons: ['color_name_ambiguous'], mpn: 'LC55172YD445-10BLU', colorNameGroupIds: ['W1803S00108', 'W1803S00106'] },
    { id: 'W1803S00108', bucket: 'HOLD_PHASE2', reasons: ['color_name_ambiguous'], mpn: 'LC55172YD445-11BLU', colorNameGroupIds: ['W1803S00108', 'W1803S00106'] },
    { id: 'W5568S00037', bucket: 'HOLD_PHASE2', reasons: ['duplicate_color'], dupGroupIds: ['W5568S00037', 'W5568S00040'] },
    { id: 'W5568S00040', bucket: 'HOLD_PHASE2', reasons: ['duplicate_color'], dupGroupIds: ['W5568S00037', 'W5568S00040'] },
  ],
};
const normalize = (r: Record<string, any>) => ({
  product_title_display: `Title ${r.supplier_product_id}`, sku_custom: `XH-${r.supplier_product_id}`, category_label: 'Chair',
  primary_image: 'https://x/a.jpg', gallery_images_json: [], price: 279, original_price: null,
  specifications_json: { Color: r.variant_color_name ?? r.color ?? 'Blue', Material: 'Wood' },
});
const rowsFor = (names: Map<string, string>) => buildPreviewRows({
  plan: PLAN,
  supplierRows: PLAN.candidates.map((c) => ({ supplier_product_id: c.id, color: 'Blue' })),
  normalize, reviewCount: () => ({ count: 5, avg: 4.6 }), variantColorNames: names,
});

it('预览把人工名挂到行上交给 normalize，manual_facts 带 mpn_color_code / color_name_group_ids / manual_color_name', () => {
  const rows = rowsFor(new Map([['W1803S00108', 'Navy Blue']]));
  const r108 = rows.find((r) => r.supplier_product_id === 'W1803S00108')!;
  assert.equal(r108.spec_summary[0], 'Color: Navy Blue');
  assert.equal(r108.manual_facts?.manual_color_name, 'Navy Blue');
  assert.equal(r108.manual_facts?.mpn_color_code, '11BLU');
  assert.deepEqual(r108.manual_facts?.color_name_group_ids, ['W1803S00108', 'W1803S00106']);
  const r106 = rows.find((r) => r.supplier_product_id === 'W1803S00106')!;
  assert.equal(r106.manual_facts?.manual_color_name, null);
  assert.equal(r106.manual_facts?.mpn_color_code, '10BLU');
});

it('决策组：color_name 组一组两件、动作 rename_color / clear_color_name / skip；撞色组照旧；一个 SKU 只进一组', () => {
  const groups = buildDecisionGroups(rowsFor(new Map()));
  assert.deepEqual(groups.map((g) => g.kind), ['color_name', 'duplicate_color']);
  const cn = groups[0];
  assert.deepEqual(cn.sku_ids, ['W1803S00106', 'W1803S00108']);
  assert.deepEqual(cn.actions, ['rename_color', 'clear_color_name', 'skip']);
  assert.deepEqual(cn.members.map((m) => m.mpn_color_code), ['10BLU', '11BLU']);
  const all = groups.flatMap((g) => g.sku_ids);
  assert.equal(new Set(all).size, all.length);
});

console.log('源码契约 —— 三个消费点都查表，表缺失 fail-open；迁移带回滚');

it('normalizeProducts.ts / planner / 桥接都读 product_variant_color_names（revoked_at IS NULL），读失败只打日志', () => {
  for (const file of ['scripts/normalizeProducts.ts', 'scripts/planGigaAutoPublish.ts', 'scripts/xoneProductOnboardingBridge.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.ok(/from\('product_variant_color_names'\)/.test(src), `${file} 必须查表`);
    assert.ok(/\.is\('revoked_at', null\)/.test(src), `${file} 只读未撤销的行`);
    assert.ok(/variant color names unavailable/.test(src), `${file} 表缺失时必须 fail-open`);
    assert.ok(/variant_color_name/.test(src), `${file} 必须把名字挂到行上`);
  }
});

it('桥接写表只在 rename_color / clear_color_name 分支，且不进本地 ledger；撤销是软删', () => {
  const src = readFileSync('scripts/xoneProductOnboardingBridge.ts', 'utf8');
  const start = src.indexOf('async function runManualOverride');
  const block = src.slice(start, src.indexOf('let ledger: Record<string, unknown> = {};', start));
  assert.ok(/action === 'rename_color' \|\| action === 'clear_color_name'/.test(block));
  assert.ok(/\.upsert\(\{/.test(block) && /onConflict: 'supplier_product_id'/.test(block));
  assert.ok(/\.update\(\{ revoked_at: now/.test(block), '撤销必须是置 revoked_at 的软删');
  assert.ok(/production_write_attempted: true/.test(block), '写生产库要如实声明');
  assert.equal(/ledger\[sku\]/.test(block), false, '色名不进本地 ledger');
});

it('迁移文件存在、幂等、带 CHECK 与 ROLLBACK，并标明尚未应用', () => {
  const file = 'supabase/migrations/20260906_product_variant_color_names.sql';
  assert.ok(existsSync(file));
  const sql = readFileSync(file, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.product_variant_color_names/);
  assert.match(sql, /CHECK \(char_length\(color_name\) BETWEEN 1 AND 40\)/);
  assert.match(sql, /revoked_at\s+timestamptz/);
  assert.match(sql, /ROLLBACK/);
  assert.match(sql, /NOT YET APPLIED/);
});

console.log(`\n${passed} passed`);
