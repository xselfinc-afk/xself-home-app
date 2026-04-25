/**
 * Product classification utilities.
 *
 * Pure functions — no side effects, no DB calls.
 * Used by detailProductAdapter (Phase 3) to enrich Product objects with
 * structured categoryPath and tags from DB fields + keyword inference.
 *
 * Source of truth for category taxonomy and tag inference rules.
 */

import type { Product, CategoryPath, ProductTags } from '../data/products';

// ── Direct label lookup (highest priority for non-priority categories) ────────
// Keys are the categoryLabel values produced by the backend normalization pipeline.

const LABEL_TO_PATH: Record<string, CategoryPath> = {
  'Cabinet':          { level1: 'Storage',          level2: 'Cabinet' },
  'Dresser':          { level1: 'Storage',           level2: 'Dresser' },
  'Sideboard':        { level1: 'Storage',           level2: 'Sideboard' },
  'Bookshelf':        { level1: 'Storage',           level2: 'Bookshelf' },
  'TV Stand':         { level1: 'Storage',           level2: 'TV Stand' },
  'Shoe Cabinet':     { level1: 'Storage',           level2: 'Shoe Cabinet' },
  'Nightstand':       { level1: 'Bedroom',           level2: 'Nightstand' },
  'Bed':              { level1: 'Bedroom',           level2: 'Bed' },
  'Sofa':             { level1: 'Living Room',       level2: 'Sofa' },
  'Coffee Table':     { level1: 'Living Room',       level2: 'Coffee Table' },
  'Console Table':    { level1: 'Living Room',       level2: 'Console Table' },
  'Side Table':       { level1: 'Living Room',       level2: 'Side Table' },
  'Ottoman':          { level1: 'Living Room',       level2: 'Ottoman' },
  'Dining Chair':     { level1: 'Dining & Kitchen',  level2: 'Dining Chair' },
  'Dining Table':     { level1: 'Dining & Kitchen',  level2: 'Dining Table' },
  'Bar Stool':        { level1: 'Dining & Kitchen',  level2: 'Dining Chair' },
  'Desk':             { level1: 'Office',            level2: 'Desk' },
  'Office Chair':     { level1: 'Office',            level2: 'Office Chair' },
  'File Cabinet':     { level1: 'Office',            level2: 'File Cabinet' },
  'Vanity':           { level1: 'Bathroom',          level2: 'Vanity' },
  'Bathroom Cabinet': { level1: 'Bathroom',          level2: 'Bathroom Cabinet' },
};

// ── Level-1 / Level-2 taxonomy ────────────────────────────────────────────────

interface TaxonomyRule {
  level1: string;
  /** Keywords matched against lowercased categoryLabel, category, or product name. */
  keywords: string[];
  /** level2 label → keywords that narrow down within this level1. */
  level2Map: Record<string, string[]>;
}

const TAXONOMY: TaxonomyRule[] = [
  {
    level1: 'Storage',
    keywords: [
      'cabinet', 'sideboard', 'dresser', 'bookshelf', 'bookcase', 'tv stand',
      'media console', 'entertainment center', 'shoe cabinet', 'shoe rack',
      'storage', 'credenza', 'buffet', 'chest', 'armoire', 'wardrobe', 'hutch',
      'pantry', 'cupboard', 'organizer', 'linen tower',
    ],
    level2Map: {
      'Cabinet':      ['cabinet', 'cupboard', 'pantry', 'storage cabinet', 'organizer'],
      'Dresser':      ['dresser', 'chest of drawers', 'armoire', 'wardrobe', 'chest'],
      'Sideboard':    ['sideboard', 'credenza', 'buffet', 'hutch'],
      'Bookshelf':    ['bookshelf', 'bookcase', 'shelf', 'shelving'],
      'TV Stand':     ['tv stand', 'media console', 'entertainment center', 'tv cabinet'],
      'Shoe Cabinet': ['shoe cabinet', 'shoe rack', 'shoe storage'],
    },
  },
  {
    level1: 'Living Room',
    keywords: [
      'sofa', 'couch', 'loveseat', 'sectional', 'recliner', 'coffee table',
      'console table', 'side table', 'end table', 'accent table', 'ottoman',
      'chaise', 'futon', 'daybed', 'living room',
    ],
    level2Map: {
      'Sofa':          ['sofa', 'couch', 'loveseat', 'sectional', 'recliner', 'chaise', 'futon', 'daybed'],
      'Coffee Table':  ['coffee table'],
      'Console Table': ['console table'],
      'Side Table':    ['side table', 'end table', 'accent table'],
      'Ottoman':       ['ottoman', 'footstool', 'pouf'],
    },
  },
  {
    level1: 'Bedroom',
    keywords: [
      'bed frame', 'headboard', 'mattress', 'nightstand', 'bedside table',
      'bedroom', 'bunk bed', 'loft bed', 'platform bed', 'canopy bed', 'trundle',
    ],
    level2Map: {
      'Bed':       ['bed frame', 'headboard', 'platform bed', 'bunk bed', 'loft bed', 'canopy bed', 'trundle', 'mattress'],
      'Nightstand': ['nightstand', 'bedside table', 'bedside'],
    },
  },
  {
    level1: 'Dining & Kitchen',
    keywords: [
      'dining table', 'dining chair', 'bar table', 'bar stool', 'counter stool',
      'kitchen island', 'kitchen table', 'bar cart', 'dining', 'kitchen',
    ],
    level2Map: {
      'Dining Table': ['dining table', 'kitchen table', 'bar table', 'kitchen island'],
      'Dining Chair': ['dining chair', 'bar stool', 'counter stool'],
      'Bar Cart':     ['bar cart'],
    },
  },
  {
    level1: 'Office',
    keywords: [
      'desk', 'office chair', 'file cabinet', 'filing cabinet', 'workstation',
      'writing desk', 'computer desk', 'standing desk', 'office',
    ],
    level2Map: {
      'Desk':         ['desk', 'workstation', 'writing desk', 'computer desk', 'standing desk'],
      'Office Chair': ['office chair', 'task chair', 'gaming chair'],
      'File Cabinet': ['file cabinet', 'filing cabinet'],
    },
  },
  {
    level1: 'Outdoor & Garden',
    keywords: [
      'patio', 'outdoor', 'garden', 'poolside', 'deck', 'backyard', 'pergola',
      'adirondack', 'picnic', 'umbrella stand',
    ],
    level2Map: {
      'Patio Furniture': ['patio', 'outdoor furniture', 'poolside', 'deck chair'],
      'Garden':          ['garden', 'backyard', 'pergola', 'planter'],
    },
  },
  {
    level1: 'Bathroom',
    keywords: [
      'bathroom', 'over toilet', 'vanity', 'toilet', 'bath', 'medicine cabinet',
      'bathroom cabinet', 'linen tower', 'shower', 'towel rack',
    ],
    level2Map: {
      'Vanity':           ['vanity'],
      'Bathroom Cabinet': ['bathroom cabinet', 'medicine cabinet', 'over toilet', 'toilet', 'linen tower'],
    },
  },
  {
    level1: 'Pet Furniture',
    keywords: ['pet', 'dog', 'cat', 'kennel', 'crate', 'pet bed', 'cat tree', 'pet house'],
    level2Map: {
      'Pet Furniture': ['pet', 'dog', 'cat', 'kennel', 'crate', 'cat tree', 'pet house', 'pet bed'],
    },
  },
];

// High-priority categories checked before LABEL_TO_PATH to prevent broad labels
// like "Cabinet" overriding specific matches like "Bathroom Cabinet" or "Patio Chair".
const HIGH_PRIORITY_LEVEL1 = new Set(['Bathroom', 'Pet Furniture', 'Outdoor & Garden']);

// ── Style keywords ────────────────────────────────────────────────────────────

const STYLE_KEYWORDS: Record<string, string[]> = {
  'Modern':       ['modern', 'contemporary', 'sleek', 'clean line', 'minimalist modern'],
  'Farmhouse':    ['farmhouse', 'barn', 'country', 'shiplap', 'fixer upper', 'cottage'],
  'Industrial':   ['industrial', 'iron', 'pipe', 'factory', 'loft', 'metal leg', 'steel frame'],
  'Minimalist':   ['minimalist', 'minimal', 'scandinavian', 'nordic', 'scandi', 'japanese'],
  'Rustic':       ['rustic', 'vintage', 'antique', 'distressed', 'weathered', 'reclaimed', 'aged'],
  'Mid-Century':  ['mid-century', 'mid century', 'mcm', 'retro', 'danish', 'eames'],
  'Bohemian':     ['bohemian', 'boho', 'eclectic', 'artisan', 'macrame'],
  'Traditional':  ['traditional', 'classic', 'formal', 'ornate', 'carved'],
  'Coastal':      ['coastal', 'beach', 'nautical', 'rattan', 'wicker', 'bamboo', 'seagrass'],
  'Glam':         ['glam', 'glamour', 'velvet', 'mirrored', 'acrylic', 'lucite', 'tufted'],
};

// ── Room inference from level1 ────────────────────────────────────────────────

const LEVEL1_TO_ROOMS: Record<string, string[]> = {
  'Storage':         [],            // ambiguous — skip; storage goes in many rooms
  'Living Room':     ['Living Room'],
  'Bedroom':         ['Bedroom'],
  'Dining & Kitchen': ['Dining Room'],
  'Office':          ['Office', 'Home Office'],
  'Outdoor & Garden': ['Outdoor'],
  'Bathroom':        ['Bathroom'],
  'Pet Furniture':   [],
};

// ── Price range buckets ───────────────────────────────────────────────────────

/**
 * Returns a human-readable price range label for the given price.
 * Used to populate tags.price_range.
 */
export function getPriceRange(price: number): string {
  if (price < 100)  return 'Under $100';
  if (price < 300)  return '$100 – $299';
  if (price < 600)  return '$300 – $599';
  if (price < 1000) return '$600 – $999';
  return '$1000+';
}

// ── Color normalization ───────────────────────────────────────────────────────

/**
 * Maps raw supplier color strings (which may be comma-separated) to
 * clean customer-facing color labels.
 * Returns an array (multiple colors possible from multi-value strings).
 *
 * Examples:
 *   normalizeColor("Antique White,Natural Wood Wash") → ["White", "Natural Wood"]
 *   normalizeColor("Dark Gray")                       → ["Gray"]
 *   normalizeColor("Espresso")                        → ["Brown"]
 */
const COLOR_MAP: [string[], string][] = [
  [['white', 'antique white', 'creamy white', 'ivory', 'cream', 'off-white', 'snow'], 'White'],
  [['black', 'antique black', 'ebony', 'onyx'], 'Black'],
  [['gray', 'grey', 'dark gray', 'dark grey', 'charcoal', 'slate'], 'Gray'],
  [['navy', 'navy blue', 'midnight blue', 'dark blue'], 'Navy'],
  [['blue', 'teal', 'turquoise', 'aqua'], 'Blue'],
  [['brown', 'cappuccino', 'espresso', 'cherry', 'mocha', 'chestnut', 'tan'], 'Brown'],
  [['walnut', 'oak', 'natural wood', 'wood wash', 'natural'], 'Natural Wood'],
  [['green', 'sage', 'olive', 'forest'], 'Green'],
  [['pink', 'rose', 'blush'], 'Pink'],
  [['beige', 'taupe', 'sand', 'linen'], 'Beige'],
  [['gold', 'brass', 'copper', 'bronze'], 'Gold'],
];

export function normalizeColor(raw: string): string[] {
  const parts = raw.split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const results = new Set<string>();
  for (const part of parts) {
    for (const [keywords, label] of COLOR_MAP) {
      if (keywords.some(kw => part.includes(kw))) {
        results.add(label);
        break;
      }
    }
    // Unknown raw values are silently dropped — not surfaced to the filter UI
  }
  return [...results];
}

// ── Material normalization ────────────────────────────────────────────────────

/**
 * Maps raw supplier material strings (which may use comma or + separators)
 * to clean customer-facing material group labels.
 *
 * Examples:
 *   normalizeMaterial("MDF+glass")              → ["Engineered Wood", "Glass"]
 *   normalizeMaterial("Ceramic,Solid Wood+MDF") → ["Glass", "Solid Wood", "Engineered Wood"]
 *   normalizeMaterial("Solid Wood")             → ["Solid Wood"]
 */
const MATERIAL_MAP: [string[], string][] = [
  [['mdf', 'particle board', 'engineered wood', 'plywood', 'fiberboard'], 'Engineered Wood'],
  [['solid wood', 'rubber wood', 'rubberwood', 'pine wood', 'hardwood'], 'Solid Wood'],
  [['metal', 'steel', 'iron', 'aluminum', 'chrome', 'alloy'], 'Metal'],
  [['glass', 'acrylic', 'mirror', 'ceramic', 'marble', 'tempered', 'crystal'], 'Glass'],
  [['fabric', 'linen', 'velvet', 'chenille', 'flannel', 'polyester', 'microfiber', 'upholstered', 'cushion'], 'Fabric'],
  [['faux leather', 'pu leather', 'bonded leather', 'leather'], 'Leather'],
  [['rattan', 'wicker', 'bamboo', 'seagrass', 'woven'], 'Rattan'],
  [['plastic', 'polypropylene', 'resin', 'abs', 'pvc'], 'Plastic'],
];

export function normalizeMaterial(raw: string): string[] {
  const parts = raw.split(/[,+;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const results = new Set<string>();
  for (const part of parts) {
    for (const [keywords, label] of MATERIAL_MAP) {
      if (keywords.some(kw => part.includes(kw))) {
        results.add(label);
        break;
      }
    }
    // Unknown raw values are silently dropped
  }
  return [...results];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lcIncludes(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

function matchesAny(text: string, keywords: string[]): boolean {
  return keywords.some(kw => lcIncludes(text, kw));
}

/** Best-effort string to match against — concatenates all available category hints. */
function categorySearchString(product: Pick<Product, 'name' | 'category' | 'categoryLabel'>): string {
  return [
    product.categoryLabel ?? '',
    product.category ?? '',
    product.name ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Infers a structured category path from a Product.
 *
 * Priority:
 * 0. High-priority specific categories (Bathroom, Outdoor & Garden, Pet Furniture)
 *    are keyword-checked FIRST, before LABEL_TO_PATH, to prevent a broad
 *    categoryLabel like "Cabinet" overriding "Bathroom Cabinet" or "Patio Chair".
 * 1. product.categoryLabel  (most reliable — normalized by the backend pipeline)
 * 2. product.category       (may be a category_code like "CB" or full name)
 * 3. product.name           (title keyword fallback)
 *
 * Returns { level1: "Other", level2: undefined } when no rule matches.
 */
export function inferCategoryPath(
  product: Pick<Product, 'name' | 'category' | 'categoryLabel'>,
): CategoryPath {
  const searchStr = categorySearchString(product);

  // 0. High-priority pre-check — prevents broad labels (e.g. "Cabinet") from
  //    overriding specific matches like "Bathroom Cabinet" or "Patio Chair".
  for (const rule of TAXONOMY.filter(r => HIGH_PRIORITY_LEVEL1.has(r.level1))) {
    if (!matchesAny(searchStr, rule.keywords)) continue;
    let level2: string | undefined;
    for (const [label, kws] of Object.entries(rule.level2Map)) {
      if (matchesAny(searchStr, kws)) { level2 = label; break; }
    }
    return { level1: rule.level1, level2 };
  }

  // 1. Direct label match — most reliable, avoids keyword false positives
  if (product.categoryLabel) {
    const direct = LABEL_TO_PATH[product.categoryLabel];
    if (direct) return direct;
  }

  // 2. Keyword fallback — for products without a normalized categoryLabel.
  //    Check specific categories before broad ones to avoid false positives.
  const prioritized = [
    ...TAXONOMY.filter(r => ['Office', 'Bedroom', 'Dining & Kitchen', 'Living Room'].includes(r.level1)),
    ...TAXONOMY.filter(r => r.level1 === 'Storage'),
  ];

  for (const rule of prioritized) {
    if (!matchesAny(searchStr, rule.keywords)) continue;

    let level2: string | undefined;
    for (const [label, kws] of Object.entries(rule.level2Map)) {
      if (matchesAny(searchStr, kws)) {
        level2 = label;
        break;
      }
    }

    return { level1: rule.level1, level2 };
  }

  return { level1: 'Other' };
}

/**
 * Infers a full ProductTags object for a Product.
 *
 * DB fields take precedence over inference; inference fills gaps.
 * Raw supplier color/material strings are normalized to clean display values.
 *
 * - material:    from product.tags.material (DB, normalized) → name keyword inference
 * - color:       from product.variants[0].color (DB, normalized) → name keyword inference
 * - style:       inferred from product.name keywords
 * - room:        derived from inferCategoryPath(product).level1
 * - price_range: from getPriceRange(product.price)
 */
export function inferProductTags(product: Product): ProductTags {
  const nameLc = (product.name ?? '').toLowerCase();

  // ── material ──────────────────────────────────────────────────────────────
  let material = product.tags?.material;
  if (material?.length) {
    // Normalize raw DB material string(s) — e.g. "MDF+glass" → ["Engineered Wood", "Glass"]
    const normalized = [...new Set(material.flatMap(m => normalizeMaterial(m)))];
    material = normalized.length ? normalized : undefined;
  }
  if (!material?.length) {
    // Infer from common material keywords in the product name
    const MATERIAL_KW: Record<string, string[]> = {
      'Solid Wood': ['solid wood', 'rubberwood', 'rubber wood', 'pine wood', 'hardwood'],
      'Engineered Wood': ['mdf', 'particle board', 'engineered wood'],
      'Metal':    ['metal', 'steel', 'iron', 'aluminum', 'chrome'],
      'Fabric':   ['fabric', 'linen', 'velvet', 'upholstered', 'polyester', 'microfiber'],
      'Leather':  ['leather', 'faux leather', 'pu leather', 'bonded leather'],
      'Glass':    ['glass', 'tempered glass'],
      'Plastic':  ['plastic', 'acrylic', 'resin'],
      'Rattan':   ['rattan', 'wicker', 'seagrass', 'woven'],
      'Marble':   ['marble', 'travertine'],
      // Broad wood fallback — only when no more specific wood type matched
      'Wood':     ['wood', 'wooden', 'oak', 'pine', 'walnut', 'mahogany', 'bamboo'],
    };
    const inferred: string[] = [];
    for (const [label, kws] of Object.entries(MATERIAL_KW)) {
      if (kws.some(kw => nameLc.includes(kw))) inferred.push(label);
    }
    material = inferred.length ? inferred : undefined;
  }

  // ── color ─────────────────────────────────────────────────────────────────
  let color = product.tags?.color;
  if (!color?.length) {
    const variantColor = product.variants?.[0]?.color;
    if (variantColor && variantColor.toLowerCase() !== 'default') {
      // Normalize raw supplier color — e.g. "Antique White,Natural Wood Wash" → ["White","Natural Wood"]
      const normalized = normalizeColor(variantColor);
      color = normalized.length ? normalized : undefined;
    }
    if (!color?.length) {
      // Infer from name keywords
      const COLOR_KW: Record<string, string[]> = {
        'White':      ['white', 'ivory', 'cream', 'off-white'],
        'Black':      ['black', 'ebony', 'onyx'],
        'Gray':       ['gray', 'grey', 'charcoal', 'slate'],
        'Brown':      ['brown', 'walnut', 'chestnut', 'espresso', 'mocha', 'tan'],
        'Natural Wood': ['natural', 'beige', 'sand', 'linen', 'oak', 'pine'],
        'Navy':       ['navy', 'dark blue', 'midnight blue'],
        'Blue':       ['blue', 'teal', 'turquoise', 'aqua'],
        'Green':      ['green', 'sage', 'olive', 'forest'],
        'Gold':       ['gold', 'brass', 'copper', 'bronze'],
      };
      const inferred: string[] = [];
      for (const [label, kws] of Object.entries(COLOR_KW)) {
        if (kws.some(kw => nameLc.includes(kw))) inferred.push(label);
      }
      color = inferred.length ? inferred : undefined;
    }
  }

  // ── style ─────────────────────────────────────────────────────────────────
  const style: string[] = [];
  for (const [label, kws] of Object.entries(STYLE_KEYWORDS)) {
    if (kws.some(kw => nameLc.includes(kw))) style.push(label);
  }

  // ── room ──────────────────────────────────────────────────────────────────
  const { level1 } = inferCategoryPath(product);
  const room = LEVEL1_TO_ROOMS[level1] ?? [];

  // ── price_range ───────────────────────────────────────────────────────────
  const price_range = product.price > 0 ? [getPriceRange(product.price)] : undefined;

  return {
    ...(material?.length    ? { material }    : {}),
    ...(color?.length       ? { color }       : {}),
    ...(style.length        ? { style }       : {}),
    ...(room.length         ? { room }        : {}),
    ...(price_range?.length ? { price_range } : {}),
  };
}
