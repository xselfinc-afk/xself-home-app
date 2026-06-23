/**
 * Refresh cached GIGA Drop Shipping Fulfillment Fees (interim portal source).
 *
 * WHY: official OpenAPI product/price/v1 is blocked by B20003. Until it's enabled, this
 * server/script-side job reads the GIGA portal internal price endpoint for each SKU and
 * caches the Drop Shipping Fulfillment Fee in public.giga_delivery_fee_cache. Customer
 * checkout will later read ONLY that cached fee (never the portal) in a separate step.
 *
 * SKU → numeric product_id resolution (in priority order; NO live SPA scraping):
 *   1. --product-id <n>            (CLI override for a single --sku)
 *   2. --seed-csv row              (supplier_product_id,dropship_giga_product_id)
 *   3. existing cache row          (giga_delivery_fee_cache.dropship_giga_product_id)
 *   else → status 'no_mapping'     (cached fee, if any, is left untouched; checkout will
 *                                   show "Delivery — Quote required" for that SKU)
 * The original GIGA SKU is supplier_product_id. NEVER use sku_custom / sku_search / the
 * stale giga_products table for GIGA lookups.
 *
 * READ-ONLY + SAFE:
 *   • The ONLY GIGA URL built is the read-only price/list endpoint; assertReadOnlyUrl()
 *     refuses anything else and any order/sync/dropShip-sync/pickUp-sync/submit/cancel/stripe.
 *   • Writes ONLY public.giga_delivery_fee_cache — never product/catalog/price tables.
 *   • Never calls an order-creating endpoint, never calls Stripe, never sets secrets.
 *   • Reuses the existing GIGA session cookie (scripts/.giga-session.json).
 *
 * FAILURE BEHAVIOR (never destroys a good fee):
 *   • On any failure/no_mapping, updates last_attempt_at / last_error_* / consecutive_failures
 *     only. NEVER nulls/overwrites an existing charged_fee_cents.
 *
 * Run:
 *   DRY_RUN=1 npx tsx scripts/refreshGigaDeliveryFees.ts --seed-csv scripts/data/dropship-fee-seed.csv
 *   DRY_RUN=1 npx tsx scripts/refreshGigaDeliveryFees.ts --sku W3204P484603 --product-id 1420191
 *   npx tsx scripts/refreshGigaDeliveryFees.ts --seed-csv scripts/data/dropship-fee-seed.csv   (real write)
 *   npx tsx scripts/refreshGigaDeliveryFees.ts --all                                            (mapped cache rows)
 *
 * Env:
 *   DRY_RUN=1                  — fetch + parse + print, NO database write.
 *   GIGA_SESSION_FILE          — Playwright storageState path (default: scripts/.giga-session.json)
 *   GIGA_USER_AGENT            — UA override
 *   GIGA_DELIVERY_BUFFER_PCT   — buffer percent (default 8)
 *   SUPPLIER_DELIVERY_ACCOUNT  — fee_source_account label (default 'dropship_82482447')
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — required for non-dry writes / DB resolution (.env.local)
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
const FEE_SOURCE_ACCOUNT = process.env.SUPPLIER_DELIVERY_ACCOUNT ?? 'dropship_82482447';

const SESSION_FILE = process.env.GIGA_SESSION_FILE
  ?? path.join(process.cwd(), 'scripts', '.giga-session.json');
const USER_AGENT = process.env.GIGA_USER_AGENT
  ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Error codes (mirror the migration's last_error_code domain) ────────────────
export type RefreshErrorCode =
  | 'aliyun_captcha' | 'session_expired' | 'no_drop_ship'
  | 'parse_error' | 'currency_mismatch' | 'http_error' | 'fee_mismatch';

export class RefreshError extends Error {
  code: RefreshErrorCode;
  constructor(code: RefreshErrorCode, message: string) { super(message); this.code = code; }
}

// ── PURE: read-only URL guard ──────────────────────────────────────────────────
// ONLY the read-only price/list endpoint is allowed. Any money-moving / order token, or any
// other route (including the old SPA search/product resolver paths), is refused.
const FORBIDDEN_TOKENS = ['order', 'sync', 'dropship-sync', 'pickup-sync', 'submit', 'cancel', 'stripe'];
const READONLY_ROUTES = ['route=/product/info/price/list'];
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
      if (v && typeof v === 'object') {
        out[k] = { min_day: (v as any).min_day ?? null, max_day: (v as any).max_day ?? null };
      }
    } else {
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
 * Throws RefreshError (no DB / network). total_amount is authoritative; packing+shipping is
 * validated against it (±2¢) to confirm "Fulfillment Fee = Packing + Shipping".
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

  if (packingFeeCents > 0 && shippingFeeCents > 0) {
    const diff = Math.abs(packingFeeCents + shippingFeeCents - fulfillmentFeeCents);
    if (diff > 2) {
      throw new RefreshError('fee_mismatch',
        `packing(${packingFeeCents}) + shipping(${shippingFeeCents}) != fulfillment(${fulfillmentFeeCents})`);
    }
  }

  const showStr = `${dropShip.total_show ?? ''}${dropShip.shipping_fee_show ?? ''}`;
  if (showStr && !showStr.includes('$')) {
    throw new RefreshError('currency_mismatch', `expected USD "$" in show fields, got: ${showStr}`);
  }

  const snapshot = buildFeeSnapshot(dropShip);
  const rawHash = crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

  return {
    packingFeeCents, shippingFeeCents, fulfillmentFeeCents,
    chargedFeeCents: applyBuffer(fulfillmentFeeCents),
    currency: 'USD', snapshot, rawHash,
  };
}

// ── PURE: seed CSV parser (supplier_product_id,dropship_giga_product_id) ─────────
export interface SeedRow { supplierProductId: string; dropshipGigaProductId: string; }
export interface SeedParse { rows: SeedRow[]; skipped: Array<{ line: string; reason: string }>; }
/** Parse the seed CSV. Header optional. Numeric product_id required (3–9 digits). */
export function parseSeedCsv(text: string): SeedParse {
  const rows: SeedRow[] = [];
  const skipped: Array<{ line: string; reason: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map((p) => p.trim());
    const [sku, id] = parts;
    // header row
    if (/^supplier_product_id$/i.test(sku) && /^dropship_giga_product_id$/i.test(id ?? '')) continue;
    if (!sku || !id) { skipped.push({ line, reason: 'missing column' }); continue; }
    if (!/^\d{3,9}$/.test(id)) { skipped.push({ line, reason: `non-numeric product_id "${id}"` }); continue; }
    if (/^XH-|sku_custom/i.test(sku)) { skipped.push({ line, reason: 'looks like sku_custom, not original GIGA SKU' }); continue; }
    rows.push({ supplierProductId: sku, dropshipGigaProductId: id });
  }
  return { rows, skipped };
}

// ── PURE: product_id resolution precedence (no scraping) ───────────────────────
export type ProductIdSource = 'cli' | 'manual_csv' | 'db' | 'none';
export function pickProductId(opts: { forced?: string | null; seeded?: string | null; db?: string | null }): { id: string | null; source: ProductIdSource } {
  if (opts.forced) return { id: String(opts.forced), source: 'cli' };
  if (opts.seeded) return { id: String(opts.seeded), source: 'manual_csv' };
  if (opts.db) return { id: String(opts.db), source: 'db' };
  return { id: null, source: 'none' };
}

// ── Session cookie (read-only; never printed) ──────────────────────────────────
interface SessionCookie { name: string; value: string; domain: string; }
export function loadCookieHeader(): string {
  if (!fs.existsSync(SESSION_FILE)) {
    throw new Error(`Session file not found: ${SESSION_FILE} — run: npm run inventory:save-session`);
  }
  const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { cookies?: SessionCookie[] };
  const cookies = (raw.cookies ?? []).filter((c) => /(^|\.)gigab2b\.com$/.test(c.domain));
  if (cookies.length === 0) throw new Error('No gigab2b.com cookies in session file.');
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
function buildHeaders(productId: string, cookieHeader: string): Record<string, string> {
  return {
    cookie: cookieHeader,
    'user-agent': USER_AGENT,
    accept: 'application/json, text/javascript, */*; q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    'x-requested-with': 'XMLHttpRequest',
    referer: `https://www.gigab2b.com/index.php?route=product/product&product_id=${encodeURIComponent(productId)}`,
    'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin',
  };
}

// ── Fetch + parse one product_id's fee (read-only) ─────────────────────────────
export async function fetchFee(gigaProductId: string, cookieHeader: string): Promise<ParsedFee> {
  const url = `https://www.gigab2b.com/index.php?route=/product/info/price/list&product_id=${gigaProductId}`;
  assertReadOnlyUrl(url);
  const res = await fetch(url, { method: 'GET', headers: buildHeaders(gigaProductId, cookieHeader), redirect: 'follow' });
  const text = await res.text();
  if (/Safe Checker|captcha|slide to verify/i.test(text)) {
    throw new RefreshError('aliyun_captcha', 'GIGA anti-bot challenge — refresh session (npm run inventory:save-session)');
  }
  if (/route=account\/login|\/login|sign[-_ ]?in/i.test(res.url)) {
    throw new RefreshError('session_expired', 'Redirected to login — GIGA session expired');
  }
  if (!res.ok) throw new RefreshError('http_error', `HTTP ${res.status} from price/list`);
  let json: any;
  try { json = JSON.parse(text); } catch { throw new RefreshError('parse_error', 'price/list did not return JSON'); }
  return parseDropShipFee(json?.data?.fulfillment_options?.drop_ship);
}

// ── Supabase (DB resolution + writes ONLY to the fee cache table) ──────────────
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (set in .env.local).');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
async function loadExisting(supabase: SupabaseClient, sku: string): Promise<any | null> {
  const { data } = await supabase.from(TABLE).select('*').eq('supplier_product_id', sku).maybeSingle();
  return data ?? null;
}

// ── One SKU end-to-end ───────────────────────────────────────────────────────────
type Status = 'priced' | 'no_mapping' | 'fee_unavailable' | 'parse_error' | 'session_error' | 'other_error';
interface Outcome { sku: string; productId: string | null; idSource: ProductIdSource; status: Status; parsed?: ParsedFee; note?: string; }

function classify(err: unknown): { status: Status; note: string } {
  const code = err instanceof RefreshError ? err.code : 'unknown';
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'no_drop_ship') return { status: 'fee_unavailable', note: msg };
  if (code === 'parse_error' || code === 'fee_mismatch' || code === 'currency_mismatch') return { status: 'parse_error', note: `${code}: ${msg}` };
  if (code === 'aliyun_captcha' || code === 'session_expired' || code === 'http_error') return { status: 'session_error', note: `${code}: ${msg}` };
  return { status: 'other_error', note: msg };
}

async function refreshSku(
  sku: string,
  cookieHeader: string,
  supabase: SupabaseClient | null,
  dryRun: boolean,
  opts: { forcedProductId?: string; seededProductId?: string } = {},
): Promise<Outcome> {
  const nowIso = new Date().toISOString();
  const existing = supabase ? await loadExisting(supabase, sku) : null;
  const { id: productId, source: idSource } = pickProductId({
    forced: opts.forcedProductId,
    seeded: opts.seededProductId,
    db: existing?.dropship_giga_product_id ? String(existing.dropship_giga_product_id) : null,
  });

  // ── No numeric product_id from any non-scraping source → no_mapping ──
  if (!productId) {
    if (!dryRun && supabase) {
      await supabase.from(TABLE).upsert({
        supplier_product_id: sku,
        last_attempt_at: nowIso,
        last_error_at: nowIso,
        last_error_code: 'no_mapping',
        last_error_msg: 'no dropship_giga_product_id (seed via --seed-csv / --product-id)',
        consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
      }, { onConflict: 'supplier_product_id' });
    }
    return { sku, productId: null, idSource, status: 'no_mapping' };
  }

  try {
    const parsed = await fetchFee(productId, cookieHeader);
    if (!dryRun && supabase) {
      const { error } = await supabase.from(TABLE).upsert({
        supplier_product_id: sku,
        dropship_giga_product_id: productId,
        product_id_source: idSource === 'db' ? (existing?.product_id_source ?? 'db') : idSource,
        product_id_resolved_at: nowIso,
        packing_fee_cents: parsed.packingFeeCents,
        shipping_fee_cents: parsed.shippingFeeCents,
        fulfillment_fee_cents: parsed.fulfillmentFeeCents,
        charged_fee_cents: parsed.chargedFeeCents,
        currency: parsed.currency,
        source: SOURCE,
        fee_source_account: FEE_SOURCE_ACCOUNT,
        fetched_at: nowIso,
        last_success_at: nowIso,
        last_attempt_at: nowIso,
        last_error_at: null,
        last_error_code: null,
        last_error_msg: null,
        consecutive_failures: 0,
        raw_hash: parsed.rawHash,
        raw_snapshot: parsed.snapshot,
      }, { onConflict: 'supplier_product_id' });
      if (error) throw new Error(`Supabase upsert failed: ${error.message}`);
    }
    return { sku, productId, idSource, status: 'priced', parsed };
  } catch (err) {
    const { status, note } = classify(err);
    // FAILURE: record diagnostics only. NEVER touch fee fields / last_success_at.
    if (!dryRun && supabase) {
      await supabase.from(TABLE).upsert({
        supplier_product_id: sku,
        dropship_giga_product_id: productId,
        last_attempt_at: nowIso,
        last_error_at: nowIso,
        last_error_code: err instanceof RefreshError ? err.code : 'other_error',
        last_error_msg: note.slice(0, 500),
        consecutive_failures: (existing?.consecutive_failures ?? 0) + 1,
      }, { onConflict: 'supplier_product_id' });
    }
    return { sku, productId, idSource, status, note };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Target resolution ─────────────────────────────────────────────────────────
/** --all → SKUs that already have a mapping (dropship_giga_product_id) in the cache. */
async function mappedSkus(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from(TABLE).select('supplier_product_id').not('dropship_giga_product_id', 'is', null);
  if (error) throw new Error(`cache read failed: ${error.message}`);
  return (data ?? []).map((r: any) => r.supplier_product_id).filter(Boolean);
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
interface Args { skus: string[]; all: boolean; productId?: string; seedCsv?: string; }
function parseArgs(argv: string[]): Args {
  const out: Args = { skus: [], all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--sku') out.skus.push(argv[++i]);
    else if (a === '--skus') (argv[++i] ?? '').split(',').forEach((s) => s.trim() && out.skus.push(s.trim()));
    else if (a === '--product-id' || a === '--id') out.productId = argv[++i];
    else if (a === '--seed-csv') out.seedCsv = argv[++i];
    else if (!a.startsWith('--')) out.skus.push(a);
  }
  return out;
}

function printOutcome(o: Outcome, dryRun: boolean): void {
  if (o.status === 'priced' && o.parsed) {
    const p = o.parsed;
    console.log(`✓ ${o.sku}  (product_id=${o.productId}, via ${o.idSource})`);
    console.log(`    packing      : ${(p.packingFeeCents / 100).toFixed(2)}  (${p.packingFeeCents}¢)`);
    console.log(`    shipping     : ${(p.shippingFeeCents / 100).toFixed(2)}  (${p.shippingFeeCents}¢)`);
    console.log(`    fulfillment  : ${(p.fulfillmentFeeCents / 100).toFixed(2)}  (${p.fulfillmentFeeCents}¢)  ← raw GIGA fee`);
    console.log(`    => charged   : ${(p.chargedFeeCents / 100).toFixed(2)}  (${p.chargedFeeCents}¢)  ← Delivery shown + Stripe charge`);
    console.log(`    snapshot     : ${JSON.stringify(p.snapshot)}`);
    if (dryRun) console.log('    (dry run — nothing written)');
  } else if (o.status === 'no_mapping') {
    console.log(`• ${o.sku}  no_mapping (no dropship_giga_product_id) → Delivery would be "Quote required"`);
  } else {
    console.log(`✗ ${o.sku}  (product_id=${o.productId ?? '?'})  [${o.status}] ${o.note ?? ''}`);
    console.log('    existing cached fee (if any) left untouched.');
  }
}

async function run(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1';
  const args = parseArgs(process.argv.slice(2));

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA DELIVERY FEE REFRESH (portal source, read-only)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Mode        : ${dryRun ? 'DRY RUN (no DB write)' : 'LIVE (DB write)'}`);
  console.log(` Buffer      : ${BUFFER_PCT}%  (charged = ceil(fulfillment*${(1 + BUFFER_PCT / 100).toFixed(2)} / 100) * 100)`);
  console.log(` Fee account : ${FEE_SOURCE_ACCOUNT}`);
  console.log(` Session     : ${SESSION_FILE}`);

  const cookieHeader = loadCookieHeader();
  console.log(` Cookie len  : ${cookieHeader.length} chars`);

  // Supabase is needed for: any LIVE write, DB-resolution (--sku/--all without CSV/--product-id), and --all.
  // A dry-run --seed-csv (ids provided) or dry-run --sku --product-id needs NO Supabase.
  const needsDb = !dryRun || args.all || (args.skus.length > 0 && !args.productId && !args.seedCsv);
  const supabase = needsDb ? getSupabase() : null;

  const outcomes: Outcome[] = [];

  if (args.seedCsv) {
    const text = fs.readFileSync(args.seedCsv, 'utf8');
    const { rows, skipped } = parseSeedCsv(text);
    console.log(` Seed CSV    : ${args.seedCsv} (${rows.length} valid rows, ${skipped.length} skipped)`);
    console.log('═══════════════════════════════════════════════════════════\n');
    for (const { line, reason } of skipped) console.log(`  ⚠ skipped: ${line}  (${reason})`);
    for (const row of rows) {
      const o = await refreshSku(row.supplierProductId, cookieHeader, supabase, dryRun, { seededProductId: row.dropshipGigaProductId });
      outcomes.push(o); printOutcome(o, dryRun);
      await sleep(400);
    }
  } else {
    const skus = args.all && supabase ? await mappedSkus(supabase) : args.skus;
    console.log(` Targets     : ${skus.length} SKU(s)${args.productId ? `  | forced id ${args.productId}` : ''}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    if (skus.length === 0) { console.log('No SKUs. Use --seed-csv <path>, --sku <SKU> [--product-id <n>], or --all.'); process.exit(2); }
    for (const sku of skus) {
      const o = await refreshSku(sku, cookieHeader, supabase, dryRun, { forcedProductId: args.productId });
      outcomes.push(o); printOutcome(o, dryRun);
      await sleep(400);
    }
  }

  const by: Record<Status, number> = { priced: 0, no_mapping: 0, fee_unavailable: 0, parse_error: 0, session_error: 0, other_error: 0 };
  for (const o of outcomes) by[o.status]++;
  console.log(`\n${by.priced} priced, ${by.no_mapping} no_mapping, ${by.fee_unavailable} fee_unavailable, ${by.parse_error} parse_error, ${by.session_error} session_error, ${by.other_error} other_error. ${dryRun ? '(dry run)' : ''}`);
  console.log('--- secret never printed; only giga_delivery_fee_cache written; no order endpoint called ---');
}

if (require.main === module) {
  run().catch((err) => {
    console.error('[refreshGigaDeliveryFees] Fatal:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
