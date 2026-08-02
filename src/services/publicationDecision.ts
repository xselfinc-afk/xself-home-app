/**
 * Publication decision — pure, deterministic, side-effect free.
 *
 * Mirrors every guard inside `set_publication_from_availability()` so a dry-run can report exactly
 * what a live run would do, without touching the database. The SQL function remains the enforcement
 * boundary — this is not a second authority, it is a faithful preview. `publicationDecision.test.ts`
 * asserts the two guard sets stay in step.
 *
 * Decision order matters and is deliberate:
 *   1. manual hold        — outranks everything, both directions
 *   2. already in state   — idempotent no-op
 *   3. evidence present   — no evidence, no action
 *   4. evidence fresh     — stale evidence proves nothing
 *   5. evidence agrees    — the answer must actually support the action
 *   6. provenance (relist)— only a product WE inventory-delisted may return
 *   7. quality gates      — a relisted product must satisfy everything sellable_products requires
 */

export type PublicationAction = 'delist' | 'relist';

/** Mirrors the SQL return values exactly. */
export type DecisionOutcome =
  | 'delisted'
  | 'relisted'
  | 'skipped_product_not_found'
  | 'skipped_manual_hold'
  | 'skipped_already_published'
  | 'skipped_already_unpublished'
  | 'skipped_no_availability_evidence'
  | 'skipped_evidence_stale'
  | 'skipped_evidence_not_unavailable'
  | 'skipped_evidence_not_available'
  | 'skipped_not_inventory_delisted'
  | 'skipped_quality_normalization'
  | 'skipped_quality_title'
  | 'skipped_quality_image'
  | 'skipped_quality_price'
  | 'skipped_quality_selling_price'
  | 'skipped_no_fulfillment_path'
  | 'skipped_no_fulfillment_qty';

export const APPLIED_OUTCOMES: ReadonlySet<DecisionOutcome> =
  new Set<DecisionOutcome>(['delisted', 'relisted']);

export const isApplied = (o: DecisionOutcome): boolean => APPLIED_OUTCOMES.has(o);

export interface ProductRow {
  supplierProductId: string;
  published: boolean;
  /** null = unknown provenance, which MUST read as manual. */
  delistReason: string | null;
  normalizationStatus: string | null;
  productTitle: string | null;
  primaryImage: string | null;
  price: number | null;
  sellingPrice: number | null;
  inventoryStatus: string | null;
  totalAvailableQty: number | null;
}

export interface AvailabilityRow {
  available: boolean;
  status: string;
  checkedAt: string;
}

export interface DecisionInput {
  product: ProductRow | null;
  availability: AvailabilityRow | null;
  action: PublicationAction;
  heldManually: boolean;
  nowIso: string;
  graceHours?: number;
}

export const DEFAULT_GRACE_HOURS = 72;

export interface Decision {
  supplierProductId: string;
  action: PublicationAction;
  outcome: DecisionOutcome;
  willApply: boolean;
  reason: string;
}

const hoursBetween = (fromIso: string, toIso: string): number | null => {
  const a = Date.parse(fromIso), b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 3_600_000;
};

export function decidePublication(input: DecisionInput): Decision {
  const grace = input.graceHours ?? DEFAULT_GRACE_HOURS;
  const sku = input.product?.supplierProductId ?? 'unknown';
  const done = (outcome: DecisionOutcome, reason: string): Decision =>
    ({ supplierProductId: sku, action: input.action, outcome, willApply: isApplied(outcome), reason });

  if (!input.product) return done('skipped_product_not_found', 'no standardized_products row');

  // 1. A hold freezes the SKU against all automation, in both directions.
  if (input.heldManually) return done('skipped_manual_hold', 'an active manual hold blocks automation');

  const target = input.action === 'relist';

  // 2. Idempotent.
  if (input.product.published === target) {
    return done(target ? 'skipped_already_published' : 'skipped_already_unpublished', 'already in the requested state');
  }

  // 3/4. Evidence must exist and be recent. Absent or stale evidence proves nothing either way.
  if (!input.availability) return done('skipped_no_availability_evidence', 'no confirmed availability answer');
  const age = hoursBetween(input.availability.checkedAt, input.nowIso);
  if (age === null || age > grace) {
    return done('skipped_evidence_stale', `evidence ${age === null ? 'unparseable' : age.toFixed(1) + 'h'} exceeds ${grace}h grace`);
  }

  // 5. The answer must support the action.
  if (input.action === 'delist') {
    if (input.availability.available !== false) {
      return done('skipped_evidence_not_unavailable', 'supplier does not report this SKU unavailable');
    }
    return done('delisted', 'fresh confirmed-unavailable evidence');
  }

  // ── relist ──
  // 6. Provenance. Only a product the inventory lifecycle delisted may come back automatically.
  if (input.product.delistReason !== 'inventory_unavailable') {
    return done('skipped_not_inventory_delisted',
      `delist_reason=${input.product.delistReason ?? 'null'} — manual or unknown provenance is never auto-relisted`);
  }
  if (input.availability.available !== true) {
    return done('skipped_evidence_not_available', 'supplier does not report this SKU available');
  }

  // 7. Every gate sellable_products enforces.
  const p = input.product;
  if (p.normalizationStatus !== 'done') return done('skipped_quality_normalization', 'normalization_status is not done');
  if (!p.productTitle?.trim()) return done('skipped_quality_title', 'missing product_title');
  if (!p.primaryImage?.trim()) return done('skipped_quality_image', 'missing primary_image');
  if (p.price == null || p.price <= 0) return done('skipped_quality_price', 'price is not positive');
  if (p.sellingPrice == null || p.sellingPrice <= 0) return done('skipped_quality_selling_price', 'selling_price is not positive');
  if (p.inventoryStatus !== 'in_stock') return done('skipped_no_fulfillment_path', 'no verified fulfillment path (inventory_status)');
  if (p.totalAvailableQty == null || p.totalAvailableQty <= 0) return done('skipped_no_fulfillment_qty', 'no fulfillable quantity');

  return done('relisted', 'fresh confirmed-available evidence and all quality gates pass');
}

export interface DecisionTally {
  total: number;
  wouldApply: number;
  skipped: number;
  byOutcome: Record<string, number>;
}

export function tallyDecisions(decisions: readonly Decision[]): DecisionTally {
  const byOutcome: Record<string, number> = {};
  for (const d of decisions) byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1;
  return {
    total: decisions.length,
    wouldApply: decisions.filter(d => d.willApply).length,
    skipped: decisions.filter(d => !d.willApply).length,
    byOutcome,
  };
}
