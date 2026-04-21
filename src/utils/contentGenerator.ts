/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Re-export barrel — logic lives in src/services/.
 * Kept for backwards compatibility with existing imports.
 */

export { cleanTitle, buildDisplayTitle, toShortTitle } from '../services/titleGenerator';
export { buildDescription, buildBulletPoints, removeSpecDuplicates } from '../services/featureGenerator';
export type { BulletPointOptions } from '../services/featureGenerator';
export { SKIP_BULLET_PATTERNS, SKIP_DESC_PATTERNS, isUsableBullet, isUsableSentence } from '../services/dirtyTextFilters';
