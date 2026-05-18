/**
 * Phase 3 — use the captured GIGA cURL as a template and fetch per-warehouse
 * stock for arbitrary target SKUs.
 *
 * The captured request has a specific product id baked into its URL / body.
 * This script:
 *   1. Parses tmp/giga_inventory_request.curl.
 *   2. Detects the captured product id (or accepts an explicit one via env).
 *   3. Substitutes that id with each TARGET_PIDS value in turn.
 *   4. Fires the request, extracts warehouse rows, prints normalized output
 *      ready to upsert into inventory_cache.
 *
 * Run with the defaults (the two diagnostic products from the audit):
 *   npx tsx scripts/fetchGigaWarehouseInventoryFromCurl.ts
 *
 * Override products:
 *   TARGET_PIDS=W1445P146389,W331P242454,W28209580 \
 *     npx tsx scripts/fetchGigaWarehouseInventoryFromCurl.ts
 *
 * Pin the captured id explicitly (if auto-detect picks the wrong token):
 *   CAPTURED_PID=W1445P146389 \
 *     npx tsx scripts/fetchGigaWarehouseInventoryFromCurl.ts
 *
 * Env:
 *   GIGA_CURL_FILE   — input cURL path (default: tmp/giga_inventory_request.curl)
 *   TARGET_PIDS      — comma-separated supplier_product_id values to fetch
 *   CAPTURED_PID     — original product id in the cURL (auto-detected otherwise)
 *   INTER_REQ_DELAY  — ms between requests (default: 800)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { parseCurl, redactForLog, ParsedCurl } from './lib/curlParser';

const CURL_FILE = process.env.GIGA_CURL_FILE
  ?? path.join(process.cwd(), 'tmp', 'giga_inventory_request.curl');
const TARGET_PIDS = (process.env.TARGET_PIDS ?? 'W1445P146389,W331P242454')
  .split(',').map(s => s.trim()).filter(Boolean);
const CAPTURED_PID_OVERRIDE = process.env.CAPTURED_PID ?? '';
const INTER_REQ_DELAY = Number(process.env.INTER_REQ_DELAY ?? 800);

// GIGA SKU shape: leading 1–3 letters, then a mix of digits + optional internal letters.
// Matches W1445P146389, W331P242454, W28209580, N725S412541K, …
const SKU_PATTERN = /\b([A-Z]{1,3}\d{2,5}[A-Z]?\d{3,8}[A-Z]?)\b/g;

// ── Warehouse extractors ─────────────────────────────────────────────────────
// Mirror scrapeGigaInventory.ts so the field shapes match what
// syncGigaFurnitureInventory.ts already writes.
const WH_CODE_RE = /\b(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)\b/gi;

function warehouseState(code: string): string | null {
  if (/^CA/i.test(code))  return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code))  return 'NJ';
  if (/^AT/i.test(code))  return 'GA';
  if (/^TX/i.test(code))  return 'TX';
  return null;
}

function supportsPickup(code: string): boolean {
  return warehouseState(code) === 'CA';
}

function parseQty(raw: string): { floor: number | null; exact: boolean } {
  const hasPlus = raw.includes('+');
  const digits = raw.replace(/,/g, '').replace(/[^\d]/g, '');
  const n = digits ? parseInt(digits, 10) : NaN;
  const floor = isNaN(n) ? null : n;
  return { floor, exact: floor !== null && !hasPlus };
}

export interface NormalizedRow {
  supplier_product_id: string;
  product_id: string;
  warehouse_code: string;
  warehouse_state: string | null;
  quantity: number | null;
  quantity_raw: string;
  quantity_exact: boolean;
  supports_pickup: boolean;
  supports_shipping: boolean;
  source_type: 'website_scrape';
  sync_status: 'ok';
  last_synced_at: string;
}

/**
 * Multi-strategy extractor. Handles:
 *   1. JSON arrays/objects: walks the tree looking for {warehouse_code, qty}-style pairs.
 *   2. Generic text/HTML: regex over `(WHCODE) … (qty)` patterns.
 */
export function extractWarehouseRows(body: string, productId: string): NormalizedRow[] {
  const now = new Date().toISOString();
  const rows = new Map<string, NormalizedRow>(); // dedupe by warehouse_code

  // Strategy 1: try JSON
  try {
    const json = JSON.parse(body);
    walkJsonForRows(json, productId, now, rows);
  } catch {
    // not JSON — fall through
  }

  if (rows.size === 0) {
    // Strategy 2: regex over text. Same approach as scrapeGigaInventory.ts —
    // for every WH code we find, grab the next 1–2 digit groups nearby.
    const lines = body.split(/\n|\\n|<\/?(?:tr|td|p|div|br)[^>]*>/i)
      .map(l => l.replace(/<[^>]+>/g, ' ').trim())
      .filter(Boolean);

    for (let i = 0; i < lines.length; i++) {
      WH_CODE_RE.lastIndex = 0;
      const codes = lines[i].match(WH_CODE_RE);
      if (!codes) continue;

      for (const codeRaw of codes) {
        const code = codeRaw.toUpperCase();
        if (rows.has(code)) continue;

        // Look for a quantity in this line first, then the next 2 lines.
        const QTY_RE = /(?<![A-Z])(\d[\d,]*\+?)\s*(?:pcs|units|件|套)?(?!\w)/i;
        let qtyRaw = '';
        const scope = [lines[i], lines[i + 1] ?? '', lines[i + 2] ?? ''];
        for (const t of scope) {
          if (!t) continue;
          // Skip the segment of t that contains the warehouse code itself —
          // otherwise we'd parse "AT3" as qty 3.
          const stripped = t.replace(WH_CODE_RE, ' ');
          const m = stripped.match(QTY_RE);
          if (m) { qtyRaw = m[1].trim(); break; }
        }

        const { floor, exact } = parseQty(qtyRaw);
        if (floor === null) continue; // no qty — skip noise

        rows.set(code, {
          supplier_product_id: productId,
          product_id:          productId,
          warehouse_code:      code,
          warehouse_state:     warehouseState(code),
          quantity:            floor,
          quantity_raw:        qtyRaw || '(not detected)',
          quantity_exact:      exact,
          supports_pickup:     supportsPickup(code),
          supports_shipping:   !supportsPickup(code),
          source_type:         'website_scrape',
          sync_status:         'ok',
          last_synced_at:      now,
        });
      }
    }
  }

  return Array.from(rows.values());
}

function walkJsonForRows(
  node: unknown,
  productId: string,
  now: string,
  rows: Map<string, NormalizedRow>,
) {
  if (Array.isArray(node)) {
    for (const item of node) walkJsonForRows(item, productId, now, rows);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;

    // Common GIGA-shape candidates: { warehouse_code, qty } / { warehouse, quantity } / { code, stock }
    const codeKey = Object.keys(obj).find(k => /warehouse(_code)?|wh_code|code/i.test(k));
    const qtyKey  = Object.keys(obj).find(k => /qty|quantity|stock|available/i.test(k));

    if (codeKey && qtyKey) {
      const codeRaw = String(obj[codeKey] ?? '').toUpperCase().trim();
      const qtyRaw  = String(obj[qtyKey] ?? '').trim();
      if (WH_CODE_RE.test(codeRaw) || /^(CA[A-Z]*\d+|NJX\d+|NJ[A-Z]*\d+|AT[A-Z]*\d+|TX[A-Z]*\d+)$/.test(codeRaw)) {
        WH_CODE_RE.lastIndex = 0;
        const match = codeRaw.match(WH_CODE_RE);
        const code = match ? match[0] : codeRaw;
        if (!rows.has(code)) {
          const { floor, exact } = parseQty(qtyRaw);
          if (floor !== null) {
            rows.set(code, {
              supplier_product_id: productId,
              product_id:          productId,
              warehouse_code:      code,
              warehouse_state:     warehouseState(code),
              quantity:            floor,
              quantity_raw:        qtyRaw,
              quantity_exact:      exact,
              supports_pickup:     supportsPickup(code),
              supports_shipping:   !supportsPickup(code),
              source_type:         'website_scrape',
              sync_status:         'ok',
              last_synced_at:      now,
            });
          }
        }
      }
    }

    for (const v of Object.values(obj)) walkJsonForRows(v, productId, now, rows);
  }
}

// ── Captured-PID detection ────────────────────────────────────────────────────

export function detectCapturedPid(parsed: ParsedCurl): string | null {
  if (CAPTURED_PID_OVERRIDE) return CAPTURED_PID_OVERRIDE;
  const candidates = [parsed.url, parsed.body ?? ''];
  for (const text of candidates) {
    SKU_PATTERN.lastIndex = 0;
    const m = text.match(SKU_PATTERN);
    if (m && m.length > 0) return m[0];
  }
  return null;
}

// ── Replay one product ────────────────────────────────────────────────────────

export async function fetchForProduct(parsed: ParsedCurl, capturedPid: string, targetPid: string): Promise<{
  status: number;
  rows: NormalizedRow[];
  bodyPreview: string;
}> {
  const url = parsed.url.split(capturedPid).join(targetPid);
  const body = parsed.body ? parsed.body.split(capturedPid).join(targetPid) : null;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (k === 'accept-encoding' || k === 'content-length') continue;
    headers[k] = v;
  }

  const init: RequestInit = { method: parsed.method, headers, redirect: 'follow' };
  if (body !== null && parsed.method !== 'GET' && parsed.method !== 'HEAD') {
    init.body = body;
  }

  const res = await fetch(url, init);
  const responseBody = await res.text();
  const rows = extractWarehouseRows(responseBody, targetPid);

  return {
    status: res.status,
    rows,
    bodyPreview: responseBody.slice(0, 400),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!fs.existsSync(CURL_FILE)) {
    console.error(`[fetchGiga] cURL file not found: ${CURL_FILE}`);
    console.error('  Capture one by following docs/GIGA_NETWORK_CAPTURE.md.');
    process.exit(1);
  }

  const parsed = parseCurl(fs.readFileSync(CURL_FILE, 'utf8'));
  const capturedPid = detectCapturedPid(parsed);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' GIGA WAREHOUSE STOCK — TEMPLATED FETCH');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' URL          :', parsed.url);
  console.log(' Method       :', parsed.method);
  console.log(' Captured pid :', capturedPid ?? '(NOT DETECTED — set CAPTURED_PID env var)');
  console.log(' Target pids  :', TARGET_PIDS.join(', '));
  console.log(' Cookies      :', Object.keys(redactForLog(parsed).cookies).length, 'cookie(s)');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!capturedPid) {
    console.error('[fetchGiga] Could not auto-detect the original product id in the cURL.');
    console.error('  Re-run with CAPTURED_PID=<exact-id-from-curl> npx tsx scripts/fetchGigaWarehouseInventoryFromCurl.ts');
    process.exit(1);
  }

  for (const pid of TARGET_PIDS) {
    console.log(`───────────────────────────────────────────────────────────`);
    console.log(` Fetching warehouse stock for ${pid}…`);
    try {
      const { status, rows, bodyPreview } = await fetchForProduct(parsed, capturedPid, pid);
      console.log(`   HTTP ${status} — extracted ${rows.length} warehouse row(s)`);
      if (rows.length === 0) {
        console.log('   Response preview:', bodyPreview.slice(0, 200), '…');
      }
      for (const row of rows) {
        console.log(
          `   ${row.warehouse_code.padEnd(8)} state=${(row.warehouse_state ?? '?').padEnd(3)} ` +
          `qty=${String(row.quantity).padStart(4)}  exact=${row.quantity_exact ? 'y' : 'n'}  raw="${row.quantity_raw}"`,
        );
      }
    } catch (err) {
      console.error('   ERROR:', err instanceof Error ? err.message : err);
    }

    if (INTER_REQ_DELAY > 0) await new Promise(r => setTimeout(r, INTER_REQ_DELAY));
  }

  console.log('\n[fetchGiga] Done.');
}

if (require.main === module) {
  run().catch(err => {
    console.error('[fetchGiga] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
