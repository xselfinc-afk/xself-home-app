/**
 * Source of truth: /NORMALIZATION_ENGINE.md
 * All product title, features, description, specifications, image, and family logic must follow this file.
 * Do NOT add UI-side cleaning or formatting logic.
 *
 * Product normalization pipeline — orchestration layer only.
 *
 * Converts a raw supplier_products row into the shape expected by
 * standardized_products. Delegates all content generation to service modules.
 *
 * Data flow:
 *   supplier_products (raw)
 *   → normalizeProduct()
 *   → StandardizedProductInsert
 *   → standardized_products (DB upsert)
 *   → app reads via adaptStandardizedRow()
 */

import type { SupplierRow } from './detailProductAdapter';
import { collectImages } from './imageSelector';
import { cleanTitle, buildDisplayTitle } from './titleGenerator';
import { buildDescription, buildBulletPoints, removeSpecDuplicates } from './featureGenerator';
import { categoryCode, sceneCode, skuSuffix, skuIdentitySuffixCandidates, fmtDimensions, fmtWeight } from './specFormatter';
import { resolveVariantGroupKey } from './familyKeyGenerator';
import { sanitizeSupplierName } from '../utils/supplierNameSanitizer';

// ── Output shape (maps directly to standardized_products columns) ─────────────

export type StandardizedProductInsert = {
  supplier_product_id: string;
  product_title: string;
  product_title_display: string;
  short_description: string;
  key_features_json: string[];
  specifications_json: Record<string, string>;
  sku_custom: string;
  category_code: string;
  scene_code: string;
  color: string;
  color_options_json: string[];
  has_multiple_colors: boolean;
  show_color_selector: boolean;
  material: string;
  dimensions: string;
  weight: string;
  primary_image: string;
  gallery_images_json: string[];
  product_family_key: string;
  normalization_status: 'done';
  price: number;
  original_price: number | null;
  sku_search: string;
  category_label: string;
  category_priority: number;
  is_new_arrival: boolean;
  new_arrival_source: string;
  new_arrival_added_at: string | null;
  // ── Supplier content preserved whole ───────────────────────────────────────
  // The fields above are derived summaries: short_description keeps 1–2
  // sentences, key_features_json keeps bullets under 180 characters. Those are
  // the right shape for a product card, and the wrong shape for a detail page —
  // 65% of the supplier's own bullets are longer than that cap and were simply
  // dropped. These carry the source content intact so the PDP can show what the
  // supplier actually wrote, without changing what the summaries mean.
  description_full: string | null;
  features_full: string[] | null;
  attributes_json: Record<string, string> | null;
  assembled_dimensions: Record<string, string> | null;
  media_json: { images: string[]; video: string | null; videos: string[] } | null;
  mpn: string | null;
  upc: string | null;
  origin: string | null;
  certifications_json: unknown[] | null;
};

// ── Category label assignment ────────────────────────────────────────────────

/** Ordered from most specific → least specific to avoid short-pattern false positives. */
const CATEGORY_PATTERNS: Array<{ patterns: string[]; label: string }> = [
  // Scenario A (Option A2): map to EXISTING labels only — no new browse categories.
  // Placed first so "kitchen island/cart" → Table and "wine rack/cabinet" → Storage win
  // over the broad 'table'/'cabinet' fallbacks below.
  { patterns: ['kitchen island', 'kitchen cart', 'rolling kitchen'], label: 'Table' },
  { patterns: ['wine rack', 'wine cabinet', 'wine storage'], label: 'Storage' },
  { patterns: ['nightstand', 'bedside table', 'bedside cabinet', 'night stand', 'night table'], label: 'Nightstand' },
  { patterns: ['tv stand', 'media console', 'entertainment center', 'media unit', 'media stand', 'tv console', 'media center'], label: 'TV Stand' },
  { patterns: ['dresser', 'chest of drawers', 'drawer dresser', 'chest drawer', '6 drawer', '5 drawer', '4 drawer', 'drawer chest'], label: 'Dresser' },
  { patterns: ['sideboard', 'buffet', 'credenza', 'server'], label: 'Sideboard' },
  { patterns: ['reception desk', 'office desk', 'computer desk', 'writing desk', 'standing desk', 'work surface', 'workstation', 'desk'], label: 'Desk' },
  { patterns: ['bookshelf', 'bookcase', 'shelving unit', 'shelf', 'shelves'], label: 'Bookshelf' },
  { patterns: ['sofa', 'loveseat', 'sectional', 'couch', 'futon'], label: 'Sofa' },
  { patterns: ['bed frame', 'platform bed', 'upholstered bed', ' bed '], label: 'Bed' },
  { patterns: ['coffee table', 'console table', 'dining table', 'side table', 'end table', 'accent table', 'sofa table', 'kitchen table'], label: 'Table' },
  { patterns: ['dining chair', 'accent chair', 'armchair', 'vanity stool', 'bar stool', 'stool', 'chair'], label: 'Chair' },
  { patterns: ['bathroom vanity', 'vanity', 'medicine cabinet', 'bathroom wall cabinet', 'bathroom cabinet', 'bathroom storage'], label: 'Bathroom' },
  { patterns: ['organizer', 'hall tree', 'shoe storage', 'storage bench', 'entryway storage', 'shoe rack', 'coat rack', 'storage unit'], label: 'Storage' },
  { patterns: ['cabinet', 'cupboard', 'pantry', 'linen cabinet', 'storage cabinet', 'bathroom cabinet', 'medicine cabinet', 'curio', 'display cabinet'], label: 'Cabinet' },
  { patterns: ['table'], label: 'Table' }, // broad fallback
];

const CATEGORY_PRIORITY: Record<string, number> = {
  Dresser: 10, Cabinet: 20, Sideboard: 25, 'TV Stand': 30,
  Nightstand: 35, Table: 40, Desk: 45, Chair: 50, Bathroom: 55, Bookshelf: 60,
  Sofa: 70, Bed: 80, Storage: 90, Other: 999,
};

function assignCategoryLabel(category: string, title: string): string {
  const text = `${category} ${title}`.toLowerCase();
  for (const { patterns, label } of CATEGORY_PATTERNS) {
    if (patterns.some(p => text.includes(p))) return label;
  }
  return 'Other';
}

function assignCategoryPriority(label: string): number {
  return CATEGORY_PRIORITY[label] ?? 999;
}

// ── New arrival assignment ────────────────────────────────────────────────────

const NEW_ARRIVAL_WINDOW_DAYS = 45;

function assignNewArrival(raw: Record<string, unknown>): { isNewArrival: boolean; source: string } {
  // 1. Explicit API boolean signal
  if (raw.isNewArrival === true || String(raw.isNewArrival).toLowerCase() === 'true') {
    return { isNewArrival: true, source: 'api' };
  }

  // 2. Channel / collection / tag containing "new arrival" keywords
  const channelStr = [raw.channel, raw.source, raw.collection, raw.tag, raw.categoryTag]
    .filter(Boolean)
    .map(v => (Array.isArray(v) ? (v as unknown[]).join(' ') : String(v)))
    .join(' ')
    .toLowerCase();
  if (channelStr.includes('new_arrival') || channelStr.includes('new arrival') || channelStr.includes('new arrivals')) {
    return { isNewArrival: true, source: 'raw' };
  }

  // 3. Recency fallback — supplier date fields (firstArrivalDate, addedTime) + generic fields
  const dateRaw =
    raw.firstArrivalDate ??  // GIGA SKU list field
    raw.addedTime ??         // GIGA SKU list field
    raw.listedAt ?? raw.publishTime ?? raw.publishDate ?? raw.onshelfTime ?? raw.addedAt ?? raw.createdAt;
  if (dateRaw != null) {
    const ms = typeof dateRaw === 'number' ? dateRaw : Date.parse(String(dateRaw));
    if (!isNaN(ms) && ms > 0) {
      const daysAgo = (Date.now() - ms) / (1000 * 60 * 60 * 24);
      if (daysAgo <= NEW_ARRIVAL_WINDOW_DAYS) {
        return { isNewArrival: true, source: 'fallback' };
      }
    }
  }

  return { isNewArrival: false, source: 'none' };
}

// ── Main normalization function ───────────────────────────────────────────────

type NormalizableRow = SupplierRow & {
  supplier_product_id?: string | null;
  /**
   * 人工指定的对外颜色名（product_variant_color_names 表，revoked_at IS NULL 的行）。
   * 调用方负责查表并挂到行上；这里保持纯函数。有它就压过标题色名与 mainColor。
   */
  variant_color_name?: string | null;
};

/**
 * 人工色名的净化：去首尾空白、折叠空格，≤ 40 字符，只允许字母 / 数字 / 空格 / 连字符 / &。
 * 不合规返回空串（= 没有人工色名），绝不把半截脏字符串写进 color。纯函数，桥接与这里共用一套规则。
 */
export function sanitizeVariantColorName(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 40) return '';
  return /^[A-Za-z0-9 &-]+$/.test(s) ? s : '';
}

// ── Variant color: the title's own color phrase beats the supplier's coarse mainColor ──
//
// GIGA `mainColor` is a color FAMILY ("Grey", "Blue"). Real variants inside one family
// differ by shade — "Light Grey" vs "Grey", or two different blues — and the family label
// alone makes those shades collide twice: in the variant-duplicate gate (two "Blue" →
// "duplicate colour") and in the storefront color selector (two identical swatches).
// The trailing comma segment of the supplier title is the supplier's per-variant colour
// name, so it wins whenever it is unambiguously a colour phrase; anything else falls
// back to mainColor unchanged. Conservative on purpose: a segment is accepted only when
// EVERY word is a known colour word or modifier — "Stainless Steel Cup Holders" is not.

const COLOR_WORDS = new Set([
  'black', 'white', 'grey', 'gray', 'blue', 'navy', 'green', 'red', 'pink', 'purple', 'yellow',
  'orange', 'beige', 'brown', 'ivory', 'cream', 'charcoal', 'teal', 'tan', 'walnut', 'oak',
  'espresso', 'cherry', 'mahogany', 'maple', 'silver', 'gold', 'bronze', 'brass', 'copper',
  'khaki', 'camel', 'taupe', 'sand', 'mocha', 'coffee', 'chocolate', 'burgundy', 'wine',
  'olive', 'sage', 'mint', 'turquoise', 'aqua', 'cyan', 'indigo', 'violet', 'lavender',
  'lilac', 'magenta', 'coral', 'peach', 'rust', 'mustard', 'emerald', 'ruby', 'champagne',
  'pearl', 'smoke', 'slate', 'graphite', 'stone', 'ash', 'linen', 'oatmeal', 'wheat', 'honey',
  'caramel', 'cognac', 'chestnut', 'hazel', 'pecan', 'hickory', 'teak', 'birch', 'pine',
  'cedar', 'acacia', 'rosewood', 'ebony', 'greige', 'nude', 'blush', 'multicolor',
  'multicolour', 'multi', 'clear', 'transparent', 'natural',
]);
const COLOR_MODIFIERS = new Set([
  'light', 'dark', 'deep', 'pale', 'soft', 'warm', 'cool', 'bright', 'matte', 'glossy',
  'antique', 'vintage', 'rustic', 'washed', 'distressed', 'off', 'medium', 'classic', 'rich',
]);

const titleCaseColor = (s: string) =>
  s.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);

/**
 * Resolve the per-variant colour name.
 *   1. trailing comma segment of the raw title, if it is purely a colour phrase (1–3 words,
 *      each a colour word or modifier, at least one colour word) → Title Case of that phrase;
 *   2. otherwise the supplier's `mainColor`, unchanged.
 * Pure; exported for tests.
 */
export function resolveVariantColor(rawTitle: string, mainColor: string): string {
  const fallback = String(mainColor ?? '').trim();
  const title = String(rawTitle ?? '').trim();
  const comma = title.lastIndexOf(',');
  if (comma < 0) return fallback;
  const segment = title.slice(comma + 1).replace(/\s+/g, ' ').trim();
  if (!segment) return fallback;
  const words = segment.split(/[\s/-]+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return fallback;
  const lower = words.map(w => w.toLowerCase());
  const allKnown = lower.every(w => COLOR_WORDS.has(w) || COLOR_MODIFIERS.has(w));
  const hasColor = lower.some(w => COLOR_WORDS.has(w));
  if (!allKnown || !hasColor) return fallback;
  return titleCaseColor(segment);
}

export function normalizeProduct(row: NormalizableRow): StandardizedProductInsert {
  const id = String(row.id);
  const supplierProductId = row.supplier_product_id
    ? String(row.supplier_product_id)
    : id;
  const raw = (row.raw_payload ?? {}) as Record<string, unknown>;

  // ── Images ──────────────────────────────────────────────────────────────────
  // Use ONLY raw_payload.imageUrls and raw_payload.mainImageUrl.
  // row.images is the supplier's fileUrls column and may contain PDFs — never use it.
  const rankedImages = collectImages([], raw);
  const [primaryImage = '', ...galleryImages] = rankedImages;

  // Every usable image the supplier published, plus video. `rankedImages` above
  // is capped at 8 for `gallery_images_json`, which is the curated set the grid
  // renders; this re-runs the same ranking with a far higher ceiling so a
  // detail-page lightbox can open the rest (suppliers ship a median of 18).
  // The ranking and the non-product filter still apply — the cap is the only
  // thing lifted, so PDFs and banner art stay out.
  const allImages = collectImages([], raw, 60);
  const allVideos = [
    ...(typeof raw.productVideoUrl === 'string' && raw.productVideoUrl.trim() ? [raw.productVideoUrl.trim()] : []),
    ...(Array.isArray(raw.videoUrls)
      ? (raw.videoUrls as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      : []),
  ];
  const uniqueVideos = [...new Set(allVideos)];
  const mediaJson =
    allImages.length > 0 || uniqueVideos.length > 0
      ? { images: allImages, video: uniqueVideos[0] ?? null, videos: uniqueVideos }
      : null;

  // Assembled size as separate numbers. `dimensions` stays the human-readable
  // string; this is the form schema.org width/height/depth can actually use.
  const assembledDimensions = (() => {
    const pick = (k: string): string | null => {
      const v = raw[k];
      const str = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
      return str && str !== '0' && str !== '0.00' ? str : null;
    };
    const out: Record<string, string> = {};
    const map: Array<[string, string]> = [
      ['length', 'assembledLength'], ['width', 'assembledWidth'],
      ['height', 'assembledHeight'], ['weight', 'assembledWeight'],
      ['lengthUnit', 'lengthUnit'], ['weightUnit', 'weightUnit'],
    ];
    for (const [outKey, rawKey] of map) {
      const v = pick(rawKey);
      if (v) out[outKey] = v;
    }
    // Units alone describe nothing — require at least one measurement.
    const hasMeasurement = ['length', 'width', 'height', 'weight'].some(k => out[k]);
    return hasMeasurement ? out : null;
  })();

  // ── Title ────────────────────────────────────────────────────────────────────
  // Strip supplier / manufacturer / vendor prefixes (e.g. "K&K") BEFORE
  // cleanTitle so subsequent retail formatting sees only product copy.
  // New supplier names go into src/utils/supplierNameSanitizer.ts.
  const rawTitle = String(row.title ?? '');
  const sanitizedRawTitle = sanitizeSupplierName(rawTitle).cleaned;
  const productTitle = cleanTitle(sanitizedRawTitle) || sanitizedRawTitle;
  const productTitleDisplay = buildDisplayTitle(productTitle);

  // ── Description: 1-2 clean retail sentences ──────────────────────────────────
  const rawDesc = typeof row.description === 'string' ? row.description : '';
  const characteristics = Array.isArray(raw.characteristics)
    ? (raw.characteristics as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  const shortDescription = buildDescription(rawDesc, characteristics, productTitle);

  // ── Core fields ──────────────────────────────────────────────────────────────
  const category = String(raw.category ?? raw.categoryName ?? raw.productCategory ?? '');
  const material = raw.mainMaterial ? String(raw.mainMaterial) : '';
  // Per-variant colour name: manual name (product_variant_color_names) → title suffix
  // (resolveVariantColor) → mainColor. Feeds `color`, specifications.Color and
  // color_options_json alike, so the duplicate gate and the storefront selector see the same name.
  const manualColor = sanitizeVariantColorName(row.variant_color_name);
  const color = manualColor || resolveVariantColor(rawTitle, raw.mainColor ? String(raw.mainColor) : '');

  // ── Category label & priority ────────────────────────────────────────────────
  const categoryLabel = assignCategoryLabel(category, productTitle);
  const categoryPriority = assignCategoryPriority(categoryLabel);
  console.log('[Normalization] category_label assigned:', categoryLabel, '| raw category:', category || productTitle.slice(0, 40));

  // ── New arrival ──────────────────────────────────────────────────────────────
  const { isNewArrival, source: newArrivalSource } = assignNewArrival(raw);
  console.log('[Normalization] is_new_arrival assigned:', isNewArrival, '| source:', newArrivalSource);

  // ── Price & original_price ────────────────────────────────────────────────────
  // raw_payload stores the complete merged API item (see supplierPickupService.ts).
  // Priority order for original_price:
  //   1. discountedPrice/exclusivePrice/salePrice < raw.price  (genuine GIGA discount)
  //   2. srpPrice > raw.price                                  (GIGA Suggested Retail Price)
  //   3. spring_sale_original_price                            (set by setupSpringCollection.ts)
  const spotArr = Array.isArray(raw.spotPrice)
    ? (raw.spotPrice as Array<Record<string, unknown>>)
    : [];
  const spot = spotArr[0] ?? {};

  const discountedRaw =
    raw.discountedPrice ??
    raw.exclusivePrice ??
    raw.salePrice ??
    spot.discountedPrice ??
    spot.exclusivePrice;

  const listRaw = raw.price ?? spot.price;

  const discountedNum = discountedRaw != null ? Number(discountedRaw) : 0;
  const listNum = listRaw != null ? Number(listRaw) : 0;

  // srpPrice = GIGA's Suggested Retail Price field (present in price/v1 response)
  const srpNum = raw.srpPrice != null && Number(raw.srpPrice) > 0 ? Number(raw.srpPrice) : 0;
  // spring_sale_original_price = promotional list price written by setupSpringCollection.ts
  const springSaleOriginal =
    raw.spring_sale_original_price != null && Number(raw.spring_sale_original_price) > 0
      ? Number(raw.spring_sale_original_price)
      : 0;

  // Selling price = discounted if valid, else fall back to whatever ingestion stored
  const price = discountedNum > 0 ? discountedNum : Number(row.price ?? 0);
  // original_price = list price only when a genuine discount exists
  const originalPrice: number | null =
    discountedNum > 0 && listNum > discountedNum ? listNum :
    srpNum > 0 && srpNum > price ? srpNum :
    springSaleOriginal > 0 && springSaleOriginal > price ? springSaleOriginal :
    null;

  // ── SKU: XH-[CATEGORY]-[SCENE]-[LAST6]-[IDENTITY] ───────────────────────────
  // LAST6 alone is NOT unique across sellers (GIGA reuses S000xx sequence numbers),
  // so new skus append a deterministic identity suffix derived from the FULL
  // supplier_product_id. This is the first CANDIDATE only — the upsert sites
  // (normalizeProducts / gigaManualProductUpload) keep any already-stored sku_custom
  // (rerun stability) and walk longer candidates on collision; the DB UNIQUE
  // constraint on sku_custom is the final arbiter.
  const cc = categoryCode(category, productTitle);
  const sc = sceneCode(category, productTitle);
  const suffix = skuSuffix(id, raw.sku ? String(raw.sku) : undefined);
  const skuCustom = `XH-${cc}-${sc}-${suffix}-${skuIdentitySuffixCandidates(id)[0]}`;
  // sku_search: uppercase with all non-alphanumeric chars stripped — enables partial SKU fragment matching.
  // e.g. XH-DR-BD-307539 → XHDRBD307539
  const skuSearch = skuCustom.toUpperCase().replace(/[^A-Z0-9]/g, '');

  // ── Key Features — zero overlap with specifications ──────────────────────────
  const specValues = [color, material, category].filter(v => v.length > 3);
  let features = buildBulletPoints(characteristics, rawDesc, { name: productTitle, category });
  features = removeSpecDuplicates(features, specValues);
  if (features.length < 4) {
    features = buildBulletPoints(undefined, rawDesc, { name: productTitle, category });
  }

  // ── Specifications JSON ──────────────────────────────────────────────────────
  const [dLen, dWid, dHt] = [raw.assembledLength, raw.assembledWidth, raw.assembledHeight];
  const dimensionsStr = dLen != null && dLen !== '' && dWid != null && dWid !== '' && dHt != null && dHt !== ''
    ? fmtDimensions(dLen, dWid, dHt)
    : '';
  const weightStr = raw.assembledWeight ? fmtWeight(raw.assembledWeight) : '';

  const specificationsJson: Record<string, string> = { SKU: skuCustom };
  if (color) specificationsJson['Color'] = color;
  if (material) specificationsJson['Material'] = material;
  if (dimensionsStr) specificationsJson['Dimensions'] = dimensionsStr;
  if (weightStr) specificationsJson['Weight'] = weightStr;
  if (category) specificationsJson['Category'] = category;

  // ── Color logic ──────────────────────────────────────────────────────────────
  const colorOptionsJson = color ? [color] : [];
  const hasMultipleColors = colorOptionsJson.length > 1;
  const showColorSelector = hasMultipleColors;

  return {
    supplier_product_id: supplierProductId,
    product_title: productTitle,
    product_title_display: productTitleDisplay,
    short_description: shortDescription,
    key_features_json: features,
    specifications_json: specificationsJson,
    sku_custom: skuCustom,
    category_code: cc,
    scene_code: sc,
    color,
    color_options_json: colorOptionsJson,
    has_multiple_colors: hasMultipleColors,
    show_color_selector: showColorSelector,
    material,
    dimensions: dimensionsStr,
    weight: weightStr,
    primary_image: primaryImage,
    gallery_images_json: galleryImages,
    product_family_key: resolveVariantGroupKey(raw, supplierProductId, cc, productTitle),
    normalization_status: 'done',
    price,
    original_price: originalPrice,
    sku_search: skuSearch,
    category_label: categoryLabel,
    category_priority: categoryPriority,
    is_new_arrival: isNewArrival,
    new_arrival_source: newArrivalSource,
    new_arrival_added_at: raw.addedTime
      ? String(raw.addedTime).replace(' ', 'T') + (String(raw.addedTime).includes('+') ? '' : 'Z')
      : null,
    // Preserved as the supplier sent it. `rawDesc` is the clean prose column
    // (measured: 0% HTML, median 1,017 chars) — deliberately not
    // raw_payload.description, which is a marketing layout blob of divs and
    // tables on 100% of rows and is not body copy.
    description_full: rawDesc.trim() || null,
    features_full: characteristics.length > 0 ? characteristics : null,
    attributes_json: plainStringMap(raw.attributes),
    assembled_dimensions: assembledDimensions,
    media_json: mediaJson,
    mpn: nonEmpty(raw.mpn),
    upc: nonEmpty(raw.upc),
    origin: nonEmpty(raw.placeOfOrigin),
    certifications_json: Array.isArray(raw.certificationList) && raw.certificationList.length > 0
      ? (raw.certificationList as unknown[])
      : null,
  };
}

/** Trimmed string, or null — so an absent supplier fact reads as absent, not ''. */
function nonEmpty(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s.length > 0 ? s : null;
}

/** A flat {string: string} map, ignoring nested or empty supplier values. */
function plainStringMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const s = nonEmpty(val);
    if (s) out[k] = s;
  }
  return Object.keys(out).length > 0 ? out : null;
}
