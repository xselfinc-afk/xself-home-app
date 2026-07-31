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
  isNewlySaved: boolean | null;        // true=newly saved, false=not new, null=UNKNOWN date (neutral)
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
  if (f.isNewlySaved === true) { score += weights.newlySaved; reasons.push('newly_saved'); }
  else if (f.isNewlySaved == null) { missingEvidence.push('save_date_unknown'); } // UNKNOWN newness is neutral: no bonus, no penalty
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
  const hasStrongSignal = f.priority === 'P1' || f.priority === 'P2' || (f.isNewlySaved === true && f.differentiated === true);
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

/**
 * Saved-items import lifecycle status (PURE). Every input product is ALREADY in Saved Items, so the
 * question is never "favorite it?" but "where is it in the import→publish pipeline?". Combines
 * snapshot evidence with live read-only Supabase evidence; on a definite disagreement it is
 * conservative (needs_more_evidence) and never silently picks a side. Unknown inventory is expected
 * pre-import and is NEVER treated as unavailable/P4.
 */
export type ImportStatus = 'already_published' | 'already_imported' | 'blocked' | 'import_ready' | 'needs_more_evidence';

export interface ImportStatusInput {
  supplierProductId: string;
  identityResolved: boolean;
  snapshotClassification?: string | null;   // 'new_candidate' | 'already_imported' | 'already_published' | 'blocked_or_invalid' | ...
  invalidReasons?: string[];                 // supplied invalid reasons (all preserved & displayed)
  hasImage?: boolean | null;                 // null = unknown (never assume false)
  hasPrice?: boolean | null;
  snapshotImported?: boolean | null;         // in_supplier_products / in_standardized_products (snapshot)
  snapshotPublished?: boolean | null;        // in_sellable_products (snapshot)
  liveImported?: boolean | null;             // present in supplier_products/standardized_products (live)
  livePublished?: boolean | null;            // standardized_products.published (live)
}

export interface ImportStatusResult {
  supplierProductId: string;
  status: ImportStatus;
  reasons: string[];
  missingEvidence: string[];
  invalidReasons: string[];
  conflict: boolean;
  nextAction: string;
}

export function classifyImportStatus(i: ImportStatusInput): ImportStatusResult {
  const invalidReasons = (i.invalidReasons ?? []).map(String).filter(Boolean);
  const missingEvidence: string[] = [];
  const mk = (status: ImportStatus, reasons: string[], nextAction: string, conflict = false): ImportStatusResult =>
    ({ supplierProductId: i.supplierProductId, status, reasons, missingEvidence, invalidReasons, conflict, nextAction });

  if (!i.identityResolved || !i.supplierProductId) return mk('needs_more_evidence', ['unresolved_identity'], 'resolve supplier identity before any action');

  // Definite disagreement (both sources known and differ) → conservative, never silent.
  const bothKnown = (a?: boolean | null, b?: boolean | null) => a != null && b != null;
  const importConflict = bothKnown(i.snapshotImported, i.liveImported) && i.snapshotImported !== i.liveImported;
  const publishConflict = bothKnown(i.snapshotPublished, i.livePublished) && i.snapshotPublished !== i.livePublished;
  if (importConflict || publishConflict) {
    const r = ['snapshot_live_disagreement'];
    if (importConflict) r.push(`imported snapshot=${i.snapshotImported} live=${i.liveImported}`);
    if (publishConflict) r.push(`published snapshot=${i.snapshotPublished} live=${i.livePublished}`);
    return mk('needs_more_evidence', r, 'reconcile snapshot vs live Supabase state before deciding', true);
  }

  const published = i.snapshotPublished === true || i.livePublished === true;
  const imported = i.snapshotImported === true || i.liveImported === true;
  if (published) return mk('already_published', ['in_sellable_products'], 'no import needed — already live; monitor inventory');
  if (imported) return mk('already_imported', ['in_supplier_products (not sellable)'], 'review for publication (verify inventory + price/margin)');

  const materialBlock = i.snapshotClassification === 'blocked_or_invalid' || invalidReasons.length > 0;
  if (materialBlock) return mk('blocked', ['blocked_or_invalid'], `resolve blocking issues before import: ${invalidReasons.join('; ') || i.snapshotClassification || 'invalid'}`);

  // Not imported, not published, not blocked → Import Ready iff we have POSITIVE readiness evidence.
  if (i.hasImage == null) missingEvidence.push('media_unknown');
  else if (i.hasImage === false) missingEvidence.push('missing_media');
  if (i.hasPrice == null) missingEvidence.push('price_unknown');
  else if (i.hasPrice === false) missingEvidence.push('missing_price');
  // Inventory/margin are expected-unknown pre-import; noted, but they NEVER downgrade readiness.
  missingEvidence.push('inventory_unverified', 'margin_unknown');

  if (i.hasImage === true && i.hasPrice === true) {
    return mk('import_ready', ['saved_not_imported', 'has_image', 'has_price'], 'import via existing giga:newly-saved:sync (dry-run first), then verify inventory + margin before publication review');
  }
  return mk('needs_more_evidence', ['saved_not_imported'], 'gather missing media/price before import');
}
