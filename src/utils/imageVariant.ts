/**
 * Image transform helper — Phase 2a (Cloudinary fetch proxy).
 *
 * Wraps a remote supplier image URL with a Cloudinary fetch transform so that
 * masonry tiles and thumbnails download a small WebP/AVIF variant instead of
 * the multi-MB original JPEG.
 *
 * Activation: set EXPO_PUBLIC_IMAGE_PROXY_BASE in .env to:
 *   https://res.cloudinary.com/{cloud}/image/fetch
 *
 * Identity rollback: when the env var is missing OR the input is not an https
 * URL (data: / file: / require()), the original src is returned unchanged.
 *
 * Cloudinary free plan rejects originals over 10 MB with HTTP 400. Use
 * `originalUrl()` as an `onError` fallback so giant supplier images still
 * render uncompressed instead of disappearing.
 */

const PROXY_BASE = (process.env.EXPO_PUBLIC_IMAGE_PROXY_BASE ?? '').replace(/\/+$/, '');
const PROXY_ENABLED = /^https:\/\/res\.cloudinary\.com\//.test(PROXY_BASE);

export type VariantOpts = {
  /** Logical width in CSS pixels (helper multiplies by dpr internally) */
  width: number;
  /** Device pixel ratio multiplier for retina output. Default 2. */
  dpr?: number;
  /**
   * Quality. 'auto' lets Cloudinary pick (`q_auto`). Numeric forces a value.
   * Default 'auto' — typically 65–75 effective quality, AVIF/WebP-aware.
   */
  quality?: 'auto' | number;
  /** Output format. 'auto' → AVIF/WebP based on Accept header. Default 'auto'. */
  format?: 'auto' | 'webp' | 'jpg';
  /**
   * 'cover' → c_fill (fills box, may crop). 'contain' → c_fit (no crop).
   * Default 'cover'.
   */
  fit?: 'cover' | 'contain';
};

function buildTransform(opts: VariantOpts): string {
  const dpr = opts.dpr ?? 2;
  const w = Math.max(1, Math.round(opts.width * dpr));
  const q = opts.quality ?? 'auto';
  const f = opts.format ?? 'auto';
  const c = (opts.fit ?? 'cover') === 'contain' ? 'fit' : 'fill';
  return [
    `w_${w}`,
    `c_${c}`,
    `q_${q === 'auto' ? 'auto' : q}`,
    `f_${f}`,
    'fl_progressive',
  ].join(',');
}

/**
 * Return a proxied (size-optimised) URL for `src`, or the original when the
 * proxy is disabled / inapplicable.
 */
export function variantUrl(src: string | undefined | null, opts: VariantOpts): string | undefined {
  if (!src) return undefined;
  if (!PROXY_ENABLED) return src;
  if (!/^https?:\/\//i.test(src)) return src;
  if (src.startsWith(PROXY_BASE)) return src;
  return `${PROXY_BASE}/${buildTransform(opts)}/${encodeURIComponent(src)}`;
}

/**
 * Strip a Cloudinary fetch wrapper to recover the underlying supplier URL,
 * or return `src` unchanged when no wrapper is present.
 *
 * Use as an `onError` fallback so a 10 MB+ supplier image (which Cloudinary
 * free plan rejects with HTTP 400) still renders.
 */
export function originalUrl(src: string | undefined | null): string | undefined {
  if (!src) return undefined;
  if (!PROXY_ENABLED) return src;
  if (!src.startsWith(PROXY_BASE + '/')) return src;
  // Format: {PROXY_BASE}/{transform-segment}/{encoded-original-url}
  const tail = src.slice(PROXY_BASE.length + 1);
  const slash = tail.indexOf('/');
  if (slash < 0) return src;
  const encoded = tail.slice(slash + 1);
  try { return decodeURIComponent(encoded); }
  catch { return encoded; }
}

/** True when the proxy is wired up via env. Useful for analytics. */
export const imageProxyEnabled = PROXY_ENABLED;
