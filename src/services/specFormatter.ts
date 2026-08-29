/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Spec formatting: category codes, scene codes, SKU generation, dimensions, and weight.
 * Produces retail-ready structured fields for standardized_products.
 */

// ── Category / scene codes ────────────────────────────────────────────────────

const CATEGORY_CODE_MAP: [RegExp, string][] = [
  [/dresser|chest|drawer/i,         'DR'],
  [/cabinet|storage|cupboard/i,     'CB'],
  [/sideboard|buffet/i,             'SB'],
  [/nightstand|bedside/i,           'NS'],
  [/tv\s*stand|media\s*console/i,   'TV'],
  [/bookshelf|bookcase|shelf/i,     'BK'],
  [/coffee\s*table/i,               'CT'],
  [/console\s*table/i,              'CO'],
  [/sofa|couch/i,                   'SF'],
  [/dining\s*chair|chair/i,         'DC'],
  [/desk/i,                         'DK'],
  [/wardrobe|armoire/i,             'WR'],
  [/bathroom/i,                     'BA'],
];

export function categoryCode(category: string, name = ''): string {
  const s = `${category} ${name}`.toLowerCase();
  for (const [re, code] of CATEGORY_CODE_MAP) {
    if (re.test(s)) return code;
  }
  return 'GH';
}

export function sceneCode(category: string, name = ''): string {
  const s = `${category} ${name}`.toLowerCase();
  if (/dresser|nightstand|bedside|bedroom|wardrobe|chest\s*of\s*drawer/i.test(s)) return 'BD';
  if (/sofa|couch|coffee\s*table|tv\s*stand|sideboard|console|living/i.test(s)) return 'LR';
  return 'HM';
}

// ── SKU helpers ───────────────────────────────────────────────────────────────

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function skuSuffix(id: string, originalSku?: string): string {
  if (originalSku && originalSku.trim().length > 0) {
    const alnum = originalSku.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (alnum.length >= 6) return alnum.slice(-6);
    return (alnum + djb2(id).toString(36).toUpperCase()).slice(-6);
  }
  return djb2(id).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

// ── sku_custom identity suffix (SKU Identity Foundation) ─────────────────────
// The LAST6 tail of a supplier SKU carries no cross-supplier uniqueness (GIGA reuses
// S000xx sequence numbers across sellers), so every NEW sku_custom appends a short
// identity suffix derived DETERMINISTICALLY from the FULL supplier_product_id.
// The suffix alone is never treated as a uniqueness guarantee — resolveUniqueSkuCustom
// walks an expandable candidate sequence against the taken set, and the DB UNIQUE
// constraint on standardized_products.sku_custom is the final arbiter.
// No randomness anywhere: the same id yields the same candidate sequence on any
// machine, any rerun, forever.

/** Deterministic, expandable identity-suffix candidates for one supplier id:
 *  2 chars, then 3…7 from the primary hash, then 2…7 from a re-hash, etc. */
export function skuIdentitySuffixCandidates(fullId: string, max = 24): string[] {
  const out: string[] = [];
  let round = 0;
  while (out.length < max) {
    const seed = round === 0 ? fullId : `${fullId}#${round}`;
    const h = djb2(seed).toString(36).toUpperCase().padStart(7, '0');
    for (let len = 2; len <= 7 && out.length < max; len++) out.push(h.slice(0, len));
    round++;
  }
  return out;
}

/**
 * Resolve the final unique sku_custom for a NEW product (pure — callers supply the
 * taken map). `base` is `XH-{CC}-{SC}-{LAST6}`; `taken` maps existing sku_custom →
 * owning supplier_product_id. A candidate already owned by the SAME id is reused
 * (rerun stability); one owned by a different id forces the next, longer candidate.
 */
export function resolveUniqueSkuCustom(
  base: string,
  fullId: string,
  taken: ReadonlyMap<string, string>,
): string {
  for (const suffix of skuIdentitySuffixCandidates(fullId)) {
    const candidate = `${base}-${suffix}`;
    const owner = taken.get(candidate);
    if (owner === undefined || owner === fullId) return candidate;
  }
  // 24 deterministic candidates exhausted — practically unreachable; fail loudly
  // rather than emit a duplicate (the DB UNIQUE constraint would reject it anyway).
  throw new Error(`sku_custom candidate space exhausted for ${fullId} (base ${base})`);
}

// ── Dimension / weight formatters ─────────────────────────────────────────────

/** Strips trailing decimal zeros: "134.00" → "134", "43.66" → "43.66" */
function fmtNum(v: unknown): string {
  const n = parseFloat(String(v));
  return isNaN(n) ? String(v) : String(n);
}

/** Produces retail-ready dimensions string: W 43.66" × D 15.74" × H 74.00" */
export function fmtDimensions(len: unknown, wid: unknown, ht: unknown): string {
  return `W ${fmtNum(len)}" × D ${fmtNum(wid)}" × H ${fmtNum(ht)}"`;
}

/** Produces retail-ready weight string: 134 lb */
export function fmtWeight(v: unknown): string {
  const n = parseFloat(String(v));
  return isNaN(n) ? `${v} lb` : `${n} lb`;
}
