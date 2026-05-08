/**
 * Clamp an image aspect ratio (width/height) to a per-surface safe range.
 * Returns the supplied fallback when `aspect` is missing or non-finite.
 *
 * Used by product cards to derive a container `aspectRatio` that matches the
 * image's intrinsic ratio (so `contentFit="cover"` doesn't crop) without
 * letting extreme outliers explode tile heights.
 */
export function clampAspect(
  aspect: number | undefined | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (aspect == null || !Number.isFinite(aspect) || aspect <= 0) return fallback;
  if (aspect < min) return min;
  if (aspect > max) return max;
  return aspect;
}
