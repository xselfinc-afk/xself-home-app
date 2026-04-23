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
import { categoryCode, sceneCode, skuSuffix, fmtDimensions, fmtWeight } from './specFormatter';
import { computeFamilyKey } from './familyKeyGenerator';

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
};

// ── Category label assignment ────────────────────────────────────────────────

/** Ordered from most specific → least specific to avoid short-pattern false positives. */
const CATEGORY_PATTERNS: Array<{ patterns: string[]; label: string }> = [
  { patterns: ['nightstand', 'bedside table', 'bedside cabinet', 'night stand', 'night table'], label: 'Nightstand' },
  { patterns: ['tv stand', 'media console', 'entertainment center', 'media unit', 'media stand', 'tv console', 'media center'], label: 'TV Stand' },
  { patterns: ['dresser', 'chest of drawers', 'drawer dresser', 'chest drawer', '6 drawer', '5 drawer', '4 drawer', 'drawer chest'], label: 'Dresser' },
  { patterns: ['sideboard', 'buffet', 'credenza', 'server'], label: 'Sideboard' },
  { patterns: ['bookshelf', 'bookcase', 'shelving unit', 'shelf', 'shelves'], label: 'Bookshelf' },
  { patterns: ['sofa', 'loveseat', 'sectional', 'couch', 'futon'], label: 'Sofa' },
  { patterns: ['bed frame', 'platform bed', 'upholstered bed', ' bed '], label: 'Bed' },
  { patterns: ['coffee table', 'console table', 'dining table', 'side table', 'end table', 'accent table', 'sofa table', 'kitchen table'], label: 'Table' },
  { patterns: ['dining chair', 'accent chair', 'armchair', 'vanity stool', 'bar stool', 'stool', 'chair'], label: 'Chair' },
  { patterns: ['organizer', 'hall tree', 'shoe storage', 'storage bench', 'entryway storage', 'shoe rack', 'coat rack', 'storage unit'], label: 'Storage' },
  { patterns: ['cabinet', 'cupboard', 'pantry', 'linen cabinet', 'storage cabinet', 'bathroom cabinet', 'medicine cabinet', 'curio', 'display cabinet'], label: 'Cabinet' },
  { patterns: ['table'], label: 'Table' }, // broad fallback
];

const CATEGORY_PRIORITY: Record<string, number> = {
  Dresser: 10, Cabinet: 20, Sideboard: 25, 'TV Stand': 30,
  Nightstand: 35, Table: 40, Chair: 50, Bookshelf: 60,
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

type NormalizableRow = SupplierRow & { supplier_product_id?: string | null };

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

  // ── Title ────────────────────────────────────────────────────────────────────
  const rawTitle = String(row.title ?? '');
  const productTitle = cleanTitle(rawTitle) || rawTitle;
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
  const color = raw.mainColor ? String(raw.mainColor) : '';

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

  // ── SKU: XH-[CATEGORY]-[SCENE]-[LAST6] ──────────────────────────────────────
  const cc = categoryCode(category, productTitle);
  const sc = sceneCode(category, productTitle);
  const suffix = skuSuffix(id, raw.sku ? String(raw.sku) : undefined);
  const skuCustom = `XH-${cc}-${sc}-${suffix}`;
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
    product_family_key: computeFamilyKey(productTitle, cc),
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
  };
}
