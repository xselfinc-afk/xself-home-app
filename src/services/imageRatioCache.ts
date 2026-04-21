/**
 * Module-level image aspect ratio cache.
 *
 * Populated by ProductCard onLoad events as images render.
 * Used to:
 *   - classify products into display buckets (standard / wider / taller)
 *   - prefer standard-fit products in featured homepage sections
 *
 * Bucket thresholds (width / height):
 *   wider   > 0.95  — landscape / square-ish (e.g. panoramic product shots)
 *   standard  0.70–0.95 — close to 4:5 = 0.80 (fits standard card well)
 *   taller  < 0.70  — very portrait (e.g. tall floor lamps, shelving)
 */

export type RatioBucket = 'standard' | 'wider' | 'taller';

/** Standard card image aspect ratio (width / height) */
export const STANDARD_CARD_RATIO = 4 / 5; // 0.80

const WIDER_THRESHOLD  = 0.95;
const TALLER_THRESHOLD = 0.70;

// Module-level cache: imageUrl → intrinsic aspect ratio (width / height)
const _cache = new Map<string, number>();

export function cacheRatio(url: string, widthOverHeight: number): void {
  _cache.set(url, widthOverHeight);
}

export function getCachedRatio(url: string): number | undefined {
  return _cache.get(url);
}

/** Classify a numeric aspect ratio into a display bucket */
export function classifyRatio(ratio: number): RatioBucket {
  if (ratio > WIDER_THRESHOLD)  return 'wider';
  if (ratio < TALLER_THRESHOLD) return 'taller';
  return 'standard';
}

/**
 * Container aspect ratio (width / height) to use per bucket.
 * Chosen to minimise letterboxing while keeping contain-mode images fully visible.
 */
export function bucketContainerRatio(bucket: RatioBucket): number {
  switch (bucket) {
    case 'wider':    return 1;        // 1:1 square — best for landscape/square images
    case 'taller':   return 2 / 3;    // 2:3 tall   — best for very portrait images
    case 'standard': return 4 / 5;    // 4:5 standard
  }
}

/** ResizeMode for each bucket when displayed in flexible (All Products) mode */
export function bucketResizeMode(bucket: RatioBucket): 'cover' | 'contain' {
  return bucket === 'standard' ? 'cover' : 'contain';
}

/**
 * Is a product's primary image a good fit for the standard 4:5 featured card?
 * Returns true when the URL is not yet cached (cold cache → assume fit).
 */
export function isGoodFitForFeatured(url: string): boolean {
  const ratio = _cache.get(url);
  if (ratio === undefined) return true; // unknown → optimistic assumption
  return classifyRatio(ratio) === 'standard';
}

/** Return the cached bucket for a URL, or null if not yet loaded */
export function getBucketForUrl(url: string): RatioBucket | null {
  const ratio = _cache.get(url);
  return ratio !== undefined ? classifyRatio(ratio) : null;
}
