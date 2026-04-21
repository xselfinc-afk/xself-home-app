/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Image selection and ranking for normalized product data.
 * Uses ONLY raw_payload.mainImageUrl and raw_payload.imageUrls.
 * Never uses the supplier fileUrls column (row.images) — it may contain PDFs.
 */

const BAD_IMAGE_KEYWORDS = [
  'label', 'manual', 'instruction', 'detail', 'details', 'size',
  'spec', 'specification', 'specifications', 'cert', 'test', 'warning',
  'pdf', 'assembly', 'carton', 'package', 'dimension', 'dimensions',
  'prop65', 'closeup', 'close-up', 'parts', 'installation', 'step',
  'guide', 'barcode', 'sticker', 'document', 'certificate', 'report',
  'tcps', 'care', 'paper', 'card', 'carta', 'description', 'shooting',
  'lighting', 'difference',
];

function isBadImageUrl(url: string): boolean {
  const l = url.toLowerCase();
  return BAD_IMAGE_KEYWORDS.some(k => l.includes(k));
}

/**
 * Returns all usable product images ranked by quality, capped at maxImages.
 * First element is always the best cover image.
 */
export function collectImages(
  images: string[],
  raw: Record<string, unknown>,
  maxImages = 8,
): string[] {
  const mainImageUrl = typeof raw.mainImageUrl === 'string' ? raw.mainImageUrl.trim() : '';

  const rawUrls: string[] = Array.isArray(raw.imageUrls)
    ? (raw.imageUrls as unknown[]).map(u => (typeof u === 'string' ? u.trim() : '')).filter(Boolean)
    : [];

  const all = Array.from(new Set(
    [mainImageUrl, ...rawUrls, ...images].filter(Boolean),
  ));

  if (all.length === 0) return [];

  const scored = all.map((url, i) => {
    const l = url.toLowerCase();
    let score = 100 - i * 2;
    if (isBadImageUrl(l)) score -= 120;
    if (l.includes('main')) score += 30;
    if (l.includes('primary')) score += 26;
    if (l.includes('front')) score += 24;
    if (l.includes('hero')) score += 18;
    if (l.includes('scene')) score += 10;
    if (l.includes('lifestyle')) score += 8;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored
    .filter(s => s.score > 0)
    .map(s => s.url)
    .slice(0, maxImages);
}
