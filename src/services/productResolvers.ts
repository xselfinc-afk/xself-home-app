/**
 * Source of truth: /PRODUCT_DISPLAY_RULES.md §1.1 (Title display) and §5
 * (Future resolver functions). Single, reusable resolver for product title
 * display so the chain rule lives in exactly one place.
 *
 * Phase 3A: only `resolveProductTitle` is implemented. The remaining
 * resolvers listed in PRODUCT_DISPLAY_RULES.md §5 (price, original price,
 * discount, SKU, images, family key, variant, inventory) will be added in
 * later phases.
 */

import { sanitizeSupplierName } from '../utils/supplierNameSanitizer';

/**
 * Returns the first value that is a non-empty string after trimming.
 * Skips `null`, `undefined`, non-strings, and whitespace-only strings.
 */
export function pickFirstNonEmptyString(
  ...values: Array<string | null | undefined>
): string | null {
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export interface ProductTitleInput {
  /** AI-optimized retail title, when available. Highest precedence. */
  optimized_title?: string | null;
  /** Pipeline-produced display-friendly title, ≤55 chars. */
  product_title_display?: string | null;
  /** Canonical full title, ≤80 chars. */
  product_title?: string | null;
  /** Looser fallbacks — accepted so callers can pass `Product` instances directly. */
  name?: string | null;
  title?: string | null;
}

const UNTITLED_FALLBACK = 'Untitled Product';

/**
 * Resolves the customer-facing product title using the official chain from
 * PRODUCT_DISPLAY_RULES.md §1.1:
 *
 *   optimized_title || product_title_display || product_title || name || title
 *
 * After picking, `sanitizeSupplierName` is applied defensively (matches the
 * adapter-time sanitizer documented in §1.1 as belt-and-suspenders). If
 * every input is empty or sanitization strips the picked value to nothing,
 * returns `'Untitled Product'`.
 */
export function resolveProductTitle(
  input: ProductTitleInput | null | undefined,
): string {
  const row = input ?? {};
  const candidate = pickFirstNonEmptyString(
    row.optimized_title,
    row.product_title_display,
    row.product_title,
    row.name,
    row.title,
  );
  if (!candidate) return UNTITLED_FALLBACK;
  const cleaned = sanitizeSupplierName(candidate).cleaned;
  return cleaned.trim().length > 0 ? cleaned : UNTITLED_FALLBACK;
}

// ── Price ─────────────────────────────────────────────────────────────────────

/**
 * `true` when the value, possibly a numeric string, parses to a finite number
 * strictly greater than zero. Rejects `null`, `undefined`, `NaN`, `Infinity`,
 * `0`, and negatives.
 */
export function isPositiveNumber(value: unknown): boolean {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export interface ProductPriceInput {
  /** AI-managed retail price. Wins when positive. */
  selling_price?: number | string | null;
  /** Supplier-side price. Used when `selling_price` is missing or not positive. */
  price?: number | string | null;
}

/**
 * Resolves the customer-facing price using the official rule from
 * PRODUCT_DISPLAY_RULES.md §1.2:
 *
 *   customerPrice = (selling_price > 0) ? selling_price : price
 *
 * Returns `0` only when neither field carries a positive number. Accepts
 * numeric strings defensively (some upstream rows may serialize `numeric`
 * Postgres values as strings depending on the client). Does not format,
 * round, or add currency symbols — that is the rendering layer's job.
 */
export function resolveCustomerPrice(
  input: ProductPriceInput | null | undefined,
): number {
  const row = input ?? {};
  for (const v of [row.selling_price, row.price]) {
    if (isPositiveNumber(v)) {
      return typeof v === 'string' ? Number(v) : (v as number);
    }
  }
  return 0;
}

// ── Original price + discount ────────────────────────────────────────────────

/** Coerces a numeric string to a number; passes other types through. */
function toNumberOrUndefined(value: number | string | null | undefined): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export interface OriginalPriceInput {
  /** Pipeline-produced compare-at value. */
  original_price?: number | string | null;
  /** Already-resolved customer-facing price. */
  customerPrice: number;
}

/**
 * Resolves the strikethrough (compare-at) price using the official rule from
 * PRODUCT_DISPLAY_RULES.md §1.3:
 *
 *   originalPrice = (original_price > customerPrice) ? original_price : undefined
 *
 * Strikethrough is shown *only* when the compare-at is strictly greater than
 * the customer-facing price. Returns `undefined` whenever the gate fails so
 * the rendering layer can simply check `if (originalPrice)`.
 */
export function resolveOriginalPrice(
  input: OriginalPriceInput | null | undefined,
): number | undefined {
  if (!input) return undefined;
  const op = toNumberOrUndefined(input.original_price);
  if (op == null || op <= 0) return undefined;
  return op > input.customerPrice ? op : undefined;
}

export interface DiscountPercentInput {
  /** Result of `resolveOriginalPrice` — already gated on `> customerPrice`. */
  originalPrice?: number | string | null;
  /** Already-resolved customer-facing price. */
  customerPrice: number;
}

/**
 * Resolves the integer discount percent using the official rule from
 * PRODUCT_DISPLAY_RULES.md §1.3:
 *
 *   discountPercent = originalPrice
 *     ? round((1 - customerPrice / originalPrice) * 100)
 *     : 0
 *
 * Returns `0` when there is no valid compare-at price, when customerPrice is
 * non-positive, or when originalPrice is not strictly greater than
 * customerPrice. Never returns negative percentages.
 */
export function resolveDiscountPercent(
  input: DiscountPercentInput | null | undefined,
): number {
  if (!input) return 0;
  const cp = input.customerPrice;
  if (!Number.isFinite(cp) || cp <= 0) return 0;
  const op = toNumberOrUndefined(input.originalPrice);
  if (op == null || op <= cp) return 0;
  return Math.round((1 - cp / op) * 100);
}

// ── Family selling_price selection ───────────────────────────────────────────

/**
 * Picks a representative `selling_price` from a sibling-variant set so a
 * newly inserted variant can inherit the family's retail price until the
 * canonical dynamic-pricing engine (`supabase/functions/dynamic-pricing`)
 * re-prices the row. This is a backfill stopgap, NOT a new pricing formula.
 *
 * Behaviour:
 *   1. Ignore `null`, `undefined`, non-numeric strings, `0`, and negatives.
 *   2. If no valid price remains, return `null` (caller should leave
 *      selling_price unset and let dynamic-pricing handle it).
 *   3. Otherwise pick the **mode** (most frequent value across siblings).
 *      On ties, pick the **highest** price — protects against under-pricing
 *      a family when siblings disagree.
 */
export function selectFamilySellingPrice(
  prices: Array<number | string | null | undefined>,
): number | null {
  const valid: number[] = [];
  for (const v of prices) {
    if (isPositiveNumber(v)) {
      valid.push(typeof v === 'string' ? Number(v) : (v as number));
    }
  }
  if (valid.length === 0) return null;

  const counts = new Map<number, number>();
  for (const p of valid) counts.set(p, (counts.get(p) ?? 0) + 1);

  let bestPrice = -Infinity;
  let bestCount = 0;
  for (const [price, count] of counts) {
    if (count > bestCount || (count === bestCount && price > bestPrice)) {
      bestPrice = price;
      bestCount = count;
    }
  }
  return bestPrice;
}

// ── SKU display ──────────────────────────────────────────────────────────────

const SKU_FALLBACK = '—';

export interface SkuDisplayInput {
  /** Pipeline-produced retail SKU (e.g. `XH-CB-HM-06904M`). Preferred. */
  skuCustom?: string | null;
  /** Direct SKU field — used when no variant array is present. */
  sku?: string | null;
  /** Variant array; first entry's `sku` is checked when other fields are empty. */
  variants?: Array<{ sku?: string | null | undefined } | null | undefined> | null;
  /** Supplier-native SKU. */
  supplierProductId?: string | null;
  supplier_product_id?: string | null;
  /** `Product.id` — adapter sets this to `supplier_product_id`, so it is a valid last-resort SKU. */
  id?: string | null;
}

/**
 * Resolves the user-visible SKU string using PRODUCT_DISPLAY_RULES.md §1.4
 * and DEP-2 (kills the hardcoded `'XSF-XXXX'` placeholder).
 *
 * Walk order: skuCustom → sku → variants[0].sku → supplierProductId →
 * supplier_product_id → id → `'—'`. Whitespace is trimmed; null/undefined/
 * empty values are skipped. `'XSF-XXXX'` is never returned as a fallback.
 */
export function resolveSkuDisplay(
  input: SkuDisplayInput | null | undefined,
): string {
  const row = input ?? {};
  const variantSku = Array.isArray(row.variants) ? row.variants[0]?.sku : null;
  return (
    pickFirstNonEmptyString(
      row.skuCustom,
      row.sku,
      variantSku,
      row.supplierProductId,
      row.supplier_product_id,
      row.id,
    ) ?? SKU_FALLBACK
  );
}
