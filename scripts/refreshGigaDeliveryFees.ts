/**
 * Refresh cached GIGA Drop Shipping Fulfillment Fees (interim portal source).
 *
 * WHY: official OpenAPI product/price/v1 is blocked by B20003 for Buyer 82482447.
 * Until GIGA enables Product Price access, this server/script-side job reads the
 * GIGA portal internal price endpoint for each SKU and caches the Drop Shipping
 * Fulfillment Fee in public.giga_delivery_fee_cache. Customer checkout will later
 * read ONLY that cached fee (never the portal) in a separate step.
 *
 * READ-ONLY + SAFE:
 *   • Only ever issues GET to read-only product pages (price/list, product, search).
 *   • assertReadOnlyUrl() refuses any URL containing order/sync/dropShip-sync/
 *     pickUp-sync/submit/cancel/stripe, and any route outside the read-only allowlist.
 *   • Never calls an order-creating endpoint, never calls Stripe, never sets secrets.
 *   • Reuses the existing GIGA session cookie (scripts/.giga-session.json).
 *
 * FAILURE BEHAVIOR (never destroys a good fee):
 *   • On any failure, updates last_attempt_at / last_error_* / consecutive_failures only.
 *   • NEVER nulls/overwrites an existing charged_fee_cents. The last successful fee
 *     survives indefinitely (no hard expiration).
 *
 * Run:
 *   DRY_RUN=1 npx tsx scripts/refreshGigaDeliveryFees.ts --sku W3204P484603
 *   DRY_RUN=1 npx tsx scripts/refreshGigaDeliveryFees.ts --product-id 1420191 --sku W3204P484603
 *   npx tsx scripts/refreshGigaDeliveryFees.ts --sku W3204P484603          (real write)
 *   npx tsx scripts/refreshGigaDeliveryFees.ts --all                       (all sellable SKUs)
 *
 * Env:
 *   DRY_RUN=1                — fetch + parse + print, NO database write.
 *   GIGA_SESSION_FILE        — Playwright storageState path (default: scripts/.giga-session.json)
 *   GIGA_USER_AGENT          — UA override
 *   GIGA_DELIVERY_BUFFER_PCT — buffer percent (default 8)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — required for real (non-dry) writes (from .env.local)
 */

import * as dotenv from 'dotenv';
// Load .env.local first (scripts/service-role creds), then .env (does not override).
dotenv.config({ path: '.env.local' });
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const TABLE = 'giga_delivery_fee_cache';
const SOURCE = 'giga_portal_price_list';
const BUFFER_PCT = Number(process.env.GIGA_DELIVERY_BUFFER_PCT ?? '8');

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');
const USER_AGENT = process.env.GIGA_USER_AGENT
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Error codes (mirror the migration's last_error_code domain) ────────────────
export type RefreshErrorCode =
  | 'aliyun_captcha' | 'session_expired' | 'sku_not_found' | 'no_drop_ship'
  | 'parse_error' | 'currency_mismatch' | 'http_error' | 'fee_mismatch';

export class RefreshError extends Error {
  code: RefreshErrorCode;
  constructor(code: RefreshErrorCode, message: string) { super(message); this.code = code; }
}

// ── PURE: read-only URL guard ──────────────────────────────────────────────────
// Refuses any money-moving / order token, and any route outside the read-only allowlist.
const FORBIDDEN_TOKENS = ['order', 'sync', 'dropship-sync', 'pickup-sync', 'submit', 'cancel', 'stripe'];
const READONLY_ROUTES = [
  'route=/product/info/price/list', // the fee endpoint
  'route=product/product',          // sku → product_id resolve (redirect)
  'route=product/search',           // sku → product_id resolve (fallback)
];
export function assertReadOnlyUrl(url: string): void {
  const low = url.toLowerCase();
  for (const t of FORBIDDEN_TOKENS) {
    if (low.includes(t)) throw new Error(`REFUSED: forbidden token "${t}" in URL: ${url}`);
  }
  if (!READONLY_ROUTES.some((r) => low.includes(r.toLowerCase()))) {
    throw new Error(`REFUSED: route not in read-only allowlist: ${url}`);
  }
}

// ── PURE: money parsing ────────────────────────────────────────────────────────
/** "$48.74" | "48.74" | 48.74 → 4874 cents. Returns null if not parseable. */
export function parseMoneyToCents(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/[0-9]/.test(s)) return null;
  // Reject ranges like "$24.83~$28.35" — drop_ship fees are single values.
  if (/[~–—-].*\d/.test(s.replace(/^\s*\$?/, ''))) return null;
  const num = Number(s.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

// ── PURE: 8% buffer, round up to the nearest whole dollar ──────────────────────
export function applyBuffer(fulfillmentFeeCents: number, bufferPct = BUFFER_PCT): number {
  return Math.ceil((fulfillmentFeeCents * (1 + bufferPct / 100)) / 100) * 100;
}

// ── PURE: snapshot — fee-safe fields ONLY (no URLs/cookies/tokens/images) ──────
const SNAPSHOT_KEYS = [
  'package_fee_show', 'shipping_fee_show', 'total_amount', 'total_show',
  'handling_time', 'estimated_ship_day',
] as const;
export function buildFeeSnapshot(dropShip: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of SNAPSHOT_KEYS) {
    if (dropShip[k] === undefined) continue;
    const v = dropShip[k];
    if (k === 'handling_time' || k === 'estimated_ship_day') {
      // keep only the small numeric {min_day,max_day} shape
      if (v && typeof v === 'object') {
        out[k] = { min_day: (v as any).min_day ?? null, max_day: (v as any).max_day ?? null };
      }
    } else {
      // scalars only — never objects/URLs
      if (typeof v === 'string' || typeof v === 'number') out[k] = v;
    }
  }
  return out;
}

export interface ParsedFee {
  packingFeeCents: number;
  shippingFeeCents: number;
  fulfillmentFeeCents: number;
  chargedFeeCents: number;
  currency: string;
  snapshot: Record<string, unknown>;
  rawHash: string;
}

/**
 * PURE: parse a drop_ship block into fee cents + buffered charge.
 * Throws RefreshError (no DB / network) — callers map this to last_error_code.
 * total_amount is authoritative; packing+shipping is validated against it (±2¢).
 */
export function parseDropShipFee(dropShip: Record<string, any> | null | undefined): ParsedFee {
  if (!dropShip || typeof dropShip !== 'object') {
    throw new RefreshError('no_drop_ship', 'drop_ship block missing from fulfillment_options');
  }
  const fulfillmentFeeCents = parseMoneyToCents(dropShip.total_amount);
  if (fulfillmentFeeCents == null || fulfillmentFeeCents <= 0) {
    throw new RefreshError('parse_error', `total_amount not a positive number: ${JSON.stringify(dropShip.total_amount)}`);
  }
  const packingFeeCents = parseMoneyToCents(dropShip.package_fee_show) ?? 0;
  const shippingFeeCents = parseMoneyToCents(dropShip.shipping_fee_show) ?? 0;

  // Fulfillment Fee = Packing + Shipping (allow 2¢ rounding tolerance).
  if (packingFeeCents > 0 && shippingFeeCents > 0) {
    const diff = Math.abs(packingFeeCents + shippingFeeCents - fulfillmentFeeCents);
    if (diff > 2) {
      throw new RefreshError('fee_mismatch',
        `packing(${packingFeeCents}) + shipping(${shippingFeeCents}) != fulfillment(${fulfillmentFeeCents})`);
    }
  }

  // Currency sanity — store is USD; the *_show strings carry a "$".
  const showStr = `${dropShip.total_show ?? ''}${dropShip.shipping_fee_show ?? ''}`;
  if (showStr && !showStr.includes('$')) {
    throw new RefreshError('currency_mismatch', `expected USD "$" in show fields, got: ${showStr}`);
  }

  const snapshot = buildFeeSnapshot(dropShip);
  const rawHash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

  return {
    packingFeeCents,
    shippingFeeCents,
    fulfillmentFeeCents,
    chargedFeeCents: applyBuffer(fulfillmentFeeCents),
    currency: 'USD',
    snapshot,
    rawHash,
  };
}

// ── Session cookie (read-only; never printed) ──────────────────────────────────
interface SessionCookie { name: string; value: string; domain: string; }
function loadCookieHeader(): string {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Session file not found: ${SESSION_FILE} — run: npm run inventory:save-session`);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { cookies?: SessionCookie[] };
  const cookies = (raw.cookies ?? []).filter((c) => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (cookies.length === 0) throw new Error('No gigab2b.com cookies in session file.');
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
function buildHeaders(productRef: string, cookieHeader: string): Record<string, string> {
  return {
    cookie: cookieHeader,
    'user-agent': USER_AGENT,
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    'x-requested-with': 'XMLHttpRequest',
    referer: `https://www.gigab2b.com/index.php?route=product/product&product_id=${encodeURIComponent(productRef)}`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}
function detectChallenge(text: string, finalUrl: string): void {
  if (/Safe Checker|captcha|slide to verify/i.test(text)) {
    throw new RefreshError('aliyun_captcha', 'GIGA anti-bot challenge — refresh session (npm run inventory:save-session)');
  }
  if (/route=account\/login|\/login|sign[-_ ]?in/i.test(finalUrl)) {
    throw new RefreshError('session_expired', 'Redirected to login — GIGA session expired');
  }
}

// ── SKU → numeric giga product_id ──────────────────────────────────────────────
async function resolveGigaProductId(sku: string, cookieHeader: string): Promise<string> {
  // 1) product/product?sku= often 302-redirects to the canonical product_id URL.
  const u1 = `https://www.gigab2b.com/index.php?route=product/product&sku=${encodeURIComponent(sku)}`;
  assertReadOnlyUrl(u1);
  const r1 = await fetch(u1, { method: 'GET', headers: buildHeaders(sku, cookieHeader), redirect: 'manual' });
  const loc = r1.headers.get('location') ?? '';
  const m1 = loc.match(/product_id=(\d{3,9})/);
  if (m1) return m1[1];

  // 2) Fallback: search results HTML contains product_id links.
  const u2 = `https://www.gigab2b.com/index.php?route=product/search&search=${encodeURIComponent(sku)}`;
  assertReadOnlyUrl(u2);
  const r2 = await fetch(u2, { method: 'GET', headers: buildHeaders(sku, cookieHeader), redirect: 'follow' });
  const html = await r2.text();
  detectChallenge(html, r2.url);
  const m2 = html.match(/product_id=(\d{3,9})/);
  if (m2) return m2[1];

  throw new RefreshError('sku_not_found', `Could not resolve a numeric product_id for SKU ${sku}`);
}

// ── Fetch + parse one SKU's fee ────────────────────────────────────────────────
async function fetchFee(gigaProductId: string, cookieHeader: string): Promise<ParsedFee> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/price/list&product_id=${gigaProductId}`;
  assertReadOnlyUrl(url);
  const res = await fetch(url, { method: 'GET', headers: buildHeaders(gigaProductId, cookieHeader), redirect: 'follow' });
  const text = await res.text();
  detectChallenge(text, res.url);
  if (!res.ok) throw new RefreshError('http_error', `HTTP ${res.status} from price/list`);

  let json: any;
  try { json = JSON.parse(text); } catch { throw new RefreshError('parse_error', 'price/list did not return JSON'); }
  const dropShip = json?.data?.fulfillment_options?.drop_ship;
  return parseDropShipFee(dropShip);
}

// ── Supabase ───────────────────────────────────────────────────────────────────
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (set in .env.local) — required for non-dry writes.');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadExisting(supabase: SupabaseClient, sku: string): Promise<any | null> {
  const { data } = await supabase.from(TABLE).select('*').eq('supplier_product_id', sku).maybeSingle();
  return data ?? null;
}

// ── One SKU end-to-end ───────────────────────────────────────────────────────────
interface RefreshOutcome {
  sku: string;
  gigaProductId: string | null;
  ok: boolean;
  parsed?: ParsedFee;
  errorCode?: RefreshErrorCode | 'unknown';
  errorMsg?: string;
}

async function refreshSku(
  sku: string,
  cookieHeader: string,
  supabase: SupabaseClient | null,
  dryRun: boolean,
  forcedProductId?: string,
): Promise<RefreshOutcome> {
  const nowIso = new Date().toISOString();
  let gigaProductId: string | null = forcedProductId ?? null;
  try {
    if (!gigaProductId) gigaProductId = await resolveGigaProductId(sku, cookieHeader);
    const parsed = await fetchFee(gigaProductId, cookieHeader);

    if (!dryRun && supabase) {
      const { error } = await supabase.from(TABLE).upsert({
        supplier_product_id:   sku,
        giga_product_id:       gigaProductId,
        packing_fee_cents:     parsed.packingFeeCents,
        shipping_fee_cents:    parsed.shippingFeeCents,
        fulfillment_fee_cents: parsed.fulfillmentFeeCents,
        charged_fee_cents:     parsed.chargedFeeCents,
        currency:              parsed.currency,
        source:                SOURCE,
        fetched_at:            nowIso,
        last_success_at:       nowIso,
        last_attempt_at:       nowIso,
        last_error_at:         null,
        last_error_code:       null,
        last_error_msg:        null,
        consecutive_failures:  0,
        raw_hash:              parsed.rawHash,
        raw_snapshot:          parsed.snapshot,
      }, { onConflict: 'supplier_product_id' });
      if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
    }
    return { sku, gigaProductId, ok: true, parsed };
  } catch (err) {
    const code: RefreshErrorCode | 'unknown' = err instanceof RefreshError ? err.code : 'unknown';
    const msg = err instanceof Error ? err.message : String(err);

    // FAILURE: record diagnostics only. NEVER touch fee fields / last_success_at.
    if (!dryRun && supabase) {
      const existing = await loadExisting(supabase, sku);
      const failurePayload: Record<string, unknown> = {
        supplier_product_id:  sku,
        last_attempt_at:      nowIso,
        last_error_at:        nowIso,
        last_error_code:      code,
        last_error_msg:       msg.slice(0, 500),
        consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
      };
      if (gigaProductId) failurePayload.giga_product_id = gigaProductId;
      // On a brand-new SKU there is no fee yet → charged_fee_cents stays NULL (→ "Quote required" later).
      await supabase.from(TABLE).upsert(failurePayload, { onConflict: 'supplier_product_id' });
    }
    return { sku, gigaProductId, ok: false, errorCode: code, errorMsg: msg };
  }
}

// ── Target SKU resolution ────────────────────────────────────────────────────────
async function resolveTargetSkus(supabase: SupabaseClient | null, all: boolean, cli: string[]): Promise<string[]> {
  if (cli.length) return cli;
  if (all) {
    if (!supabase) throw new Error('--all requires Supabase credentials.');
    const { data, error } = await supabase
      .from('sellable_products')
      .select('supplier_product_id')
      .not('supplier_product_id', 'is', null);
    if (error) throw new Error(`Failed to list sellable SKUs: ${error.message}`);
    return Array.from(new Set((data ?? []).map((r: any) => r.supplier_product_id).filter(Boolean)));
  }
  return [];
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
interface Args { skus: string[]; all: boolean; productId?: string; }
function parseArgs(argv: string[]): Args {
  const out: Args = { skus: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--sku') out.skus.push(argv[++i]);
    else if (a === '--skus') (argv[++i] ?? '').split(',').forEach((s) => s.trim() && out.skus.push(s.trim()));
    else if (a === '--product-id' || a === '--id') out.productId = argv[++i];
    else if (!a.startsWith('--')) out.skus.push(a);
  }
  return out;
}

async function run(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  const args = parseArgs(process.argv.slice(2));

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA DELIVERY FEE REFRESH (portal source, read-only)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Mode        : ${dryRun ? 'DRY RUN (no DB write)' : 'LIVE (DB write)'}`);
  console.log(` Buffer      : ${BUFFER_PCT}%  (charged = ceil(fulfillment*${(1 + BUFFER_PCT / 100).toFixed(2)} / 100) * 100)`);
  console.log(` Session     : ${SESSION_FILE}`);

  const cookieHeader = loadCookieHeader();
  console.log(` Cookie len  : ${cookieHeader.length} chars`);

  const supabase = dryRun ? null : getSupabase();
  const skus = await resolveTargetSkus(supabase, args.all, args.skus);
  if (skus.length === 0) {
    console.log('\nNo SKUs given. Use --sku <SKU>, --skus a,b,c, or --all.');
    process.exit(2);
  }
  console.log(` Targets     : ${skus.length} SKU(s)`);
  if (args.productId) console.log(` Forced id   : ${args.productId} (resolve skipped)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  let ok = 0, fail = 0;
  for (const sku of skus) {
    const outcome = await refreshSku(sku, cookieHeader, supabase, dryRun, args.productId);
    if (outcome.ok && outcome.parsed) {
      ok++;
      const p = outcome.parsed;
      console.log(`✓ ${sku}  (product_id=${outcome.gigaProductId})`);
      console.log(`    packing      : ${(p.packingFeeCents / 100).toFixed(2)}  (${p.packingFeeCents}¢)`);
      console.log(`    shipping     : ${(p.shippingFeeCents / 100).toFixed(2)}  (${p.shippingFeeCents}¢)`);
      console.log(`    fulfillment  : ${(p.fulfillmentFeeCents / 100).toFixed(2)}  (${p.fulfillmentFeeCents}¢)  ← raw GIGA fee`);
      console.log(`    => charged   : ${(p.chargedFeeCents / 100).toFixed(2)}  (${p.chargedFeeCents}¢)  ← Delivery shown + Stripe charge`);
      console.log(`    snapshot     : ${JSON.stringify(p.snapshot)}`);
      if (dryRun) console.log('    (dry run — nothing written)');
    } else {
      fail++;
      console.log(`✗ ${sku}  (product_id=${outcome.gigaProductId ?? '?'})  [${outcome.errorCode}] ${outcome.errorMsg}`);
      console.log('    existing cached fee (if any) left untouched.');
    }
  }
  console.log(`\n${ok} ok, ${fail} failed. ${dryRun ? '(dry run)' : ''}`);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[refreshGigaDeliveryFees] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
