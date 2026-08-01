/**
 * Assortment decision comparison — pure, read-only, side-effect free.
 *
 * Runs the CURRENT production gate and the NEW taxonomy-first classifier side by side so their
 * disagreements can be inspected before any production behavior changes. This module is a mirror,
 * not a switch: nothing in the live plan path imports it, and it performs no I/O of any kind.
 *
 * WHAT IS BEING COMPARED — and what is deliberately held constant
 * ---------------------------------------------------------------
 * `scripts/planGigaSavedItems.ts` blocks a candidate when ANY of these hold:
 *
 *     !hasTitle || HARD_JUNK.test(title) || hasImage === false || hasPrice === false || ...
 *
 * Only the `HARD_JUNK.test(title)` term is under review. The image/price/enrichment terms are
 * unchanged by this work and depend on live supplier enrichment, so they are held constant and
 * excluded from the comparison. A row reported here as "would be accepted" means "would no longer be
 * blocked *for assortment reasons*" — the other gates still apply unchanged.
 *
 * THE GATE DOES NOT APPLY TO EVERY SAVED ITEM
 * -------------------------------------------
 * In the production flow, membership precedence runs FIRST:
 *
 *     inSell            → 'already_published'   (never reaches the junk gate)
 *     inSupplier|inStd  → 'already_imported'    (never reaches the junk gate)
 *     otherwise         → candidate             (junk gate applies)
 *
 * So a published or imported product cannot be affected by changing this gate. `gateApplies`
 * records that per row rather than assuming it.
 */
import { classifyAssortment, type AssortmentClass } from '../utils/assortmentClassifier';

/**
 * Byte-for-byte replica of the production literal in `scripts/planGigaSavedItems.ts:62` and
 * `scripts/planGigaAutoPublish.ts:70` (verified identical in both). Replicated rather than imported
 * because those scripts execute supplier/database work at module scope. `assortmentComparison.test.ts`
 * asserts this stays character-identical to the production source, so drift fails the suite.
 */
export const LEGACY_HARD_JUNK =
  /\b(pet|dog|cat|kitten|puppy|fish\s*tank|aquarium|litter|kennel|crate|kid|kids|toy|toddler|nursery|bunk|murphy|crib|playpen|patio|outdoor|garden|gazebo|pergola|trampoline|trash|garbage|luggage|suitcase|bean\s?bag)\b/i;

export type LegacyDecision = 'accepted' | 'excluded';

/**
 * `policy_review` is NOT an exclusion. Outdoor furniture and decor are correctly identified products
 * whose place in the assortment is a Founder decision, so they are routed to a decision queue rather
 * than silently dropped — the failure mode this whole correction exists to remove.
 */
export type NewDecision = 'accepted' | 'excluded' | 'policy_review' | 'manual_review';

export type ChangeType =
  | 'gate_not_applicable'
  | 'unchanged_accepted'
  | 'unchanged_excluded'
  | 'rescued'
  | 'newly_excluded'
  | 'moved_to_policy_review'
  | 'moved_to_manual_review';

export interface ComparisonInput {
  sku: string;
  title: string;
  category?: string;
  /** Present in `supplier_products`. */
  inSupplier: boolean;
  /** Present in `standardized_products`. */
  inStd: boolean;
  /** Present in `sellable_products` — i.e. published. */
  inSell: boolean;
}

export interface ComparisonRow {
  sku: string;
  title: string;
  /** False when membership precedence short-circuits before the junk gate. */
  gateApplies: boolean;
  /** Published (present in `sellable_products`) — carried so "published affected" is computed, not assumed. */
  inSell: boolean;
  /** Already imported into `supplier_products` / `standardized_products`. */
  inDb: boolean;
  legacyDecision: LegacyDecision;
  newDecision: NewDecision;
  changeType: ChangeType;
  assortmentClass: AssortmentClass;
  classifierBasis: string;
  taxonomyDepartment: string;
  taxonomyProductType: string;
  matched: string | null;
}

/** Tables this module must never write. Asserted by the test suite against this module's source. */
export const FORBIDDEN_WRITE_TABLES = [
  'saved_assets',
  'saved_asset_transitions',
  'supplier_favorite_memberships',
  'standardized_products',
  'supplier_products',
  'sellable_products',
  'inventory_cache',
  'product_reviews',
  'orders',
] as const;

/** The current production assortment gate, isolated to its title term. */
export function legacyJunkDecision(title: string): LegacyDecision {
  return LEGACY_HARD_JUNK.test(title ?? '') ? 'excluded' : 'accepted';
}

const CLASS_TO_DECISION: Record<AssortmentClass, NewDecision> = {
  core_indoor_furniture: 'accepted',
  outdoor_furniture: 'policy_review',
  home_decor: 'policy_review',
  genuine_non_furniture: 'excluded',
  ambiguous_manual_review: 'manual_review',
};

export function newAssortmentDecision(
  title: string,
  category?: string,
): { decision: NewDecision; assortmentClass: AssortmentClass; basis: string; department: string; productType: string; matched: string | null } {
  const r = classifyAssortment({ title, category });
  return {
    decision: CLASS_TO_DECISION[r.assortment],
    assortmentClass: r.assortment,
    basis: r.basis,
    department: r.taxonomyDepartment,
    productType: r.taxonomyProductType,
    matched: r.matched,
  };
}

function changeTypeOf(gateApplies: boolean, legacy: LegacyDecision, next: NewDecision): ChangeType {
  if (!gateApplies) return 'gate_not_applicable';
  if (next === 'manual_review') return 'moved_to_manual_review';
  if (next === 'policy_review') return 'moved_to_policy_review';
  if (legacy === 'excluded' && next === 'accepted') return 'rescued';
  if (legacy === 'accepted' && next === 'excluded') return 'newly_excluded';
  return legacy === 'accepted' ? 'unchanged_accepted' : 'unchanged_excluded';
}

export function compareOne(input: ComparisonInput): ComparisonRow {
  const title = input.title ?? '';
  // Membership precedence, mirroring planGigaSavedItems.ts exactly.
  const gateApplies = !(input.inSell || input.inSupplier || input.inStd);
  const legacyDecision = legacyJunkDecision(title);
  const n = newAssortmentDecision(title, input.category);
  return {
    sku: input.sku,
    title,
    gateApplies,
    inSell: input.inSell,
    inDb: input.inSupplier || input.inStd,
    legacyDecision,
    newDecision: n.decision,
    changeType: changeTypeOf(gateApplies, legacyDecision, n.decision),
    assortmentClass: n.assortmentClass,
    classifierBasis: n.basis,
    taxonomyDepartment: n.department,
    taxonomyProductType: n.productType,
    matched: n.matched,
  };
}

export interface ComparisonSummary {
  total: number;
  gateApplies: number;
  byChangeType: Record<string, number>;
  byAssortmentClass: Record<string, number>;
  /** Candidates that would newly pass the assortment gate. */
  candidatesAdded: number;
  /** Candidates that would newly fail it. */
  candidatesRemoved: number;
  /** Routed to an explicit Founder assortment decision instead of being silently dropped. */
  routedToPolicyReview: number;
  /** Published rows touched by this change — structurally always 0. */
  publishedAffected: number;
}

export function summarise(rows: readonly ComparisonRow[]): ComparisonSummary {
  const byChangeType: Record<string, number> = {};
  const byAssortmentClass: Record<string, number> = {};
  for (const r of rows) {
    byChangeType[r.changeType] = (byChangeType[r.changeType] ?? 0) + 1;
    byAssortmentClass[r.assortmentClass] = (byAssortmentClass[r.assortmentClass] ?? 0) + 1;
  }
  const n = (k: ChangeType) => byChangeType[k] ?? 0;
  return {
    total: rows.length,
    gateApplies: rows.filter(r => r.gateApplies).length,
    byChangeType,
    byAssortmentClass,
    candidatesAdded: n('rescued'),
    candidatesRemoved: n('newly_excluded'),
    routedToPolicyReview: n('moved_to_policy_review'),
    // Computed, not asserted: a published row can only count here if it both is published AND had
    // its decision changed. Membership precedence makes that impossible, and this measures it.
    publishedAffected: rows.filter(r => r.inSell && r.changeType !== 'gate_not_applicable').length,
  };
}

/** Rows whose decision changed — the only ones a reviewer needs to read. */
export function changedRows(rows: readonly ComparisonRow[]): ComparisonRow[] {
  return rows.filter(
    r => r.changeType !== 'gate_not_applicable' && r.changeType !== 'unchanged_accepted' && r.changeType !== 'unchanged_excluded',
  );
}
