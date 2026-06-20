/**
 * READ-ONLY coverage audit — can the dropship session price the mapped SKUs?
 *
 * Resolution (NO giga_products, NO SPA scraping, NO sku_custom):
 *   • --seed-csv <path>  → supplier_product_id,dropship_giga_product_id rows
 *   • --sku <SKU> [--product-id <n>]
 *   • otherwise/--sample → read sellable_products SKUs, resolve product_id from the
 *     giga_delivery_fee_cache.dropship_giga_product_id column (whatever has been seeded).
 *
 * For each SKU: read-only GET the portal price/list, parse the drop_ship fee + 8% buffer
 * (reusing the committed parsers), classify priced | no_mapping | fee_unavailable |
 * parse_error | session_error | other_error.
 *
 * STRICTLY READ-ONLY: only SELECTs Supabase; NEVER writes/upserts; NEVER calls order/Stripe.
 *
 * Run:
 *   npx tsx scripts/auditDropshipFeeCoverage.ts --seed-csv scripts/data/dropship-fee-seed.csv
 *   npx tsx scripts/auditDropshipFeeCoverage.ts --sku W3204P484603 --product-id 1420191
 *   npx tsx scripts/auditDropshipFeeCoverage.ts --sample --limit 10
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { parseDropShipFee, assertReadOnlyUrl, parseSeedCsv, pickProductId, RefreshError } from './refreshGigaDeliveryFees';

const TABLE = 'giga_delivery_fee_cache';
const SESSION_FILE = process.env.GIGA_SESSION_FILE ?? path.join(process.cwd(), 'scripts', '.giga-session.json');
const USER_AGENT = process.env.GIGA_USER_AGENT
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type Status = 'priced' | 'no_mapping' | 'fee_unavailable' | 'parse_error' | 'session_error' | 'other_error';

function loadCookieHeader(): string {
  if (!fs.existsSync(SESSION_FILE)) throw new Error(`Session file not found: ${SESSION_FILE}`);
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { cookies?: { name: string; value: string; domain: string }[] };
  const cookies = (raw.cookies ?? []).filter((c) => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (cookies.length === 0) throw new Error('No gigab2b.com cookies in session file.');
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
function headers(productId: string, cookie: string): Record<string, string> {
  return {
    cookie, 'user-agent': USER_AGENT, accept: 'application/json, text/javascript, */*; q=0.01',
    'x-requested-with': 'XMLHttpRequest', referer: `https://www.gigab2b.com/index.php?route=product/product&product_id=${productId}`,
    'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
  };
}
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local) for read access.');
  return createClient(url, key, { auth: { persistSession: false } });
}
async function sampleSkus(sb: SupabaseClient, limit: number): Promise<string[]> {
  const { data, error } = await sb.from('sellable_products').select('supplier_product_id').limit(limit);
  if (error) throw new Error(`sellable_products read failed: ${error.message}`);
  return Array.from(new Set((data ?? []).map((r: any) => r.supplier_product_id).filter(Boolean)));
}
async function cacheProductId(sb: SupabaseClient, sku: string): Promise<string | null> {
  const { data } = await sb.from(TABLE).select('dropship_giga_product_id').eq('supplier_product_id', sku).maybeSingle();
  const pid = data?.dropship_giga_product_id;
  return pid != null ? String(pid) : null;
}
async function fetchFee(productId: string, cookie: string): Promise<ReturnType<typeof parseDropShipFee>> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/price/list&product_id=${productId}`;
  assertReadOnlyUrl(url);
  const res = await fetch(url, { method: 'GET', headers: headers(productId, cookie), redirect: 'follow' });
  const text = await res.text();
  if (/Safe Checker|captcha|slide to verify/i.test(text)) throw new RefreshError('aliyun_captcha', 'anti-bot challenge');
  if (/route=account\/login|\/login|sign[-_ ]?in/i.test(res.url)) throw new RefreshError('session_expired', 'redirected to login');
  if (!res.ok) throw new RefreshError('http_error', `HTTP ${res.status}`);
  let json: any;
  try { json = JSON.parse(text); } catch { throw new RefreshError('parse_error', 'non-JSON'); }
  return parseDropShipFee(json?.data?.fulfillment_options?.drop_ship);
}
function classify(err: unknown): { status: Status; note: string } {
  const code = err instanceof RefreshError ? err.code : 'unknown';
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'no_drop_ship') return { status: 'fee_unavailable', note: msg };
  if (code === 'parse_error' || code === 'fee_mismatch' || code === 'currency_mismatch') return { status: 'parse_error', note: `${code}: ${msg}` };
  if (code === 'aliyun_captcha' || code === 'session_expired' || code === 'http_error') return { status: 'session_error', note: `${code}: ${msg}` };
  return { status: 'other_error', note: msg };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const explicit: string[] = [];
  let useSample = false, limit = 10, seedCsv: string | undefined, forcedId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sku') explicit.push(argv[++i]);
    else if (a === '--sample') useSample = true;
    else if (a === '--limit') limit = parseInt(argv[++i], 10) || 10;
    else if (a === '--seed-csv') seedCsv = argv[++i];
    else if (a === '--product-id' || a === '--id') forcedId = argv[++i];
    else if (!a.startsWith('--')) explicit.push(a);
  }

  const cookie = loadCookieHeader();
  // Build [sku → seededId?] work list.
  const seedMap = new Map<string, string>();
  let skus: string[];
  let sb: SupabaseClient | null = null;
  if (seedCsv) {
    const { rows, skipped } = parseSeedCsv(fs.readFileSync(seedCsv, 'utf8'));
    rows.forEach((r) => seedMap.set(r.supplierProductId, r.dropshipGigaProductId));
    skus = rows.map((r) => r.supplierProductId);
    skipped.forEach((s) => console.log(`  ⚠ skipped: ${s.line} (${s.reason})`));
  } else if (explicit.length && !useSample) {
    skus = explicit;
    sb = forcedId ? null : getSupabase(); // DB only needed if no forced id
  } else {
    sb = getSupabase();
    skus = await sampleSkus(sb, limit);
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' DROPSHIP DELIVERY-FEE COVERAGE AUDIT (read-only)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Session : ${SESSION_FILE} (cookie ${cookie.length} chars)`);
  console.log(` SKUs    : ${skus.length} | source: ${seedCsv ? 'seed-csv' : (explicit.length && !useSample ? 'explicit' : 'sellable sample')}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const by: Record<Status, number> = { priced: 0, no_mapping: 0, fee_unavailable: 0, parse_error: 0, session_error: 0, other_error: 0 };
  for (const sku of skus) {
    const dbId = sb ? await cacheProductId(sb, sku) : null;
    const { id: productId, source } = pickProductId({ forced: forcedId, seeded: seedMap.get(sku), db: dbId });
    if (!productId) { by.no_mapping++; console.log(`  ${sku.padEnd(16)} no_mapping`); continue; }
    try {
      const p = await fetchFee(productId, cookie);
      by.priced++;
      console.log(`  ${sku.padEnd(16)} pid=${productId.padEnd(9)} via ${source.padEnd(10)} priced  fulfill=${(p.fulfillmentFeeCents/100).toFixed(2)} charged=$${(p.chargedFeeCents/100).toFixed(2)}`);
    } catch (err) {
      const { status, note } = classify(err);
      by[status]++;
      console.log(`  ${sku.padEnd(16)} pid=${productId.padEnd(9)} ${status}  ${note.slice(0, 56)}`);
    }
    await sleep(400);
  }

  const total = skus.length;
  const mapped = total - by.no_mapping;
  console.log('\n─── SUMMARY ───────────────────────────────────────────────');
  console.log(` total=${total} | mapped=${mapped} (${total ? Math.round(mapped/total*100) : 0}%) | priced=${by.priced} (${total ? Math.round(by.priced/total*100) : 0}%) | priced-of-mapped=${mapped ? Math.round(by.priced/mapped*100) : 0}%`);
  console.log(` no_mapping=${by.no_mapping} fee_unavailable=${by.fee_unavailable} parse_error=${by.parse_error} session_error=${by.session_error} other_error=${by.other_error}`);
  console.log('\n(audit only — nothing written to Supabase or the fee cache)');
}

run().catch((e) => { console.error('[auditDropshipFeeCoverage] Fatal:', e instanceof Error ? e.message : e); process.exit(1); });
