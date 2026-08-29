/**
 * Generates Xself-format SKUs: XH-SS-TT-XXXXXX
 *
 *   XH       — Xself Home prefix (fixed)
 *   SS       — 2-letter category code
 *   TT       — 2-letter material code
 *   XXXXXX   — last 6 alphanumeric chars from original supplier SKU,
 *              or a 6-char hash of the product ID when no original SKU exists
 */

import { skuSuffix } from '../services/specFormatter';

export type SkuParams = {
  id: string;
  category?: string;
  material?: string;
  originalSku?: string;
};

export function generateSku({ id, category, material, originalSku }: SkuParams): string {
  const ss = categoryCode(category ?? '');
  const tt = materialCode(material ?? '');
  const suffix = skuSuffix(id, originalSku);
  return `XH-${ss}-${tt}-${suffix}`;
}

// ── Category codes (SS) ───────────────────────────────────────────────────────

const CATEGORY_MAP: [RegExp, string][] = [
  [/cabinet|storage|cupboard/i,     'CB'],
  [/dresser|chest|drawer/i,         'DR'],
  [/bookshelf|bookcase|shelf|shelv/i,'BK'],
  [/tv\s*stand|media\s*console/i,   'TV'],
  [/nightstand|bedside/i,           'NS'],
  [/dining\s*chair|chair/i,         'DC'],
  [/coffee\s*table/i,               'CT'],
  [/console\s*table/i,              'CO'],
  [/bathroom/i,                     'BA'],
  [/sofa|couch|loveseat/i,          'SF'],
  [/bed\s*frame|headboard/i,        'BD'],
  [/desk|workstation/i,             'DK'],
  [/wardrobe|armoire|closet/i,      'WR'],
  [/side\s*table|end\s*table/i,     'ST'],
  [/sideboard|buffet/i,             'SB'],
];

function categoryCode(cat: string): string {
  for (const [re, code] of CATEGORY_MAP) {
    if (re.test(cat)) return code;
  }
  return 'GH'; // General Home
}

// ── Material codes (TT) ───────────────────────────────────────────────────────

const MATERIAL_MAP: [RegExp, string][] = [
  [/solid\s*wood|hardwood|oak|walnut|pine|birch|teak/i, 'WD'],
  [/mdf|particleboard|engineered\s*wood|wood\s*composite/i, 'EW'],
  [/metal|steel|iron|aluminum|aluminium/i,              'MT'],
  [/fabric|velvet|linen|cotton|polyester/i,             'FB'],
  [/leather|pu\s*leather|faux\s*leather|bonded/i,       'LR'],
  [/glass/i,                                            'GL'],
  [/plastic|acrylic|abs|polypropylene/i,                'PL'],
  [/rattan|wicker|bamboo/i,                             'RA'],
  [/marble|stone|granite/i,                             'MR'],
];

function materialCode(mat: string): string {
  for (const [re, code] of MATERIAL_MAP) {
    if (re.test(mat)) return code;
  }
  return 'HM'; // Home Material (default)
}

// ── Suffix ────────────────────────────────────────────────────────────────────
// Single source of truth: specFormatter.skuSuffix (imported above). The previous
// local copy drifted independently and was removed — do not reintroduce it.
