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
