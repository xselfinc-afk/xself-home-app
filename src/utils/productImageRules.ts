/**
 * Source of truth: PRODUCT_DISPLAY_RULES.md §1.8 (Image selection) and
 * §4 DEP-5 (duplicated image deny-lists). Single shared deny-list used by:
 *
 *   - src/services/imageSelector.ts — normalize-time image ranking
 *   - scripts/syncGigaVariants.ts   — Playwright-fallback DOM scraping
 *
 * Both consumers must reject the same non-product images: marketing banners
 * (bannerDesign), UI chrome (logo/icon/sprite/favicon/placeholder/loading/
 * spinner/pixel/tracking), and supplier "documentation" assets (label,
 * manual, instruction, spec, dimension, prop65, certificate, etc.). SVG
 * files are anchored to `.svg` at end-of-string or before `?` to avoid
 * false positives on path components that merely contain "svg".
 */

/**
 * Keyword list used by both the substring matcher (Node side) and the
 * compiled regex (browser side via Playwright). All entries are stored
 * lowercase so the matcher can lowercase the URL once and use `includes`.
 */
export const PRODUCT_IMAGE_DENY_KEYWORDS: readonly string[] = [
  // Documentation / supplier-facing assets (from imageSelector.ts BAD_IMAGE_KEYWORDS)
  'label', 'manual', 'instruction', 'detail', 'details', 'size',
  'spec', 'specification', 'specifications', 'cert', 'test', 'warning',
  'pdf', 'assembly', 'carton', 'package', 'dimension', 'dimensions',
  'prop65', 'closeup', 'close-up', 'parts', 'installation', 'step',
  'guide', 'barcode', 'sticker', 'document', 'certificate', 'report',
  'tcps', 'care', 'paper', 'card', 'carta', 'description', 'shooting',
  'lighting', 'difference',
  // Marketing / UI chrome (from syncGigaVariants.ts NON_PRODUCT_RE)
  'logo', 'placeholder', 'icon', 'sprite', 'tracking', 'pixel',
  'loading', 'spinner', 'favicon', 'bannerdesign',
];

/**
 * `.svg` at end-of-string or before `?` only — substring matching `'svg'`
 * would over-reject any path containing the letters "svg".
 */
const SVG_EXT_RE = /\.svg(\?|$)/i;

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Single compiled regex equivalent to the keyword list + the SVG-extension
 * anchor. Designed for callers that need a serializable pattern — in
 * particular Playwright `page.evaluate` callbacks, which receive the source
 * string and flags via parameters and reconstruct the regex in the browser.
 */
export const PRODUCT_IMAGE_DENY_RE: RegExp = new RegExp(
  PRODUCT_IMAGE_DENY_KEYWORDS.map(escapeForRegex).join('|') + '|\\.svg(\\?|$)',
  'i',
);

/**
 * Returns `true` when the URL is a non-product image (marketing banner,
 * documentation asset, UI chrome, or SVG). Case-insensitive substring
 * match for keywords; anchored SVG check.
 */
export function isLikelyNonProductImage(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false;
  const l = url.toLowerCase();
  if (SVG_EXT_RE.test(l)) return true;
  for (const k of PRODUCT_IMAGE_DENY_KEYWORDS) {
    if (l.includes(k)) return true;
  }
  return false;
}
