/**
 * Assortment classifier — pure, deterministic, side-effect free.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/planGigaSavedItems.ts` gates saved items with a flat title regex (`HARD_JUNK`) that asks
 * only "does the title contain a suspicious word?". That produced a ~29% false-positive rate in the
 * 144-row REVIEW_REQUIRED analysis: Murphy beds, bunk beds, trash *cabinets* and fish-tank *stands*
 * are core furniture, but were excluded because their titles contain "murphy", "bunk", "trash" and
 * "fish tank".
 *
 * `scripts/planGigaAutoPublish.ts` already solved this correctly (see `baseBucketOf`): the Commerce
 * Taxonomy is the authority, and HARD_JUNK only applies to products the taxonomy cannot place. This
 * module makes that same authority reusable, and layers the small number of supplementary rules
 * needed to resolve titles the taxonomy leaves at `needs-review`.
 *
 * DELIBERATELY NOT MODIFYING `src/utils/commerceTaxonomy.ts`. That crosswalk drives
 * `commerceCanonical`, which drives auto-publish CLEAN/HOLD/REJECT. Widening its keywords would make
 * currently-unplaceable products publish-eligible — a publication behavior change. This module is
 * additive and read-only with respect to the taxonomy.
 */
import { classifyCommerce, isNeedsReview } from './commerceTaxonomy';
import type { Product } from '../data/products';

export type AssortmentClass =
  | 'core_indoor_furniture'
  | 'outdoor_furniture'
  | 'home_decor'
  | 'genuine_non_furniture'
  | 'ambiguous_manual_review';

export type AssortmentBasis =
  | 'furniture_compound_override'
  | 'strong_non_furniture'
  | 'taxonomy_furniture'
  | 'taxonomy_outdoor_garden'
  | 'taxonomy_non_furniture_department'
  | 'supplementary_furniture_head'
  | 'supplementary_non_furniture'
  | 'unresolved';

export interface AssortmentResult {
  assortment: AssortmentClass;
  /** Which rule decided the outcome — for auditability in reports. */
  basis: AssortmentBasis;
  /** Taxonomy output, always reported even when a supplementary rule decided. */
  taxonomyDepartment: string;
  taxonomyProductType: string;
  /** The token that triggered `basis`, when a regex rule decided. */
  matched: string | null;
}

export interface AssortmentInput {
  title: string;
  category?: string;
  categoryLabel?: string;
}

// ── Rule tables ───────────────────────────────────────────────────────────────

/**
 * Compounds that ARE furniture even though they contain a non-furniture word. Checked FIRST, so a
 * fish-tank *stand* is never mistaken for an aquarium and a trash *cabinet* is never mistaken for a
 * trash can. This is the direct fix for the false positives found in the REVIEW_REQUIRED analysis.
 */
const FURNITURE_COMPOUND_OVERRIDE: Array<[RegExp, string]> = [
  [/\b(?:fish\s*tank|aquarium)\s+(?:stand|cabinet|table)\b/i, 'fish tank stand'],
  [/\btrash\s+(?:can\s+)?cabinet\b/i, 'trash cabinet'],
  [/\b(?:garbage|recycling)\s+(?:can\s+)?cabinet\b/i, 'garbage cabinet'],
  [/\blitter\s*box\s+(?:enclosure|cabinet|bench|furniture)\b/i, 'litter box enclosure'],
  [/\b(?:dog|pet|cat)\s+crate\s+(?:end\s+)?table\b/i, 'crate end table'],
  // "Dog Crate Furniture, Indoor Wooden Dog Kennel End Table" — the furniture head can sit several
  // words after the enclosure word, so proximity matching is required, not adjacency.
  [/\b(?:crate|kennel)\b[^.]{0,60}?\b(?:furniture|(?:end|side)\s+table|nightstand|console)\b/i, 'crate furniture'],
  [/\b(?:furniture|(?:end|side)\s+table|nightstand|console)\b[^.]{0,60}?\b(?:crate|kennel)\b/i, 'crate furniture'],
  [/\btilt[\s-]?out\s+(?:trash|garbage)\b/i, 'tilt-out trash cabinet'],
];

/**
 * Product nouns that are never furniture. These BEAT generic furniture words (stand / rack / bench),
 * so "bike with training wheels and stand" stays non-furniture even though "stand" is present.
 * Note `\bbike\b` and `\bbicycle\b` are here; `kickstand` is a single token and cannot match
 * `\bstand\b`, so it needs no special handling.
 */
const STRONG_NON_FURNITURE: Array<[RegExp, string]> = [
  [/\b(?:luggage|suitcase|carry[\s-]?on)\b/i, 'luggage'],
  [/\btrampolines?\b/i, 'trampoline'],
  [/\b(?:bicycles?|bikes?|tricycles?)\b/i, 'bicycle'],
  [/\btraining\s+wheels\b/i, 'training wheels'],
  [/\blitter\s*box(?:es)?\b/i, 'litter box'],
  [/\bcat\s+(?:tower|tree|condo|scratch(?:er|ing)?)\b/i, 'cat tower'],
  [/\b(?:treadmill|exercise\s+machine|dumbbell|kettlebell)\b/i, 'fitness equipment'],
  [/\b(?:stroller|car\s+seat|playpen|walker)\b/i, 'juvenile gear'],
];

/** Decor, not furniture: display objects rather than functional pieces. */
const DECOR: Array<[RegExp, string]> = [
  [/\b(?:statues?|sculptures?|figurines?)\b/i, 'statue'],
  [/\bfountains?\b/i, 'fountain'],
  [/\b(?:planters?|flower\s*pots?)\b/i, 'planter'],
  [/\b(?:wall\s+art|wind\s*chimes?|bird\s*bath)\b/i, 'decor'],
];

/**
 * Furniture head-nouns. Reached only after the strong non-furniture check, so generic words like
 * `stand`, `rack`, `bench` and `cabinet` here are already safe from non-furniture contexts.
 */
const FURNITURE_HEAD: Array<[RegExp, string]> = [
  [/\b(?:beds?|bunk\s*beds?|daybeds?|headboards?)\b/i, 'bed'],
  [/\b(?:sofas?|couch(?:es)?|sectionals?|loveseats?|settees?|futons?)\b/i, 'sofa'],
  [/\b(?:chairs?|recliners?|stools?|bench(?:es)?|chaise|ottomans?)\b/i, 'chair'],
  [/\b(?:tables?|desks?|consoles?|credenzas?)\b/i, 'table'],
  [/\b(?:dressers?|nightstands?|wardrobes?|armoires?|chests?)\b/i, 'case good'],
  [/\b(?:cabinets?|cupboards?|sideboards?|buffets?|hutch(?:es)?|vanit(?:y|ies))\b/i, 'cabinet'],
  [/\b(?:bookcases?|bookshel(?:f|ves)|shelving|étag[eè]res?)\b/i, 'shelving'],
  [/\b(?:tv|television|media)\s+(?:stand|unit|center|centre)\b/i, 'tv stand'],
  [/\bfurniture\s+(?:set|sets|piece)\b/i, 'furniture set'],
  [/\b(?:stands?|racks?)\b/i, 'stand'],
];

/**
 * Product types that ARE furniture but live outside the `furniture` department. Without this, a
 * bathroom vanity (department `bathroom`) would be called non-furniture — the same class of error
 * this module exists to fix. Sourced from the taxonomy registry, not invented.
 */
const FURNITURE_TYPES_OUTSIDE_FURNITURE_DEPT = new Set([
  'bathroom-vanity',
  'bathroom-cabinet',
  'outdoor-bench',
  'toy-box',
  'kids-storage',
]);

const OUTDOOR_MARKER =
  /\b(?:outdoor|patio|backyard|garden|poolside|porch|balcony|lawn|deck|all[\s-]?weather|weather[\s-]?resistant)\b/i;

const first = (table: Array<[RegExp, string]>, s: string): string | null => {
  for (const [re, label] of table) if (re.test(s)) return label;
  return null;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a product title into an assortment bucket. Pure and deterministic; never throws.
 * An empty/whitespace title yields `ambiguous_manual_review` — absence of evidence is never
 * treated as evidence of exclusion.
 */
export function classifyAssortment(input: AssortmentInput): AssortmentResult {
  const title = (input.title ?? '').trim();
  const tax = classifyCommerce({
    name: title,
    category: input.category ?? '',
    categoryLabel: input.categoryLabel ?? '',
  } as Pick<Product, 'name' | 'category' | 'categoryLabel'>);
  const dept = tax.department;
  const type = tax.productType;
  const base = { taxonomyDepartment: dept, taxonomyProductType: type };

  if (!title) {
    return { assortment: 'ambiguous_manual_review', basis: 'unresolved', matched: null, ...base };
  }

  const outdoor = OUTDOOR_MARKER.test(title);
  const asFurniture = (basis: AssortmentBasis, matched: string | null): AssortmentResult => ({
    assortment: outdoor ? 'outdoor_furniture' : 'core_indoor_furniture',
    basis,
    matched,
    ...base,
  });

  // 1. Furniture compounds win outright — a fish-tank STAND is furniture.
  const override = first(FURNITURE_COMPOUND_OVERRIDE, title);
  if (override) return asFurniture('furniture_compound_override', override);

  // 2. Strong non-furniture nouns beat generic furniture words (bike + "stand" → non-furniture).
  const strong = first(STRONG_NON_FURNITURE, title);
  if (strong) {
    return { assortment: 'genuine_non_furniture', basis: 'strong_non_furniture', matched: strong, ...base };
  }

  // 3. Commerce Taxonomy is the authority wherever it can place the product.
  if (!isNeedsReview(tax)) {
    if (dept === 'furniture' || FURNITURE_TYPES_OUTSIDE_FURNITURE_DEPT.has(type)) {
      return asFurniture('taxonomy_furniture', type);
    }
    if (dept === 'outdoor-garden') {
      const decor = first(DECOR, title);
      return decor
        ? { assortment: 'home_decor', basis: 'taxonomy_outdoor_garden', matched: decor, ...base }
        : { assortment: 'outdoor_furniture', basis: 'taxonomy_outdoor_garden', matched: type, ...base };
    }
    return {
      assortment: 'genuine_non_furniture',
      basis: 'taxonomy_non_furniture_department',
      matched: dept,
      ...base,
    };
  }

  // 4. Taxonomy could not place it — supplementary rules.
  const decor = first(DECOR, title);
  if (decor) return { assortment: 'home_decor', basis: 'supplementary_non_furniture', matched: decor, ...base };

  const head = first(FURNITURE_HEAD, title);
  if (head) return asFurniture('supplementary_furniture_head', head);

  // 5. Unknown stays unknown. Never inferred as excluded.
  return { assortment: 'ambiguous_manual_review', basis: 'unresolved', matched: null, ...base };
}

/** True when the class represents something XSelf sells as furniture (indoor or outdoor). */
export const isFurnitureClass = (c: AssortmentClass): boolean =>
  c === 'core_indoor_furniture' || c === 'outdoor_furniture';
