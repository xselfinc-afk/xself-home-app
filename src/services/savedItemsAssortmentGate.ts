/**
 * Saved Items assortment gate — pure, deterministic, side-effect free.
 *
 * This is the single decision point that `scripts/planGigaSavedItems.ts` consults for the assortment
 * dimension of candidate validity. It exists as its own module because the plan script performs
 * supplier and database I/O at module scope and therefore cannot be unit-tested directly.
 *
 * TWO BRANCHES, ONE OF WHICH MUST NEVER CHANGE
 * --------------------------------------------
 * With the flag OFF (the shipped default) this returns exactly what the legacy inline expression
 * returned — `HARD_JUNK.test(title)` — with the same `junk_category` reason string. Nothing else is
 * consulted, so the emitted plan report stays byte-identical.
 *
 * With the flag ON the taxonomy-first classifier decides, and only `genuine_non_furniture` blocks.
 * Outdoor, decor and ambiguous products are routed to review outcomes: identified correctly, held
 * for a Founder decision, and — because they are not `new_candidate` — never auto-published.
 *
 * WHAT THIS GATE DOES NOT TOUCH
 * -----------------------------
 * Image, price, enrichment, membership-precedence and every other candidate safety check live in
 * the plan script and are unchanged. This gate answers one question — "is this the kind of product
 * we carry?" — and its answer is combined with, never substituted for, those checks.
 */
import { type AssortmentGateOutcome, isTaxonomyFirstEnabled } from '../config/savedItemsAssortment';
import { classifyAssortment, type AssortmentClass } from '../utils/assortmentClassifier';

export type { AssortmentGateOutcome };

/**
 * Byte-for-byte replica of the production literal in `scripts/planGigaSavedItems.ts` and
 * `scripts/planGigaAutoPublish.ts`. `savedItemsAssortmentGate.test.ts` asserts this stays
 * character-identical to both sources, so any drift fails the suite.
 */
export const LEGACY_HARD_JUNK =
  /\b(pet|dog|cat|kitten|puppy|fish\s*tank|aquarium|litter|kennel|crate|kid|kids|toy|toddler|nursery|bunk|murphy|crib|playpen|patio|outdoor|garden|gazebo|pergola|trampoline|trash|garbage|luggage|suitcase|bean\s?bag)\b/i;

/** The legacy reason string. Preserved verbatim — report consumers match on it. */
export const LEGACY_JUNK_REASON = 'junk_category';

/** Reason emitted when the taxonomy-first gate rejects a product as outside the assortment. */
export const NON_FURNITURE_REASON = 'non_furniture';

export interface AssortmentGateInput {
  title: string;
  /** Normalized category label, when known — a classifier hint only. */
  category?: string;
  /** Test/dry-run override. Production callers omit it and get the shipped default (false). */
  taxonomyFirst?: boolean;
}

export interface AssortmentGateResult {
  /** True when the SKU must not become a candidate. */
  blocked: boolean;
  /** Reason string to append to `invalid_reasons`, or null when not blocked. */
  reason: string | null;
  outcome: AssortmentGateOutcome;
  /** Null in legacy mode — the legacy gate has no notion of assortment class. */
  assortmentClass: AssortmentClass | null;
  /** Which branch produced this result. */
  mode: 'legacy' | 'taxonomy_first';
}

const CLASS_TO_OUTCOME: Record<AssortmentClass, AssortmentGateOutcome> = {
  core_indoor_furniture: 'allow',
  outdoor_furniture: 'policy_review_outdoor',
  home_decor: 'policy_review_decor',
  genuine_non_furniture: 'reject_non_furniture',
  ambiguous_manual_review: 'manual_review_required',
};

/** Outcomes that must never be treated as an eligible candidate. */
const NON_CANDIDATE_OUTCOMES: ReadonlySet<AssortmentGateOutcome> = new Set<AssortmentGateOutcome>([
  'policy_review_outdoor',
  'policy_review_decor',
  'reject_non_furniture',
  'manual_review_required',
]);

/** True when the outcome means "do not process as a normal candidate". */
export function isNonCandidateOutcome(o: AssortmentGateOutcome): boolean {
  return NON_CANDIDATE_OUTCOMES.has(o);
}

/**
 * The legacy assortment gate, isolated. This is the exact expression the plan script used inline,
 * and it must keep returning identical results forever — the flag-off path depends on it.
 */
export function legacyJunkBlocked(title: string): boolean {
  return LEGACY_HARD_JUNK.test(title ?? '');
}

/**
 * Decide the assortment dimension for one saved item. Pure; never throws.
 */
export function assortmentGate(input: AssortmentGateInput): AssortmentGateResult {
  const title = input.title ?? '';

  if (!isTaxonomyFirstEnabled(input.taxonomyFirst)) {
    const blocked = legacyJunkBlocked(title);
    return {
      blocked,
      reason: blocked ? LEGACY_JUNK_REASON : null,
      outcome: blocked ? 'reject_non_furniture' : 'allow',
      assortmentClass: null,
      mode: 'legacy',
    };
  }

  const c = classifyAssortment({ title, category: input.category }).assortment;
  const outcome = CLASS_TO_OUTCOME[c];
  return {
    // Only a genuine non-furniture product is an outright block. Review outcomes are held, not
    // rejected, and are surfaced through their own classification rather than as invalid.
    blocked: outcome === 'reject_non_furniture',
    reason: outcome === 'reject_non_furniture' ? NON_FURNITURE_REASON : null,
    outcome,
    assortmentClass: c,
    mode: 'taxonomy_first',
  };
}

/**
 * Plan-report classification for a review outcome, or null when the SKU should continue through the
 * normal candidate path. Kept here so the plan script has no mapping logic of its own.
 */
export function reviewClassificationFor(outcome: AssortmentGateOutcome): string | null {
  switch (outcome) {
    case 'policy_review_outdoor': return 'policy_review_outdoor';
    case 'policy_review_decor': return 'policy_review_decor';
    case 'manual_review_required': return 'manual_review_required';
    default: return null;
  }
}
