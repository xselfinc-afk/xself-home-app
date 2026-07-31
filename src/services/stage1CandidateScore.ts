/**
 * Stage 1A — transparent, rule-based candidate scorer (PURE: no I/O, no network, no DB, no ML).
 *
 * Product Bible alignment (product-bible-v1.0-rc1): this is the "New Product Engine" initial
 * opportunity evaluation for a discovered (saved-list) supplier product. It answers only:
 * "should this candidate receive scarce attention and possibly a Favorite slot?" It is a
 * RECOMMENDATION, never an action. Governing laws honored here:
 *   • New-first, with safeguards — newness raises priority but never overrides a safeguard.
 *   • Unknown is not zero — missing evidence is recorded, never scored as a negative fact.
 *   • Favorites are scarce — slot cost is a first-class input; verdicts stay conservative.
 *   • Business-first — hard blocks reflect commercial/quality reality, not model confidence.
 *
 * Weights and thresholds are PROVISIONAL config (no outcome data exists yet); callers may
 * override them. Nothing here is a production-final threshold.
 */
import type { PriorityClass } from './inventoryPriority';

/** Supply priority as known at scoring time; 'unknown' is expected for a not-yet-verified candidate. */
export type SupplyPriority = PriorityClass | 'unknown';

/** Margin knowledge at scoring time. 'unknown' is common pre-import and must NOT be treated as bad. */
export type MarginState = 'acceptable' | 'low' | 'negative' | 'unknown';

/** Boolean-or-unknown: null means the evidence is not yet available (never interpret as false). */
type Tri = boolean | null;

export interface CandidateFeatures {
  supplierProductId: string;           // GIGA sku == supplier_product_id
  identityResolved: boolean;           // a non-empty supplier_product_id exists
  duplicate: boolean;                  // already imported/published in XSelf (exact supplier_product_id)
  isNewlySaved: boolean;               // appeared in the newly-saved delta
  daysSinceSaved: number | null;       // recency of the save (null = unknown)
  priority: SupplyPriority;            // from inventory classification, else 'unknown'
  hasShipping: Tri;                    // dropship/delivery-fee capability (null = unknown)
  marginState: MarginState;            // requires known cost to be non-'unknown'
  costKnown: boolean;                  // cost/price evidence exists
  complete: Tri;                       // normalizable / required fields present (null = unknown)
  usableImages: Tri;                   // usable media present (null = unknown)
  differentiated: Tri;                 // not a near-duplicate of existing assortment (null = unknown)
  fulfillmentPossible: Tri;            // false only when CONFIRMED impossible
  slotCost: 1 | 2;                     // favorite slots consumed (2 if both accounts required)
}

export type Verdict =
  | 'favorite_immediately'
  | 'candidate'
  | 'waitlist'
  | 'ignore'
  | 'request_more_evidence';

export interface CandidateScore {
  supplierProductId: string;
  verdict: Verdict;
  score: number;                       // provisional composite (higher = stronger opportunity)
  reasons: string[];                   // positive/neutral factors that shaped the score
  missingEvidence: string[];           // unknowns (never counted as negative)
  blocked: boolean;                    // a safeguard fired
  blockReasons: string[];              // which safeguard(s)
  slotCost: 1 | 2;
}

export interface ScoreWeights {
  newlySaved: number;
  recentlySavedBonus: number;          // within recentDays
  p1: number;                          // verified California
  p2: number;                          // verified shippable
  shipping: number;                    // known shipping capability
  complete: number;
  usableImages: number;
  differentiated: number;
  dualSlotPenalty: number;             // subtracted when slotCost === 2 (scarcity cost)
}

export interface ScoreThresholds {
  favoriteImmediately: number;
  candidate: number;
  waitlist: number;
  recentDays: number;                  // "recently saved" window
}

/** PROVISIONAL defaults — tune from evidence; do not treat as production-final. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  newlySaved: 30,
  recentlySavedBonus: 10,
  p1: 40,
  p2: 20,
  shipping: 10,
  complete: 10,
  usableImages: 8,
  differentiated: 8,
  dualSlotPenalty: 12,
};

export const DEFAULT_THRESHOLDS: ScoreThresholds = {
  favoriteImmediately: 70,
  candidate: 40,
  waitlist: 20,
  recentDays: 14,
};

/**
 * Score one candidate. Precedence: (1) safeguards/blocks, then (2) composite score → verdict.
 * Blocks split into CONFIRMED-negative (→ ignore) and MISSING/fixable evidence (→ request_more_evidence),
 * so an unknown is never converted into a rejection.
 */
export function scoreCandidate(
  f: CandidateFeatures,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
  thresholds: ScoreThresholds = DEFAULT_THRESHOLDS,
): CandidateScore {
  const reasons: string[] = [];
  const missingEvidence: string[] = [];
  const blockReasons: string[] = [];

  // ── Missing-evidence blocks (fixable → request_more_evidence) ──
  if (!f.identityResolved || !f.supplierProductId) blockReasons.push('unresolved_identity');
  if (f.usableImages === false) blockReasons.push('unusable_media');
  if (f.complete === false) blockReasons.push('incomplete_data');

  // ── Confirmed-negative blocks (→ ignore) ──
  const confirmedNegative: string[] = [];
  if (f.duplicate) confirmedNegative.push('already_imported_duplicate');
  if (f.priority === 'P4') confirmedNegative.push('confirmed_unavailable');
  if (f.costKnown && f.marginState === 'negative') confirmedNegative.push('negative_margin');
  if (f.costKnown && f.marginState === 'low') confirmedNegative.push('low_margin');
  if (f.fulfillmentPossible === false) confirmedNegative.push('fulfillment_impossible');

  // Record unknowns (informational — NEVER negative).
  if (f.priority === 'unknown') missingEvidence.push('inventory_unverified');
  if (f.marginState === 'unknown' || !f.costKnown) missingEvidence.push('cost_or_margin_unknown');
  if (f.hasShipping === null) missingEvidence.push('shipping_capability_unknown');
  if (f.complete === null) missingEvidence.push('completeness_unknown');
  if (f.usableImages === null) missingEvidence.push('media_unknown');
  if (f.differentiated === null) missingEvidence.push('differentiation_unknown');

  if (confirmedNegative.length > 0) {
    return blocked(f, ['ignore', 'confirmed'], [...blockReasons, ...confirmedNegative], reasons, missingEvidence);
  }
  if (blockReasons.length > 0) {
    return blocked(f, ['request_more_evidence', 'fixable'], blockReasons, reasons, missingEvidence);
  }

  // ── Composite score (unknowns contribute 0 — neutral, never negative) ──
  let score = 0;
  if (f.isNewlySaved) { score += weights.newlySaved; reasons.push('newly_saved'); }
  if (f.daysSinceSaved != null && f.daysSinceSaved <= thresholds.recentDays) { score += weights.recentlySavedBonus; reasons.push('recently_saved'); }
  if (f.priority === 'P1') { score += weights.p1; reasons.push('verified_california'); }
  else if (f.priority === 'P2') { score += weights.p2; reasons.push('verified_shippable'); }
  if (f.hasShipping === true) { score += weights.shipping; reasons.push('shipping_capable'); }
  if (f.complete === true) { score += weights.complete; reasons.push('complete_data'); }
  if (f.usableImages === true) { score += weights.usableImages; reasons.push('usable_images'); }
  if (f.differentiated === true) { score += weights.differentiated; reasons.push('differentiated'); }
  if (f.slotCost === 2) { score -= weights.dualSlotPenalty; reasons.push('dual_slot_cost'); }

  // ── Verdict from score, capped conservatively when strong signal is absent ──
  let verdict: Verdict;
  const hasStrongSignal = f.priority === 'P1' || f.priority === 'P2' || (f.isNewlySaved && f.differentiated === true);
  if (score >= thresholds.favoriteImmediately && hasStrongSignal) verdict = 'favorite_immediately';
  else if (score >= thresholds.candidate) verdict = 'candidate';
  else if (score >= thresholds.waitlist) verdict = 'waitlist';
  else verdict = 'ignore';

  return { supplierProductId: f.supplierProductId, verdict, score, reasons, missingEvidence, blocked: false, blockReasons: [], slotCost: f.slotCost };
}

function blocked(
  f: CandidateFeatures,
  [verdict]: [Verdict, string],
  blockReasons: string[],
  reasons: string[],
  missingEvidence: string[],
): CandidateScore {
  return { supplierProductId: f.supplierProductId, verdict, score: 0, reasons, missingEvidence, blocked: true, blockReasons, slotCost: f.slotCost };
}
