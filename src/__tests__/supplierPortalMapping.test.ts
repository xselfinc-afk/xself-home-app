/**
 * Supplier portal product_id mapping tests (pure; no network, no database, no browser).
 *
 * The property everything else depends on: the wishlist XHR addresses a numeric website
 * product_id, and getting it wrong silently acts on a different product. So a mapping is evidence
 * that must be proven per SKU and verified in reverse — never guessed, never inherited from
 * inventory_cache, never picked from several candidates.
 *
 * Run: npx tsx src/__tests__/supplierPortalMapping.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  BANNED_MAPPING_SOURCES,
  MAPPING_STALE_AFTER_DAYS,
  PORTAL_MAPPING_CONFIDENCE,
  PORTAL_MAPPING_SOURCE,
  isStale,
  isUsableMapping,
  resolvePortalMapping,
  toUsableMapping,
  type StoredPortalMapping,
} from '../services/supplierPortalMapping';
import { buildFavoriteSyncPlan } from '../services/supplierFavoriteSync';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }

const NOW = '2026-08-06T00:00:00.000Z';

const stored = (over: Partial<StoredPortalMapping> = {}): StoredPortalMapping => ({
  supplier_product_id: 'W409P327406',
  website_product_id: 667968,
  portal_sku: 'W409P327406',
  source: PORTAL_MAPPING_SOURCE,
  confidence: PORTAL_MAPPING_CONFIDENCE,
  resolved_at: NOW,
  last_verified_at: NOW,
  ...over,
});

function main(): void {
  // ── 1–5: 解析规则 ─────────────────────────────────────────────────────────

  it('1. 唯一候选 + 数字 product_id + portal_sku 一致 → 成功', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W409P327406',
      candidates: ['667968'],
      portal_sku: 'W409P327406',
    });
    assert.equal(r.status, 'resolved');
    assert.equal(r.website_product_id, 667968);
    assert.equal(r.portal_sku, 'W409P327406');
    assert.equal(r.source, 'supplier_portal');
    assert.equal(r.confidence, 'exact');
  });

  it('2. portal_sku 与目标 SKU 不一致 → 拒绝', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W409P327406',
      candidates: [667968],
      portal_sku: 'W409P327407',      // 搜索模糊命中了邻近商品
    });
    assert.equal(r.status, 'portal_sku_mismatch');
    assert.equal(r.website_product_id, null);
    assert.equal(r.confidence, null);
  });

  it('3. product_id 非数字 → 拒绝', () => {
    for (const candidate of ['W409P327406', 'abc123', '12.5', '-7', '0']) {
      const r = resolvePortalMapping({
        supplier_product_id: 'W409P327406',
        candidates: [candidate],
        portal_sku: 'W409P327406',
      });
      assert.equal(r.status, 'product_id_not_numeric', `${candidate} 必须被拒绝`);
      assert.equal(r.website_product_id, null);
    }
  });

  it('4. 多候选 → 拒绝，绝不自动取第一个', () => {
    const r = resolvePortalMapping({
      supplier_product_id: 'W409P327406',
      candidates: ['667968', '667969'],
      portal_sku: 'W409P327406',
    });
    assert.equal(r.status, 'multiple_candidates');
    assert.equal(r.website_product_id, null);
    assert.match(r.detail ?? '', /拒绝自动选取/);
  });

  it('5. 无候选 → exception', () => {
    const r = resolvePortalMapping({ supplier_product_id: 'W409P327406', candidates: [], portal_sku: null });
    assert.equal(r.status, 'no_candidate');
    assert.equal(r.website_product_id, null);

    // 详情读不到时同样不能成立 —— 没有反查就没有映射。
    const noDetail = resolvePortalMapping({
      supplier_product_id: 'W409P327406', candidates: ['667968'], portal_sku: null,
    });
    assert.equal(noDetail.status, 'detail_unavailable');
    assert.equal(noDetail.website_product_id, null);
  });

  // ── 6–7: 被禁来源 ─────────────────────────────────────────────────────────

  it('6. inventory_cache 永远不能作为映射来源', () => {
    assert.equal(isUsableMapping(stored({ source: 'inventory_cache' })), false);
    for (const banned of BANNED_MAPPING_SOURCES) {
      assert.equal(isUsableMapping(stored({ source: banned })), false, `${banned} 必须被拒绝`);
    }
    // 源码层面：解析与同步链都不得再引用 inventory_cache。
    for (const file of [
      'src/services/supplierPortalMapping.ts',
      'src/services/supplierFavoriteSync.ts',
      'scripts/xoneSupplierFavoriteBridge.ts',
    ]) {
      const src = fs.readFileSync(file, 'utf8');
      assert.equal(
        /from\('inventory_cache'\)|readAll[^\n]*inventory_cache/.test(src), false,
        `${file} 不得再读取 inventory_cache`,
      );
    }
  });

  it('7. SKU 自我副本不能被当作 product_id', () => {
    // inventory_cache 的真实形态：product_id 就是 SKU 本身。个别 SKU 全是数字，
    // 只做数字校验会放行，然后作用到毫不相干的商品上。
    assert.equal(isUsableMapping(stored({ supplier_product_id: '1315793', website_product_id: 1315793, portal_sku: '1315793' })), false);
    // 非数字的自我副本本来就过不了数字校验。
    assert.equal(isUsableMapping(stored({ website_product_id: 'W409P327406' })), false);
  });

  // ── 8–9: 存量映射 ─────────────────────────────────────────────────────────

  it('8. 已确认的映射可直接复用', () => {
    const row = stored();
    assert.equal(isUsableMapping(row), true);
    assert.deepEqual(toUsableMapping(row), {
      supplier_product_id: 'W409P327406',
      website_product_id: 667968,
      portal_sku: 'W409P327406',
    });
    assert.equal(isStale(row, NOW), false);

    // 任一门禁不满足都不可复用。
    for (const spoil of [
      { confidence: 'fuzzy' }, { source: 'guess' }, { portal_sku: 'OTHER' },
      { portal_sku: null }, { website_product_id: null },
    ] as Partial<StoredPortalMapping>[]) {
      assert.equal(isUsableMapping(stored(spoil)), false, `${JSON.stringify(spoil)} 必须不可用`);
      assert.equal(toUsableMapping(stored(spoil)), null);
    }
    assert.equal(isUsableMapping(null), false);
  });

  it('9. 过期映射需要重新验证', () => {
    const old = new Date(Date.parse(NOW) - (MAPPING_STALE_AFTER_DAYS + 1) * 86400_000).toISOString();
    assert.equal(isStale(stored({ last_verified_at: old, resolved_at: old }), NOW), true);
    // 仍在有效期内的不算过期。
    const recent = new Date(Date.parse(NOW) - 10 * 86400_000).toISOString();
    assert.equal(isStale(stored({ last_verified_at: recent }), NOW), false);
    // 没有任何时间戳时按过期处理，宁可重验也不盲信。
    assert.equal(isStale(stored({ last_verified_at: null, resolved_at: null }), NOW), true);
    // 过期不等于失效：内容仍然合法，只是需要重验。
    assert.equal(isUsableMapping(stored({ last_verified_at: old, resolved_at: old })), true);
  });

  // ── 10–11: 接入同步计划 ───────────────────────────────────────────────────

  it('10. 同步计划只认 portal mapping', () => {
    const mappings = new Map([['PUB-A', stored({ supplier_product_id: 'PUB-A', portal_sku: 'PUB-A', website_product_id: 1001 })]]);
    const resolve = (sku: string) => {
      const usable = toUsableMapping(mappings.get(sku) ?? ({} as StoredPortalMapping));
      return usable
        ? { product_id: usable.website_product_id, verified_sku: usable.portal_sku, status: 'unique' as const }
        : { product_id: null, verified_sku: null, status: 'not_mapped' as const };
    };
    const plan = buildFavoriteSyncPlan(
      ['PUB-A', 'PUB-B'],
      [{ account: 'pickup', saved: [], authoritative: true }],
      resolve,
    );
    assert.deepEqual(plan.accounts[0].missing.map((i) => i.supplier_product_id), ['PUB-A']);
    assert.equal(plan.accounts[0].missing[0].product_id, 1001);
    assert.deepEqual(plan.accounts[0].exceptions.map((e) => e.supplier_product_id), ['PUB-B']);
  });

  it('11. 映射逻辑变化不影响 missing/extra 的计算', () => {
    const target = ['PUB-A', 'PUB-B'];
    const saved = ['PUB-A', 'OLD-X'];
    // 全部无映射时，集合运算结果不变，只是全部落进 exception。
    const none = buildFavoriteSyncPlan(target, [{ account: 'pickup', saved, authoritative: true }],
      () => ({ product_id: null, verified_sku: null, status: 'not_mapped' as const }));
    assert.equal(none.accounts[0].missing.length + none.accounts[0].exceptions.filter(e => e.intended_operation === 'add').length, 1);
    assert.equal(none.accounts[0].extra.length + none.accounts[0].exceptions.filter(e => e.intended_operation === 'remove').length, 1);

    // 全部有映射时，同样的集合运算，只是变成可执行。
    let n = 5000;
    const all = buildFavoriteSyncPlan(target, [{ account: 'pickup', saved, authoritative: true }],
      (sku) => ({ product_id: ++n, verified_sku: sku, status: 'unique' as const }));
    assert.deepEqual(all.accounts[0].missing.map(i => i.supplier_product_id), ['PUB-B']);
    assert.deepEqual(all.accounts[0].extra.map(i => i.supplier_product_id), ['OLD-X']);
    assert.equal(all.accounts[0].exceptions.length, 0);
  });

  // ── 12: 本轮不得发出任何收藏增删 ──────────────────────────────────────────

  it('12. 解析链不包含任何 wishlist 增删调用', () => {
    for (const file of [
      'src/services/supplierPortalMapping.ts',
      'scripts/resolveSupplierPortalProductIds.ts',
    ]) {
      const src = fs.readFileSync(file, 'utf8');
      for (const forbidden of ['addProductsToWish', 'delProductsFromWish', 'executeSyncOperation', 'executeRemoval']) {
        assert.equal(src.includes(forbidden), false, `${file} 不得引用 ${forbidden}`);
      }
    }
    // 解析脚本只允许写这一张映射表：写入目标常量固定，且没有任何绕过它的写操作。
    const runner = fs.readFileSync('scripts/resolveSupplierPortalProductIds.ts', 'utf8');
    assert.ok(
      /const WRITE_TABLE = 'supplier_portal_product_mappings'/.test(runner),
      '写入目标常量必须固定为映射表',
    );
    const writeTargets = [...runner.matchAll(/\.from\(([^)]+)\)[\s\S]{0,200}?\.(upsert|insert|update|delete)\(/g)]
      .map((m) => m[1].trim());
    assert.deepEqual([...new Set(writeTargets)], ['WRITE_TABLE'], '所有写操作都必须经由 WRITE_TABLE');
  });

  console.log(`\n${passed} passed`);
}

main();
