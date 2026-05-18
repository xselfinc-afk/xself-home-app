/**
 * Probe GIGA's authenticated product info XHRs to find which endpoint
 * returns per-warehouse stock and total available qty.
 *
 * Why: the product detail page is now an SPA — HTML scraping returns no
 * warehouse rows because the data is fetched client-side. We have one
 * confirmed XHR:
 *   GET https://www.gigab2b.com/index.php?route=/product/info/info/baseInfos&product_id=<id>
 * and we suspect siblings under /product/info/.
 *
 * This script:
 *   1. Calls the known baseInfos endpoint plus a list of guessed siblings.
 *   2. Prints HTTP status, content-type, body size, top-level JSON keys.
 *   3. Walks each JSON response tree for `(warehouse_code, qty)` pairs and
 *      reports which endpoint + JSON path actually contains the warehouse
 *      table.
 *   4. If found, prints normalized rows for inventory_cache.
 *
 * Run:
 *   npx tsx scripts/probeGigaProductXhr.ts --product-id 1064421
 *   PRODUCT_IDS=1064421,670347 npx tsx scripts/probeGigaProductXhr.ts
 *
 * Env:
 *   GIGA_SESSION_FILE — Playwright storageState path (default: scripts/.giga-session.json)
 *   GIGA_USER_AGENT   — UA override
 *   GIGA_PROBE_PATHS  — comma-separated route= values to probe instead of defaults
 *   GIGA_DEBUG_JSON=1 — dump each raw JSON response to tmp/giga-xhr-<id>-<endpoint>.json
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');
const USER_AGENT = process.env.GIGA_USER_AGENT
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEBUG_JSON = process.env.GIGA_DEBUG_JSON === '1';

// Discovered + plausible sibling routes. baseInfos is confirmed; the rest are
// guesses based on common OpenCart / GIGA naming. The probe will mark each
// "FOUND warehouse rows" vs "no warehouse data".
const DEFAULT_PROBE_PATHS = [
  '/product/info/info/baseInfos',
  '/product/info/info/warehouseStock',
  '/product/info/info/warehouseQty',
  '/product/info/info/specifiedWarehouse',
  '/product/info/info/getStock',
  '/product/info/info/getInventory',
  '/product/info/info/inventory',
  '/product/info/info/stockInfo',
  '/product/info/info/qtyInfo',
  '/product/info/stock/list',
  '/product/info/warehouse/list',
];

const probePaths = (process.env.GIGA_PROBE_PATHS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const ROUTES = probePaths.length > 0 ? probePaths : DEFAULT_PROBE_PATHS;

// ── Warehouse pattern helpers ─────────────────────────────────────────────────
const WH_CODE_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/;

function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}
function supportsPickup(code: string): boolean { return warehouseState(code) === 'CA'; }
function parseQty(raw: string): { floor: number | null; exact: boolean } {
  const hasPlus = String(raw).includes('+');
  const digits = String(raw).replace(/,/g, '').replace(/[^\d]/g, '');
  const n = digits ? parseInt(digits, 10) : NaN;
  const floor = isNaN(n) ? null : n;
  return { floor, exact: floor !== null && !hasPlus };
}

// ── Cookie load ──────────────────────────────────────────────────────────────
interface SessionCookie { name: string; value: string; domain: string; path?: string; }

function loadCookieHeader(): string {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Session file not found: ${SESSION_FILE} — run: npm run inventory:save-session`);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { cookies?: SessionCookie[] };
  const cookies = (raw.cookies ?? []).filter(c => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (cookies.length === 0) throw new Error('No gigab2b.com cookies in session file.');
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ── HTTP call ────────────────────────────────────────────────────────────────
function buildHeaders(productId: string, cookieHeader: string): Record<string, string> {
  return {
    'cookie':              cookieHeader,
    'user-agent':          USER_AGENT,
    'accept':              'application/json, text/javascript, */*; q=0.01',
    'accept-language':     'en-US,en;q=0.9',
    'x-requested-with':    'XMLHttpRequest',
    'referer':             `https://www.gigab2b.com/index.php?route=product/product&product_id=${productId}`,
    'sec-ch-ua':           '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile':    '?0',
    'sec-ch-ua-platform':  '"macOS"',
    'sec-fetch-dest':      'empty',
    'sec-fetch-mode':      'cors',
    'sec-fetch-site':      'same-origin',
  };
}

interface ProbeResult {
  route: string;
  url: string;
  status: number;
  contentType: string;
  bodyLen: number;
  bodyHead: string;
  json: unknown | null;
  jsonKeys: string[];
  warehousePaths: Array<{ path: string; sample: unknown }>;
  totalCandidates: Array<{ path: string; value: unknown }>;
  itemCodeCandidates: Array<{ path: string; value: unknown }>;
  isAliyunChallenge: boolean;
}

async function probeOne(productId: string, route: string, cookieHeader: string): Promise<ProbeResult> {
  const url = `https://www.gigab2b.com/index.php?route=${encodeURI(route)}&product_id=${productId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(productId, cookieHeader),
    redirect: 'follow',
  });
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';

  let json: unknown | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  const isAliyun = /<title>\s*Safe Checker\s*<\/title>/i.test(text);
  const warehousePaths: ProbeResult['warehousePaths'] = [];
  const totalCandidates: ProbeResult['totalCandidates'] = [];
  const itemCodeCandidates: ProbeResult['itemCodeCandidates'] = [];

  if (json !== null) walkJson(json, '$', warehousePaths, totalCandidates, itemCodeCandidates);

  const jsonKeys = (json && typeof json === 'object' && !Array.isArray(json))
    ? Object.keys(json as Record<string, unknown>)
    : [];

  return {
    route, url,
    status: res.status,
    contentType: ct,
    bodyLen: text.length,
    bodyHead: text.slice(0, 240),
    json,
    jsonKeys,
    warehousePaths,
    totalCandidates,
    itemCodeCandidates,
    isAliyunChallenge: isAliyun,
  };
}

// ── JSON walker — flag warehouse codes, qty fields, item codes, totals ────────
const ITEM_CODE_RE = /^[A-Z]{1,3}\d{2,5}[A-Z]?\d{3,8}[A-Z]?$/;
const QTY_FIELD_RE = /^(qty|quantity|stock|available|available_qty|availableQty|total|totalAvailable)$/i;
const TOTAL_FIELD_RE = /^(total|totalAvailable|totalQty|grand_total|sum)$/i;
const ITEM_CODE_FIELD_RE = /^(item_code|itemCode|sku|skuCode|sku_no|item_no|supplier_sku)$/i;

function walkJson(
  node: unknown,
  pathStr: string,
  warehousePaths: ProbeResult['warehousePaths'],
  totalCandidates: ProbeResult['totalCandidates'],
  itemCodeCandidates: ProbeResult['itemCodeCandidates'],
) {
  if (node === null || node === undefined) return;

  if (Array.isArray(node)) {
    // Check if this is an array of warehouse-row objects
    const sample = node[0];
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
      const keys = Object.keys(sample as Record<string, unknown>);
      const hasCode = keys.some(k => /warehouse|wh_code|code/i.test(k));
      const hasQty  = keys.some(k => QTY_FIELD_RE.test(k));
      const looksLikeWhArray = hasCode && hasQty;
      // Or simpler heuristic — any value in the sample looks like a warehouse code
      const anyValueIsWhCode = keys.some(k => {
        const v = (sample as Record<string, unknown>)[k];
        return typeof v === 'string' && WH_CODE_RE.test(v);
      });
      if (looksLikeWhArray || anyValueIsWhCode) {
        warehousePaths.push({ path: pathStr, sample });
      }
    }
    node.forEach((v, i) => walkJson(v, `${pathStr}[${i}]`, warehousePaths, totalCandidates, itemCodeCandidates));
    return;
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      const sub = `${pathStr}.${k}`;
      if (TOTAL_FIELD_RE.test(k) && (typeof v === 'number' || typeof v === 'string')) {
        totalCandidates.push({ path: sub, value: v });
      }
      if (ITEM_CODE_FIELD_RE.test(k) && typeof v === 'string') {
        itemCodeCandidates.push({ path: sub, value: v });
      }
      if (typeof v === 'string' && ITEM_CODE_RE.test(v) && /(item|sku|code)/i.test(k)) {
        itemCodeCandidates.push({ path: sub, value: v });
      }
      walkJson(v, sub, warehousePaths, totalCandidates, itemCodeCandidates);
    }
  }
}

// ── Normalised row extraction once a warehouse path is known ──────────────────
export interface NormalizedRow {
  product_id: string;
  supplier_product_id: string;
  warehouse_code: string;
  warehouse_state: string | null;
  quantity: number | null;
  quantity_raw: string;
  quantity_exact: boolean;
  is_available: boolean;
  supports_pickup: boolean;
  supports_shipping: boolean;
  source_type: 'website_scrape';
  sync_status: 'ok';
  last_synced_at: string;
  total_available: number | null;
}

export function extractRowsFromWarehouseArray(
  arr: unknown[],
  supplierId: string,
  total: number | null,
): NormalizedRow[] {
  const now = new Date().toISOString();
  const rows: NormalizedRow[] = [];

  for (const item of arr) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;

    // Find a warehouse code in any field
    let code: string | null = null;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string') {
        const m = v.match(WH_CODE_RE);
        if (m) { code = m[0].toUpperCase(); break; }
      }
    }
    if (!code) continue;

    // Find a qty in any field whose name is qty-shaped, falling back to any string with digits
    let qtyRaw = '';
    const preferredKeys = Object.keys(obj).filter(k => QTY_FIELD_RE.test(k));
    for (const k of preferredKeys) {
      const v = obj[k];
      if (v == null) continue;
      qtyRaw = String(v);
      break;
    }
    if (!qtyRaw) {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string' && typeof v !== 'number') continue;
        // skip the field that held the code
        const str = String(v);
        if (str === code) continue;
        if (/\d/.test(str) && !WH_CODE_RE.test(str)) { qtyRaw = str; break; }
      }
    }
    if (!qtyRaw) continue;

    const { floor, exact } = parseQty(qtyRaw);
    if (floor === null) continue;

    rows.push({
      product_id:          supplierId,
      supplier_product_id: supplierId,
      warehouse_code:      code,
      warehouse_state:     warehouseState(code),
      quantity:            floor,
      quantity_raw:        qtyRaw,
      quantity_exact:      exact,
      is_available:        floor > 0,
      supports_pickup:     supportsPickup(code),
      supports_shipping:   !supportsPickup(code),
      source_type:         'website_scrape',
      sync_status:         'ok',
      last_synced_at:      now,
      total_available:     total,
    });
  }

  return rows;
}

function getByPath(root: unknown, dotPath: string): unknown {
  // very small path resolver: $.a.b[0].c → root.a.b[0].c
  const tokens = dotPath.replace(/^\$\.?/, '').split(/\.|\[/).map(t => t.replace(/\]$/, ''));
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(t)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[t];
    else return undefined;
  }
  return cur;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--product-id' || a === '--id') { out.push(argv[++i]); continue; }
    if (a === '--products')   { (argv[++i] ?? '').split(',').forEach(t => t && out.push(t.trim())); continue; }
    if (!a.startsWith('--'))  { out.push(a); continue; }
  }
  if (process.env.PRODUCT_IDS) process.env.PRODUCT_IDS.split(',').forEach(t => t && out.push(t.trim()));
  return out;
}

async function run() {
  const targets = parseArgs(process.argv.slice(2));
  const list = targets.length ? targets : ['1064421'];

  const cookieHeader = loadCookieHeader();

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA PRODUCT XHR PROBE');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Session file : ${SESSION_FILE}`);
  console.log(` Cookie len   : ${cookieHeader.length} chars`);
  console.log(` Targets      : ${list.join(', ')}`);
  console.log(` Routes       : ${ROUTES.length}`);
  ROUTES.forEach(r => console.log(`   • ${r}`));
  console.log('═══════════════════════════════════════════════════════════\n');

  for (const pid of list) {
    console.log(`──── product_id=${pid} ────────────────────────────────────`);
    const results: ProbeResult[] = [];
    for (const route of ROUTES) {
      try {
        const r = await probeOne(pid, route, cookieHeader);
        results.push(r);
        const tag = r.isAliyunChallenge
          ? 'ALIYUN'
          : r.json
            ? 'json'
            : 'raw';
        console.log(
          `  [${tag.padEnd(6)}] HTTP ${r.status}  ${r.contentType.padEnd(40)}  ${String(r.bodyLen).padStart(6)}B  ${r.route}`,
        );
        if (DEBUG_JSON && r.json) {
          const dumpDir = path.join(process.cwd(), 'tmp');
          fs.mkdirSync(dumpDir, { recursive: true });
          const safeRoute = r.route.replace(/[^A-Za-z0-9_-]+/g, '_');
          const dumpPath = path.join(dumpDir, `giga-xhr-${pid}-${safeRoute}.json`);
          fs.writeFileSync(dumpPath, JSON.stringify(r.json, null, 2));
        }
      } catch (err) {
        console.error(`  [ERROR ] ${route}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Choose the most promising result.
    const promising = results.filter(r => r.warehousePaths.length > 0)
      .sort((a, b) => b.warehousePaths.length - a.warehousePaths.length);

    console.log('');
    if (promising.length === 0) {
      console.log('  (no endpoint returned warehouse-shaped JSON)');
      // Still try to report any JSON shape we got
      const anyJson = results.find(r => r.json && !r.isAliyunChallenge);
      if (anyJson) {
        console.log(`  Top-level keys from ${anyJson.route}:`, anyJson.jsonKeys.join(', ') || '(none)');
        console.log('  Body head:', anyJson.bodyHead.replace(/\s+/g, ' ').slice(0, 200));
      } else if (results.every(r => r.isAliyunChallenge)) {
        console.log('  All endpoints returned Aliyun Safe Checker. Refresh session via npm run inventory:save-session,');
        console.log('  or use the render path: GIGA_RENDER=always npm run inventory:html:fetch -- --product-id ' + pid);
      }
      continue;
    }

    const top = promising[0];
    console.log(`  ✓ Warehouse data found in ${top.route}`);
    for (const wp of top.warehousePaths) {
      console.log(`     path=${wp.path}  sample=${JSON.stringify(wp.sample).slice(0, 220)}`);
    }
    if (top.totalCandidates.length > 0) {
      console.log('  Total qty candidates:');
      top.totalCandidates.forEach(t => console.log(`     ${t.path} = ${t.value}`));
    }
    if (top.itemCodeCandidates.length > 0) {
      console.log('  Item-code candidates:');
      top.itemCodeCandidates.forEach(t => console.log(`     ${t.path} = ${t.value}`));
    }

    // Best-effort extraction with the discovered shape.
    const itemCodeVal = top.itemCodeCandidates.find(c => ITEM_CODE_RE.test(String(c.value)))?.value as string | undefined;
    const supplierId = itemCodeVal ?? pid;
    const totalVal = top.totalCandidates[0]?.value;
    const total = typeof totalVal === 'number'
      ? totalVal
      : (typeof totalVal === 'string' ? parseQty(totalVal).floor : null);

    const whArr = getByPath(top.json, top.warehousePaths[0].path);
    if (Array.isArray(whArr)) {
      const rows = extractRowsFromWarehouseArray(whArr, supplierId, total);
      console.log(`\n  PARSED ROWS (${rows.length}) for supplier_product_id=${supplierId}, total=${total}:`);
      for (const row of rows) {
        console.log(
          `    ${row.warehouse_code.padEnd(8)} state=${(row.warehouse_state ?? '?').padEnd(3)} ` +
          `qty=${String(row.quantity).padStart(4)} exact=${row.quantity_exact ? 'y' : 'n'} raw="${row.quantity_raw}"`,
        );
      }
    }
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('[probe] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
