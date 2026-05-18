/**
 * Strips supplier / manufacturer / vendor branding from customer-facing
 * product copy before it lands in standardized_products.
 *
 * Two roles:
 *   - `sanitizeSupplierName(text)` — auto-cleans known-bad prefixes (e.g.
 *     "K&K", "K & K", "K.K", "KK") from the START of a title.
 *   - `detectSuspiciousBrandPrefix(text)` — audit-only; flags rows that
 *     *look* like they begin with an unknown brand prefix but aren't on the
 *     known-bad list. Never auto-applied.
 *   - `containsKnownSupplier(text)` — audit-only; searches anywhere in a
 *     string for a known supplier mention so description / feature / spec
 *     fields can be surfaced for human review without being mutated.
 *
 * Add new known supplier names to `SUPPLIER_PATTERNS` below as they are
 * surfaced by the audit script.
 */

export interface SanitizeResult {
  cleaned: string;
  supplier: string | null;
  changed: boolean;
}

interface SupplierEntry {
  /** Display name used in audit reports. */
  name: string;
  /** Anchored to the start of a title. */
  prefix: RegExp;
  /** Same supplier anywhere inside a string (for description / feature audit). */
  substring: RegExp;
}

const SUPPLIER_PATTERNS: SupplierEntry[] = [
  // K&K family — first supplier surfaced 2026-05.
  // Matches "K&K", "K & K", "K&K.", optional trailing punctuation/spaces.
  {
    name: 'K&K',
    prefix:    /^K\s*&\s*K\b\.?\s*/i,
    substring: /\bK\s*&\s*K\b/i,
  },
  {
    name: 'K.K',
    prefix:    /^K\.K\.?\b\s*/i,
    substring: /\bK\.K\.?\b/i,
  },
  // Standalone "KK" only when followed by a digit, dimension mark, or a
  // capitalised word — avoids stripping legitimate words like "KKW Series".
  {
    name: 'KK',
    prefix:    /^KK\b(?=\s+(?:\d|["']|[A-Z]))/,
    substring: /\bKK\b(?=\s+(?:\d|["']|[A-Z]))/,
  },
];

/** Conservative heuristic for "starts with an unknown brand-like prefix". */
const SUSPICIOUS_PREFIX =
  /^([A-Z][A-Z0-9&.\-]{0,2}(?:\s*[&.]\s*[A-Z][A-Z0-9&.\-]{0,2})?)\s+(?:\d+(?:\.\d+)?["']|(?:Modern|Farmhouse|Wood(?:en)?|Industrial|Rustic|Contemporary|Classic|Antique|Vintage|Home|Kitchen|Bedroom|Living|Dining|Office|Outdoor)\b)/;

export function sanitizeSupplierName(text: string | null | undefined): SanitizeResult {
  if (typeof text !== 'string' || !text) {
    return { cleaned: text ?? '', supplier: null, changed: false };
  }
  const original = text;
  let working = text;
  let supplier: string | null = null;

  for (const entry of SUPPLIER_PATTERNS) {
    if (entry.prefix.test(working)) {
      supplier = entry.name;
      working = working.replace(entry.prefix, '');
      break;
    }
  }

  // Normalise: strip leading punctuation that may dangle after removal,
  // collapse runs of whitespace, trim.
  working = working
    .replace(/^[\s,.;:|\-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return {
    cleaned: working,
    supplier,
    changed: working !== original,
  };
}

export function detectSuspiciousBrandPrefix(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text) return null;
  // Skip rows the known-bad list will already catch.
  if (sanitizeSupplierName(text).supplier) return null;
  const m = text.match(SUSPICIOUS_PREFIX);
  return m ? m[1] : null;
}

export function containsKnownSupplier(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || !text) return null;
  for (const entry of SUPPLIER_PATTERNS) {
    if (entry.substring.test(text)) return entry.name;
  }
  return null;
}
