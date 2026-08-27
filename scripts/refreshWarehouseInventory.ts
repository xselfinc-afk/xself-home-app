/**
 * refreshWarehouseInventory.ts — 全量仓库库存刷新（Stage 2）。
 *
 * 官方 Open API `inventory/quantity/v2` → `inventory_cache`。没有浏览器、没有 scrape、
 * 没有 session：只有 HMAC 签名的服务端调用。
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────────
 * 在此之前，inventory_cache 里唯一还在更新的行来自 verify-inventory-live —— 也就是
 * 顾客自己走到结账那一步时的按需自愈。实测 1629 行里只有 67 行新于 24 小时，
 * 年龄中位数 663 小时。日常的每日 scraper 早已被 CAPTCHA 挡住，每轮写 0 行。
 *
 * ── 三条与既有脚本不同的硬约定 ──────────────────────────────────────────────
 *
 * 1. **只对本轮真正刷新过的 SKU 调用 refresh_product_inventory_status()，且必须紧接写入。**
 *    那个函数用它自己的 24 小时规则判 stale，并且直接写 `published`
 *    （supabase/inventory_source_of_truth.sql:134-148）。这是它危险也是它有用的地方：
 *
 *      - 对刚写完的 SKU 调用，行龄是 0 秒，它读到的就是供应商此刻的真实数量，
 *        0 件 → out_of_stock → published=false → 退出 sellable_products。
 *        这正是「CA 库存为 0 自动下架」缺失的那一环。
 *      - 对**没刷新到**的 SKU 调用，它只会按 24 小时线把陈旧数据判成 stale 并下架，
 *        那是拿「我们没查到」当「供应商说没有」。所以绝不对它们调用。
 *
 *    换句话说：调用范围严格等于本轮 answered 的集合，一个不多。有测试守着。
 *
 * 2. **0 库存照写。** 见 gigaQuantityToCacheRows 的说明：不写 0 会让缺货商品
 *    同时保持「有货」和「新鲜」。
 *
 * 3. **健康指标是本轮自己的。** rows_written / coverage / failure 都只统计这一次
 *    运行，绝不看全表 max(last_synced_at) —— 旧 scraper 的假绿就是那么来的：
 *    它写了 0 行，却因为某个顾客几小时前结过账而报 PASS。
 *
 * 用法：
 *   npx tsx scripts/refreshWarehouseInventory.ts              # dry-run，不写任何东西
 *   npx tsx scripts/refreshWarehouseInventory.ts --apply      # 真写
 *   npx tsx scripts/refreshWarehouseInventory.ts --limit=50   # 限制 SKU 数（排查用）
 *
 * 退出码：0 ok · 1 fatal · 2 覆盖率不达标 · 3 失败率超限
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  quantityRecordsToCacheRows,
  zeroOutVanishedWarehouses,
  type GigaQuantityRecord,
  type InventoryCacheRow,
} from '../src/services/gigaQuantityToCacheRows';

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => argv.find((a) => a.startsWith(`--${f}=`))?.split('=')[1];

const APPLY = has('--apply');
const LIMIT = Math.max(0, parseInt(val('limit') ?? '0', 10) || 0);
const RUN_ID = `whrefresh_${Date.now().toString(36)}`;

const GIGA_BASE = (process.env.SUPPLIER_API_BASE_URL ?? '').trim();
const GIGA_CID = (process.env.SUPPLIER_CLIENT_ID ?? '').trim();
const GIGA_SEC = (process.env.SUPPLIER_CLIENT_SECRET ?? '').trim();
const SUPA_URL = (process.env.SUPABASE_URL ?? '').trim();
const SUPA_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

const ENDPOINT = '/b2b-overseas-api/v1/buyer/inventory/quantity/v2';
/** quantity/v2 每次接受 200 个 SKU —— 与 runGigaAutoPublish / seedPilotInventory 一致。 */
const SKU_BATCH = 200;
/** PostgREST 单次 upsert 的行数，与 seedPilotInventory 一致。 */
const ROW_BATCH = 500;

/** 与既有 inventory_automation 配置同名同值，避免两套阈值各说各话。 */
const MIN_COVERAGE_PERCENT = Number(process.env.INVENTORY_MIN_COVERAGE_PERCENT ?? 95);
const MAX_FAILURE_PERCENT = Number(process.env.INVENTORY_MAX_FAILURE_PERCENT ?? 20);
/**
 * 一轮最多允许多少比例的在架商品被判成缺货。
 *
 * 供应商接口如果某次抽风、给整批返回 0，上面的失败率闸门是拦不住的 —— 那些响应
 * 在协议上完全成功。这道闸门看的是**后果**：要下架的比例异常高就整轮中止，
 * 宁可让库存旧一天，也不要一次性清空店面。默认 10%，按当前 385 件约 38 件。
 */
const MAX_DELIST_PERCENT = Number(process.env.WAREHOUSE_MAX_DELIST_PERCENT ?? 10);

if (!GIGA_BASE || !GIGA_CID || !GIGA_SEC) {
  console.error('[warehouse-refresh] FATAL 缺少 GIGA 凭据（需要 .env.giga-alt.local）');
  process.exit(1);
}
if (!/openapi\.gigab2b\.com/.test(GIGA_BASE)) {
  console.error(`[warehouse-refresh] FATAL 期望 openapi.gigab2b.com，实际 ${GIGA_BASE}`);
  process.exit(1);
}
if (!SUPA_URL || !SUPA_KEY) {
  console.error('[warehouse-refresh] FATAL 缺少 Supabase 凭据（需要 .env.local）');
  process.exit(1);
}

const SB = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, 'Content-Type': 'application/json' };

function nonce(n = 10): string {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}
function sign(apiPath: string, ts: string, nc: string): string {
  const msg = `${GIGA_CID}&${apiPath}&${ts}&${nc}`;
  const key = `${GIGA_CID}&${GIGA_SEC}&${nc}`;
  return Buffer.from(crypto.createHmac('sha256', key).update(msg).digest('hex'), 'utf8').toString('base64');
}

/**
 * 一批 SKU 的 quantity/v2 调用。失败只影响这一批，不放弃整轮。
 *
 * `records` 为 null 表示这一批没拿到答案 —— 与「拿到了、里面是 0」是两回事，
 * 后者才是缺货。这个区分是整个脚本最不能含糊的地方，所以用 null 而不是空数组。
 */
async function fetchQuantities(
  skus: string[],
): Promise<{ records: GigaQuantityRecord[] | null; reason: string | null }> {
  const ts = Date.now().toString();
  const nc = nonce();
  try {
    const res = await fetch(`${GIGA_BASE}${ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-id': GIGA_CID,
        timestamp: ts,
        nonce: nc,
        sign: sign(ENDPOINT, ts, nc),
      },
      body: JSON.stringify({ skus }),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: GigaQuantityRecord[] } | null;
    if (res.status !== 200 || json?.success !== true) {
      return { records: null, reason: `giga_http_${res.status}` };
    }
    return { records: Array.isArray(json.data) ? json.data : [], reason: null };
  } catch (e) {
    return { records: null, reason: e instanceof Error ? e.message : 'network_error' };
  }
}

async function sbGet<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`${SUPA_URL}/rest/v1/${pathAndQuery}`, { headers: SB });
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`PostgREST 非数组响应: ${JSON.stringify(body).slice(0, 200)}`);
  return body as T;
}

/** 拉全部分页，PostgREST 单页上限 1000。 */
async function sbGetAll<T>(base: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await sbGet<T[]>(`${base}&limit=1000&offset=${off}`);
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

async function upsertRows(rows: InventoryCacheRow[]): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${SUPA_URL}/rest/v1/inventory_cache?on_conflict=product_id,warehouse_code`, {
    method: 'POST',
    headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  return { ok: res.status < 300, detail: `${res.status} ${(await res.text()).slice(0, 200)}` };
}

/**
 * 让数据库按刚写入的数量重算这个商品的库存状态与发布状态。
 *
 * 判定全在 refresh_product_inventory_status() 里：它按 website_scrape 行求和，
 * 0 件 → out_of_stock → published=false，商品随即退出 sellable_products。
 * 这里不复制那套规则，只负责在正确的时机、对正确的 SKU 调用它。
 */
async function refreshStatus(sku: string): Promise<boolean> {
  const res = await fetch(`${SUPA_URL}/rest/v1/rpc/refresh_product_inventory_status`, {
    method: 'POST',
    headers: SB,
    body: JSON.stringify({ p_supplier_product_id: sku }),
  });
  return res.status < 300;
}

async function main(): Promise<void> {
  const started = new Date();
  console.log(`WAREHOUSE_REFRESH run=${RUN_ID} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // ── 目标集：checkout 真正可能撞上的商品 = published ────────────────────────
  const published = await sbGetAll<{ supplier_product_id: string }>(
    'standardized_products?select=supplier_product_id&published=is.true',
  );
  let targets = published.map((r) => r.supplier_product_id).filter(Boolean);
  const publishedSet = new Set(targets);
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);
  console.log(`  目标 SKU: ${targets.length}${LIMIT ? ` (--limit=${LIMIT})` : ''}`);
  if (targets.length === 0) {
    console.error('[warehouse-refresh] FATAL 没有 published 商品 —— 拒绝把这当成成功');
    process.exit(1);
  }

  // ── 取数：按 200 一批，串行。两个请求的量级不需要并发。 ────────────────────
  const records: GigaQuantityRecord[] = [];
  const failedSkus: string[] = [];
  let batches = 0;
  let failedBatches = 0;
  for (let i = 0; i < targets.length; i += SKU_BATCH) {
    const batch = targets.slice(i, i + SKU_BATCH);
    batches++;
    const out = await fetchQuantities(batch);
    if (out.records === null) {
      failedBatches++;
      failedSkus.push(...batch);
      console.warn(`  batch ${batch.length} → 失败 ${out.reason}`);
      continue;
    }
    records.push(...out.records);
    console.log(`  batch ${batch.length} → ${out.records.length} 条记录`);
  }

  const answered = new Set(records.map((r) => r.sku));
  // 供应商没返回的 SKU 既不算成功也不能当 0：本轮就是没查到它。
  const missing = targets.filter((s) => !answered.has(s) && !failedSkus.includes(s));

  const now = new Date().toISOString();
  const fresh = quantityRecordsToCacheRows(records, { now, sourceNote: 'warehouse_refresh', runId: RUN_ID });

  // ── 幽灵仓库：上一轮有、这一轮没有的 (product, warehouse) ──────────────────
  const existing = await sbGetAll<{ product_id: string; warehouse_code: string }>(
    "inventory_cache?select=product_id,warehouse_code&source_type=eq.website_scrape",
  );
  const zeroed = zeroOutVanishedWarehouses(existing, fresh, { now, sourceNote: 'warehouse_refresh', runId: RUN_ID });
  const rows = [...fresh, ...zeroed];

  // ── 本轮自己的健康指标 ─────────────────────────────────────────────────────
  const coverage = targets.length ? (answered.size / targets.length) * 100 : 0;
  const failurePercent = targets.length ? ((failedSkus.length + missing.length) / targets.length) * 100 : 100;
  const inStock = new Set(fresh.filter((r) => r.quantity > 0).map((r) => r.product_id));
  const zeroOnly = [...answered].filter((s) => !inStock.has(s));

  // 会被判成缺货的商品：本轮问到了、且所有仓库合计为 0。这就是下架的预期范围。
  const willDelist = zeroOnly.filter((sku) => publishedSet.has(sku));
  const delistPercent = targets.length ? (willDelist.length / targets.length) * 100 : 0;

  const summary = {
    run_id: RUN_ID,
    started_at: started.toISOString(),
    finished_at: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry_run',
    targets: targets.length,
    answered: answered.size,
    batches,
    failed_batches: failedBatches,
    failed_skus: failedSkus.length,
    missing_skus: missing.length,
    rows_built: rows.length,
    rows_fresh: fresh.length,
    rows_zeroed_vanished: zeroed.length,
    products_in_stock: inStock.size,
    products_zero_stock: zeroOnly.length,
    coverage_percent: Number(coverage.toFixed(2)),
    failure_percent: Number(failurePercent.toFixed(2)),
    rows_written: 0,
    /** 本轮因为真实为 0 而应当下架的在架商品。 */
    will_delist: willDelist.length,
    delist_percent: Number(delistPercent.toFixed(2)),
    delist_skus: willDelist,
    /** 实际调用状态刷新成功的 SKU 数；下架由数据库自己判定，这里只记调用结果。 */
    status_refreshed: 0,
    status_refresh_failed: 0,
    delist_blocked_reason: null as string | null,
  };

  // ── 写入 ───────────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log(`  DRY-RUN — 不写任何东西（本轮将有 ${willDelist.length} 件因为真实为 0 而下架）`);
  } else if (failurePercent > MAX_FAILURE_PERCENT) {
    summary.delist_blocked_reason = `failure_percent_${failurePercent.toFixed(1)}`;
    console.error(`  失败率 ${failurePercent.toFixed(1)}% > ${MAX_FAILURE_PERCENT}% —— 中止，不写任何东西`);
  } else if (delistPercent > MAX_DELIST_PERCENT) {
    // 协议上全部成功、但结果是要下架一大片 —— 更像供应商抽风，不像店里真的空了。
    // 宁可让库存旧一天。这一步连缓存都不写：写了就等于让下一轮接受这个结果。
    summary.delist_blocked_reason = `delist_percent_${delistPercent.toFixed(1)}`;
    console.error(
      `  本轮将下架 ${willDelist.length} 件（${delistPercent.toFixed(1)}% > ${MAX_DELIST_PERCENT}%）—— 中止，不写任何东西。`
      + ' 若确认属实，用 WAREHOUSE_MAX_DELIST_PERCENT 显式放宽后重跑。',
    );
  } else {
    for (let i = 0; i < rows.length; i += ROW_BATCH) {
      const chunk = rows.slice(i, i + ROW_BATCH);
      const out = await upsertRows(chunk);
      if (!out.ok) {
        console.error(`  upsert 失败: ${out.detail}`);
        break;
      }
      summary.rows_written += chunk.length;
    }
    console.log(`  已写入 ${summary.rows_written} 行`);

    // ── 状态刷新：只对本轮问到的 SKU，且必须在写入之后 ────────────────────────
    //
    // 此刻这些 SKU 的行龄是 0 秒，所以 refresh_product_inventory_status 的 24 小时
    // 规则不会误判；它读到的就是供应商刚给的数量。没问到的 SKU 一个都不碰 ——
    // 对它们调用只会把「我们没查到」变成「下架」。
    if (summary.rows_written > 0) {
      for (const sku of answered) {
        if (await refreshStatus(sku)) summary.status_refreshed++;
        else summary.status_refresh_failed++;
      }
      console.log(
        `  状态刷新 ${summary.status_refreshed} 件`
        + (summary.status_refresh_failed ? `，失败 ${summary.status_refresh_failed} 件` : '')
        + `；其中 ${willDelist.length} 件应转为缺货并退出 sellable_products`,
      );
    }
  }

  // 本轮报告落盘，供 runner 与 XOne 读取；文件名带 run_id，不覆盖历史。
  const dir = path.join(process.cwd(), 'reports', 'warehouse-refresh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${RUN_ID}.json`), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(dir, 'latest-warehouse-refresh.json'), JSON.stringify(summary, null, 2));

  console.log(JSON.stringify(summary, null, 2));

  if (failurePercent > MAX_FAILURE_PERCENT) process.exit(3);
  if (coverage < MIN_COVERAGE_PERCENT) {
    console.error(`  覆盖率 ${coverage.toFixed(1)}% < ${MIN_COVERAGE_PERCENT}%`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('[warehouse-refresh] FATAL', e instanceof Error ? e.message : e);
  process.exit(1);
});
