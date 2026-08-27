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
 * 1. **绝不调用 refresh_product_inventory_status()。**
 *    那个函数用它自己的 24 小时规则判 stale，并且直接写 `published`
 *    （supabase/inventory_source_of_truth.sql:148）。本任务每 48 小时跑一轮，
 *    所以每个周期的后半程，所有行都会超过它的 24 小时线 —— 调它就等于每隔一天
 *    把整个目录下架一次。发布决策归 set_publication_from_availability()，
 *    由可用性证据驱动，不归这里。这条有测试守着。
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

/** 一批 SKU 的 quantity/v2 调用。失败只影响这一批，不放弃整轮。 */
async function fetchQuantities(skus: string[]): Promise<
  { ok: true; records: GigaQuantityRecord[] } | { ok: false; reason: string }
> {
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
    if (res.status !== 200 || json?.success !== true) return { ok: false, reason: `giga_http_${res.status}` };
    return { ok: true, records: Array.isArray(json.data) ? json.data : [] };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'network_error' };
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

async function main(): Promise<void> {
  const started = new Date();
  console.log(`WAREHOUSE_REFRESH run=${RUN_ID} mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // ── 目标集：checkout 真正可能撞上的商品 = published ────────────────────────
  const published = await sbGetAll<{ supplier_product_id: string }>(
    'standardized_products?select=supplier_product_id&published=is.true',
  );
  let targets = published.map((r) => r.supplier_product_id).filter(Boolean);
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
    if (!out.ok) {
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
  };

  // ── 写入 ───────────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log('  DRY-RUN — 不写任何东西');
  } else if (failurePercent > MAX_FAILURE_PERCENT) {
    console.error(`  失败率 ${failurePercent.toFixed(1)}% > ${MAX_FAILURE_PERCENT}% —— 中止，不写任何东西`);
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
