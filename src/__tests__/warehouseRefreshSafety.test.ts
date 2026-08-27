/**
 * Stage 2 仓库刷新的安全不变量。纯逻辑 + 源码断言，不联网、不碰数据库。
 *
 * 最重要的一条在最后：这个脚本**绝不能**调 refresh_product_inventory_status()。
 * 那个函数用它自己的 24 小时规则判 stale 并直接写 published，而本任务每 48 小时
 * 跑一轮 —— 调它就等于每隔一天把整个目录下架一次。
 *
 * 运行：npx tsx src/__tests__/warehouseRefreshSafety.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  quantityRecordsToCacheRows,
  supportsPickup,
  warehouseState,
  zeroOutVanishedWarehouses,
  type GigaQuantityRecord,
} from '../services/gigaQuantityToCacheRows';

let passed = 0;
const it = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const NOW = '2026-08-27T12:00:00.000Z';
const OPTS = { now: NOW, sourceNote: 'warehouse_refresh', runId: 'test_run' };

const rec = (sku: string, dist: [string, number, number][], total: number | null = null): GigaQuantityRecord => ({
  sku,
  sellerInventoryInfo: {
    sellerAvailableInventory: total,
    sellerInventoryDistribution: dist.map(([warehouseCode, availableQtyMin, availableQtyMax]) =>
      ({ warehouseCode, availableQtyMin, availableQtyMax })),
  },
});

console.log('仓库代码 → 州 / 自提');
it('前缀有包含关系时顺序即正确性：NJX 是 MD，不是 NJ', () => {
  assert.equal(warehouseState('NJX3'), 'MD');
  assert.equal(warehouseState('NJ1'), 'NJ');
  assert.equal(warehouseState('TXX1'), 'TX');
  assert.equal(warehouseState('CA7'), 'CA');
  assert.equal(warehouseState('AT2'), 'GA');
  assert.equal(warehouseState('ZZ9'), null);
});
it('只有加州仓支持自提 —— CA 生命周期与 has_ca_pickup 都由它推导', () => {
  assert.equal(supportsPickup('CAX1'), true);
  assert.equal(supportsPickup('NJX3'), false);
  assert.equal(supportsPickup('AT1'), false);
});

console.log('\n映射');
it('一个 SKU 的每个仓库摊成一行', () => {
  const rows = quantityRecordsToCacheRows([rec('A', [['CA7', 5, 5], ['NJ1', 0, 3]])], OPTS);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.warehouse_code), ['CA7', 'NJ1']);
  assert.ok(rows.every((r) => r.last_synced_at === NOW && r.sync_status === 'ok'));
});

it('0 库存照写 —— 不写 0 会让缺货商品同时是「有货」和「新鲜」', () => {
  const rows = quantityRecordsToCacheRows([rec('A', [['CA7', 0, 0]])], OPTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 0);
  assert.equal(rows[0].is_available, false);
  assert.equal(rows[0].last_synced_at, NOW, '0 库存的行也必须刷新时间戳');
});

it('min≠max 时记区间，并标记为非精确', () => {
  const [r] = quantityRecordsToCacheRows([rec('A', [['CA7', 2, 9]])], OPTS);
  assert.equal(r.quantity, 2, 'quantity 取下界 —— 承诺不能超过确定有的量');
  assert.equal(r.quantity_raw, '2-9');
  assert.equal(r.quantity_exact, false);
  assert.equal(r.is_available, true, 'max>0 就算可得');
});

it('负数与脏值按 0 处理，不产生负库存', () => {
  const [r] = quantityRecordsToCacheRows([rec('A', [['CA7', -5, 'x' as unknown as number]])], OPTS);
  assert.equal(r.quantity, 0);
  assert.equal(r.is_available, false);
});

it('没有仓库分布的记录不产生任何行 —— 不能把「没数据」写成 0', () => {
  assert.equal(quantityRecordsToCacheRows([{ sku: 'A', sellerInventoryInfo: null }], OPTS).length, 0);
  assert.equal(quantityRecordsToCacheRows([rec('A', [])], OPTS).length, 0);
});

it('source_type 是 website_scrape，真实来源记在 raw_payload', () => {
  const [r] = quantityRecordsToCacheRows([rec('A', [['CA7', 1, 1]])], OPTS);
  assert.equal(r.source_type, 'website_scrape',
    'refresh_product_inventory_status 只统计 website_scrape；改这里会让商品静默消失');
  assert.equal(r.raw_payload.original_source_type, 'official_api');
  assert.equal(r.raw_payload.run_id, 'test_run', 'run_id 让 per-run 健康统计成为可能');
});

console.log('\n幽灵仓库');
it('本轮消失的仓库被写成 0 且时间戳刷新，而不是删除', () => {
  const fresh = quantityRecordsToCacheRows([rec('A', [['CA7', 5, 5]])], OPTS);
  const zeroed = zeroOutVanishedWarehouses(
    [{ product_id: 'A', warehouse_code: 'CA7' }, { product_id: 'A', warehouse_code: 'NJ1' }],
    fresh, OPTS,
  );
  assert.equal(zeroed.length, 1);
  assert.equal(zeroed[0].warehouse_code, 'NJ1');
  assert.equal(zeroed[0].quantity, 0);
  assert.equal(zeroed[0].last_synced_at, NOW);
  assert.equal(zeroed[0].raw_payload.vanished_from_distribution, true);
});

it('本轮没查过的商品绝不被宣布为 0', () => {
  const fresh = quantityRecordsToCacheRows([rec('A', [['CA7', 5, 5]])], OPTS);
  const zeroed = zeroOutVanishedWarehouses([{ product_id: 'B', warehouse_code: 'NJ1' }], fresh, OPTS);
  assert.equal(zeroed.length, 0, '没查 B 就不能替 B 下结论');
});

console.log('\n脚本的硬约定（源码断言）');
const SRC = fs.readFileSync(path.join(__dirname, '../../scripts/refreshWarehouseInventory.ts'), 'utf8');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

it('状态刷新只对本轮问到的 SKU，且必须排在写入之后', () => {
  // 对没问到的 SKU 调用，只会把「我们没查到」按 24h 规则变成「下架」。
  assert.ok(/for \(const sku of answered\)[\s\S]{0,160}refreshStatus\(sku\)/.test(code),
    '调用范围必须严格等于 answered');
  assert.ok(!/for \(const sku of targets\)[\s\S]{0,160}refreshStatus/.test(code),
    '绝不能对全部 targets 调用');
  // 写入之前调用没有意义：那时行龄还是旧的，24h 规则会把陈旧数据判成 stale 并下架。
  const write = code.indexOf('summary.rows_written += chunk.length');
  const call = code.indexOf('refreshStatus(sku)');
  assert.ok(write > 0 && call > write, '状态刷新必须排在写入之后');
  assert.ok(/if \(summary\.rows_written > 0\)/.test(code), '一行都没写就不该刷新状态');
});

it('不整库刷新，也不自己写发布状态 —— 判定留在数据库函数里', () => {
  assert.ok(!code.includes('refresh_all_inventory_status'),
    '整库刷新会连本轮没问到的 SKU 一起按 24h 规则下架');
  // 唯一允许碰 standardized_products 的方式是只读查询。发布状态由
  // refresh_product_inventory_status 自己算，这个脚本不替它下结论。
  const writes = code.match(/standardized_products[^\n]*/g) ?? [];
  for (const line of writes) {
    assert.ok(/select=/.test(line), `standardized_products 只能只读访问，实际: ${line.trim()}`);
  }
  for (const verb of ["method: 'PATCH'", "method: 'PUT'", "method: 'DELETE'"]) {
    assert.ok(!code.includes(verb), `这个脚本不该出现 ${verb}`);
  }
});

it('下架比例异常时整轮中止，连缓存都不写', () => {
  assert.ok(code.includes('MAX_DELIST_PERCENT'));
  // 闸门必须排在写入之前，否则缓存已经落库，下一轮会把这个结果当成既定事实。
  const gate = code.indexOf('delistPercent > MAX_DELIST_PERCENT');
  const write = code.indexOf('summary.rows_written += chunk.length');
  assert.ok(gate > 0 && gate < write, '下架闸门必须在写入之前');
});

it('「没问到」和「问到了是 0」必须分开 —— 只有后者才是缺货', () => {
  assert.ok(code.includes('out.records === null'), '用 null 表示没拿到答案');
  assert.ok(/willDelist = zeroOnly\.filter/.test(code),
    '下架范围只从 answered 里筛，missing 不在其中');
});

it('不碰可用性证据那条发布路径', () => {
  // 两条路各管各的：这里按仓库数量算库存状态，那里按 Open API 可用性证据算发布资格。
  // 一个脚本同时走两条，就没人说得清某次下架到底是哪条判的。
  assert.ok(!code.includes('set_publication_from_availability'));
  assert.ok(!code.includes('publication_audit_log'));
});

it('默认 dry-run，写入必须显式 --apply', () => {
  assert.ok(code.includes("const APPLY = has('--apply')"));
  assert.ok(/if \(!APPLY\) \{[\s\S]{0,80}DRY-RUN/.test(code), 'dry-run 分支必须在写入之前');
});

it('健康指标只统计本轮，不看全表最新时间', () => {
  assert.ok(code.includes('coverage_percent') && code.includes('rows_written') && code.includes('failure_percent'));
  assert.ok(!/max\(.*last_synced_at/i.test(code) && !code.includes('order=last_synced_at.desc'),
    '旧 scraper 的假绿就是拿全表 max(last_synced_at) 当健康证据');
});

it('批量大小与生产既有路径一致', () => {
  assert.ok(code.includes('SKU_BATCH = 200'), 'quantity/v2 每次 200 个');
  assert.ok(code.includes('ROW_BATCH = 500'));
});

it('两道闸门都排在写入之前，任一触发就一行不写', () => {
  const write = code.indexOf('summary.rows_written += chunk.length');
  for (const gate of ['failurePercent > MAX_FAILURE_PERCENT', 'delistPercent > MAX_DELIST_PERCENT']) {
    const at = code.indexOf(gate);
    assert.ok(at > 0, `缺少闸门 ${gate}`);
    assert.ok(at < write, `${gate} 必须在写入之前`);
  }
  // 触发时要说清是哪一道，否则日志里只看到「什么都没写」，排查无从下手。
  assert.ok(code.includes('delist_blocked_reason'));
});

console.log(`\n${passed} passed`);
