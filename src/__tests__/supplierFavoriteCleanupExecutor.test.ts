/**
 * Supplier Favorites cleanup executor tests (pure; no network, no database, no browser).
 *
 * The property everything else depends on: a wishlist removal is irreversible and outward-facing,
 * so nothing is sent unless both the env switch and --execute are set, every send is one
 * reverse-verified product_id, and a code 200 is not "done" until the official Favorites read shows
 * the SKU gone.
 *
 * Run: npx tsx src/__tests__/supplierFavoriteCleanupExecutor.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  checkpointKey,
  executeCleanup,
  extraSkuSet,
  planFavoriteCleanup,
  resolveExtraMappings,
  type CleanupCheckpoint,
  type CleanupPlan,
  type ExecuteDeps,
} from '../services/supplierFavoriteCleanupExecutor';
import { PORTAL_MAPPING_CONFIDENCE, PORTAL_MAPPING_SOURCE, type StoredPortalMapping } from '../services/supplierPortalMapping';
import type { ProductIdMapping } from '../services/supplierFavoriteProductId';
import type { SyncAccount } from '../services/supplierFavoriteSync';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}

const ON = { SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'true' } as Record<string, string | undefined>;
const OFF = {} as Record<string, string | undefined>;

const unique = (id: number, sku: string): ProductIdMapping => ({ product_id: id, verified_sku: sku, status: 'unique' });

/** A plan whose extra items are all uniquely mapped, for the execution tests. */
function planWith(pickupExtra: string[], dropshipExtra: string[]): { plan: CleanupPlan; mappings: Map<string, ProductIdMapping> } {
  const target = ['PUB-A', 'PUB-B'];
  const favorites = { pickup: [...target, ...pickupExtra], dropship: [...target, ...dropshipExtra] };
  const mappings = new Map<string, ProductIdMapping>();
  let id = 9000;
  for (const sku of new Set([...pickupExtra, ...dropshipExtra])) mappings.set(sku, unique(++id, sku));
  const plan = planFavoriteCleanup(target, favorites, (sku) => mappings.get(sku) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });
  return { plan, mappings };
}

function baseDeps(over: Partial<ExecuteDeps> = {}): ExecuteDeps {
  return {
    fetcherFor: () => async () => ({ status: 200, json: async () => ({ code: 200, data: { totalNum: 1 } }) }),
    readFavorites: async () => new Set<string>(),   // everything gone → verified
    sessionPresent: () => true,
    saveCheckpoint: () => {},
    pace: async () => {},
    now: () => '2026-08-06T00:00:00.000Z',
    env: ON,
    ...over,
  };
}

const opts = (over: Partial<{ execute: boolean; batchSize: number; maxConsecutiveFailures: number; runId: string }> = {}) =>
  ({ execute: true, batchSize: 50, maxConsecutiveFailures: 5, runId: 'run-1', perItemTimeoutMs: 90_000, verifyTimeoutMs: 90_000, ...over });

async function main(): Promise<void> {
  // ── 1–3: TARGET, extra, scope ──────────────────────────────────────────────

  it('1. published=true 永不进入 extra', () => {
    const plan = planFavoriteCleanup(['PUB-A', 'PUB-B'], { pickup: ['PUB-A', 'PUB-B'], dropship: ['PUB-A'] }, () => unique(1, 'x'));
    assert.equal(plan.removals.pickup.length, 0);
    assert.equal(plan.removals.dropship.length, 0);
    assert.equal(plan.extra_skus.length, 0);
  });

  it('2. published=false + 收藏存在 → extra', () => {
    const plan = planFavoriteCleanup(['PUB-A'], { pickup: ['PUB-A', 'OLD-X'], dropship: ['OLD-Y'] },
      (sku) => unique(100, sku));
    assert.deepEqual(plan.removals.pickup.map((i) => i.supplier_product_id), ['OLD-X']);
    assert.deepEqual(plan.removals.dropship.map((i) => i.supplier_product_id), ['OLD-Y']);
    assert.deepEqual(plan.extra_skus, ['OLD-X', 'OLD-Y']);
  });

  await itAsync('3. 只解析 extra 集合，不碰其他 SKU', async () => {
    const target = ['PUB-A', 'PUB-B', 'PUB-C'];
    const favorites = { pickup: ['PUB-A', 'OLD-X'], dropship: ['PUB-B', 'OLD-Y'] };
    const extra = extraSkuSet(target, favorites);
    assert.deepEqual(extra, ['OLD-X', 'OLD-Y']);

    const probed: string[] = [];
    await resolveExtraMappings(extra, {
      storedMappings: [],
      portalResolve: async (sku) => { probed.push(sku); return unique(1, sku); },
      now: '2026-08-06T00:00:00.000Z',
    });
    // TARGET 的 published 商品绝不会被送去解析。
    assert.deepEqual(probed.sort(), ['OLD-X', 'OLD-Y']);
    for (const pub of target) assert.equal(probed.includes(pub), false);
  });

  // ── 5–8: mapping resolution ────────────────────────────────────────────────

  await itAsync('5. 已有合法 mapping → 不重复 portal 解析', async () => {
    const stored: StoredPortalMapping[] = [{
      supplier_product_id: 'OLD-X', website_product_id: 667968, portal_sku: 'OLD-X',
      source: PORTAL_MAPPING_SOURCE, confidence: PORTAL_MAPPING_CONFIDENCE,
      resolved_at: '2026-08-01T00:00:00.000Z', last_verified_at: '2026-08-01T00:00:00.000Z',
    }];
    let probes = 0;
    const r = await resolveExtraMappings(['OLD-X'], {
      storedMappings: stored,
      portalResolve: async () => { probes += 1; return unique(1, 'OLD-X'); },
      now: '2026-08-06T00:00:00.000Z',
    });
    assert.equal(probes, 0, '有表内可用映射时不得再探门户');
    assert.equal(r.usable.get('OLD-X')?.product_id, 667968);
    assert.deepEqual(r.probed, []);
  });

  await itAsync('6. mapping 缺失 → 即时解析', async () => {
    const r = await resolveExtraMappings(['OLD-X'], {
      storedMappings: [],
      portalResolve: async (sku) => unique(555, sku),
      now: '2026-08-06T00:00:00.000Z',
    });
    assert.equal(r.usable.get('OLD-X')?.product_id, 555);
    assert.deepEqual(r.probed, ['OLD-X']);
  });

  await itAsync('7. multiple candidate → exception，继续其他', async () => {
    const r = await resolveExtraMappings(['MULTI', 'OK'], {
      storedMappings: [],
      portalResolve: async (sku) => sku === 'MULTI'
        ? { product_id: null, verified_sku: null, status: 'multiple_product_ids' }
        : unique(7, sku),
      now: '2026-08-06T00:00:00.000Z',
    });
    assert.deepEqual(r.exceptions.map((e) => e.supplier_product_id), ['MULTI']);
    assert.equal(r.usable.has('OK'), true);
  });

  await itAsync('8. product_id 反查不一致 → exception', async () => {
    const r = await resolveExtraMappings(['OLD-X'], {
      storedMappings: [],
      // 门户返回的候选反查得到别的 SKU：resolveExtraMappings 要求 verified_sku === sku。
      portalResolve: async () => ({ product_id: 888, verified_sku: 'DIFFERENT', status: 'unique' }),
      now: '2026-08-06T00:00:00.000Z',
    });
    assert.equal(r.usable.has('OLD-X'), false);
    assert.deepEqual(r.exceptions.map((e) => e.supplier_product_id), ['OLD-X']);
  });

  // ── 4, 9: single item, per-account session ─────────────────────────────────

  await itAsync('4 + 9. 单件发送，且 Pickup / Dropship 用各自的 fetcher，互不串号', async () => {
    const { plan, mappings } = planWith(['P-1'], ['D-1']);
    const sends: Array<{ account: string; body: unknown }> = [];
    const result = await executeCleanup(plan, mappings, baseDeps({
      fetcherFor: (account) => async (_url, init) => {
        sends.push({ account, body: JSON.parse(init.body) });
        return { status: 200, json: async () => ({ code: 200, data: { totalNum: 1 } }) };
      },
    }), opts());

    assert.equal(sends.length, 2);
    const pickupSend = sends.find((s) => s.account === 'pickup')!;
    const dropshipSend = sends.find((s) => s.account === 'dropship')!;
    // 每次只带一个 product_id（数字），不是数组。
    assert.equal(typeof (pickupSend.body as { product_ids: unknown }).product_ids, 'number');
    assert.notEqual((pickupSend.body as { product_ids: number }).product_ids, (dropshipSend.body as { product_ids: number }).product_ids);
    assert.equal(result.xhr_sends, 2);
  });

  // ── 10–11: verification ────────────────────────────────────────────────────

  await itAsync('10. code=200 但官方 Favorites 仍存在 → verification_failed', async () => {
    const { plan, mappings } = planWith(['P-1'], []);
    const result = await executeCleanup(plan, mappings, baseDeps({
      readFavorites: async () => new Set(['P-1']),   // 还在收藏里
    }), opts());
    const rec = result.items.find((r) => r.supplier_product_id === 'P-1')!;
    assert.equal(rec.status, 'verification_failed');
    assert.equal(result.verified_removed, 0);
  });

  await itAsync('11. 官方 Favorites 消失 → verified_removed', async () => {
    const { plan, mappings } = planWith(['P-1'], []);
    const result = await executeCleanup(plan, mappings, baseDeps({
      readFavorites: async () => new Set<string>(),
    }), opts());
    const rec = result.items.find((r) => r.supplier_product_id === 'P-1')!;
    assert.equal(rec.status, 'verified_removed');
    assert.equal(rec.verified_at, '2026-08-06T00:00:00.000Z');
    assert.equal(result.verified_removed, 1);
  });

  // ── 12: one failure doesn't block others ───────────────────────────────────

  await itAsync('12. 单 SKU 失败不阻塞其他 SKU', async () => {
    const { plan, mappings } = planWith(['P-1', 'P-2', 'P-3'], []);
    const result = await executeCleanup(plan, mappings, baseDeps({
      fetcherFor: () => async (_url, init) => {
        const id = JSON.parse(init.body).product_ids;
        // P-2 的 send 返回业务失败码，其余成功。
        const failId = mappings.get('P-2')!.product_id;
        return { status: 200, json: async () => (id === failId ? { code: 500 } : { code: 200, data: { totalNum: 1 } }) };
      },
    }), opts());
    assert.equal(result.send_failed, 1);
    assert.equal(result.verified_removed, 2);
    assert.equal(result.global_stop, null);
  });

  // ── 13: global stop ────────────────────────────────────────────────────────

  await itAsync('13. auth / captcha / rate-limit → 全局停止', async () => {
    for (const [code, reason] of [[401, 'auth_failed'], [429, 'rate_limited']] as const) {
      const { plan, mappings } = planWith(['P-1', 'P-2'], ['D-1']);
      const result = await executeCleanup(plan, mappings, baseDeps({
        fetcherFor: () => async () => ({ status: code, json: async () => ({ code }) }),
      }), opts());
      assert.equal(result.global_stop, reason, `code ${code} 应触发 ${reason}`);
      // 停止后不再继续后续 SKU / 账号。
      assert.ok(result.xhr_sends <= 1);
    }
    // CAPTCHA 走 error 文本分类。
    const { plan, mappings } = planWith(['P-1'], []);
    const captcha = await executeCleanup(plan, mappings, baseDeps({
      fetcherFor: () => async () => { throw new Error('CAPTCHA_REQUIRED'); },
    }), opts());
    assert.equal(captcha.global_stop, 'captcha_required');
  });

  // ── 14–15: checkpoint + resume ─────────────────────────────────────────────

  await itAsync('14 + 15. checkpoint 生效，续跑时已完成的 SKU 自动跳过', async () => {
    const { plan, mappings } = planWith(['P-1', 'P-2'], []);
    const saved: CleanupCheckpoint[] = [];
    const first = await executeCleanup(plan, mappings, baseDeps({
      saveCheckpoint: (cp) => saved.push(JSON.parse(JSON.stringify(cp))),
    }), opts());
    assert.equal(first.verified_removed, 2);
    const cp = saved[saved.length - 1];
    assert.equal(cp.items[checkpointKey('pickup', 'P-1')].status, 'verified_removed');

    // 续跑：喂回 checkpoint，已完成的 P-1/P-2 应被跳过，不再发送。
    let sends = 0;
    const resumed = await executeCleanup(plan, mappings, baseDeps({
      fetcherFor: () => async () => { sends += 1; return { status: 200, json: async () => ({ code: 200, data: { totalNum: 1 } }) }; },
    }), opts(), cp);
    assert.equal(sends, 0, '已 verified_removed 的 SKU 不得重复发送');
    assert.equal(resumed.skipped, 2);
    assert.equal(resumed.xhr_sends, 0);
  });

  // ── 16–17: the gate ────────────────────────────────────────────────────────

  await itAsync('16. 默认门禁关闭 → 0 个真实 XHR', async () => {
    const { plan, mappings } = planWith(['P-1', 'P-2'], ['D-1']);
    let sends = 0;
    const fetcherFor = () => async () => { sends += 1; return { status: 200, json: async () => ({ code: 200, data: { totalNum: 1 } }) }; };

    // env 关：即便 --execute 也不发。
    const envOff = await executeCleanup(plan, mappings, baseDeps({ env: OFF, fetcherFor }), opts({ execute: true }));
    assert.equal(envOff.dry_run, true);
    assert.equal(envOff.xhr_sends, 0);

    // --execute 关：即便 env 开也不发。
    const noFlag = await executeCleanup(plan, mappings, baseDeps({ env: ON, fetcherFor }), opts({ execute: false }));
    assert.equal(noFlag.dry_run, true);
    assert.equal(noFlag.xhr_sends, 0);

    assert.equal(sends, 0, 'fetcher 在任一门禁关闭时都不得被调用');
    // dry run 里每个 extra 记为 planned。
    assert.equal(envOff.planned, 3);
  });

  await itAsync('17. 只有 env=true 且 --execute 才发送', async () => {
    const { plan, mappings } = planWith(['P-1'], []);
    const result = await executeCleanup(plan, mappings, baseDeps({ env: ON }), opts({ execute: true }));
    assert.equal(result.dry_run, false);
    assert.equal(result.xhr_sends, 1);
  });

  // ── 18: chain isolation ────────────────────────────────────────────────────

  it('18. 收藏清理执行器无法写库存链', () => {
    for (const file of [
      'src/services/supplierFavoriteCleanupExecutor.ts',
      'scripts/syncSupplierFavoritesToPublished.ts',
    ]) {
      const src = fs.readFileSync(file, 'utf8');
      for (const mod of ['standardizedInventoryProjection', 'availabilityPersistence', 'openApiAvailability', 'inventoryStateMachine']) {
        assert.equal(new RegExp(`(import|require)[^\\n]*${mod}`).test(src), false, `${file} 不得 import ${mod}`);
      }
      for (const table of ['product_availability', 'inventory_workflow', 'standardized_products', 'sellable_products', 'inventory_cache']) {
        assert.equal(new RegExp(`from\\('${table}[^']*'\\)[\\s\\S]{0,120}?\\.(update|upsert|insert|delete)\\(`).test(src), false, `${file} 不得写 ${table}`);
      }
      for (const forbidden of ['relist', 'delist', 'scanPublishedAvailability']) {
        assert.equal(src.includes(forbidden), false, `${file} 不得引用 ${forbidden}`);
      }
      // 读 published 计算 TARGET 是允许的；禁止的是把 published 写进任何 update/upsert。
      assert.equal(/\.(update|upsert)\(\s*\{[^}]*\bpublished\b/.test(src), false, `${file} 不得写 published`);
    }
    // CLI 只允许写映射表（且仅在 EXECUTE 时）。
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    const writeTargets = [...cli.matchAll(/\.from\('([a-z_]+)'\)[\s\S]{0,160}?\.(upsert|insert|update|delete)\(/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(writeTargets)], ['supplier_portal_product_mappings'], 'CLI 只能写映射表');
  });

  console.log(`\n${passed} passed`);
}

void main();
