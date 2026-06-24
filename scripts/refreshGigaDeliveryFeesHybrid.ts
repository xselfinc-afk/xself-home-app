/**
 * Hybrid GIGA Drop Shipping Fulfillment-Fee refresh.
 *
 * Priority: OFFICIAL GIGA OpenAPI product/price/v1 first → per-SKU fallback to the existing
 * PORTAL price/list scraper (reused from refreshGigaDeliveryFees.ts) when official fails →
 * write public.giga_delivery_fee_cache. Checkout keeps reading the cache (unchanged).
 *
 * Field rule (official):
 *   rawFee = shippingFee ?? shippingFeeRange.maxAmount
 *   NEVER-UNDERCHARGE guard: if both exist and maxAmount > shippingFee, use maxAmount + warn.
 *   internationalFulfillmentFees is NOT used (empty for domestic US responses).
 * Buffer: charged_fee_cents = applyBuffer(rawFeeCents, 8)  (reused — buffer math unchanged).
 *
 * SAFETY:
 *   • Read-only GIGA endpoints only (official price/v1 + portal price/list). No order endpoints.
 *   • Writes ONLY giga_delivery_fee_cache. On BOTH-source failure, updates failure metadata ONLY
 *     and NEVER nulls/zeroes/overwrites an existing charged_fee_cents.
 *   • DRY_RUN=1 → fetch + decide + print, NO DB write.
 *   • Never logs client_secret / sign / nonce / cookies / headers; raw_snapshot is fee-safe only.
 *
 * Run:
 *   DRY_RUN=1 npx tsx scripts/refreshGigaDeliveryFeesHybrid.ts --sku W409P327401
 *   npx tsx scripts/refreshGigaDeliveryFeesHybrid.ts --skus W409P327407,W2899P372844
 *   npx tsx scripts/refreshGigaDeliveryFeesHybrid.ts --all          (sellable_products SKUs)
 *
 * Env:
 *   SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID / _SECRET   official creds (runtime env; never a file)
 *   SUPPLIER_DELIVERY_API_BASE_URL                     default https://openapi.gigab2b.com
 *   GIGA_SESSION_FILE                                  portal fallback session (default scripts/.giga-session.json)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY           cache read/write (.env.local)
 *   GIGA_DELIVERY_BUFFER_PCT                           default 8
 *   DRY_RUN=1                                          no DB write
 */
import * as dotenv from 'dotenv';
// Dropship delivery-fee creds: .env.giga-delivery.local (untracked) loads FIRST so a fresh terminal
// works without re-exporting secrets; dotenv never overrides already-exported env. .env.local still
// supplies Supabase. (.env.giga-alt.local is the PICKUP/saved-list account — intentionally NOT loaded here.)
dotenv.config({ path: '.env.giga-delivery.local' });
dotenv.config({ path: '.env.local' });
dotenv.config();

import * as crypto from 'crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  applyBuffer,
  fetchFee,
  loadCookieHeader,
  pickProductId,
  RefreshError,
  type ParsedFee,
} from './refreshGigaDeliveryFees';

const TABLE = 'giga_delivery_fee_cache';
const FEE_SOURCE_ACCOUNT = process.env.SUPPLIER_DELIVERY_ACCOUNT ?? 'dropship_82482447';
const BUFFER_PCT = Number(process.env.GIGA_DELIVERY_BUFFER_PCT ?? '8');
const DRY_RUN = process.env.DRY_RUN === '1';

const SOURCE_OFFICIAL = 'giga_openapi_price_v1';
const SOURCE_FALLBACK = 'giga_openapi_price_v1_fallback_portal';

const OFFICIAL_BASE = process.env.SUPPLIER_DELIVERY_API_BASE_URL ?? 'https://openapi.gigab2b.com';
const OFFICIAL_CID = process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID ?? '';
const OFFICIAL_SEC = process.env.SUPPLIER_DELIVERY_PRODUCTION_CLIENT_SECRET ?? '';
const PRICE_PATH = '/b2b-overseas-api/v1/buyer/product/price/v1';

// ── PURE: official price row + fee picker ─────────────────────────────────────
export interface OfficialPriceRow {
  sku: string;
  currency?: string | null;
  price?: number | null;
  shippingFee?: number | null;
  shippingFeeRange?: { minAmount?: number | null; maxAmount?: number | null } | null;
  internationalFulfillmentFees?: unknown;
  skuAvailable?: boolean | null;
}
export type OfficialPick =
  | { status: 'ok'; rawFeeCents: number; currency: string; usedField: 'shippingFee' | 'shippingFeeRange.maxAmount'; warning?: string }
  | { status: 'no_fee' | 'currency_mismatch' | 'unavailable'; reason: string };

/**
 * PURE. Apply the field rule to an official price/v1 row:
 *   rawFee = shippingFee, falling back to shippingFeeRange.maxAmount.
 *   Never-undercharge: if both present and maxAmount > shippingFee → use maxAmount (+ warning).
 * Returns cents (rounded) or a non-ok status. NO network, NO secrets.
 */
export function pickOfficialRawFeeCents(row: OfficialPriceRow | undefined | null, expectedCurrency = 'USD'): OfficialPick {
  if (!row) return { status: 'unavailable', reason: 'no_row' };
  if (row.skuAvailable === false) return { status: 'unavailable', reason: 'sku_unavailable' };
  if (row.currency && row.currency !== expectedCurrency) return { status: 'currency_mismatch', reason: `currency=${row.currency}` };

  const sf = typeof row.shippingFee === 'number' ? row.shippingFee : null;
  const mx = typeof row.shippingFeeRange?.maxAmount === 'number' ? row.shippingFeeRange!.maxAmount! : null;

  let raw: number | null = null;
  let usedField: 'shippingFee' | 'shippingFeeRange.maxAmount' = 'shippingFee';
  let warning: string | undefined;

  if (sf != null) {
    raw = sf; usedField = 'shippingFee';
    if (mx != null && mx > sf + 0.005) {            // never-undercharge guard
      raw = mx; usedField = 'shippingFeeRange.maxAmount';
      warning = `maxAmount ${mx} > shippingFee ${sf} — using maxAmount to avoid undercharge`;
    }
  } else if (mx != null) {
    raw = mx; usedField = 'shippingFeeRange.maxAmount';
  }

  if (raw == null || raw <= 0) return { status: 'no_fee', reason: 'missing shippingFee and shippingFeeRange.maxAmount' };
  return { status: 'ok', rawFeeCents: Math.round(raw * 100), currency: row.currency ?? expectedCurrency, usedField, warning };
}

// ── PURE: failure-only upsert (NEVER touches fee columns) ─────────────────────
/** Diagnostics-only patch for a both-sources-failed SKU. Excludes ALL fee columns so a valid
 *  cached charged_fee_cents is preserved. */
export function buildFailureUpsert(sku: string, prevFailures: number, code: string, msg: string, nowIso: string): Record<string, unknown> {
  return {
    supplier_product_id: sku,
    last_attempt_at: nowIso,
    last_error_at: nowIso,
    last_error_code: code,
    last_error_msg: msg.slice(0, 500),
    consecutive_failures: (prevFailures ?? 0) + 1,
  };
}

// ── PURE: official-success cache row ──────────────────────────────────────────
export function buildOfficialUpsert(sku: string, pick: Extract<OfficialPick, { status: 'ok' }>, raw: OfficialPriceRow, nowIso: string): Record<string, unknown> {
  const fulfillment = pick.rawFeeCents;
  const snapshot = {
    sku: raw.sku, currency: raw.currency ?? null, price: raw.price ?? null,
    shippingFee: raw.shippingFee ?? null, shippingFeeRange: raw.shippingFeeRange ?? null,
  };
  return {
    supplier_product_id: sku,
    product_id_source: 'official_api',
    dropship_giga_product_id: null,
    packing_fee_cents: null,
    shipping_fee_cents: fulfillment,        // official has no split; shippingFee IS the value
    fulfillment_fee_cents: fulfillment,     // raw official fee
    charged_fee_cents: applyBuffer(fulfillment, BUFFER_PCT),
    currency: pick.currency,
    source: SOURCE_OFFICIAL,
    fee_source_account: FEE_SOURCE_ACCOUNT,
    fetched_at: nowIso, last_success_at: nowIso, last_attempt_at: nowIso,
    last_error_at: null, last_error_code: null, last_error_msg: null, consecutive_failures: 0,
    raw_hash: crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    raw_snapshot: snapshot,
  };
}

// ── PURE: portal-fallback-success cache row (from reused parseDropShipFee result) ─────────────
export function buildPortalUpsert(sku: string, productId: string, parsed: ParsedFee, nowIso: string): Record<string, unknown> {
  return {
    supplier_product_id: sku,
    dropship_giga_product_id: productId,
    product_id_source: 'db',
    product_id_resolved_at: nowIso,
    packing_fee_cents: parsed.packingFeeCents,
    shipping_fee_cents: parsed.shippingFeeCents,
    fulfillment_fee_cents: parsed.fulfillmentFeeCents,
    charged_fee_cents: parsed.chargedFeeCents,
    currency: parsed.currency,
    source: SOURCE_FALLBACK,
    fee_source_account: FEE_SOURCE_ACCOUNT,
    fetched_at: nowIso, last_success_at: nowIso, last_attempt_at: nowIso,
    last_error_at: null, last_error_code: null, last_error_msg: null, consecutive_failures: 0,
    raw_hash: parsed.rawHash, raw_snapshot: parsed.snapshot,
  };
}

// ── Official batch fetch (signed). Throws → caller treats whole batch as official-unavailable. ──
function nonce(n = 10): string { const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let r = ''; for (let i = 0; i < n; i++) r += c[Math.floor(Math.random() * c.length)]; return r; }
function signOfficial(path: string, ts: string, nc: string): string {
  return Buffer.from(crypto.createHmac('sha256', `${OFFICIAL_CID}&${OFFICIAL_SEC}&${nc}`).update(`${OFFICIAL_CID}&${path}&${ts}&${nc}`).digest('hex'), 'utf8').toString('base64');
}
async function fetchOfficialPrices(skus: string[]): Promise<{ map: Map<string, OfficialPriceRow>; note: string }> {
  if (!OFFICIAL_CID || !OFFICIAL_SEC) return { map: new Map(), note: 'official_creds_missing → all SKUs use portal fallback' };
  const ts = Date.now().toString(), nc = nonce();
  let res: Response, text: string;
  try {
    res = await fetch(`${OFFICIAL_BASE}${PRICE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'client-id': OFFICIAL_CID, timestamp: ts, nonce: nc, sign: signOfficial(PRICE_PATH, ts, nc) },
      body: JSON.stringify({ skus }),
    });
    text = await res.text();
  } catch (e) { return { map: new Map(), note: `official_network_error: ${String(e).slice(0, 60)}` }; }
  let j: any = null; try { j = JSON.parse(text); } catch { return { map: new Map(), note: 'official_non_json' }; }
  if (!(j?.success === true || String(j?.code) === '200')) {
    return { map: new Map(), note: `official_api_error code=${j?.code} msg=${(j?.msg || j?.subMsg || '').toString().slice(0, 60)}` };
  }
  const data = Array.isArray(j.data) ? j.data : (j.data?.list || j.data?.records || []);
  const map = new Map<string, OfficialPriceRow>();
  for (const r of data) if (r && typeof r.sku === 'string') map.set(r.sku, r as OfficialPriceRow);
  return { map, note: `official_ok rows=${map.size}` };
}

// ── Supabase ──────────────────────────────────────────────────────────────────
function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('Missing SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local).');
  return createClient(url, key, { auth: { persistSession: false } });
}
async function loadExisting(supabase: SupabaseClient, sku: string): Promise<any | null> {
  const { data } = await supabase.from(TABLE).select('*').eq('supplier_product_id', sku).maybeSingle();
  return data ?? null;
}

type Outcome = 'official' | 'portal_fallback' | 'both_failed_preserved' | 'no_mapping_preserved';

async function processSku(
  supabase: SupabaseClient, sku: string, officialRow: OfficialPriceRow | undefined,
  cookieHeader: string | null, forcedProductId: string | undefined,
): Promise<{ outcome: Outcome; detail: string; wouldWrite: Record<string, unknown> | null }> {
  const nowIso = new Date().toISOString();
  const existing = await loadExisting(supabase, sku);

  // 1) Official first
  const pick = pickOfficialRawFeeCents(officialRow);
  if (pick.status === 'ok') {
    const patch = buildOfficialUpsert(sku, pick, officialRow!, nowIso);
    if (pick.warning) console.warn(`  ⚠ ${sku}: ${pick.warning}`);
    if (!DRY_RUN) { const { error } = await supabase.from(TABLE).upsert(patch, { onConflict: 'supplier_product_id' }); if (error) throw new Error(`upsert(official) ${sku}: ${error.message}`); }
    return { outcome: 'official', detail: `${pick.usedField} → fulfillment=${pick.rawFeeCents}¢ charged=${patch.charged_fee_cents}¢`, wouldWrite: patch };
  }

  // 2) Portal fallback (reuse refreshGigaDeliveryFees.fetchFee)
  const { id: productId } = pickProductId({ forced: forcedProductId, seeded: null, db: existing?.dropship_giga_product_id ? String(existing.dropship_giga_product_id) : null });
  if (productId && cookieHeader) {
    try {
      const parsed = await fetchFee(productId, cookieHeader);
      const patch = buildPortalUpsert(sku, productId, parsed, nowIso);
      if (!DRY_RUN) { const { error } = await supabase.from(TABLE).upsert(patch, { onConflict: 'supplier_product_id' }); if (error) throw new Error(`upsert(portal) ${sku}: ${error.message}`); }
      return { outcome: 'portal_fallback', detail: `official=${pick.status}(${pick.reason}) → portal charged=${patch.charged_fee_cents}¢`, wouldWrite: patch };
    } catch (err) {
      const code = err instanceof RefreshError ? err.code : 'portal_error';
      const patch = buildFailureUpsert(sku, existing?.consecutive_failures ?? 0, code, `official=${pick.reason}; portal=${(err as Error).message}`, nowIso);
      if (!DRY_RUN) await supabase.from(TABLE).upsert(patch, { onConflict: 'supplier_product_id' });   // diagnostics only — fee preserved
      return { outcome: 'both_failed_preserved', detail: `official=${pick.status}; portal=${code}; existing charged=${existing?.charged_fee_cents ?? 'none'} PRESERVED`, wouldWrite: patch };
    }
  }

  // 3) Official unusable + no portal mapping → diagnostics only, preserve existing
  const patch = buildFailureUpsert(sku, existing?.consecutive_failures ?? 0, 'no_mapping', `official=${pick.reason}; no dropship_giga_product_id for portal fallback`, nowIso);
  if (!DRY_RUN) await supabase.from(TABLE).upsert(patch, { onConflict: 'supplier_product_id' });
  return { outcome: 'no_mapping_preserved', detail: `official=${pick.status}(${pick.reason}); no portal mapping; existing charged=${existing?.charged_fee_cents ?? 'none'} PRESERVED`, wouldWrite: patch };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { skus: string[]; all: boolean; productId?: string } {
  const out: { skus: string[]; all: boolean; productId?: string } = { skus: [], all: false };
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
  const args = parseArgs(process.argv.slice(2));
  const supabase = getSupabase();

  let skus = args.skus;
  if (args.all) {
    const { data, error } = await supabase.from('sellable_products').select('supplier_product_id');
    if (error) throw new Error(`sellable_products read failed: ${error.message}`);
    skus = [...new Set((data ?? []).map((r: any) => String(r.supplier_product_id)).filter(Boolean))];
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' GIGA DELIVERY FEE — HYBRID (official price/v1 → portal fallback)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` Mode        : ${DRY_RUN ? 'DRY RUN (no DB write)' : 'LIVE (DB write)'}`);
  console.log(` Buffer      : ${BUFFER_PCT}%`);
  console.log(` Official    : ${OFFICIAL_CID ? `creds present (client-id ${OFFICIAL_CID.slice(0, 4)}…)` : 'NO creds → portal fallback only'}`);
  if (!OFFICIAL_CID) console.log(' ⚠ Missing dropship delivery credentials. Create .env.giga-delivery.local or export SUPPLIER_DELIVERY_PRODUCTION_CLIENT_ID/SECRET.');
  console.log(` Targets     : ${skus.length} SKU(s)${args.productId ? `  (forced product_id ${args.productId})` : ''}`);
  console.log('═══════════════════════════════════════════════════════════');
  if (skus.length === 0) { console.log('No SKUs. Use --sku/--skus/--all.'); process.exit(2); }

  const { map: officialMap, note } = await fetchOfficialPrices(skus);
  console.log(` Official fetch: ${note}\n`);

  // Portal session is needed only if any SKU will fall back. Load lazily/safely.
  let cookieHeader: string | null = null;
  try { cookieHeader = loadCookieHeader(); } catch (e) { console.warn(` (portal session unavailable: ${(e as Error).message.slice(0, 70)} — fallback disabled)`); }

  const tally: Record<Outcome, number> = { official: 0, portal_fallback: 0, both_failed_preserved: 0, no_mapping_preserved: 0 };
  for (const sku of skus) {
    const r = await processSku(supabase, sku, officialMap.get(sku), cookieHeader, args.productId);
    tally[r.outcome]++;
    const tag = r.outcome === 'official' ? '✓ official' : r.outcome === 'portal_fallback' ? '✓ portal' : '• preserved';
    console.log(`${tag.padEnd(12)} ${sku.padEnd(14)} ${r.detail}${DRY_RUN ? '  [dry]' : ''}`);
  }

  console.log(`\n${tally.official} official, ${tally.portal_fallback} portal-fallback, ${tally.both_failed_preserved} both-failed(preserved), ${tally.no_mapping_preserved} no-mapping(preserved). ${DRY_RUN ? '(dry run — no writes)' : ''}`);
  console.log('--- secrets never printed; only giga_delivery_fee_cache written (live mode); no order endpoint called ---');
}

if (require.main === module) {
  run().catch((err) => { console.error('[refreshGigaDeliveryFeesHybrid] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
