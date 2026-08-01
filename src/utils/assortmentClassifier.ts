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
  | 'supplementary_outdoor_product'
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
  /** How the title uses outdoor language — the input to indoor/outdoor placement. */
  outdoorSignal: OutdoorSignal;
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

// ── Outdoor context analysis ──────────────────────────────────────────────────
//
// A bare outdoor keyword is NOT evidence that a product is outdoor furniture. Supplier titles use
// these words in three non-identifying ways, each of which previously produced a false outdoor
// classification:
//
//   1. Multi-room suitability lists — "End Table for Living Room, Bedroom, or Patio"
//   2. Style phrases              — "deck chair" is a recliner style, not a location
//   3. Dual-use claims            — "Indoor & Outdoor" without any outdoor product identity
//
// Outdoor identity therefore requires an outdoor word bound to an outdoor-capable product, and a
// strong indoor identity is never overridden by a single loose keyword.

/** Outdoor words that can carry product identity when bound to a product noun. */
const OUTDOOR_STRONG_WORD = 'outdoor|patio|garden|backyard|poolside|porch|lawn|yard';

/**
 * Outdoor words that are only ever weak hints. `balcony`, `deck` and `terrace` overwhelmingly appear
 * as room-suitability mentions or in style phrases ("deck chair"), so they can never establish
 * outdoor identity on their own.
 */
const OUTDOOR_WEAK_WORD = /\b(?:balcony|balconies|deck|terrace|veranda)\b/i;

/** Products that can plausibly be outdoor furniture. */
const OUTDOOR_CAPABLE_HEAD =
  'sofas?|sectionals?|couch(?:es)?|settees?|benches?|bench|chairs?|tables?|sets?|dining|daybeds?|loungers?|lounge|chaise|furniture|umbrellas?|swings?|storage|conversation|bistro|hammocks?|gliders?';

/**
 * Outdoor identity by proximity: a strong outdoor word within 60 characters of an outdoor-capable
 * product noun, in either order. The window is generous because supplier titles pad heavily
 * ("Outdoor Extendable Acacia Wood 3 Seater Sofa"), and it is only consulted when no strong indoor
 * identity is present.
 */
const OUTDOOR_PROXIMITY: RegExp[] = [
  new RegExp(`\\b(?:${OUTDOOR_STRONG_WORD})\\b[^.]{0,60}?\\b(?:${OUTDOOR_CAPABLE_HEAD})\\b`, 'i'),
  new RegExp(`\\b(?:${OUTDOOR_CAPABLE_HEAD})\\b[^.]{0,60}?\\b(?:${OUTDOOR_STRONG_WORD})\\b`, 'i'),
];

/**
 * Unambiguous outdoor products. These are tight enough to outrank even a strong indoor identity —
 * a title naming a "porch swing" or a "patio dining set" is describing an outdoor product regardless
 * of which rooms it also mentions.
 */
const OUTDOOR_PRODUCT_PHRASE: Array<[RegExp, string]> = [
  [/\bporch\s+swings?\b/i, 'porch swing'],
  [/\bfire\s?pits?(?:\s+tables?)?\b/i, 'fire pit'],
  [/\b(?:patio|outdoor|garden)\s+umbrellas?\b/i, 'patio umbrella'],
  [/\bumbrella\s+holes?\b/i, 'umbrella hole'],
  [/\b(?:patio|outdoor)\s+(?:\w+\s+){0,2}?dining\s+sets?\b/i, 'patio dining set'],
  [/\b(?:patio|outdoor)\s+(?:\w+\s+){0,2}?(?:sectionals?|sofa\s+sets?)\b/i, 'outdoor sectional'],
  [/\b(?:garden|patio)\s+(?:\w+\s+){0,2}?bench(?:es)?\b/i, 'garden bench'],
  [/\ball[\s-]?weather\b/i, 'all-weather'],
  [/\bweather[\s-]?(?:resistant|proof)\b/i, 'weather-resistant'],
];

/**
 * Weather-facing materials and construction. Used to resolve dual-use titles: "Dining Set For
 * Outdoor & Indoor" on an ACACIA picnic set is an outdoor product, while "Indoor Outdoor Storage
 * Bench with Cushion Seat" carries no outdoor-specific construction and is a suitability claim.
 */
const OUTDOOR_MATERIAL_HINT =
  /\b(?:acacia|teak|eucalyptus|rattan|wicker|hdpe|pe\s+rattan|picnic|rust[\s-]?(?:resistant|proof)|powder[\s-]?coated|galvani[sz]ed)\b/i;

/**
 * A named room implies the product's home is indoors. Bare "indoor" is deliberately EXCLUDED — it
 * appears in dual-use claims like "For Outdoor & Indoor", where it does not indicate indoor identity.
 */
const INDOOR_ROOM_IDENTITY =
  /\b(?:living\s*rooms?|bed\s*rooms?|dining\s*rooms?|home\s+offices?|study\s*rooms?|nurser(?:y|ies)|apartments?)\b/i;

/** Indoor-only furniture types — an outdoor keyword must never move these outside. */
const INDOOR_ONLY_TYPE =
  /\b(?:murphy\s+beds?|bunk\s*beds?|nightstands?|dressers?|wardrobes?|armoires?|gaming\s+chairs?|office\s+chairs?|desks?|bookcases?|bookshel(?:f|ves)|headboards?|mattress(?:es)?|vanit(?:y|ies))\b/i;

/** "Indoor & Outdoor" / "indoor-outdoor" — a suitability claim, not an outdoor identity. */
const DUAL_USE =
  /\b(?:indoors?\s*(?:&|and|\/|,)\s*outdoors?|outdoors?\s*(?:&|and|\/|,)\s*indoors?|indoor[-\s]outdoor)\b/i;

/**
 * How an outdoor word in the title should be read. Exported so the distinction is directly testable
 * rather than only observable through the final class.
 */
export type OutdoorSignal =
  | 'strong_outdoor_product_signal'
  | 'outdoor_suitability_mention'
  | 'indoor_product_with_optional_outdoor_use'
  | 'ambiguous_outdoor_manual_review'
  | 'none';

/** Classify how the title uses outdoor language. Pure; exported for tests. */
export function outdoorSignalOf(title: string): OutdoorSignal {
  const t = title ?? '';

  // 1. An unambiguous outdoor product wins outright — even over a named indoor room.
  if (OUTDOOR_PRODUCT_PHRASE.some(([re]) => re.test(t))) return 'strong_outdoor_product_signal';

  const strongWordPresent = new RegExp(`\\b(?:${OUTDOOR_STRONG_WORD})\\b`, 'i').test(t);
  const weakWordPresent = OUTDOOR_WEAK_WORD.test(t);
  if (!strongWordPresent && !weakWordPresent) return 'none';

  // 2. A strong indoor identity is never overridden by a loose outdoor keyword.
  if (INDOOR_ROOM_IDENTITY.test(t) || INDOOR_ONLY_TYPE.test(t)) {
    // Exception: a room list naming SEVERAL outdoor locations on a weather-built product is a
    // genuine dual-use item ("Rattan Hanging Egg Chair … for Patio Balcony Backyard Bedroom").
    // Calling it indoor would be as wrong as calling it outdoor, so it goes to manual review.
    const distinctStrongWords = new Set(
      (t.match(new RegExp(`\\b(?:${OUTDOOR_STRONG_WORD})\\b`, 'gi')) ?? []).map(w => w.toLowerCase()),
    );
    if (distinctStrongWords.size >= 2 && OUTDOOR_MATERIAL_HINT.test(t)) {
      return 'ambiguous_outdoor_manual_review';
    }
    return 'indoor_product_with_optional_outdoor_use';
  }

  // 3. "Indoor & Outdoor" is a suitability claim UNLESS the product is built for weather.
  if (DUAL_USE.test(t) && !OUTDOOR_MATERIAL_HINT.test(t)) return 'outdoor_suitability_mention';

  // 4. Does the outdoor word actually bind to an outdoor-capable product?
  if (strongWordPresent && OUTDOOR_PROXIMITY.some(re => re.test(t))) {
    return 'strong_outdoor_product_signal';
  }

  // 5. A weak word alone (balcony / deck / terrace) never establishes outdoor identity.
  if (!strongWordPresent) return 'outdoor_suitability_mention';

  // 6. A strong word floating free of any product noun — unresolvable from the title.
  return 'ambiguous_outdoor_manual_review';
}

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
  // Outdoor placement is decided by CONTEXT, not by the presence of an outdoor keyword.
  const outdoorSignal = outdoorSignalOf(title);
  const base = { taxonomyDepartment: dept, taxonomyProductType: type, outdoorSignal };

  if (!title) {
    return { assortment: 'ambiguous_manual_review', basis: 'unresolved', matched: null, ...base };
  }

  const asFurniture = (basis: AssortmentBasis, matched: string | null): AssortmentResult => {
    const assortment: AssortmentClass =
      outdoorSignal === 'strong_outdoor_product_signal' ? 'outdoor_furniture'
      : outdoorSignal === 'ambiguous_outdoor_manual_review' ? 'ambiguous_manual_review'
      // `outdoor_suitability_mention` and `indoor_product_with_optional_outdoor_use` are indoor
      // products that merely mention outdoor use — they stay in the core assortment.
      : 'core_indoor_furniture';
    return { assortment, basis, matched, ...base };
  };

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

  // 4b. Outdoor products whose head-noun is not indoor furniture — a porch swing, a patio umbrella,
  // an outdoor storage box. A strong outdoor signal has already established outdoor identity here,
  // and decor and non-furniture were both ruled out above.
  if (outdoorSignal === 'strong_outdoor_product_signal') {
    return { assortment: 'outdoor_furniture', basis: 'supplementary_outdoor_product', matched: null, ...base };
  }

  // 5. Unknown stays unknown. Never inferred as excluded.
  return { assortment: 'ambiguous_manual_review', basis: 'unresolved', matched: null, ...base };
}

/** True when the class represents something XSelf sells as furniture (indoor or outdoor). */
export const isFurnitureClass = (c: AssortmentClass): boolean =>
  c === 'core_indoor_furniture' || c === 'outdoor_furniture';
