import type { Product, MediaItem, ProductVariant } from '../data/products';
import { generateSku } from '../utils/skuGenerator';
import { cleanTitle, toShortTitle, buildDescription, buildBulletPoints, removeSpecDuplicates } from '../utils/contentGenerator';
// Image logic lives in imageSelector — imported and re-exported for backwards compatibility.
import { collectImages } from './imageSelector';
export { collectImages };
import { inferCategoryPath, inferProductTags } from '../utils/productClassification';

// ── Debug counter (remove after Phase 3 verification) ────────────────────────
let _debugCount = 0;

// ── Input shape (Supabase supplier_products row) ──────────────────────────────

export type SupplierRow = {
  id: string | number;
  title?: string | null;
  images?: string[] | null;
  price?: number | null;
  description?: string | null;
  raw_payload?: Record<string, unknown> | null;
};

// ── Spec builder ──────────────────────────────────────────────────────────────

function buildSpecs(
  raw: Record<string, unknown>,
  id: string,
): { group?: string; label: string; value: string }[] {
  const g = 'Specifications';
  const rows: { group: string; label: string; value: string }[] = [];

  const sku = generateSku({
    id,
    category: String(raw.category ?? raw.categoryName ?? ''),
    material: raw.mainMaterial ? String(raw.mainMaterial) : undefined,
    originalSku: raw.sku ? String(raw.sku) : undefined,
  });
  rows.push({ group: g, label: 'SKU', value: sku });

  if (raw.mainColor) rows.push({ group: g, label: 'Color', value: String(raw.mainColor) });
  if (raw.mainMaterial) rows.push({ group: g, label: 'Material', value: String(raw.mainMaterial) });

  const dims = [raw.assembledLength, raw.assembledWidth, raw.assembledHeight]
    .filter(v => v != null && v !== '');
  if (dims.length === 3) {
    rows.push({ group: g, label: 'Dimensions (L×W×H)', value: dims.map(String).join(' × ') });
  }

  if (raw.assembledWeight) rows.push({ group: g, label: 'Weight', value: String(raw.assembledWeight) });

  const cat = raw.category ?? raw.categoryName;
  if (cat) rows.push({ group: g, label: 'Category', value: String(cat) });

  return rows;
}

// ── Main adapter ──────────────────────────────────────────────────────────────

export function adaptSupplierRow(r: SupplierRow): Product {
  const id = String(r.id);
  const raw = (r.raw_payload ?? {}) as Record<string, unknown>;

  // Images — use ONLY raw_payload.imageUrls and raw_payload.mainImageUrl.
  // r.images is the supplier fileUrls column and may contain PDFs — never use it.
  const finalImages = collectImages([], raw);

  // Title
  const rawTitle = String(r.title ?? '');
  const name = cleanTitle(rawTitle) || rawTitle;
  const shortTitle = toShortTitle(name);

  // Description
  const rawDesc = typeof r.description === 'string' ? r.description : '';
  const characteristics = Array.isArray(raw.characteristics)
    ? (raw.characteristics as unknown[]).filter((s): s is string => typeof s === 'string')
    : undefined;
  const desc = buildDescription(rawDesc, characteristics);

  const category = String(raw.category ?? raw.categoryName ?? raw.productCategory ?? '');
  const price = Number(r.price ?? 0);

  // Features / bullet points — deduplicate against spec values so Key Features
  // never just restate what's already in the Specifications section
  const specValues = [
    raw.mainColor,
    raw.mainMaterial,
    raw.category ?? raw.categoryName ?? raw.productCategory,
  ]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 3)
    .map(String);

  let featureList = buildBulletPoints(characteristics, rawDesc, { name, category });
  featureList = removeSpecDuplicates(featureList, specValues);
  // If deduplication left fewer than 4, regenerate from templates
  if (featureList.length < 4) {
    featureList = buildBulletPoints(undefined, rawDesc, { name, category });
  }

  // Specs
  const specs = buildSpecs(raw, id);
  const material = raw.mainMaterial ? [String(raw.mainMaterial)] : undefined;
  const media: MediaItem[] = finalImages.map(url => ({ type: 'image' as const, url }));

  // Build a single real variant when the supplier provides a color.
  // This lets ProductDetailScreen skip the fake VARIANT_COLORS fallback
  // and hide the color selector (single-option = hidden by App.tsx guard).
  const variantSku = generateSku({
    id,
    category,
    material: raw.mainMaterial ? String(raw.mainMaterial) : undefined,
    originalSku: raw.sku ? String(raw.sku) : undefined,
  });

  const variants: ProductVariant[] | undefined = raw.mainColor
    ? [
        {
          sku: variantSku,
          color: String(raw.mainColor),
          size: '',
          price,
          stock: 999,
          images: finalImages,
          enabled: true,
        },
      ]
    : undefined;

  const base: Product = {
    id,
    name,
    shortTitle,
    category,
    desc,
    price,
    discountPercent: 0,
    rating: 4.6,
    reviewCount: 24,
    stock: 999,
    images: finalImages,
    media,
    features: featureList.length > 0 ? featureList : undefined,
    specs,
    tags: material ? { material } : undefined,
    variants,
    sales: 0,
  };

  const categoryPath = inferCategoryPath(base);
  const tags = inferProductTags(base);

  return { ...base, categoryPath, tags };
}

// ── Standardized product adapter ──────────────────────────────────────────────

/**
 * Shape returned by Supabase when querying standardized_products.
 * Mirrors the columns defined in supabase/standardized_products.sql.
 */
export type StandardizedRow = {
  id: string;
  supplier_product_id: string;
  product_title: string;
  product_title_display?: string;
  optimized_title?: string | null;
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
  price: number;
  original_price?: number | null;
  selling_price?: number | null;
  sku_search?: string | null;
  category_label?: string | null;
  category_priority?: number | null;
  is_new_arrival?: boolean;
  new_arrival_source?: string | null;
  new_arrival_added_at?: string | null;
  product_family_key: string;
  normalization_status: string;
  total_available_qty?: number | null;
};

/**
 * Converts a standardized_products row to the Product shape the app expects.
 * This is intentionally simpler than adaptSupplierRow — the data is already clean.
 */
export function adaptStandardizedRow(r: StandardizedRow): Product {
  const gallery = Array.isArray(r.gallery_images_json) ? r.gallery_images_json : [];
  const dedupedGallery = gallery.filter(
    (url): url is string => typeof url === 'string' && url.length > 0 && url !== r.primary_image,
  );
  const images = r.primary_image ? [r.primary_image, ...dedupedGallery] : dedupedGallery;
  const media: MediaItem[] = images.map(url => ({ type: 'image' as const, url }));

  // specifications_json is { SKU: "...", Color: "...", ... } — convert to label/value array
  const SPEC_GROUP = 'Specifications';
  const specsJson: Record<string, string> =
    r.specifications_json && typeof r.specifications_json === 'object'
      ? (r.specifications_json as Record<string, string>)
      : {};
  const specs = Object.entries(specsJson)
    .filter(([, v]) => v && v.trim().length > 0)
    .map(([label, value]) => ({ group: SPEC_GROUP, label, value }));

  // Use the full category name from specs for display/filtering; fall back to code
  const category = specsJson['Category'] || r.category_code;

  // AI-managed retail price — falls back to supplier price when not yet set
  const customerPrice = r.selling_price != null && r.selling_price > 0 ? r.selling_price : r.price;
  // Show strikethrough when supplier's list price is genuinely above what we charge
  const originalPrice = r.original_price != null && r.original_price > customerPrice
    ? r.original_price
    : undefined;

  // Build a single real variant so the app hides the fake VARIANT_COLORS fallback.
  // show_color_selector = false → picker stays hidden (colorImageVariants.length <= 1 guard).
  const variants: ProductVariant[] | undefined = r.color
    ? [
        {
          sku: r.sku_custom,
          color: r.color,
          size: '',
          price: customerPrice,
          stock: r.total_available_qty ?? 0,
          images,
          enabled: true,
        },
      ]
    : undefined;

  const base: Product = {
    id: r.supplier_product_id,
    name: r.optimized_title || r.product_title_display || r.product_title || '',
    shortTitle: toShortTitle(r.optimized_title || r.product_title_display || r.product_title || ''),
    displayTitle: r.product_title_display || undefined,
    category,
    desc: r.short_description,
    price: customerPrice,
    originalPrice,
    discountPercent: originalPrice
      ? Math.round((1 - customerPrice / originalPrice) * 100)
      : 0,
    rating: 4.6,
    reviewCount: 24,
    stock: r.total_available_qty ?? 0,
    image: images[0],
    thumbnail: images[0],
    coverImage: images[0],
    product_family_key: r.product_family_key || undefined,
    skuCustom: r.sku_custom || undefined,
    skuSearch: r.sku_search || undefined,
    categoryLabel: r.category_label || undefined,
    categoryPriority: r.category_priority ?? undefined,
    isNewArrival: r.is_new_arrival ?? false,
    isNew: r.is_new_arrival ?? false,
    newArrivalSource: r.new_arrival_source || undefined,
    newArrivalAddedAt: r.new_arrival_added_at || undefined,
    images,
    media,
    features: Array.isArray(r.key_features_json) && r.key_features_json.length > 0 ? r.key_features_json : undefined,
    specs,
    tags: r.material ? { material: [r.material] } : undefined,
    variants,
    sales: 0,
  };

  // Enrich with structured category path and full tag set.
  // DB fields take precedence inside inferProductTags (material from tags.material,
  // color from variants[0].color); inference fills any remaining gaps.
  const categoryPath = inferCategoryPath(base);
  const tags = inferProductTags(base);

  if (__DEV__ && _debugCount < 5) {
    _debugCount++;
    console.log('[ProductAdapter] enriched product', _debugCount + ':', {
      id:           base.id,
      name:         base.name,
      oldCategory:  base.category,
      categoryLabel: base.categoryLabel,
      categoryPath,
      tags,
    });
  }

  return { ...base, categoryPath, tags };
}
