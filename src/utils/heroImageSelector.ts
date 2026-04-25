/**
 * Hero image selection utility.
 *
 * Enforces a strict "lifestyle-only" rule:
 *   - images[0] is ALWAYS the plain white/solid-bg primary shot → never used for hero
 *   - images[1] is usually a second angle, still often plain → secondary fallback only
 *   - images[2]+ are overwhelmingly lifestyle/room-scene shots → hero targets
 *
 * Three-tier pool selection:
 *   Tier A  3+ images  → hero image taken from index 3 or 2 (room scene)
 *   Tier B  2 images   → hero image taken from index 1 (alternate angle)
 *   Tier C  1 image    → last-resort plain shot (avoided wherever possible)
 *
 * Pure function — no side effects, no DB calls.
 */

import type { Product } from '../data/products';

// ── Return type ───────────────────────────────────────────────────────────────

export type HeroImageResult = {
  uri: string;
  /**
   * Recommended image position for the banner layout.
   * Tier-A lifestyle shots → 'right' (TEXT_LEFT friendly).
   * Tier-C plain single-image products → 'center'.
   */
  position: 'left' | 'center' | 'right';
  /** Id of the selected product — used for anti-repeat tracking. */
  productId?: string;
  /** categoryPath.level1 of the selected product — used for anti-repeat tracking. */
  category?: string;
};

// ── Selection options ─────────────────────────────────────────────────────────

export type SelectHeroImageOptions = {
  /** categoryPath.level1 to prefer (e.g. 'Living Room'). */
  preferredCategory?: string;
  /** Skip products whose id is in this list. */
  excludeProductIds?: string[];
  /** Skip products whose categoryPath.level1 is in this list. */
  excludeCategories?: string[];
  /**
   * After scoring, pick randomly from the top N candidates.
   * Prevents the banner from always showing the same product while keeping quality high.
   * Default: 3.
   */
  randomizeTopN?: number;
};

// ── Scoring constants ─────────────────────────────────────────────────────────

/** Categories that tend to have good interior/lifestyle photography. */
const HIGH_VALUE_CATEGORIES = new Set([
  'Living Room', 'Dining & Kitchen', 'Bedroom', 'Storage',
]);

/** Furniture types that photograph well in editorial / lifestyle contexts. */
const HIGH_VALUE_NAME_KW = [
  'sofa', 'sectional', 'dining', 'table', 'sideboard', 'cabinet', 'bed', 'vanity',
];

/** Style descriptors that correlate with better-photographed products. */
const STYLE_NAME_KW = ['modern', 'mid-century', 'farmhouse', 'rustic', 'contemporary'];

/** Signals of a parts/accessory listing — bad hero candidates. */
const NEGATIVE_KW = ['parts', 'hardware', 'replacement', 'bracket', 'screw', 'knob'];

/** Bundle listings tend to have cluttered composite images. */
const BUNDLE_KW = ['set', 'bundle', 'kit', 'pack', 'combo'];

// ── Image tier helpers ────────────────────────────────────────────────────────

/** Tier label for a product — used for debug logging and pool selection. */
type ImageTier = 'A-lifestyle' | 'B-secondary' | 'C-fallback';

function imageTier(p: Product): ImageTier {
  if (p.images.length >= 3) return 'A-lifestyle';
  if (p.images.length === 2) return 'B-secondary';
  return 'C-fallback';
}

/**
 * Picks the hero image URI following the strict lifestyle-first rule.
 *
 * Tier A (3+ images):  prefer index 3 → 2 (room/scene shots)
 * Tier B (2 images):   use index 1 (alternate angle; better than plain white index 0)
 * Tier C (1 image):    use index 0 only as last resort
 */
function pickLifestyleUri(p: Product): string | null {
  const imgs = p.images;
  if (imgs.length >= 4) return imgs[3] ?? imgs[2] ?? null;
  if (imgs.length === 3) return imgs[2] ?? null;
  if (imgs.length === 2) return imgs[1] ?? null;
  return imgs[0] ?? null;  // Tier C — last resort
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a numeric score for how good a product is as a hero banner candidate.
 * Higher is better. May be negative for poor candidates.
 */
export function scoreHeroCandidate(product: Product): number {
  let score = 0;
  const nameLc = (product.name ?? '').toLowerCase();

  // Category bonus — rooms that photograph well and drive high-AOV purchases
  if (product.categoryPath?.level1 && HIGH_VALUE_CATEGORIES.has(product.categoryPath.level1)) {
    score += 5;
  }

  // Image richness — steeper scoring to enforce lifestyle-tier preference
  const imgCount = product.images.length;
  if (imgCount >= 5)       score += 8;   // multiple lifestyle scenes virtually guaranteed
  else if (imgCount >= 3)  score += 5;   // lifestyle shot at index 2 is likely
  else if (imgCount === 2) score -= 2;   // both are probably plain-background angles
  else                     score -= 10;  // single image = plain white catalog shot

  // Tag richness signals well-photographed, well-described products
  if (product.tags?.style?.length)    score += 3;
  if (product.tags?.material?.length) score += 3;
  if (product.tags?.color?.length)    score += 2;

  // High-value furniture types
  if (HIGH_VALUE_NAME_KW.some(kw => nameLc.includes(kw))) score += 3;

  // Style descriptors correlate with editorial photography
  if (STYLE_NAME_KW.some(kw => nameLc.includes(kw))) score += 2;

  // Negative signals
  if (NEGATIVE_KW.some(kw => nameLc.includes(kw))) score -= 5;  // parts/hardware
  if (BUNDLE_KW.some(kw => nameLc.includes(kw)))   score -= 3;  // cluttered composites

  return score;
}

/**
 * Selects the best lifestyle hero image from a product catalog.
 *
 * Priority:
 *   1. Tier-A product in preferred category (3+ images → room scene)
 *   2. Tier-A product in any category
 *   3. Tier-B product in preferred category (2 images → alternate angle)
 *   4. Tier-B product in any category
 *   5. Any product (last resort — never blank the banner)
 *
 * Exclusion lists and light top-N randomness are applied within each tier.
 */
export function selectHeroImage(
  products: Product[],
  options?: SelectHeroImageOptions,
): HeroImageResult | null {
  const {
    preferredCategory,
    excludeProductIds = [],
    excludeCategories = [],
    randomizeTopN = 3,
  } = options ?? {};

  const withImages = products.filter(p => p.images.length > 0);
  if (!withImages.length) return null;

  // Tier A first — lifestyle candidates (3+ images)
  const tierAPool = withImages.filter(p => p.images.length >= 3);
  const tierBPool = withImages.filter(p => p.images.length === 2);

  return (
    // 1. Lifestyle tier, preferred category, with exclusions
    _selectFrom(tierAPool, preferredCategory, excludeProductIds, excludeCategories, randomizeTopN) ??
    // 2. Lifestyle tier, any category, with exclusions
    _selectFrom(tierAPool, undefined, excludeProductIds, excludeCategories, randomizeTopN) ??
    // 3. Lifestyle tier, preferred category, no exclusions
    _selectFrom(tierAPool, preferredCategory, [], [], randomizeTopN) ??
    // 4. Lifestyle tier, any category, no exclusions
    _selectFrom(tierAPool, undefined, [], [], randomizeTopN) ??
    // 5. Secondary tier, preferred category
    _selectFrom(tierBPool, preferredCategory, excludeProductIds, excludeCategories, randomizeTopN) ??
    // 6. Secondary tier, any category
    _selectFrom(tierBPool, undefined, excludeProductIds, excludeCategories, randomizeTopN) ??
    // 7. Any product — last resort (never leave banner blank)
    _selectFrom(withImages, undefined, [], [], randomizeTopN)
  );
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _selectFrom(
  pool: Product[],
  preferredCategory: string | undefined,
  excludeProductIds: string[],
  excludeCategories: string[],
  randomizeTopN: number,
): HeroImageResult | null {
  if (!pool.length) return null;

  const excludeIdSet  = new Set(excludeProductIds);
  const excludeCatSet = new Set(excludeCategories);

  // Apply exclusion filters
  let candidates = pool.filter(p => {
    if (excludeIdSet.size  && excludeIdSet.has(p.id))                       return false;
    if (excludeCatSet.size && p.categoryPath?.level1 &&
        excludeCatSet.has(p.categoryPath.level1))                           return false;
    return true;
  });

  if (!candidates.length) return null;

  // Apply preferred-category filter
  if (preferredCategory) {
    const catCandidates = candidates.filter(p => p.categoryPath?.level1 === preferredCategory);
    if (!catCandidates.length) return null;  // let the caller fall through to next tier
    candidates = catCandidates;
  }

  // Rank by score descending
  const ranked = [...candidates].sort(
    (a, b) => scoreHeroCandidate(b) - scoreHeroCandidate(a),
  );

  // Light randomness from top N — keeps quality high while avoiding repetition
  const topN = ranked.slice(0, Math.max(1, randomizeTopN));
  const best = topN[Math.floor(Math.random() * topN.length)];
  if (!best) return null;

  const uri = pickLifestyleUri(best);
  if (!uri) return null;

  // Lifestyle images (Tier A) always position right — room scene fills right half.
  // Plain single images (Tier C) look better centered.
  const position: HeroImageResult['position'] =
    best.images.length >= 2 ? 'right' : 'center';

  if (__DEV__) {
    const tier = imageTier(best);
    const score = scoreHeroCandidate(best);
    console.log(
      '[HeroImage] selected:',
      `productId=${best.id}`,
      `category=${best.categoryPath?.level1 ?? 'unknown'}`,
      `tier=${tier}`,
      `imgCount=${best.images.length}`,
      `score=${score}`,
      `uri=${uri.slice(0, 60)}...`,
    );
  }

  return {
    uri,
    position,
    productId: best.id,
    category: best.categoryPath?.level1,
  };
}
