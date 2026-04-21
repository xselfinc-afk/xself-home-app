/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Feature and description generation for normalized product data.
 * Produces Wayfair-style key_features_json and short_description.
 */

import { isUsableBullet, isUsableSentence } from './dirtyTextFilters';

// ── Category fallback features (Wayfair-style, usage-focused) ────────────────

type FeatureSet = {
  function: string;
  storage: string;
  usability: string;
  scenario: string;
  style: string;
  stability: string;
};

const CATEGORY_FEATURES: Record<string, FeatureSet> = {
  dresser: {
    function:   'Keeps clothing and accessories organized and within arm\'s reach',
    storage:    'Multiple drawers accommodate folded clothing, linens, and everyday items',
    usability:  'Smooth-gliding drawers open and close effortlessly for daily use',
    scenario:   'Fits naturally in bedrooms, guest rooms, and walk-in closets',
    style:      'Clean, streamlined profile blends with modern and transitional décor',
    stability:  'Solid base stays level and secure on hardwood and carpeted floors',
  },
  cabinet: {
    function:   'Tucks clutter out of sight while keeping essentials accessible',
    storage:    'Enclosed interior accommodates books, electronics, and everyday items',
    usability:  'Doors open fully for unobstructed access to everything inside',
    scenario:   'Complements living rooms, entryways, home offices, and bedrooms',
    style:      'Understated silhouette works with minimalist, Scandinavian, and classic styles',
    stability:  'Reinforced construction stays firmly in place on any flat surface',
  },
  bookshelf: {
    function:   'Displays books, plants, and decorative objects at a glance',
    storage:    'Open shelves hold everything from paperbacks to art pieces and baskets',
    usability:  'Everything stays visible and reachable without opening doors or drawers',
    scenario:   'Works in living rooms, home offices, bedrooms, and hallways',
    style:      'Open-frame design complements any style from industrial to cozy farmhouse',
    stability:  'Wide base distributes weight evenly for a steady, wobble-free stand',
  },
  nightstand: {
    function:   'Keeps bedtime essentials within reach without leaving the bed',
    storage:    'Drawer and open shelf hold a book, phone, charger, and reading glasses',
    usability:  'Compact footprint fits beside any bed without crowding the floor space',
    scenario:   'Ideal for bedrooms, reading nooks, and guest rooms',
    style:      'Minimal form pairs cleanly with most bed frames and bedroom palettes',
    stability:  'Four-legged base sits steady on hardwood and low-pile carpet alike',
  },
  tvstand: {
    function:   'Centers your living room around the screen with organized storage below',
    storage:    'Open and closed compartments house media equipment, remotes, and cables',
    usability:  'Cable management openings keep wires hidden and the surface tidy',
    scenario:   'Designed for living rooms, bedrooms, and shared media spaces',
    style:      'Low-profile lines suit modern, mid-century, and Scandi interiors',
    stability:  'Broad base and reinforced top surface safely support large flat-screen TVs',
  },
  coffeetable: {
    function:   'Anchors a seating area while keeping everyday items at hand',
    storage:    'Surface space holds drinks, remotes, and décor without feeling cluttered',
    usability:  'The right height lets you set down a cup or book from the sofa comfortably',
    scenario:   'Works in living rooms, lounges, and open-plan spaces',
    style:      'Timeless shape integrates with contemporary, mid-century, and transitional rooms',
    stability:  'Stable four-leg construction stays put on rugs and hard floors',
  },
  consoletable: {
    function:   'Provides a landing spot for keys, bags, and everyday carry items',
    storage:    'Slim top surface stays clear while a lower shelf handles extras',
    usability:  'Narrow depth fits tight spaces without blocking foot traffic',
    scenario:   'Perfect for entryways, hallways, behind sofas, and office walls',
    style:      'Slender profile adapts to traditional, transitional, and modern spaces',
    stability:  'Leveling feet keep the table flush on uneven floors',
  },
  sideboard: {
    function:   'Provides ample storage while doubling as a display surface',
    storage:    'Wide interior fits table linens, serving pieces, and bulky items',
    usability:  'Door and drawer hardware are easy to grasp for smooth, daily operation',
    scenario:   'A natural fit for dining rooms, living rooms, and home offices',
    style:      'Broad, horizontal form brings grounded elegance to any wall',
    stability:  'Full-width base and solid construction handle loaded tabletop displays',
  },
};

const DEFAULT_FEATURES: FeatureSet = {
  function:   'Provides dedicated storage to keep your space neat and organized',
  storage:    'Spacious interior fits a wide range of everyday household items',
  usability:  'Designed for effortless daily access with smooth-operating parts',
  scenario:   'Versatile enough for living rooms, bedrooms, offices, and hallways',
  style:      'Understated design complements a wide range of interior styles',
  stability:  'Sturdy build stays stable and level on most flat surfaces',
};

function categoryKey(cat: string, name: string): string {
  const s = `${cat} ${name}`.toLowerCase();
  if (/dresser|chest\s+of\s+drawer/i.test(s)) return 'dresser';
  if (/nightstand|bedside/i.test(s)) return 'nightstand';
  if (/tv\s*stand|media\s*console/i.test(s)) return 'tvstand';
  if (/coffee\s*table/i.test(s)) return 'coffeetable';
  if (/console\s*table/i.test(s)) return 'consoletable';
  if (/sideboard|buffet/i.test(s)) return 'sideboard';
  if (/bookshelf|bookcase/i.test(s)) return 'bookshelf';
  if (/cabinet|cupboard|wardrobe|armoire/i.test(s)) return 'cabinet';
  return '';
}

function normalizeBullet(s: string): string {
  const b = s.trim().replace(/^[-–•*]\s*/, '').replace(/\.$/, '').trim();
  return b.charAt(0).toUpperCase() + b.slice(1);
}

function buildStructuredFeatures(clean: string[], featureSet: FeatureSet): string[] {
  const slots: Array<keyof FeatureSet> = [
    'function', 'storage', 'usability', 'scenario', 'style', 'stability',
  ];
  const result: string[] = [...clean];
  for (const slot of slots) {
    if (result.length >= 6) break;
    const fallback = featureSet[slot];
    const alreadyCovered = result.some(b =>
      b.toLowerCase().slice(0, 20) === fallback.toLowerCase().slice(0, 20),
    );
    if (!alreadyCovered) result.push(fallback);
  }
  return result.slice(0, 6);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a short_description (1–2 sentences) from supplier description or characteristics.
 * Filters out spec content, dimensions, weights, and title-repeat sentences.
 */
export function buildDescription(
  desc: string,
  characteristics?: string[] | null,
  productTitle?: string,
): string {
  const titleWords = productTitle
    ? productTitle.toLowerCase().split(/\s+/).slice(0, 4).join(' ')
    : '';
  const titlePrefix = titleWords.length >= 15 ? titleWords : '';

  function isCleanSentence(s: string): boolean {
    if (!isUsableSentence(s)) return false;
    if (titlePrefix && s.trim().toLowerCase().startsWith(titlePrefix)) return false;
    return true;
  }

  if (desc && desc.trim().length > 20) {
    const sentences = desc
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(isCleanSentence);
    if (sentences.length >= 1) return sentences.slice(0, 2).join(' ');
  }

  if (Array.isArray(characteristics) && characteristics.length > 0) {
    const usable = characteristics
      .filter(s => typeof s === 'string' && isCleanSentence(s))
      .slice(0, 2);
    if (usable.length > 0) return usable.join('. ');
  }

  return '';
}

export type BulletPointOptions = {
  name?: string;
  category?: string;
  maxItems?: number;
};

/**
 * Builds key_features_json: 4–6 usage-focused bullets.
 * Uses characteristics → desc sentences → category templates as fallback tiers.
 */
export function buildBulletPoints(
  characteristics?: string[] | null,
  desc?: string,
  opts: BulletPointOptions = {},
): string[] {
  const { name = '', category = '', maxItems = 6 } = opts;

  const clean: string[] = Array.isArray(characteristics)
    ? characteristics
        .filter((s): s is string => typeof s === 'string' && isUsableBullet(s))
        .map(normalizeBullet)
    : [];

  if (clean.length >= 4) return clean.slice(0, maxItems);

  const fromDesc: string[] =
    desc && desc.trim().length > 0
      ? desc
          .split(/(?<=[.!?])\s+|;\s*/)
          .map(s => s.trim())
          .filter(isUsableBullet)
          .map(normalizeBullet)
      : [];

  const combined = [...clean, ...fromDesc.filter(b => !clean.includes(b))];

  if (combined.length < 4) {
    const key = categoryKey(category, name);
    const featureSet = CATEGORY_FEATURES[key] ?? DEFAULT_FEATURES;
    return buildStructuredFeatures(combined, featureSet);
  }

  return combined.slice(0, maxItems);
}

/**
 * Removes feature bullets that merely restate a known spec value.
 * Reverts to the original list if deduplication leaves fewer than minFeatures.
 */
export function removeSpecDuplicates(
  features: string[],
  specValues: string[],
  minFeatures = 4,
): string[] {
  if (specValues.length === 0) return features;

  const specTokens = specValues
    .map(v => v.toLowerCase().trim())
    .filter(v => v.length >= 4);

  const filtered = features.filter(f => {
    const fl = f.toLowerCase();
    return !specTokens.some(token => fl.includes(token));
  });

  return filtered.length >= minFeatures ? filtered : features;
}
