/**
 * Supplier wishlist removal protocol tests (pure; no network, no database, no browser).
 *
 * Regression for a real production failure: a removal returned HTTP 200 and was recorded as sent,
 * but the item was still favourited. Two defects combined —
 *   1. the request omitted `x-gmd-device-id`, which the site's own HTTP client injects, so the
 *      backend accepted the session and no-oped the mutation;
 *   2. success was judged with `body.code ?? response.status`, so a body with no business code at
 *      all fell back to the transport 200 and looked like success.
 *
 * Fixture is the exact item that failed: W640P483728 → product_id 1418000, Pickup only.
 *
 * Run: npx tsx src/__tests__/supplierWishlistProtocol.test.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { executeSyncOperation, type RemovalFetcher } from '../services/supplierFavoriteRemoval';
import {
  checkpointKey,
  executeCleanup,
  planFavoriteCleanup,
  resolveExtraMappings,
  resumableVerdict,
  countResumable,
  type ExecuteDeps,
} from '../services/supplierFavoriteCleanupExecutor';
import type { ProductIdMapping } from '../services/supplierFavoriteProductId';
import type { SyncAccount } from '../services/supplierFavoriteSync';

let passed = 0;
function it(name: string, fn: () => void): void { fn(); passed++; console.log(`  ✓ ${name}`); }
async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}

// ── The failing item, exactly as production saw it ───────────────────────────
const SKU = 'W640P483728';
const PRODUCT_ID = 1418000;
const ON = { SUPPLIER_FAVORITE_REMOVAL_ENABLED: 'true' } as Record<string, string | undefined>;

const request = {
  supplier_product_id: SKU,
  operation: 'remove' as const,
  product_id: PRODUCT_ID,
  verified_sku_for_product_id: SKU,
  session_present: true,
};

/** A fetcher returning one canned body, recording what headers it was given. */
function fetcherReturning(
  body: unknown,
  status = 200,
  sink?: { headers: Record<string, string>[]; urls: string[] },
): RemovalFetcher {
  return async (url, init) => {
    sink?.headers.push(init.headers);
    sink?.urls.push(url);
    return { status, json: async () => body };
  };
}

/** Session-shaped fixtures for the two accounts, each with its OWN device id. */
const SESSIONS: Record<SyncAccount, { cookies: Array<{ name: string; value: string }> }> = {
  pickup: { cookies: [{ name: 'PHPSESSID', value: 'p-sess' }, { name: 'gmd_device_id', value: 'DEV-PICKUP' }] },
  dropship: { cookies: [{ name: 'PHPSESSID', value: 'd-sess' }, { name: 'gmd_device_id', value: 'DEV-DROPSHIP' }] },
};

/** Mirrors the CLI's loadAccountSession: cookie header + device id from that account's own file. */
function loadAccountSession(account: SyncAccount): { cookieHeader: string; deviceId: string | null } {
  const cookies = SESSIONS[account].cookies;
  return {
    cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    deviceId: cookies.find((c) => c.name === 'gmd_device_id')?.value ?? null,
  };
}

async function main(): Promise<void> {
  // ── 1–3: the device-id header ──────────────────────────────────────────────

  it('1. 缺 x-gmd-device-id 的请求不被认为是合法的取消请求', () => {
    // 生产事故的形状：无 device 绑定时后端返回 200 但响应体里没有业务 code。
    // 源码层面：CLI 必须显式注入该头，否则这次修复形同虚设。
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    assert.ok(cli.includes("headers['x-gmd-device-id'] = session.deviceId"), 'CLI 必须注入 x-gmd-device-id');
    assert.ok(cli.includes("'ori-status-in-response': 'code'"), '必须要求业务 code 出现在响应中');
    assert.ok(cli.includes("'content-type': 'application/json;charset=UTF-8'"), 'content-type 必须带 charset');
    // 绝不硬编码 device id —— 必须从 cookie 提取。
    assert.ok(cli.includes("c.name === 'gmd_device_id'"), 'device id 必须来自 gmd_device_id cookie');
    assert.equal(/x-gmd-device-id['"]\s*\]\s*=\s*['"][A-Za-z0-9-]{6,}/.test(cli), false, '不得硬编码 device id');
  });

  it('2. device id 从各账号自己的 session cookie 正确提取', () => {
    assert.equal(loadAccountSession('pickup').deviceId, 'DEV-PICKUP');
    assert.equal(loadAccountSession('dropship').deviceId, 'DEV-DROPSHIP');
    assert.ok(loadAccountSession('pickup').cookieHeader.includes('gmd_device_id=DEV-PICKUP'));
    // 无 device cookie 时是 null，不是抛错，也不是编一个。
    const bare = [{ name: 'PHPSESSID', value: 'x' }];
    assert.equal(bare.find((c) => c.name === 'gmd_device_id')?.value ?? null, null);
  });

  it('3. Pickup / Dropship 的 device id 不串号', () => {
    const p = loadAccountSession('pickup');
    const d = loadAccountSession('dropship');
    assert.notEqual(p.deviceId, d.deviceId);
    assert.equal(p.cookieHeader.includes('DEV-DROPSHIP'), false);
    assert.equal(d.cookieHeader.includes('DEV-PICKUP'), false);
    // CLI 的 session 文件也必须按账号分开。
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    assert.ok(cli.includes('giga-session-pickup.json') && cli.includes('giga-session-dropship.json'));
  });

  // ── 4–6: success judgement ─────────────────────────────────────────────────

  await itAsync('4. HTTP 200 但响应体没有 body.code → send_failed（正是本次事故）', async () => {
    // 这是真实发生的响应形状：HTTP 200，但不是一个 wishlist 成功体。
    for (const body of [null, {}, { msg: 'ok' }, { data: { totalNum: 692 } }]) {
      const r = await executeSyncOperation(request, fetcherReturning(body), ON);
      assert.equal(r.attempted, true);
      assert.equal(r.succeeded, false, `${JSON.stringify(body)} 不得判为成功`);
    }
    // 错误信息要指向真正的原因，而不是笼统失败。
    const r = await executeSyncOperation(request, fetcherReturning({}), ON);
    assert.match(r.error ?? '', /no business code/);
    assert.equal(r.response_code, null, '不得把 HTTP 200 回退成业务 code');
  });

  await itAsync('5. body.code=200 但缺 data.totalNum → send_failed', async () => {
    for (const body of [{ code: 200 }, { code: 200, data: {} }, { code: 200, data: { totalNum: 'x' } }]) {
      const r = await executeSyncOperation(request, fetcherReturning(body), ON);
      assert.equal(r.succeeded, false, `${JSON.stringify(body)} 不得判为成功`);
    }
    const r = await executeSyncOperation(request, fetcherReturning({ code: 200, data: {} }), ON);
    assert.match(r.error ?? '', /no data\.totalNum/);
  });

  await itAsync('6. body.code=200 + data.totalNum → 仅表示发送成功', async () => {
    const r = await executeSyncOperation(request, fetcherReturning({ code: 200, data: { totalNum: 692 } }), ON);
    assert.equal(r.succeeded, true);
    assert.equal(r.response_code, 200);
    assert.equal(r.error, null);
    // 业务码非 200 仍然失败，即便 HTTP 是 200。
    const denied = await executeSyncOperation(request, fetcherReturning({ code: 401, data: { totalNum: 693 } }), ON);
    assert.equal(denied.succeeded, false);
    assert.match(denied.error ?? '', /code 401/);
    // HTTP 非 2xx 也失败。
    const http500 = await executeSyncOperation(request, fetcherReturning({ code: 200, data: { totalNum: 692 } }, 500), ON);
    assert.equal(http500.succeeded, false);
    assert.match(http500.error ?? '', /http 500/);
  });

  // ── 7–8: verification is still the final word ──────────────────────────────

  const singlePlan = () => {
    const mappings = new Map<string, ProductIdMapping>([[SKU, { product_id: PRODUCT_ID, verified_sku: SKU, status: 'unique' }]]);
    const plan = planFavoriteCleanup(['PUB-A'], { pickup: ['PUB-A', SKU], dropship: [] },
      (s) => mappings.get(s) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });
    return { plan, mappings };
  };

  const deps = (over: Partial<ExecuteDeps> = {}): ExecuteDeps => ({
    fetcherFor: () => fetcherReturning({ code: 200, data: { totalNum: 692 } }),
    readFavorites: async () => new Set<string>(),
    sessionPresent: () => true,
    saveCheckpoint: () => {},
    pace: async () => {},
    now: () => '2026-08-07T00:00:00.000Z',
    env: ON,
    ...over,
  });
  const opts = { execute: true, batchSize: 50, maxConsecutiveFailures: 5, runId: 'run-proto', perItemTimeoutMs: 90_000, verifyTimeoutMs: 90_000 };

  await itAsync('7. 业务成功但 Favorites API 仍存在 → verification_failed', async () => {
    const { plan, mappings } = singlePlan();
    const result = await executeCleanup(plan, mappings, deps({
      readFavorites: async () => new Set([SKU]),   // 仍在收藏里 —— 正是本次事故的回读结果
    }), opts);
    const rec = result.items.find((r) => r.supplier_product_id === SKU)!;
    assert.equal(rec.status, 'verification_failed');
    assert.equal(result.verified_removed, 0);
  });

  await itAsync('8. Favorites API 中消失 → verified_removed', async () => {
    const { plan, mappings } = singlePlan();
    const result = await executeCleanup(plan, mappings, deps(), opts);
    const rec = result.items.find((r) => r.supplier_product_id === SKU)!;
    assert.equal(rec.status, 'verified_removed');
    assert.equal(result.verified_removed, 1);
  });

  // ── 9–10: single-item targeting ────────────────────────────────────────────

  await itAsync('9 + 10. 单件模式只处理 W640P483728，且 Dropship fetcher 调用 0 次', async () => {
    // 模拟 CLI 的单件收窄：只留目标账号的目标 SKU，另一账号清空。
    const mappings = new Map<string, ProductIdMapping>([
      [SKU, { product_id: PRODUCT_ID, verified_sku: SKU, status: 'unique' }],
      ['OTHER-1', { product_id: 999, verified_sku: 'OTHER-1', status: 'unique' }],
    ]);
    const plan = planFavoriteCleanup(['PUB-A'], { pickup: [SKU], dropship: [] },
      (s) => mappings.get(s) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });

    const calls: Record<string, number> = { pickup: 0, dropship: 0 };
    const sentSkus: number[] = [];
    const result = await executeCleanup(plan, mappings, deps({
      fetcherFor: (account) => async (_url, init) => {
        calls[account] += 1;
        sentSkus.push(JSON.parse(init.body).product_ids);
        return { status: 200, json: async () => ({ code: 200, data: { totalNum: 692 } }) };
      },
    }), opts);

    assert.equal(calls.pickup, 1, '只应对 Pickup 发一次');
    assert.equal(calls.dropship, 0, 'Dropship fetcher 一次都不得被调用');
    assert.deepEqual(sentSkus, [PRODUCT_ID], '只发送目标 product_id，绝无第二件');
    assert.equal(result.items.filter((r) => r.supplier_product_id !== SKU).length, 0, '不得触及其他 SKU');

    // CLI 层面：--sku 必须配 --account，且会把另一账号清空。
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    assert.ok(cli.includes('--sku 必须配合 --account 使用'));
    assert.ok(cli.includes('favorites[other] = []'), '单件模式必须清空另一账号');
    assert.ok(cli.includes('不属于 extra'), '单件模式仍须校验目标属于 extra');
  });

  // ── 11–12: the gates still hold ────────────────────────────────────────────

  await itAsync('11 + 12. 默认 dry-run 时 wishlist POST=0；仅 env=true + execute 才发送', async () => {
    const { plan, mappings } = singlePlan();
    let sends = 0;
    const counting = () => async () => { sends += 1; return { status: 200, json: async () => ({ code: 200, data: { totalNum: 692 } }) }; };

    // env 关 / --execute 关，两种都不得发送。
    const envOff = await executeCleanup(plan, mappings, deps({ env: {}, fetcherFor: counting }), opts);
    assert.equal(envOff.dry_run, true);
    assert.equal(envOff.xhr_sends, 0);
    const noFlag = await executeCleanup(plan, mappings, deps({ fetcherFor: counting }), { ...opts, execute: false });
    assert.equal(noFlag.dry_run, true);
    assert.equal(noFlag.xhr_sends, 0);
    assert.equal(sends, 0, 'dry-run 下 fetcher 不得被调用');

    // 双门禁齐开才真正发送。
    const live = await executeCleanup(plan, mappings, deps({ fetcherFor: counting }), opts);
    assert.equal(live.dry_run, false);
    assert.equal(live.xhr_sends, 1);
    assert.equal(sends, 1);
  });


  // ── 卡死防护 ───────────────────────────────────────────────────────────────

  await itAsync('13. 单件超时 → 记为 timeout 并继续下一件，不阻塞整批', async () => {
    const mappings = new Map<string, ProductIdMapping>([
      ['HANG-1', { product_id: 111, verified_sku: 'HANG-1', status: 'unique' }],
      ['OK-1', { product_id: 222, verified_sku: 'OK-1', status: 'unique' }],
    ]);
    const plan = planFavoriteCleanup(['PUB-A'], { pickup: ['PUB-A', 'HANG-1', 'OK-1'], dropship: [] },
      (s) => mappings.get(s) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });

    const progress: string[] = [];
    const result = await executeCleanup(plan, mappings, deps({
      // HANG-1 永远不 resolve —— 正是上一批卡死的形状。
      fetcherFor: () => async (_url, init) => {
        const id = JSON.parse(init.body).product_ids;
        if (id === 111) return new Promise(() => {}) as never;
        return { status: 200, json: async () => ({ code: 200, data: { totalNum: 1 } }) };
      },
      onProgress: (l) => progress.push(l),
    }), { ...opts, perItemTimeoutMs: 120, verifyTimeoutMs: 500 });

    const hang = result.items.find((r) => r.supplier_product_id === 'HANG-1')!;
    assert.equal(hang.status, 'timeout', '卡住的件必须记为 timeout');
    assert.match(hang.last_error ?? '', /per-item timeout/);
    // 关键：卡住一件之后，后面的件仍然被处理。
    const ok = result.items.find((r) => r.supplier_product_id === 'OK-1')!;
    assert.equal(ok.status, 'verified_removed', '超时不得阻塞后续 SKU');
    assert.equal(result.timeout, 1);
    assert.ok(progress.some((l) => l.includes('HANG-1') && l.includes('timeout')));
    assert.ok(progress.some((l) => l.includes('resolving...')), '必须有实时进度输出');
  });

  await itAsync('14. 回读超时不会挂起整批，已发送项保持待验证', async () => {
    const { plan, mappings } = singlePlan();
    const result = await executeCleanup(plan, mappings, deps({
      readFavorites: () => new Promise(() => {}) as never,   // 回读永不返回
    }), { ...opts, perItemTimeoutMs: 2000, verifyTimeoutMs: 120 });
    // 没有卡死：函数返回了，且该件保持 verification_failed（未被误判为已删除）。
    const rec = result.items.find((r) => r.supplier_product_id === SKU)!;
    assert.equal(rec.status, 'verification_failed');
    assert.equal(result.verified_removed, 0);
  });

  await itAsync('15. resume 时 B091119898 不再发送第二次取消请求', async () => {
    // 真实 checkpoint 形状：该件已在上一轮 verified_removed。
    const sku = 'B091119898';
    const mappings = new Map<string, ProductIdMapping>([[sku, { product_id: 581026, verified_sku: sku, status: 'unique' }]]);
    const plan = planFavoriteCleanup(['PUB-A'], { pickup: [], dropship: ['PUB-A', sku] },
      (s) => mappings.get(s) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });

    const checkpoint = {
      run_id: 'prior',
      items: {
        [checkpointKey('dropship', sku)]: {
          account: 'dropship' as const, supplier_product_id: sku, product_id: 581026,
          status: 'verified_removed' as const, attempts: 1, last_error: null,
          verified_at: '2026-08-07T06:05:00.000Z',
        },
      },
    };

    let sends = 0;
    const result = await executeCleanup(plan, mappings, deps({
      fetcherFor: () => async () => { sends += 1; return { status: 200, json: async () => ({ code: 200, data: { totalNum: 1 } }) }; },
    }), opts, checkpoint);

    assert.equal(sends, 0, 'B091119898 已 verified_removed，绝不得再次发送取消请求');
    assert.equal(result.xhr_sends, 0);
    const rec = result.items.find((r) => r.supplier_product_id === sku)!;
    assert.equal(rec.status, 'skipped_checkpoint');
    assert.equal(result.skipped, 1);
  });

  await itAsync('16. 每件结束立即写 checkpoint', async () => {
    const mappings = new Map<string, ProductIdMapping>([
      ['A-1', { product_id: 1, verified_sku: 'A-1', status: 'unique' }],
      ['A-2', { product_id: 2, verified_sku: 'A-2', status: 'unique' }],
    ]);
    const plan = planFavoriteCleanup(['PUB-A'], { pickup: ['PUB-A', 'A-1', 'A-2'], dropship: [] },
      (s) => mappings.get(s) ?? { product_id: null, verified_sku: null, status: 'not_mapped' });
    let saves = 0;
    await executeCleanup(plan, mappings, deps({ saveCheckpoint: () => { saves += 1; } }), opts);
    // 2 件 + 批末回读 + 批末保存 → 明显多于一次（旧实现只在批末存一次）。
    assert.ok(saves >= 3, `checkpoint 应逐件写入，实际 ${saves} 次`);
  });


  await itAsync('17. 单个 portal 探测卡住 → 记为 exception 并继续解析后续 SKU', async () => {
    const progress: string[] = [];
    const resolved = await resolveExtraMappings(['STALL-1', 'GOOD-1'], {
      storedMappings: [],
      portalResolve: async (sku) => {
        if (sku === 'STALL-1') return new Promise(() => {}) as never;   // 永不返回
        return { product_id: 777, verified_sku: 'GOOD-1', status: 'unique' };
      },
      now: '2026-08-07T00:00:00.000Z',
      onProgress: (l) => progress.push(l),
      perSkuTimeoutMs: 120,
    });
    // 卡住的那个没有拖垮整轮解析。
    assert.equal(resolved.usable.get('GOOD-1')?.product_id, 777, '卡住的探测不得阻塞后续 SKU');
    assert.deepEqual(resolved.exceptions, [{ supplier_product_id: 'STALL-1', reason: 'timeout' }]);
    assert.ok(progress.some((l) => l.includes('STALL-1') && l.includes('timeout')));
    assert.ok(progress.some((l) => l.includes('resolve 1/2')), '解析阶段必须有实时进度');
  });

  await itAsync('18. 解析阶段的 auth/CAPTCHA 仍然中止全局，不被 watchdog 吞掉', async () => {
    await assert.rejects(
      resolveExtraMappings(['X-1'], {
        storedMappings: [],
        portalResolve: async () => { throw new Error('AUTH_FAILED: session expired'); },
        now: '2026-08-07T00:00:00.000Z',
        perSkuTimeoutMs: 5000,
      }),
      /AUTH_FAILED/,
    );
  });


  it('19. 异常明细不得泄露任何会话信息', () => {
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    const mapBlock = cli.slice(cli.indexOf('const exceptions = exceptionRecords'), cli.indexOf('const envelope = {'));
    // 明细只由这五个字段构成 —— 原始 last_error 绝不进信封。
    for (const field of ['account:', 'sku:', 'reason:', 'product_id:', 'status:']) {
      assert.ok(mapBlock.includes(field), `异常明细必须含 ${field}`);
    }
    assert.equal(/last_error\s*:/.test(mapBlock), false, '不得把原始 last_error 放进信封');
    for (const secret of ['cookie', 'token', 'device', 'session', 'PHPSESSID']) {
      assert.equal(mapBlock.toLowerCase().includes(secret.toLowerCase()), false, `异常明细不得出现 ${secret}`);
    }
    // 有上限，避免一次吐出上千行。
    assert.ok(cli.includes('MAX_EXCEPTION_ROWS'), '异常明细必须有条数上限');
    assert.ok(cli.includes('exceptions_total') && cli.includes('exceptions_truncated'), '截断时必须如实声明');
  });

  it('20. reason 归一到固定枚举，不回传任意错误串', () => {
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    const fn = cli.slice(cli.indexOf('function normalizeReason'), cli.indexOf('async function main'));
    for (const reason of ['not_mapped', 'multiple_product_ids', 'timeout', 'verification_failed', 'send_failed']) {
      assert.ok(fn.includes(`'${reason}'`), `reason 必须支持 ${reason}`);
    }
    // 兜底分支必须回到固定值，而不是把 raw 直接返回。
    assert.ok(/return 'not_mapped';\s*\n\}/.test(fn), 'reason 必须有固定兜底值');
    assert.equal(/return raw/.test(fn), false, '不得直接返回原始错误串');
  });


  it('21. 事实刷新读取 existing 必须分页，否则 1000 行以外的收藏永远刷不掉', () => {
    const facts = fs.readFileSync('scripts/syncSupplierFavoriteFacts.ts', 'utf8');
    const block = facts.slice(facts.indexOf('const existingRows'), facts.indexOf('const rows = buildFactRows'));
    // PostgREST 默认一次最多 1000 行；Dropship 有 1497 行事实，不分页时后面的行对 diff 不可见。
    assert.ok(/\.range\(/.test(block), 'existing 读取必须分页');
    assert.ok(/for \(let from = 0/.test(block), '必须循环取完所有页');
    assert.ok(/page\.length < 1000/.test(block), '必须以「不足一页」作为终止条件');
  });

  it('22. resumable 反映执行之后的状态，不是执行之前的 checkpoint', () => {
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    const after = cli.slice(cli.indexOf('const currentFavorites'), cli.indexOf('const envelope = {'));
    // 必须从本轮的最终条目状态算，而不是 priorCheckpoint。
    assert.ok(after.includes('countResumable(result.items'), 'resumable 必须由本轮最终条目算出');
    assert.equal(/priorCheckpoint/.test(after), false, '不得用执行前的 checkpoint 判定待续跑');
    // 信封必须用 after 版本。
    const envelope = cli.slice(cli.indexOf('const envelope = {'));
    assert.ok(envelope.includes('resumable: resumableAfterRun > 0'));
    assert.ok(envelope.includes('resumable_count: resumableAfterRun'));
    // 可重试状态的白名单集中在 executor 里，CLI 不再各写一份。
    const exec = fs.readFileSync('src/services/supplierFavoriteCleanupExecutor.ts', 'utf8');
    const list = exec.slice(exec.indexOf('const RETRYABLE_STATUSES'), exec.indexOf('export function resumableVerdict'));
    for (const status of ['send_failed', 'verification_failed', 'timeout', 'global_stop']) {
      assert.ok(list.includes(`'${status}'`), `${status} 应计入待续跑`);
    }
    for (const status of ['verified_removed', 'skipped_checkpoint', 'exception']) {
      assert.equal(list.includes(`'${status}'`), false, `${status} 不得计入待续跑`);
    }
  });

  it('23. 续跑判定必须核对当前收藏，而不是只看 checkpoint 状态', () => {
    const target = new Set(['PUB-A']);
    const favorites = {
      pickup: new Set(['STILL-P', 'PUB-A']),
      dropship: new Set(['STILL-D']),
    } as Record<'pickup' | 'dropship', ReadonlySet<string>>;
    const v = (account: 'pickup' | 'dropship', sku: string, status: any) =>
      resumableVerdict({ account, supplier_product_id: sku, status }, favorites, target);

    // 1. send_failed + 仍在收藏 + 非 TARGET → 待续跑
    assert.equal(v('pickup', 'STILL-P', 'send_failed'), 'resumable');
    // 2. send_failed + 已不在收藏 → 目标已达成
    assert.equal(v('pickup', 'GONE-P', 'send_failed'), 'no_longer_favourited');
    // 3. verification_failed + 仍在收藏 → 待续跑
    assert.equal(v('dropship', 'STILL-D', 'verification_failed'), 'resumable');
    // 4. timeout + 已不在收藏 → 不待续跑
    assert.equal(v('dropship', 'GONE-D', 'timeout'), 'no_longer_favourited');
    // 5. verified_removed 永远不待续跑
    assert.equal(v('pickup', 'STILL-P', 'verified_removed'), 'not_retryable');
    // 6. 身份异常要人工处理，重跑解决不了
    assert.equal(v('pickup', 'STILL-P', 'exception'), 'not_retryable');
    assert.equal(v('pickup', 'STILL-P', 'skipped_checkpoint'), 'not_retryable');
    // 7. 已进入 TARGET 的商品绝不清理，即便还在收藏里
    assert.equal(v('pickup', 'PUB-A', 'send_failed'), 'now_published');
    // global_stop 属于可重试
    assert.equal(v('dropship', 'STILL-D', 'global_stop'), 'resumable');
    // 账号不串：pickup 的收藏不能替 dropship 作证
    assert.equal(v('dropship', 'STILL-P', 'send_failed'), 'no_longer_favourited');
  });

  it('24. 生产现况：B091119898 / W640P483728 都不再算待续跑，count = 0', () => {
    // 当前真实事实：两者都已不在各自账号的 Favorites 里（本轮只读验收确认过）。
    const target = new Set<string>();
    const favorites = {
      pickup: new Set<string>(),      // W640P483728 已不在
      dropship: new Set<string>(),    // B091119898 已不在
    } as Record<'pickup' | 'dropship', ReadonlySet<string>>;
    const items = [
      { account: 'dropship' as const, supplier_product_id: 'B091119898', status: 'send_failed' as const },
      { account: 'pickup' as const, supplier_product_id: 'W640P483728', status: 'send_failed' as const },
      // 38 条身份异常同样不算待续跑。
      ...Array.from({ length: 38 }, (_, i) => ({
        account: 'dropship' as const, supplier_product_id: `EXC-${i}`, status: 'exception' as const,
      })),
      // 1796 条已验证取消同样不算。
      ...Array.from({ length: 5 }, (_, i) => ({
        account: 'dropship' as const, supplier_product_id: `OK-${i}`, status: 'verified_removed' as const,
      })),
    ];
    assert.equal(resumableVerdict(items[0], favorites, target), 'no_longer_favourited');
    assert.equal(resumableVerdict(items[1], favorites, target), 'no_longer_favourited');
    assert.equal(countResumable(items, favorites, target), 0, '当前生产事实下待续跑必须为 0');
  });

  it('25. 异常与待续跑是两件事，不得混为一谈', () => {
    const target = new Set<string>();
    const favorites = {
      pickup: new Set(['E1', 'E2']),
      dropship: new Set(['E3']),
    } as Record<'pickup' | 'dropship', ReadonlySet<string>>;
    // 全是异常，且都还在收藏里 —— 依然不算待续跑。
    const items = [
      { account: 'pickup' as const, supplier_product_id: 'E1', status: 'exception' as const },
      { account: 'pickup' as const, supplier_product_id: 'E2', status: 'exception' as const },
      { account: 'dropship' as const, supplier_product_id: 'E3', status: 'exception' as const },
    ];
    assert.equal(countResumable(items, favorites, target), 0);
  });

  it('26. CLI 用实时回读而不是执行前快照来判定续跑', () => {
    const cli = fs.readFileSync('scripts/syncSupplierFavoritesToPublished.ts', 'utf8');
    const block = cli.slice(cli.indexOf('const currentFavorites'), cli.indexOf('const envelope = {'));
    assert.ok(block.includes('readFavorites('), '必须重新实时回读当前收藏');
    assert.ok(block.includes('countResumable('), '必须走统一的续跑判定');
    // 回读失败时保守：宁可留在待续跑，也不要谎称已达成。
    assert.ok(block.includes('catch'), '回读失败必须有兜底');
    assert.ok(/resumable: resumableAfterRun > 0/.test(cli));
  });

  it('成功判定不再有 HTTP 状态回退', () => {
    const src = fs.readFileSync('src/services/supplierFavoriteRemoval.ts', 'utf8');
    assert.equal(src.includes('?? response.status'), false, '不得再把 HTTP 状态当业务码回退');
    assert.ok(src.includes('data.totalNum'), '成功判定必须要求 data.totalNum');
  });

  console.log(`\n${passed} passed`);
}

void main();
