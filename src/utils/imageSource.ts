/**
 * Phase 3 source-of-truth resolver.
 *
 * Renders the URL the app should hand to `variantUrl()` for transform. When
 * EXPO_PUBLIC_PREFER_MIRROR=1 AND a mirror_path is set on the row, returns the
 * Supabase Storage URL; otherwise returns the original supplier URL unchanged.
 *
 * Identity rollback: unset EXPO_PUBLIC_PREFER_MIRROR (or leave the column null)
 * and every consumer reverts to supplier URLs in one Metro restart.
 */

const SUPABASE_URL = (process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').replace(/\/+$/, '');
const PREFER_MIRROR = process.env.EXPO_PUBLIC_PREFER_MIRROR === '1';
const STORAGE_BASE = SUPABASE_URL ? `${SUPABASE_URL}/storage/v1/object/public/product-images` : '';

/**
 * Pick the URL that the rest of the pipeline should treat as canonical for
 * this product image. Pure function — safe to call inside renders.
 */
export function sourceUrl(
  supplierUrl: string | undefined | null,
  mirrorPath: string | undefined | null,
): string | undefined {
  if (PREFER_MIRROR && mirrorPath && STORAGE_BASE) {
    return `${STORAGE_BASE}/${mirrorPath.replace(/^\/+/, '')}`;
  }
  return supplierUrl ?? undefined;
}

export const mirrorPreferred = PREFER_MIRROR;
