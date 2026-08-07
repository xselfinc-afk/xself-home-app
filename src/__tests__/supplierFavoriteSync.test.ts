/**
 * Favorites synchronisation tests (pure; no network, no database, no browser).
 *
 * TARGET is exactly `published = true`. Not sellable_products, not inventory status — a product
 * that is temporarily out of stock is still one we sell, and un-favouriting it over a transient
 * condition would lose the supplier relationship.
 *
 * Run: npx tsx src/__tests__/supplierFavoriteSync.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  buildFavoriteSyncPlan,
  projectAccountAfterSync,
  type AccountFavoritesState,
} from '../services/supplierFavoriteSync';
import { resolveProductIdMapping } from '../services/supplierFavoriteProductId';
import {
  ADD_ENDPOINT,
  REMOVAL_ENDPOINT,
  endpointFor,
  executeSyncOperation,
  previewSyncOperation,
} from '../services/supplierFavoriteRemoval';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}

/** A cache with genuine website ids — production has none of these, so tests supply their own. */
const CACHE = [
  { supplier_product_id: 'PUB-A', product_id: 1001 },
  { supplier_product_id: 'PUB-B', product_id: 1002 },
  { supplier_product_id: 'PUB-C', product_id: 1003 },
  { supplier_product_id: 'OLD-X', product_id: 2001 },
  { supplier_product_id: 'OLD-Y', product_id: 2002 },
  { supplier_product_id: 'TWO-IDS', product_id: 3001 },
  { supplier_product_id: 'TWO-IDS', product_id: 3002 },
  { supplier_product_id: 'SHARE-A', product_id: 4001 },
  { supplier_product_id: 'SHARE-B', product_id: 4001 },
  // 生产中的真实形态：product_id 只是 SKU 自身的副本，不是网站 id。
  { supplier_product_id: 'SELFCOPY', product_id: 'SELFCOPY' },
  { supplier_product_id: '1315793', product_id: '1315793' },
];
const resolve = (sku: string) => resolveProductIdMapping(sku, CACHE);

const account = (
  name: 'pickup' | 'dropship',
  saved: string[],
  authoritative = true,
): AccountFavoritesState => ({ account: name, saved, authoritative });

const ON = { SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'true' };
const session = { session_present: true };

async function main(): Promise<void> {
  // ── 1–4: TARGET 的定义 ─────────────────────────────────────────────────────

  it('1. published=true 且未收藏 → missing', () => {
    const plan = buildFavoriteSyncPlan(['PUB-A', 'PUB-B'], [account('pickup', [])], resolve);
    const p = plan.accounts[0];
    assert.deepEqual(p.missing.map(i => i.supplier_product_id), ['PUB-A', 'PUB-B']);
    assert.ok(p.missing.every(i => i.operation === 'add'));
    assert.equal(p.extra.length, 0);
    assert.equal(plan.target_count, 2);
  });

  it('2. published=true 且已收藏 → 不产生任何操作', () => {
    const plan = buildFavoriteSyncPlan(['PUB-A', 'PUB-B'], [account('pickup', ['PUB-A', 'PUB-B'])], resolve);
    assert.equal(plan.accounts[0].missing.length, 0);
    assert.equal(plan.accounts[0].extra.length, 0);
    assert.equal(plan.total_operations, 0);
  });

  it('3. published=false 且已收藏 → extra', () => {
    // 旧规则下 SAVED_CANDIDATE / HOLD / REVIEW_REQUIRED 会拦住它；新规则只看 published。
    const plan = buildFavoriteSyncPlan(['PUB-A'], [account('pickup', ['PUB-A', 'OLD-X', 'OLD-Y'])], resolve);
    const p = plan.accounts[0];
    assert.deepEqual(p.extra.map(i => i.supplier_product_id), ['OLD-X', 'OLD-Y']);
    assert.ok(p.extra.every(i => i.operation === 'remove'));
    assert.equal(p.missing.length, 0);
  });

  it('4. 临时缺货但 published=true → 保留收藏，不进 extra', () => {
    // TARGET 完全不看库存，所以「缺货」这个事实根本不参与计算。缺货商品仍在 TARGET 里，
    // 已收藏就是 no-op，未收藏则是 missing —— 无论如何都不会被取消。
    const outOfStockButPublished = ['PUB-A', 'PUB-B'];
    const plan = buildFavoriteSyncPlan(outOfStockButPublished, [account('pickup', ['PUB-A', 'PUB-B'])], resolve);
    assert.equal(plan.accounts[0].extra.length, 0, '缺货绝不能导致取消收藏');
    assert.equal(plan.total_operations, 0);

    const notYetSaved = buildFavoriteSyncPlan(outOfStockButPublished, [account('pickup', ['PUB-A'])], resolve);
    assert.deepEqual(notYetSaved.accounts[0].missing.map(i => i.supplier_product_id), ['PUB-B']);
    assert.equal(notYetSaved.accounts[0].extra.length, 0);
  });

  // ── 5: 双账号独立 ──────────────────────────────────────────────────────────

  it('5. Pickup 与 Dropship 各自独立计算', () => {
    const plan = buildFavoriteSyncPlan(
      ['PUB-A', 'PUB-B'],
      [account('pickup', ['PUB-A', 'OLD-X']), account('dropship', [])],
      resolve,
    );
    const [pickup, dropship] = plan.accounts;
    assert.deepEqual(pickup.missing.map(i => i.supplier_product_id), ['PUB-B']);
    assert.deepEqual(pickup.extra.map(i => i.supplier_product_id), ['OLD-X']);
    assert.deepEqual(dropship.missing.map(i => i.supplier_product_id), ['PUB-A', 'PUB-B']);
    assert.equal(dropship.extra.length, 0);
    assert.equal(plan.total_operations, 4);

    // 一个账号读取不完整时，它自己不出计划，也不影响另一个账号。
    const partial = buildFavoriteSyncPlan(
      ['PUB-A'],
      [account('pickup', ['PUB-A']), account('dropship', ['PUB-A'], false)],
      resolve,
    );
    assert.equal(partial.accounts[1].authoritative, false);
    assert.equal(partial.accounts[1].missing.length + partial.accounts[1].extra.length, 0);
    assert.equal(partial.accounts[1].exceptions[0].reason, 'account_not_authoritative');
    assert.equal(partial.executable, false);
    assert.equal(partial.accounts[0].authoritative, true);
  });

  // ── 6–7: 身份守卫 ─────────────────────────────────────────────────────────

  it('6. product_id 无映射 → exception，不进入可执行集合', () => {
    const plan = buildFavoriteSyncPlan(['NO-MAP', 'PUB-A'], [account('pickup', [])], resolve);
    const p = plan.accounts[0];
    assert.deepEqual(p.missing.map(i => i.supplier_product_id), ['PUB-A']);
    assert.deepEqual(p.exceptions, [{ supplier_product_id: 'NO-MAP', intended_operation: 'add', reason: 'not_mapped' }]);
    assert.equal(p.executable_count, 1);

    // 一个 SKU 对应多个 product_id、或 product_id 被多个 SKU 共用，同样是 exception。
    const ambiguous = buildFavoriteSyncPlan(['TWO-IDS', 'SHARE-A'], [account('pickup', [])], resolve);
    assert.equal(ambiguous.accounts[0].missing.length, 0);
    assert.deepEqual(
      ambiguous.accounts[0].exceptions.map(e => e.reason).sort(),
      ['multiple_product_ids', 'shared_product_id'],
    );
  });

  it('7. product_id 只是 SKU 自身副本 → 拒绝，绝不当成网站 id', () => {
    // 生产中 inventory_cache 的 product_id 全部等于 supplier_product_id。其中个别 SKU
    // 本身全是数字，若照收就会把一个 SKU 当作网站 product_id 发出去，作用到别的商品上。
    for (const sku of ['SELFCOPY', '1315793']) {
      const mapping = resolve(sku);
      assert.equal(mapping.status, 'not_mapped', `${sku} 的自我副本不得算作映射`);
      assert.equal(mapping.product_id, null);
    }
    const plan = buildFavoriteSyncPlan(['1315793'], [account('pickup', [])], resolve);
    assert.equal(plan.accounts[0].missing.length, 0);
    assert.equal(plan.accounts[0].exceptions[0].reason, 'not_mapped');

    // 反查得到不同 SKU 时也必须拒绝执行。
    const mismatched = previewSyncOperation(
      { supplier_product_id: 'PUB-A', operation: 'add', product_id: 1001, verified_sku_for_product_id: 'PUB-B', ...session },
      ON,
    );
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.rejections.includes('identity_mismatch'));
    assert.equal(mismatched.payload, null);
  });

  // ── 8–9: 两个方向各自的接口 ────────────────────────────────────────────────

  it('8. missing 走 addProductsToWish', () => {
    const plan = buildFavoriteSyncPlan(['PUB-A'], [account('pickup', [])], resolve);
    const item = plan.accounts[0].missing[0];
    const preview = previewSyncOperation(
      { supplier_product_id: item.supplier_product_id, operation: item.operation, product_id: item.product_id, verified_sku_for_product_id: item.verified_sku, ...session },
      ON,
    );
    assert.equal(preview.operation, 'add');
    assert.equal(preview.endpoint, ADD_ENDPOINT);
    assert.ok(preview.endpoint.includes('addProductsToWish'));
    assert.deepEqual(preview.payload, { product_ids: 1001 });
    assert.equal(endpointFor('add'), ADD_ENDPOINT);
  });

  it('9. extra 走 delProductsFromWish', () => {
    const plan = buildFavoriteSyncPlan(['PUB-A'], [account('pickup', ['PUB-A', 'OLD-X'])], resolve);
    const item = plan.accounts[0].extra[0];
    const preview = previewSyncOperation(
      { supplier_product_id: item.supplier_product_id, operation: item.operation, product_id: item.product_id, verified_sku_for_product_id: item.verified_sku, ...session },
      ON,
    );
    assert.equal(preview.operation, 'remove');
    assert.equal(preview.endpoint, REMOVAL_ENDPOINT);
    assert.ok(preview.endpoint.includes('delProductsFromWish'));
    assert.deepEqual(preview.payload, { product_ids: 2001 });
    assert.equal(endpointFor('remove'), REMOVAL_ENDPOINT);
  });

  // ── 10: 默认门禁 ──────────────────────────────────────────────────────────

  await itAsync('10. 门禁默认关闭 → 整份计划 0 次 XHR 写请求', async () => {
    let calls = 0;
    const fetcher = async () => { calls++; return { status: 200, json: async () => ({ code: 200 }) }; };
    const plan = buildFavoriteSyncPlan(
      ['PUB-A', 'PUB-B', 'PUB-C'],
      [account('pickup', ['PUB-A', 'OLD-X']), account('dropship', ['OLD-Y'])],
      resolve,
    );
    const everyItem = plan.accounts.flatMap(a => [...a.missing, ...a.extra]);
    assert.ok(everyItem.length > 0, '这份计划本身必须是非空的，否则这条断言没有意义');

    for (const env of [{}, { SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'false' }, { SUPPLIER_FAVORITE_REMOVAL_ENABLED: '1' }]) {
      for (const item of everyItem) {
        const result = await executeSyncOperation(
          { supplier_product_id: item.supplier_product_id, operation: item.operation, product_id: item.product_id, verified_sku_for_product_id: item.verified_sku, ...session },
          fetcher, env,
        );
        assert.equal(result.attempted, false);
        assert.ok(result.preview.rejections.includes('sync_disabled'));
      }
    }
    assert.equal(calls, 0, '门禁关闭时 fetcher 一次都不得被调用');
  });

  // ── 11: 链隔离 ────────────────────────────────────────────────────────────

  it('11. 同步模块不触碰库存链', () => {
    const files = [
      'src/services/supplierFavoriteSync.ts',
      'src/services/supplierFavoriteProductId.ts',
      'src/services/supplierFavoriteRemoval.ts',
    ];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      // 说明性注释里提到这些名字是允许的；禁止的是真的 import 或真的去读写它们。
      for (const forbidden of [
        'standardizedInventoryProjection', 'availabilityPersistence', 'openApiAvailability',
        'inventoryStateMachine',
      ]) {
        assert.equal(
          new RegExp(`(import|require)[^\\n]*${forbidden}`).test(src), false,
          `${file} 不得 import ${forbidden}`,
        );
      }
      for (const table of ['product_availability', 'inventory_workflow', 'sellable_products', 'standardized_products']) {
        assert.equal(
          new RegExp(`from\\('${table}`).test(src), false,
          `${file} 不得访问 ${table}`,
        );
      }
      // 这三个都是纯模块：根本不该拿到数据库客户端，也就无从写库。
      assert.equal(
        /supabase-js|SupabaseClient|createClient/.test(src), false,
        `${file} 是纯模块，不得引入数据库客户端`,
      );
    }
    // TARGET 的来源必须是 published，而不是可售视图或库存状态。
    const bridge = fs.readFileSync('scripts/xoneSupplierFavoriteBridge.ts', 'utf8');
    assert.ok(bridge.includes('rows.products.filter((p) => p.published === true)'), 'TARGET 必须来自 published=true');
    assert.equal(bridge.includes("from('sellable_products')"), false, 'TARGET 不得来自 sellable_products');
  });

  // ── 12: 收敛性 ────────────────────────────────────────────────────────────

  it('12. 执行计划后两账号都收敛到 TARGET', () => {
    const target = ['PUB-A', 'PUB-B', 'PUB-C'];
    const pickupBefore = ['PUB-A', 'OLD-X', 'OLD-Y'];
    const dropshipBefore = ['OLD-X'];
    const plan = buildFavoriteSyncPlan(
      target,
      [account('pickup', pickupBefore), account('dropship', dropshipBefore)],
      resolve,
    );
    const after = [
      projectAccountAfterSync(plan.accounts[0], pickupBefore),
      projectAccountAfterSync(plan.accounts[1], dropshipBefore),
    ];
    for (const [index, set] of after.entries()) {
      assert.deepEqual([...set].sort(), [...target].sort(), `账号 ${index} 未收敛到 TARGET`);
    }

    // 有 exception 时，收敛到「TARGET 去掉无法识别的那些」，且绝不会误删可识别的商品。
    const withException = buildFavoriteSyncPlan(
      [...target, 'NO-MAP'],
      [account('pickup', ['NO-MAP', 'OLD-X'])],
      resolve,
    );
    const projected = projectAccountAfterSync(withException.accounts[0], ['NO-MAP', 'OLD-X']);
    assert.equal(projected.has('NO-MAP'), true, '无法识别的商品保持原样，不被动');
    assert.equal(projected.has('OLD-X'), false);
    assert.deepEqual([...projected].sort(), ['NO-MAP', 'PUB-A', 'PUB-B', 'PUB-C']);
  });

  console.log(`\n${passed} passed`);
}

void main();
