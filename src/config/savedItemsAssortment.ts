/**
 * Saved Items — taxonomy-first assortment gate feature flag.
 *
 * DEFAULT OFF. While false, `scripts/planGigaSavedItems.ts` behaves EXACTLY as it does today: the
 * legacy `HARD_JUNK` title regex is the sole assortment gate, the same SKUs are blocked with the
 * same `junk_category` reason, and the emitted plan report is byte-identical. Turning it off again
 * is a one-character revert with no database or migration involvement.
 *
 * WHY THE FLAG EXISTS
 * -------------------
 * The legacy gate mis-classified 30 of 85 flagged saved items (22 furniture called junk, 8 indoor
 * products called outdoor). The replacement — `src/utils/assortmentClassifier.ts`, validated in
 * `docs/product-supply/OUTDOOR_CONTEXT_CORRECTION_REPORT.md` — adds 10 candidates, removes 0, and
 * affects 0 published products. That validation was performed read-only; this flag keeps the change
 * inert until it is explicitly approved.
 *
 * Compile-time constant, following `src/config/commerceTaxonomy.ts` and
 * `src/config/productFamilyPilot.ts`: zero runtime and zero database dependency, so there is no
 * remote flag to mis-set and no production row to write.
 *
 * ACTIVATION (requires separate approval — do not flip as a side effect of other work):
 *   1. Dry-run first:  npm run giga:saved:compare-assortment
 *   2. Flip SAVED_ITEMS_TAXONOMY_FIRST_ENABLED to true here.
 *   3. Re-run the saved-items plan and diff the report against the prior run.
 *   4. Rollback = flip back to false; nothing else to undo.
 */

/** Master switch for the taxonomy-first assortment gate. MUST default to false. */
export const SAVED_ITEMS_TAXONOMY_FIRST_ENABLED = false;

/**
 * Outcomes of the assortment gate.
 *
 * Only `reject_non_furniture` blocks a SKU outright. The review outcomes are NOT rejections — they
 * park a correctly-identified product for a Founder decision instead of silently dropping it, which
 * is the failure mode this whole correction exists to remove. None of them are `new_candidate`, so
 * none can auto-publish.
 */
export type AssortmentGateOutcome =
  | 'allow'
  | 'policy_review_outdoor'
  | 'policy_review_decor'
  | 'reject_non_furniture'
  | 'manual_review_required';

/**
 * Resolve whether the taxonomy-first gate is active.
 *
 * `override` exists so the read-only comparison mode and the tests can exercise both branches
 * without mutating the shipped default. Production callers pass nothing and get `false`.
 */
export function isTaxonomyFirstEnabled(override?: boolean): boolean {
  return override ?? SAVED_ITEMS_TAXONOMY_FIRST_ENABLED;
}
