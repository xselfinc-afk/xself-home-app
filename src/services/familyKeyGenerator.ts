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

/**
 * Produces a product_family_key from supplier-authoritative variant data when
 * available, falling back to the title-derived computeFamilyKey() otherwise.
 *
 * GIGA's raw_payload.associateProductList names every sibling SKU in a family
 * (plus cross-sells). Siblings sharing a >= VARIANT_PREFIX_MIN_MATCH-char SKU
 * prefix with `supplierProductId` are true color/finish variants; shorter
 * matches are cross-sells and ignored (same rule as syncGigaVariants.ts).
 *
 * When such siblings exist, the cluster = { self } ∪ kept-siblings and the key
 * is `${cc}-vg-${groupRoot}`, where groupRoot is the lexicographically smallest
 * SKU in the cluster. Because associateProductList is complete per row, every
 * sibling computes the same groupRoot → an identical key → they group. Pure and
 * deterministic (no I/O, no global state).
 *
 * With no valid sibling cluster, behavior is unchanged: title-derived key.
 */
export function resolveVariantGroupKey(
  raw: Record<string, unknown> | null | undefined,
  supplierProductId: string,
  cc: string,
  productTitle: string,
): string {
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
    return `${cc.toLowerCase()}-vg-${groupRoot.toLowerCase()}`;
  }

  return computeFamilyKey(productTitle, cc);
}
