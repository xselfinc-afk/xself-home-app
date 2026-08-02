/**
 * Availability coverage gate — pure, deterministic, side-effect free.
 *
 * WHY THIS EXISTS
 * ---------------
 * The visibility rule ("a product is visible only with fresh confirmed availability") is correct but
 * catastrophic if switched on before the evidence exists. Applied against today's 26/353 coverage it
 * would take the storefront from 353 products to roughly 23. The gate makes that mistake impossible
 * to make by accident: enforcement is blocked until coverage is real.
 *
 * A second, subtler requirement: coverage alone is not enough. A single scan can cover 100% of the
 * catalogue and still be untrustworthy if it also failed on a fifth of it, so the failure rate is
 * part of the gate.
 */

export const DEFAULT_MIN_COVERAGE_PERCENT = 95;
export const DEFAULT_MAX_FAILURE_PERCENT = 20;
/** Evidence older than this is not counted toward coverage — 72h grace, matching the view. */
export const DEFAULT_COVERAGE_GRACE_HOURS = 72;

export interface CoverageInput {
  /** Every currently published SKU. */
  publishedSkus: readonly string[];
  /** SKUs holding a CONFIRMED availability answer, with the instant it was recorded. */
  evidence: ReadonlyArray<{ sku: string; checkedAt: string }>;
  nowIso: string;
  /** Failure percentage of the most recent scan, when known. */
  lastRunFailurePercent?: number | null;
  minCoveragePercent?: number;
  maxFailurePercent?: number;
  graceHours?: number;
}

export type CoverageBlock =
  | 'insufficient_coverage'
  | 'excessive_failure_rate'
  | 'no_published_products'
  | 'no_evidence';

export interface CoverageReport {
  publishedCount: number;
  coveredCount: number;
  staleCount: number;
  missingCount: number;
  coveragePercent: number;
  failurePercent: number | null;
  ready: boolean;
  blocks: CoverageBlock[];
  /** SKUs published but lacking fresh evidence — the exact work remaining. */
  uncoveredSkus: string[];
}

export function evaluateCoverage(input: CoverageInput): CoverageReport {
  const minCoverage = input.minCoveragePercent ?? DEFAULT_MIN_COVERAGE_PERCENT;
  const maxFailure = input.maxFailurePercent ?? DEFAULT_MAX_FAILURE_PERCENT;
  const grace = input.graceHours ?? DEFAULT_COVERAGE_GRACE_HOURS;
  const now = Date.parse(input.nowIso);

  const freshBySku = new Map<string, boolean>();
  for (const e of input.evidence) {
    const t = Date.parse(e.checkedAt);
    // Unparseable timestamps count as NOT fresh — never inflate coverage on bad data.
    freshBySku.set(e.sku, Number.isFinite(t) && Number.isFinite(now) && (now - t) / 3_600_000 <= grace);
  }

  const published = input.publishedSkus;
  const uncoveredSkus: string[] = [];
  let covered = 0, stale = 0, missing = 0;
  for (const sku of published) {
    const fresh = freshBySku.get(sku);
    if (fresh === true) { covered++; continue; }
    if (fresh === false) stale++; else missing++;
    uncoveredSkus.push(sku);
  }

  const publishedCount = published.length;
  const coveragePercent = publishedCount === 0 ? 0 : +((covered / publishedCount) * 100).toFixed(2);
  const failurePercent = input.lastRunFailurePercent ?? null;

  const blocks: CoverageBlock[] = [];
  if (publishedCount === 0) blocks.push('no_published_products');
  if (covered === 0 && publishedCount > 0) blocks.push('no_evidence');
  if (publishedCount > 0 && coveragePercent < minCoverage) blocks.push('insufficient_coverage');
  if (failurePercent !== null && failurePercent > maxFailure) blocks.push('excessive_failure_rate');

  return {
    publishedCount,
    coveredCount: covered,
    staleCount: stale,
    missingCount: missing,
    coveragePercent,
    failurePercent,
    ready: blocks.length === 0,
    blocks,
    uncoveredSkus,
  };
}

/**
 * Would applying visibility enforcement right now be safe?
 *
 * Deliberately stricter than `evaluateCoverage`: it also refuses when enforcement would remove more
 * of the catalogue than the coverage shortfall can explain — a blunt guard against enabling on a
 * scan that technically passed but disagrees wildly with the current storefront.
 */
export function readyForVisibilityEnforcement(
  report: CoverageReport,
  currentlyVisible: number,
  wouldRemainVisible: number,
): { ready: boolean; blocks: string[]; wouldRemove: number; wouldRemovePercent: number } {
  const blocks: string[] = [...report.blocks];
  const wouldRemove = Math.max(0, currentlyVisible - wouldRemainVisible);
  const wouldRemovePercent = currentlyVisible === 0 ? 0 : +((wouldRemove / currentlyVisible) * 100).toFixed(2);
  // Removing more than the uncovered share means the evidence disagrees with the catalogue itself.
  if (wouldRemovePercent > 100 - report.coveragePercent + 5) blocks.push('would_remove_more_than_uncovered');
  return { ready: blocks.length === 0, blocks, wouldRemove, wouldRemovePercent };
}
