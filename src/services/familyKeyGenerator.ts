/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Product family key generator.
 * Groups same-style, different-color products under a stable key.
 */

// Words that distinguish color variants but don't define the product family.
const COLOR_VARIANT_WORDS =
  /\b(white|black|gray|grey|brown|beige|oak|walnut|espresso|natural|dark|light|navy|blue|green|red|yellow|pink|purple|cream|ivory|gold|silver|charcoal|washed|rustic|vintage|antique|matte|glossy|frosted)\b/gi;

/**
 * Produces a stable key that groups same-style products that differ only by
 * color/finish. Built from: categoryCode + normalized title (color words stripped,
 * first 6 meaningful words).
 */
export function computeFamilyKey(productTitle: string, cc: string): string {
  const normalized = productTitle
    .toLowerCase()
    .replace(COLOR_VARIANT_WORDS, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return `${cc.toLowerCase()}-${normalized}`;
}

// ── Supplier-derived variant grouping ─────────────────────────────────────────

/**
 * Minimum shared SKU-prefix length for two GIGA SKUs to count as true family
 * variants (same product, different color/finish) rather than cross-sells.
 * Mirrors scripts/syncGigaVariants.ts PREFIX_MIN_MATCH — keep in sync.
 */
const VARIANT_PREFIX_MIN_MATCH = 8;

function sharedPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

// ── Phase 2.1a: split complex variant families by config + width ──────────────
//
// A single supplier `-vg-` cluster can contain rows that are NOT a clean color-only
// set — different widths (62.60" vs 59.10") and/or duplicate colors (two "Walnut").
// Putting them under one key produces an ambiguous color selector. Model B splits the
// cluster into separate product cards by (config, rounded-width), so each card is a
// clean single-axis color family. We do this by APPENDING a deterministic
// `-${config}-w${width}` token to the supplier-derived key. Title-derived singleton
// keys are unchanged. The token is per-row and deterministic, so every member of a
// real color family (same config + width) computes the SAME key and still groups.

/** Door/drawer config token derived from supplier text (NOT the optimized title, which may strip it).
 *  Sources, in order: raw.productName → passed productTitle → characteristics → description.
 *  Returns e.g. "4door", "9drawer", "2door3drawer", or null when neither can be found. */
export function deriveConfigToken(
  raw: Record<string, unknown> | null | undefined,
  productTitle: string,
): string | null {
  const chars = Array.isArray(raw?.characteristics)
    ? (raw!.characteristics as unknown[]).map(String).join(' ')
    : String((raw?.characteristics as unknown) ?? '');
  const sources = [String((raw?.productName as unknown) ?? ''), String(productTitle ?? ''), chars, String((raw?.description as unknown) ?? '')];
  let doors: number | null = null;
  let drawers: number | null = null;
  for (const s of sources) {
    if (doors == null) { const m = s.match(/(\d+)\s*[-\s]?doors?\b/i); if (m) doors = parseInt(m[1], 10); }
    if (drawers == null) { const m = s.match(/(\d+)\s*[-\s]?drawers?\b/i); if (m) drawers = parseInt(m[1], 10); }
  }
  const parts: string[] = [];
  if (doors != null) parts.push(`${doors}door`);
  if (drawers != null) parts.push(`${drawers}drawer`);
  return parts.length ? parts.join('') : null;
}

/** Primary horizontal dimension (the long "width" customers compare): assembledLength,
 *  falling back to raw.length only if assembledLength is missing. Returns null if neither. */
export function deriveWidth(raw: Record<string, unknown> | null | undefined): number | null {
  for (const v of [raw?.assembledLength, (raw as any)?.length]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

export type VariantSplitResult = {
  key: string;            // the product_family_key to use
  isVg: boolean;          // true = supplier-derived variant family (token appended)
  groupRoot: string | null;
  configToken: string | null;
  cfgMissing: boolean;    // true → config could not be derived; key carries a `cfgmissing` sentinel
  width: number | null;
  widthToken: string | null;
  widthMissing: boolean;  // true → width could not be derived; key carries a `wmissing` sentinel
};

/**
 * Structured variant-family resolution. For supplier `-vg-` clusters it returns the
 * split key `${cc}-vg-${groupRoot}-${config}-w${width}` plus the derivation flags so
 * callers (detector/dry-run) can surface cfg/width gaps. When config or width cannot be
 * derived it does NOT guess — it appends an explicit `cfgmissing`/`wmissing` sentinel so
 * the row is isolated (never silently merged into a clean group) and the planner holds it.
 * No-sibling rows fall back to the unchanged title-derived key.
 */
export function resolveVariantSplit(
  raw: Record<string, unknown> | null | undefined,
  supplierProductId: string,
  cc: string,
  productTitle: string,
): VariantSplitResult {
  const self = String(supplierProductId ?? '').trim();
  const associates = Array.isArray(raw?.associateProductList)
    ? (raw!.associateProductList as unknown[])
        .filter((s): s is string => typeof s === 'string')
        .map(s => s.trim())
        .filter(Boolean)
    : [];

  const siblings = associates.filter(
    assoc => assoc !== self && sharedPrefixLength(self, assoc) >= VARIANT_PREFIX_MIN_MATCH,
  );

  if (self && siblings.length > 0) {
    const cluster = Array.from(new Set([self, ...siblings]));
    const groupRoot = [...cluster].sort()[0];
    const base = `${cc.toLowerCase()}-vg-${groupRoot.toLowerCase()}`;
    const configToken = deriveConfigToken(raw, productTitle);
    const width = deriveWidth(raw);
    const widthToken = width != null ? `w${Math.round(width)}` : null;
    const cfgPart = configToken ?? 'cfgmissing';
    const wPart = widthToken ?? 'wmissing';
    return {
      key: `${base}-${cfgPart}-${wPart}`,
      isVg: true, groupRoot, configToken, cfgMissing: configToken == null,
      width, widthToken, widthMissing: widthToken == null,
    };
  }

  return {
    key: computeFamilyKey(productTitle, cc),
    isVg: false, groupRoot: null, configToken: null, cfgMissing: false,
    width: null, widthToken: null, widthMissing: false,
  };
}

/**
 * Produces a product_family_key from supplier-authoritative variant data when
 * available, falling back to the title-derived computeFamilyKey() otherwise.
 * Supplier `-vg-` clusters are split by config + width (see resolveVariantSplit).
 * Title-derived singleton keys are unchanged.
 */
export function resolveVariantGroupKey(
  raw: Record<string, unknown> | null | undefined,
  supplierProductId: string,
  cc: string,
  productTitle: string,
): string {
  return resolveVariantSplit(raw, supplierProductId, cc, productTitle).key;
}
