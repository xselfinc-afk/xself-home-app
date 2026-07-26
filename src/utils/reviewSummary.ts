/**
 * Pure summary of ACTIVE product_reviews rows for the product-detail HEADER.
 *
 * Mirrors the count/average that ReviewSection displays so the header and the review
 * section always agree: use real (non-generated) reviews when any exist, otherwise the
 * generated bootstrap set; average rounded to one decimal. Returns count 0 when there are
 * no active reviews (header hides its rating row in that case — no fabricated "4.5 (0)").
 *
 * This does NOT change the review generator, ReviewSection, moderation, or review data — it
 * only summarizes rows already fetched from product_reviews (status='active').
 */
export function summarizeActiveReviews(
  rows: Array<{ rating: number; is_generated?: boolean | null }>,
): { count: number; avg: number } {
  const real = rows.filter(r => !r.is_generated);
  const shown = real.length > 0 ? real : rows;
  if (shown.length === 0) return { count: 0, avg: 0 };
  const avg = shown.reduce((s, r) => s + (r.rating ?? 0), 0) / shown.length;
  return { count: shown.length, avg: Math.round(avg * 10) / 10 };
}
