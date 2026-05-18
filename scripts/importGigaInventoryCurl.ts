/**
 * Phase 2 — replay the captured GIGA warehouse-stock request verbatim.
 *
 * Read tmp/giga_inventory_request.curl, parse it, log the redacted shape,
 * fire the same request with `fetch`, and surface whether the body looks
 * like real per-warehouse stock.
 *
 * Run:
 *   npx tsx scripts/importGigaInventoryCurl.ts
 *
 * Env:
 *   GIGA_CURL_FILE     — input cURL path (default: tmp/giga_inventory_request.curl)
 *   PREVIEW_BYTES      — bytes of body preview (default: 1500)
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { parseCurl, redactForLog, looksLikeWarehouseStock } from './lib/curlParser';

const CURL_FILE = process.env.GIGA_CURL_FILE
  ?? path.join(process.cwd(), 'tmp', 'giga_inventory_request.curl');
const PREVIEW_BYTES = Number(process.env.PREVIEW_BYTES ?? 1500);

async function run() {
  if (!fs.existsSync(CURL_FILE)) {
    console.error(`[importGigaInventoryCurl] cURL file not found: ${CURL_FILE}`);
    console.error('  Capture one by following docs/GIGA_NETWORK_CAPTURE.md.');
    process.exit(1);
  }

  const raw = fs.readFileSync(CURL_FILE, 'utf8');
  if (!raw.trim().startsWith('curl')) {
    console.error('[importGigaInventoryCurl] File does not start with "curl" — is this a cURL command?');
    process.exit(1);
  }

  const parsed = parseCurl(raw);
  const redacted = redactForLog(parsed);

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(' GIGA cURL IMPORT — REPLAY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' URL          :', parsed.url || '(missing!)');
  console.log(' Method       :', parsed.method);
  console.log(' Headers      :');
  for (const [k, v] of Object.entries(redacted.headers)) {
    console.log(`   ${k.padEnd(28)} ${v}`);
  }
  console.log(' Cookies      :', Object.keys(parsed.cookies).length, 'cookie(s) —', Object.keys(parsed.cookies).join(', '));
  console.log(' Body         :', parsed.body == null ? '(none)' : `${parsed.body.length} chars — ${parsed.body.slice(0, 200)}${parsed.body.length > 200 ? '…' : ''}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  if (!parsed.url) {
    console.error('[importGigaInventoryCurl] No URL parsed from cURL — aborting.');
    process.exit(1);
  }

  // Strip Accept-Encoding so fetch doesn't return gzipped bytes we can't read.
  const fetchHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.headers)) {
    if (k === 'accept-encoding') continue;
    if (k === 'content-length') continue; // fetch recomputes this
    fetchHeaders[k] = v;
  }

  const init: RequestInit = {
    method: parsed.method,
    headers: fetchHeaders,
    redirect: 'follow',
  };
  if (parsed.body !== null && parsed.method !== 'GET' && parsed.method !== 'HEAD') {
    init.body = parsed.body;
  }

  console.log('[importGigaInventoryCurl] Sending request…');
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(parsed.url, init);
  } catch (err) {
    console.error('[importGigaInventoryCurl] fetch failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const elapsedMs = Date.now() - t0;

  const ct = res.headers.get('content-type') ?? '(none)';
  const len = res.headers.get('content-length') ?? '(unknown)';
  console.log(`\n[importGigaInventoryCurl] HTTP ${res.status} ${res.statusText}  (${elapsedMs} ms)`);
  console.log(`[importGigaInventoryCurl] content-type=${ct}  content-length=${len}`);

  const body = await res.text();
  console.log(`[importGigaInventoryCurl] body bytes : ${body.length}`);
  console.log('\n--- preview ---------------------------------------------------');
  console.log(body.slice(0, PREVIEW_BYTES));
  if (body.length > PREVIEW_BYTES) console.log(`\n... (truncated, ${body.length - PREVIEW_BYTES} more bytes)`);
  console.log('---------------------------------------------------------------\n');

  // Heuristic detection
  const { warehouseCodes, qtyTokens } = looksLikeWarehouseStock(body);
  console.log(`[importGigaInventoryCurl] Detected warehouse codes  : ${warehouseCodes.length ? warehouseCodes.join(', ') : '(none)'}`);
  console.log(`[importGigaInventoryCurl] Detected qty-shaped tokens: ${qtyTokens.length ? qtyTokens.slice(0, 15).join(', ') : '(none)'}`);

  const looksLoggedOut = /sign\s*in|log\s*in|password/i.test(body) && !/warehouse|quantity|stock/i.test(body);
  if (looksLoggedOut) {
    console.warn('\n[importGigaInventoryCurl] ⚠ Body looks like a login page — session cookies likely expired.');
    console.warn('   Recapture per docs/GIGA_NETWORK_CAPTURE.md.');
    process.exit(2);
  }

  if (warehouseCodes.length === 0) {
    console.warn('\n[importGigaInventoryCurl] ⚠ No warehouse codes detected in the response.');
    console.warn('   You likely captured a wrapper/HTML page instead of the warehouse JSON.');
    console.warn('   Recapture — pick the request that fires immediately after the');
    console.warn('   "Specified Warehouse" radio is clicked.');
    process.exit(3);
  }

  console.log('\n[importGigaInventoryCurl] ✓ Looks like a real warehouse-stock response.');
}

run().catch(err => {
  console.error('[importGigaInventoryCurl] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
