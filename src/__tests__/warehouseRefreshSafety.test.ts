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

it('绝不调用 refresh_product_inventory_status —— 它会按 24h 规则把 published 写成 false', () => {
  assert.ok(!code.includes('refresh_product_inventory_status'),
    '48h 的刷新节奏碰上 24h 的发布规则，等于每隔一天下架整个目录');
  assert.ok(!code.includes('refresh_all_inventory_status'));
  assert.ok(!code.includes('/rpc/'), '这个脚本不该调任何 RPC');
});

it('不写 published / inventory_status —— 发布决策归可用性证据那条路', () => {
  for (const forbidden of ['published', 'set_publication_from_availability', 'standardized_products?', 'delist']) {
    assert.ok(!code.includes(`${forbidden}:`), `不应写 ${forbidden}`);
  }
  assert.ok(!/from\('standardized_products'\)\s*\.update/.test(code));
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

it('失败率超限时中止且不写任何行', () => {
  assert.ok(/failurePercent > MAX_FAILURE_PERCENT[\s\S]{0,160}不写任何东西/.test(SRC));
});

console.log(`\n${passed} passed`);
