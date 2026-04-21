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
