/**
 * Source of truth for normalization: /NORMALIZATION_ENGINE.md
 * This tool does NOT add UI-side cleaning/formatting — it feeds operator-supplied
 * data through the EXISTING normalizeProduct() engine. Do not reimplement normalization.
 *
 * gigaManualProductUpload.ts — MANUAL EMERGENCY single-SKU product upload.
 *
 * Emergency fallback for when the GIGA saved-list / detail APIs are DOWN and the normal
 * saved-to-live import cannot fetch product data. The operator supplies the product data in
 * a JSON file; this tool validates it, runs it through the canonical normalizeProduct()
 * engine, and (on --confirm) writes supplier_products + standardized_products + inventory_cache
 * for ONE SKU, then calls refresh_product_inventory_status so the product can go live.
 *
 *   PLAN  (default, read-only DB, writes only a local report):
 *     npm run giga:manual-product:plan  -- --sku W80870283 --folder tmp/manual-products/W80870283
 *   APPLY (writes DB — requires explicit --confirm):
 *     npm run giga:manual-product:apply -- --sku W80870283 --folder tmp/manual-products/W80870283 --confirm
 *
 * Flags:
 *   --sku <SKU>            REQUIRED; must equal the JSON supplier_product_id.
 *   --folder <dir>         folder workflow: reads <dir>/manual.json and auto-detects images
 *                          (main.png → primary, gallery-NN.png → gallery). Image public URLs are
 *                          built at the deny-safe storage prefix (see MANUAL_STORAGE_PREFIX).
 *   --input <path>         alternative to --folder: path to a manual product JSON (with images URLs).
 *   --confirm              perform the DB writes (without it, behaves like PLAN).
 *   --update-existing      allow overwriting a SKU that already exists (refused otherwise).
 *
 * PRICING: if manual.json has selling_price_mode="auto", selling_price is computed from cost_price via
 * the dynamic-pricing base-retail rule (no manual selling_price needed). Otherwise a selling_price > 0
 * must be supplied. IMAGES: --folder mode requires the images to have been uploaded to the deny-safe
 * bucket prefix already; the tool references those public URLs (it does not upload).
 *
 * SAFETY: single SKU only; no bulk mode; dry-run (PLAN) first; APPLY needs --confirm; refuses on
 * SKU mismatch; refuses an existing SKU unless --update-existing; tags raw_payload.manual_upload;
 * NEVER writes giga_delivery_fee_cache (existing fee is preserved); only rows keyed by this SKU.
 *
 * Env (loaded inside main, like normalizeProducts.ts): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 * from .env.local (fallback .env). The pure helpers below read NO env and touch NO DB, so this
 * module is import-safe for tests.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { normalizeProduct } from '../src/services/normalizationPipeline';
import { resolveUniqueSkuCustom } from '../src/services/specFormatter';

export const REPORT_DIR = path.join('reports', 'giga-manual-product');

// ── Types ───────────────────────────────────────────────────────────────────────────────────────
export interface ManualInput {
  supplier_product_id: string;
  manual_upload_reason?: string;
  operator?: { name?: string; approved_at?: string; giga_page_url?: string };
  title: string;
  description?: string;
  category?: string;
  color?: string;
  material?: string;
  assembled_length?: number | string;
  assembled_width?: number | string;
  assembled_height?: number | string;
  assembled_weight?: number | string;
  specifications?: Record<string, string>;
  key_features?: string[];
  images?: { primary: string; gallery?: string[] };
  cost_price?: number;
  /** 'auto' → selling_price is computed from cost_price via the dynamic-pricing base-retail rule.
   *  'manual' (default when a selling_price is supplied) → use the provided selling_price. */
  selling_price_mode?: 'auto' | 'manual';
  selling_price?: number;
  original_price?: number | null;
  warehouse_inventory: Array<{ warehouse_code: string; quantity: number }>;
  giga_numeric_product_id?: number | string;
}

export interface ValidationResult { errors: string[]; warnings: string[] }
export interface ValidateCtx {
  sku: string;
  canonicalCodes: Set<string>;
  skuExists: boolean;
  updateExisting: boolean;
  feePresent: boolean;
}

// ── PURE helpers (no env, no DB — fully testable) ─────────────────────────────────────────────────

/** Merchant On-Site warehouse code pattern the DB guard trigger quarantines (see
 *  supabase/migrations/20260621_guard_onsite_merchant_inventory.sql). e.g. "B062-FL1", "T2574-OH1". */
export const MERCHANT_PREFIX_RE = /^.+-[A-Z]{2}[0-9]+$/;
export function isMerchantPrefixed(code: string): boolean { return MERCHANT_PREFIX_RE.test(code); }

/** Same state mapping as scripts/fetchGigaWarehouseInventoryFromXhr.ts (kept identical on purpose). */
export function warehouseState(code: string): string | null {
  if (/^CA/i.test(code)) return 'CA';
  if (/^NJX/i.test(code)) return 'MD';
  if (/^NJ/i.test(code)) return 'NJ';
  if (/^AT/i.test(code)) return 'GA';
  if (/^TX/i.test(code)) return 'TX';
  return null;
}
export function supportsPickup(code: string): boolean { return warehouseState(code) === 'CA'; }

export function parseArgs(argv: string[]): { sku?: string; input?: string; folder?: string; confirm: boolean; updateExisting: boolean } {
  const out = { sku: undefined as string | undefined, input: undefined as string | undefined, folder: undefined as string | undefined, confirm: false, updateExisting: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sku') out.sku = argv[++i];
    else if (a === '--input') out.input = argv[++i];
    else if (a === '--folder') out.folder = argv[++i];
    else if (a === '--confirm') out.confirm = true;
    else if (a === '--update-existing') out.updateExisting = true;
  }
  return out;
}

/** Validate operator input. PURE — the caller supplies DB-derived context (canonical codes, existence, fee). */
export function validateManualInput(json: ManualInput, ctx: ValidateCtx): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!json.supplier_product_id || String(json.supplier_product_id) !== ctx.sku) {
    errors.push(`SKU mismatch: --sku=${ctx.sku} but JSON supplier_product_id=${json.supplier_product_id ?? '(missing)'}`);
  }
  if (ctx.skuExists && !ctx.updateExisting) {
    errors.push(`SKU ${ctx.sku} already exists — refusing to overwrite without --update-existing`);
  }
  if (!json.title || !String(json.title).trim()) errors.push('title is required');
  if (!json.images || !json.images.primary || !String(json.images.primary).trim()) {
    errors.push('images.primary is required (at least one image)');
  }
  if (!(typeof json.selling_price === 'number' && json.selling_price > 0)) {
    errors.push('selling_price is required and must be > 0');
  }
  if (json.cost_price != null) {
    if (!(typeof json.cost_price === 'number' && json.cost_price > 0)) errors.push('cost_price, if provided, must be > 0');
  } else {
    warnings.push('cost_price absent → standardized_products.price will be 0, and sellable_products requires price > 0 (product will NOT be sellable until a positive cost_price is provided)');
  }
  if (typeof json.cost_price === 'number' && json.cost_price > 0 &&
      typeof json.selling_price === 'number' && json.selling_price > 0 &&
      json.selling_price < json.cost_price) {
    warnings.push(`selling_price (${json.selling_price}) is below cost_price (${json.cost_price}) — selling below cost`);
  }

  const rows = Array.isArray(json.warehouse_inventory) ? json.warehouse_inventory : [];
  if (rows.length === 0) errors.push('warehouse_inventory is required (at least one warehouse row)');
  let total = 0;
  for (const r of rows) {
    const code = String(r?.warehouse_code ?? '').trim().toUpperCase();
    const qty = Number(r?.quantity ?? 0);
    if (!code) { errors.push('warehouse_inventory row missing warehouse_code'); continue; }
    if (!Number.isFinite(qty) || qty < 0) { errors.push(`warehouse ${code}: quantity must be a non-negative number`); continue; }
    total += qty;
    // Mirror the DB guard EXACTLY: only merchant-prefixed codes NOT in public.warehouses are quarantined
    // (forced sync_status='error' → never counted). Bare codes (CA6, NJ5) are fine and ARE counted.
    if (isMerchantPrefixed(code) && !ctx.canonicalCodes.has(code)) {
      errors.push(`warehouse ${code}: merchant On-Site code not in public.warehouses → would be quarantined (qty would NOT count). Use a canonical/bare warehouse code.`);
    } else if (!ctx.canonicalCodes.has(code)) {
      warnings.push(`warehouse ${code}: not a seeded canonical warehouse, but bare codes are not quarantined and WILL be counted`);
    }
  }
  if (rows.length > 0 && total <= 0) errors.push('warehouse_inventory total quantity must be > 0 (product would be out_of_stock)');

  if (!ctx.feePresent) {
    warnings.push('no giga_delivery_fee_cache row for this SKU → DELIVERY checkout will be blocked (delivery_fee_unavailable) until a fee is cached; pickup is unaffected');
  }
  return { errors, warnings };
}

/** Build a SupplierApiItem-shaped raw payload (field names normalizeProduct() reads from raw_payload). */
export function buildSupplierItem(json: ManualInput, nowIso: string): Record<string, unknown> {
  const primary = String(json.images?.primary ?? '');
  const gallery = Array.isArray(json.images?.gallery) ? json.images!.gallery!.map(String) : [];
  const imageUrls = [primary, ...gallery].filter(Boolean);
  return {
    sku: json.supplier_product_id,
    id: json.giga_numeric_product_id ?? json.supplier_product_id,
    productId: json.giga_numeric_product_id ?? null,
    title: json.title,
    productName: json.title,
    description: json.description ?? null,
    characteristics: Array.isArray(json.key_features) ? json.key_features : [],
    price: json.cost_price ?? 0,
    imageUrls,
    mainImageUrl: primary,
    category: json.category ?? '',
    mainColor: json.color ?? '',
    mainMaterial: json.material ?? '',
    assembledLength: json.assembled_length ?? '',
    assembledWidth: json.assembled_width ?? '',
    assembledHeight: json.assembled_height ?? '',
    assembledWeight: json.assembled_weight ?? '',
    srpPrice: json.original_price ?? undefined,
    // Provenance marker — auditable + reconcilable when GIGA recovers.
    manual_upload: {
      source: 'manual_emergency_upload',
      reason: json.manual_upload_reason ?? null,
      operator: json.operator ?? null,
      at: nowIso,
    },
  };
}

/** Row shape normalizeProduct() consumes (a supplier_products-like row). */
export function buildNormalizableRow(json: ManualInput, item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: json.giga_numeric_product_id ?? json.supplier_product_id,
    supplier_product_id: json.supplier_product_id,
    title: json.title,
    description: json.description ?? null,
    price: json.cost_price ?? 0,
    images: [],
    raw_payload: item,
  };
}

/** supplier_products row (same column shape supplierPickupService writes). */
export function buildSupplierProductRow(json: ManualInput, item: Record<string, unknown>, totalQty: number): Record<string, unknown> {
  const primary = String(json.images?.primary ?? '');
  const gallery = Array.isArray(json.images?.gallery) ? json.images!.gallery!.map(String) : [];
  return {
    supplier_product_id: json.supplier_product_id,
    title: json.title,
    description: json.description ?? null,
    price: json.cost_price ?? 0,
    images: [primary, ...gallery].filter(Boolean),
    inventory: totalQty,
    pickup_address: null,
    raw_payload: item,
  };
}

/** standardized_products upsert row = normalizeProduct() output minus new_arrival_added_at, plus selling_price.
 *  (Mirrors scripts/normalizeProducts.ts which drops new_arrival_added_at; selling_price is NOT emitted by
 *  normalizeProduct and must be set explicitly — sellable_products requires selling_price > 0.) */
export function buildStandardizedUpsertRow(json: ManualInput): Record<string, unknown> {
  const normalized = normalizeProduct(buildNormalizableRow(json, buildSupplierItem(json, '')) as never);
  const { new_arrival_added_at: _dropped, ...rest } = normalized as Record<string, unknown> & { new_arrival_added_at?: unknown };
  return { ...rest, selling_price: json.selling_price };
}

/** inventory_cache rows (source_type='website_scrape', sync_status='ok'), same shape as syncGigaInventoryXhr. */
export function buildInventoryRows(json: ManualInput, nowIso: string): Array<Record<string, unknown>> {
  const rows = Array.isArray(json.warehouse_inventory) ? json.warehouse_inventory : [];
  const total = rows.reduce((s, r) => s + (Number(r?.quantity) || 0), 0);
  return rows.map(r => {
    const code = String(r.warehouse_code).trim().toUpperCase();
    const qty = Number(r.quantity) || 0;
    return {
      product_id: json.supplier_product_id,
      supplier_product_id: json.supplier_product_id,
      warehouse_code: code,
      warehouse_state: warehouseState(code),
      quantity: qty,
      quantity_floor: qty,
      quantity_raw: String(qty),
      quantity_exact: true,
      total_available: total,
      is_available: qty > 0,
      supports_pickup: supportsPickup(code),
      supports_shipping: !supportsPickup(code),
      last_synced_at: nowIso,
      sync_status: 'ok',
      source_type: 'website_scrape',
    };
  });
}

// ── PRICING (auto selling_price) ──────────────────────────────────────────────────────────────────
// Mirrors the BASE-RETAIL rule in supabase/functions/dynamic-pricing/index.ts (calculateBaseRetail).
// That edge function is the live source of truth and re-prices over time; this is the STARTING price.
// Constants/tiers are kept byte-identical and locked by a test — if dynamic-pricing changes, update both.
export const STRIPE_FEE_RATE = 0.033;
export const SALES_TAX_ON_FEE_RATE = 0.0775; // CA tax applied to the Stripe processing fee
export const PAYMENT_FEE_RATE = STRIPE_FEE_RATE * (1 + SALES_TAX_ON_FEE_RATE); // ≈ 0.035558

export function getMarkup(cost: number): number {
  if (cost <= 50) return 2.20;
  if (cost <= 150) return 1.80;
  if (cost <= 400) return 1.55;
  if (cost <= 800) return 1.40;
  return 1.28;
}
export function getBuffer(cost: number): number {
  if (cost <= 100) return 20;
  if (cost <= 300) return 30;
  if (cost <= 800) return 50;
  return 80;
}
export function psychologicalRound(price: number): number {
  if (price < 100) return Math.floor(price) + 0.99;
  if (price < 300) {
    const decadeFloor = Math.floor(price / 10) * 10;
    const candidate = decadeFloor + 9;
    return candidate >= price ? candidate : candidate + 10;
  }
  const floor100 = Math.floor(price / 100) * 100;
  for (const suffix of [49, 79, 99]) { if (floor100 + suffix >= price) return floor100 + suffix; }
  return floor100 + 149;
}
/** Base retail price from cost (cost×markup+buffer, grossed for payment fee, psychological round, 25% margin floor). */
export function calculateBaseRetail(cost: number): { baseRetailPrice: number; markup: number; buffer: number } {
  const markup = getMarkup(cost);
  const buffer = getBuffer(cost);
  const rawBase = cost * markup + buffer;
  const grossed = rawBase / (1 - PAYMENT_FEE_RATE);
  let baseRetail = psychologicalRound(grossed);
  const marginFloor = cost / 0.75;
  if (baseRetail < marginFloor) baseRetail = psychologicalRound(marginFloor);
  return { baseRetailPrice: baseRetail, markup, buffer };
}

/** Resolve the selling price. mode='auto' → compute from cost_price; else use the supplied selling_price. */
export function resolveSellingPrice(json: ManualInput): {
  mode: 'auto' | 'manual'; sellingPrice?: number; error?: string; markup?: number; buffer?: number;
} {
  const mode: 'auto' | 'manual' = json.selling_price_mode === 'auto' ? 'auto' : 'manual';
  if (mode === 'auto') {
    if (!(typeof json.cost_price === 'number' && json.cost_price > 0)) {
      return { mode, error: 'selling_price_mode=auto requires cost_price > 0 to compute selling_price' };
    }
    const { baseRetailPrice, markup, buffer } = calculateBaseRetail(json.cost_price);
    return { mode, sellingPrice: baseRetailPrice, markup, buffer };
  }
  return { mode, sellingPrice: typeof json.selling_price === 'number' ? json.selling_price : undefined };
}

// ── FOLDER workflow (tmp/manual-products/<SKU>/) ────────────────────────────────────────────────────
// Storage prefix is DENY-SAFE: the shared image deny-list (src/utils/productImageRules.ts) flags the
// substring 'manual', so a 'manual-products/' storage path would drop every image at normalize time.
// 'operator-uploads' contains no deny keyword. (The LOCAL folder may still be tmp/manual-products/.)
export const MANUAL_STORAGE_PREFIX = 'operator-uploads';
export const MANUAL_STORAGE_BUCKET = 'product-images';

/** Auto-detect images in a folder by filename convention: main.png → primary; gallery-NN.png → gallery (sorted). */
export function detectFolderImages(filenames: string[]): { primary?: string; gallery: string[] } {
  const primary = filenames.find(f => f.toLowerCase() === 'main.png');
  const gallery = filenames.filter(f => /^gallery-\d+\.png$/i.test(f)).sort((a, b) => a.localeCompare(b));
  return { primary, gallery };
}

/** Public Supabase Storage URL for a manual product image at the deny-safe prefix. */
export function buildPublicImageUrl(supabaseUrl: string, sku: string, file: string): string {
  const base = supabaseUrl.replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${MANUAL_STORAGE_BUCKET}/${MANUAL_STORAGE_PREFIX}/${sku}/${file}`;
}

// ── IMPURE: env + DB orchestration ───────────────────────────────────────────────────────────────
// ── REVIEW SEEDING (reuse the Protected Review System script; do NOT reimplement) ────────────────────
// Mirrors runGigaAutoPublish Stage 8: after the SKU is published/in_stock, seed the same generated
// cold-start reviews via scripts/seedGeneratedReviews.ts, scoped to ONLY this SKU. Pure/testable.
export const REVIEW_SEED_SCRIPT = 'scripts/seedGeneratedReviews.ts';
export function reviewSeedArgs(): string[] { return ['tsx', REVIEW_SEED_SCRIPT]; }
export function reviewSeedEnvScope(sku: string): { ONLY_SKUS: string } { return { ONLY_SKUS: sku }; }
/** Only seed when the SKU has no reviews yet (idempotent; avoids duplicate work). */
export function shouldSeedReviews(existingReviewCount: number): boolean { return existingReviewCount === 0; }

function die(msg: string): never { console.error(`MANUAL_UPLOAD_ERROR\n  ${msg}`); process.exit(1); }

async function loadCanonicalCodes(sb: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await sb.from('warehouses').select('code');
  if (error) throw new Error(`warehouses read failed: ${error.message}`);
  return new Set((data ?? []).map(r => String(r.code).toUpperCase()));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sku) die('missing --sku');

  // Input path: --folder <dir>/manual.json takes precedence over --input <path>.
  const inputPath = args.folder ? path.join(args.folder, 'manual.json') : args.input;
  if (!inputPath) die('missing --folder <dir> or --input <path-to-json>');
  if (!fs.existsSync(inputPath)) die(`input file not found: ${inputPath}`);

  const rawText = fs.readFileSync(inputPath, 'utf8');
  if (/^\s*\{\\rtf/.test(rawText)) {
    die(`${inputPath} is Rich Text Format, not plain JSON — re-save as plain text (TextEdit → Format → Make Plain Text, or use a code editor)`);
  }
  let json: ManualInput;
  try { json = JSON.parse(rawText) as ManualInput; }
  catch (e) { die(`could not parse JSON input (${inputPath}): ${e instanceof Error ? e.message : String(e)} — ensure it is plain JSON, not RTF/TXT`); }
  if (String(json.supplier_product_id ?? '') !== args.sku) {
    die(`SKU mismatch: --sku=${args.sku} but JSON supplier_product_id=${json.supplier_product_id ?? '(missing)'}`);
  }

  // dynamic env load (kept out of module scope so this file is import-safe for tests)
  const { config: loadEnv } = await import('dotenv');
  loadEnv({ path: '.env.local' }); loadEnv({ path: '.env' });
  const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) die('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local)');
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  const nowIso = new Date().toISOString();
  const mode = args.confirm ? 'APPLY' : 'PLAN';

  // ── Resolve images: folder auto-detect (deny-safe storage URLs) or input-JSON images ──
  let images: { primary: string; gallery: string[] };
  let imageSource: string;
  if (args.folder) {
    const det = detectFolderImages(fs.readdirSync(args.folder));
    if (!det.primary) die(`no main.png found in folder ${args.folder}`);
    images = {
      primary: buildPublicImageUrl(SUPABASE_URL, args.sku, det.primary),
      gallery: det.gallery.map(f => buildPublicImageUrl(SUPABASE_URL, args.sku, f)),
    };
    imageSource = `folder auto-detect: main.png + ${det.gallery.length} gallery → ${MANUAL_STORAGE_BUCKET}/${MANUAL_STORAGE_PREFIX}/${args.sku}/ (must already be uploaded)`;
  } else {
    images = { primary: String(json.images?.primary ?? ''), gallery: (json.images?.gallery ?? []).map(String) };
    imageSource = 'input JSON images';
  }

  // ── Resolve selling_price (auto from cost via dynamic-pricing rule, or supplied) ──
  const priced = resolveSellingPrice(json);

  // Resolved input feeds every builder + validation (images + selling_price filled in).
  const resolved: ManualInput = { ...json, images, selling_price: priced.sellingPrice };

  // Read-only DB context for validation.
  const canonicalCodes = await loadCanonicalCodes(sb);
  const [{ data: supRow }, { data: stdRow }, { data: feeRow }] = await Promise.all([
    sb.from('supplier_products').select('supplier_product_id').eq('supplier_product_id', args.sku).maybeSingle(),
    sb.from('standardized_products').select('supplier_product_id').eq('supplier_product_id', args.sku).maybeSingle(),
    sb.from('giga_delivery_fee_cache').select('charged_fee_cents').eq('supplier_product_id', args.sku).maybeSingle(),
  ]);
  const skuExists = !!supRow || !!stdRow;
  const feePresent = !!feeRow && feeRow.charged_fee_cents != null;

  const { errors, warnings } = validateManualInput(resolved, {
    sku: args.sku, canonicalCodes, skuExists, updateExisting: args.updateExisting, feePresent,
  });
  if (priced.error) errors.unshift(priced.error);

  // Build the planned rows (deterministic; identical in PLAN and APPLY).
  const item = buildSupplierItem(resolved, nowIso);
  const totalQty = (resolved.warehouse_inventory ?? []).reduce((s, r) => s + (Number(r?.quantity) || 0), 0);
  const supplierProductRow = buildSupplierProductRow(resolved, item, totalQty);
  const standardizedRow = buildStandardizedUpsertRow(resolved);
  const inventoryRows = buildInventoryRows(resolved, nowIso);

  console.log('═══════════════════════════════════════════════════════════');
  console.log(` GIGA MANUAL PRODUCT UPLOAD — ${mode} — SKU ${args.sku}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(` input            : ${inputPath}${args.folder ? ` (folder mode: ${args.folder})` : ''}`);
  console.log(` pricing          : mode=${priced.mode}${priced.mode === 'auto' ? ` cost=${json.cost_price} markup=${priced.markup} buffer=${priced.buffer} → selling_price=${priced.sellingPrice ?? '(error)'}` : ` selling_price=${priced.sellingPrice ?? '(missing)'}`}`);
  console.log(` images           : ${imageSource}`);
  console.log(` sku exists       : ${skuExists}${skuExists ? (args.updateExisting ? ' (--update-existing)' : '') : ''}`);
  console.log(` delivery fee row : ${feePresent ? `present (charged_fee_cents=${feeRow!.charged_fee_cents})` : 'MISSING'}`);
  console.log(` canonical whs    : ${canonicalCodes.size} codes loaded from public.warehouses`);
  console.log('── Planned writes (scoped to this SKU only) ──');
  console.log(`  supplier_products    : 1 row (${args.updateExisting ? 'upsert' : 'insert'})`);
  console.log(`  standardized_products: 1 row (upsert; normalization_status=${standardizedRow.normalization_status}; selling_price=${standardizedRow.selling_price}; price=${standardizedRow.price}; category_label=${standardizedRow.category_label}; title="${String(standardizedRow.product_title).slice(0, 50)}")`);
  console.log(`  inventory_cache      : ${inventoryRows.length} row(s), total_qty=${totalQty}`);
  for (const r of inventoryRows) console.log(`     ${String(r.warehouse_code).padEnd(6)} qty=${String(r.quantity).padStart(4)} state=${r.warehouse_state ?? '?'} pickup=${r.supports_pickup}`);
  console.log(`  refresh_product_inventory_status('${args.sku}')  → sets inventory_status/published`);
  console.log('  giga_delivery_fee_cache: NOT written (preserved)');

  if (warnings.length) { console.log('── Warnings ──'); for (const w of warnings) console.log(`  [WARN] ${w}`); }
  if (errors.length) {
    console.log('── Errors (blocking) ──'); for (const e of errors) console.log(`  ✗ ${e}`);
  }

  // Write a local report (both modes).
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportBase = path.join(REPORT_DIR, `${args.sku}-${mode.toLowerCase()}`);
  const report = {
    mode, sku: args.sku, input: inputPath, generated_at: nowIso,
    sku_exists: skuExists, update_existing: args.updateExisting, fee_present: feePresent,
    errors, warnings,
    planned: {
      supplier_products: { ...supplierProductRow, raw_payload: '«manual item (see input)»' },
      standardized_products: standardizedRow,
      inventory_cache: inventoryRows,
      refresh_product_inventory_status: args.sku,
      giga_delivery_fee_cache: 'NOT_WRITTEN',
    },
  };
  fs.writeFileSync(`${reportBase}.json`, JSON.stringify(report, null, 2));
  console.log(`\n  report: ${reportBase}.json`);

  if (errors.length) { console.log(`\nMANUAL_UPLOAD_RESULT=${mode}_BLOCKED (${errors.length} error(s)) — no writes`); process.exit(1); }

  if (!args.confirm) {
    console.log('\nMANUAL_UPLOAD_RESULT=PLAN_OK (no DB writes — re-run with --confirm to apply)');
    return;
  }

  // ── APPLY ──
  console.log('\n── Applying (DB writes) ──');
  const supRes = await sb.from('supplier_products').upsert([supplierProductRow], { onConflict: 'supplier_product_id' });
  if (supRes.error) die(`supplier_products write failed: ${supRes.error.message}`);
  console.log('  ✓ supplier_products upserted');

  // sku_custom identity resolution: keep an already-stored code verbatim (rerun
  // stability); otherwise walk the deterministic candidate sequence against every
  // taken code. Same contract as normalizeProducts.ts; DB UNIQUE backstops.
  {
    const sid = (standardizedRow as { supplier_product_id: string }).supplier_product_id;
    const { data: skuRows, error: skuErr } = await sb.from('standardized_products').select('supplier_product_id, sku_custom');
    if (skuErr) die(`sku_custom preload failed: ${skuErr.message}`);
    const mine = (skuRows ?? []).find(r => r.supplier_product_id === sid)?.sku_custom as string | undefined;
    const taken = new Map<string, string>((skuRows ?? []).filter(r => r.sku_custom).map(r => [r.sku_custom as string, r.supplier_product_id as string]));
    const row = standardizedRow as { sku_custom: string; sku_search: string };
    const finalSku = mine ?? resolveUniqueSkuCustom(row.sku_custom.split('-').slice(0, 4).join('-'), sid, taken);
    row.sku_custom = finalSku;
    row.sku_search = finalSku.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  const stdRes = await sb.from('standardized_products').upsert([standardizedRow], { onConflict: 'supplier_product_id' });
  if (stdRes.error) die(`standardized_products write failed: ${stdRes.error.message}`);
  console.log('  ✓ standardized_products upserted (selling_price set)');

  const invRes = await sb.from('inventory_cache').upsert(inventoryRows, { onConflict: 'product_id,warehouse_code' });
  if (invRes.error) die(`inventory_cache write failed: ${invRes.error.message}`);
  console.log(`  ✓ inventory_cache upserted (${inventoryRows.length} row(s))`);

  const { error: rpcErr } = await sb.rpc('refresh_product_inventory_status', { p_supplier_product_id: args.sku });
  if (rpcErr) die(`refresh_product_inventory_status failed: ${rpcErr.message}`);
  console.log('  ✓ refresh_product_inventory_status called');

  // Seed generated cold-start reviews for THIS SKU only, reusing the canonical (protected)
  // seedGeneratedReviews.ts — mirrors runGigaAutoPublish Stage 8. SOFT: a seed failure does NOT
  // undo the already-published product. Idempotent: skipped if the SKU already has reviews.
  const { count: existingReviews } = await sb.from('product_reviews')
    .select('id', { count: 'exact', head: true }).eq('supplier_product_id', args.sku);
  if (shouldSeedReviews(existingReviews ?? 0)) {
    console.log(`  seeding generated reviews (ONLY_SKUS=${args.sku}) …`);
    const seed = spawnSync('npx', reviewSeedArgs(), { env: { ...process.env, ...reviewSeedEnvScope(args.sku) }, stdio: 'inherit' });
    if (seed.status !== 0) console.warn(`  ⚠ review seed exited ${seed.status ?? 'null'} — product is live; re-seed later: ONLY_SKUS=${args.sku} npx tsx ${REVIEW_SEED_SCRIPT}`);
    else console.log('  ✓ generated reviews seeded');
  } else {
    console.log(`  reviews already exist (${existingReviews}) — skipping seed`);
  }

  // Read back final state.
  const { data: finalStd } = await sb.from('standardized_products')
    .select('normalization_status,published,inventory_status,total_available_qty,price,selling_price')
    .eq('supplier_product_id', args.sku).maybeSingle();
  const { data: finalSell } = await sb.from('sellable_products').select('supplier_product_id').eq('supplier_product_id', args.sku).maybeSingle();
  const { count: activeReviews } = await sb.from('product_reviews')
    .select('id', { count: 'exact', head: true }).eq('supplier_product_id', args.sku).eq('status', 'active');
  console.log('── Final state ──');
  console.log(`  standardized: ${JSON.stringify(finalStd)}`);
  console.log(`  sellable_products: ${finalSell ? 'LIVE ✅' : 'NOT live'}`);
  console.log(`  active reviews: ${activeReviews ?? 0}`);
  console.log(`\nMANUAL_UPLOAD_RESULT=APPLIED (sku=${args.sku}; delivery fee cache untouched)`);
}

if (require.main === module) {
  main().catch(err => { console.error('[manualUpload] Fatal:', err instanceof Error ? err.message : err); process.exit(1); });
}
