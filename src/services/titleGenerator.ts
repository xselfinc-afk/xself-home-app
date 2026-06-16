/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Title generation for normalized product data.
 * Produces Wayfair-style retail-ready titles from raw supplier text.
 */

const PROMO_PATTERNS: RegExp[] = [
  /\b(brand\s+new|new\s+arrival|hot\s+(sale|deal|item)|flash\s+sale|best\s+seller|top\s+rated|clearance|free\s+shipping|limited\s+time)\b/gi,
  /\b\d+\s*%\s*off\b/gi,
  /\bbuy\s+\d+\s+get\s+\d+\b/gi,
  /\b(amazing|premium|luxury|superior|excellent|perfect|gorgeous|fantastic|wonderful)\b/gi,
  /\b(sale|discount|promo|deal)\b/gi,
];

const CATEGORY_SUFFIXES_TO_STRIP: RegExp[] = [
  /\s*[-–|]\s*[A-Z][A-Za-z\s]+$/,   // trailing "- Brand Name" separators
  /\s*\([^)]{20,}\)\s*$/,            // long parenthetical at end
  /\s*\[[^\]]{10,}\]\s*$/,           // long bracket content at end
];

// Strategy A: strip a leading supplier brand prefix (anchored, explicit list).
// Bare "GO" is deliberately EXCLUDED (too ambiguous — e.g. real words). Mirrors the
// brand list in scripts/planGigaAutoPublish.ts so the planner gate and the normalizer agree.
const LEADING_BRAND_PREFIX = /^(?:trexm|vibe\s?haus|k&k|fch|gartoo|kepswin|woj|topmax|tomax)\b[\s:.,\-–|]*/i;

// Leading promotional tag(s) like "[Video]" / "[Assembly Video Provided]".
const LEADING_PROMO_TAG = /^\s*(?:\[[^\]]*\b(?:video|assembly)\b[^\]]*\]\s*)+/i;

// Clearly-promotional fragments removed anywhere in the title (tightly scoped).
const MARKETING_FRAGMENTS: RegExp[] = [
  /\bmade in usa\b/gi,
  /\b\d+\s*-?\s*day shipping\b/gi,
  /\bcustom fabric options?\b/gi,
];

function truncateAtWord(s: string, max: number): string {
  if (!s) return '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Strips promotional noise and trailing brand/category separators.
 * Truncates at word boundary to ≤80 chars.
 */
export function cleanTitle(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';

  let t = raw.trim();

  // Strategy A: strip leading supplier brand prefix + clearly-promotional fragments
  // before the generic promo/suffix cleanup below.
  t = t.replace(LEADING_PROMO_TAG, '');
  t = t.replace(LEADING_BRAND_PREFIX, '');
  for (const re of MARKETING_FRAGMENTS) {
    t = t.replace(re, '');
  }

  for (const re of PROMO_PATTERNS) {
    t = t.replace(re, '');
  }
  for (const re of CATEGORY_SUFFIXES_TO_STRIP) {
    t = t.replace(re, '');
  }

  // Collapse separator/comma debris left behind by fragment removal (e.g. "– , , ,").
  t = t.replace(/[-–|]\s*,/g, ',').replace(/(?:,\s*){2,}/g, ', ');
  t = t.replace(/,\s*,/g, ',').replace(/\s{2,}/g, ' ').trim();
  t = t.replace(/^[,\-–|:]+\s*/, '').replace(/\s*[,\-–|:]+$/, '').trim();

  return truncateAtWord(t, 80);
}

/** Truncates to ≤36 chars at word boundary. Used for compact UI surfaces. */
export function toShortTitle(title: string): string {
  return truncateAtWord(title, 36);
}

/**
 * Generates a shorter display title optimized for UI surfaces.
 * - Strips leading [Tag] prefixes (e.g. "[Video]")
 * - Strips leading SKU references ("OLD SKU XXXX", "new sku: ...")
 * - Moves leading "Set of N" quantity to the end
 * - Truncates at word boundary to ≤55 chars
 */
export function buildDisplayTitle(title: string): string {
  if (!title) return '';
  let t = title.trim();
  t = t.replace(/^\[.*?\]\s*/i, '');
  t = t.replace(/^(old|new|same)\s+sku\s*[:\-]?\s*\S*\s*/i, '');
  t = t.replace(/^(Set of \d+)\s+(.+)$/, '$2, $1');
  t = t.replace(/\s{2,}/g, ' ').trim();
  return truncateAtWord(t, 55);
}
