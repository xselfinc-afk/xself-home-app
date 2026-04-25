/**
 * Product family loader.
 *
 * Queries all standardized_products rows that share a product_family_key and
 * merges them into a single Product where each row becomes a color variant.
 * Called by ProductDetailScreen when navigating from Discover with a family key.
 */

import { supabase } from '../lib/supabase';
import { adaptStandardizedRow } from './detailProductAdapter';
import type { Product, ProductVariant } from '../data/products';

const FAMILY_SELECT =
  'id, supplier_product_id, product_title, short_description, ' +
  'key_features_json, specifications_json, sku_custom, ' +
  'category_code, scene_code, color, color_options_json, ' +
  'has_multiple_colors, show_color_selector, material, dimensions, weight, ' +
  'primary_image, gallery_images_json, product_family_key, price, selling_price, original_price, normalization_status';

/**
 * Builds the image array for a single standardized row, deduplicating primary
 * against gallery.
 */
function rowImages(r: {
  primary_image: string;
  gallery_images_json: string[] | null;
}): string[] {
  const gallery = Array.isArray(r.gallery_images_json) ? r.gallery_images_json : [];
  const deduped = gallery.filter(
    (u): u is string => typeof u === 'string' && u.length > 0 && u !== r.primary_image,
  );
  return r.primary_image ? [r.primary_image, ...deduped] : deduped;
}

/**
 * Loads all rows with the given product_family_key and merges them into one
 * Product with a real ProductVariant per color.
 *
 * Returns null if the family cannot be loaded or has no rows.
 */
export async function loadProductFamily(familyKey: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('standardized_products')
    .select(FAMILY_SELECT)
    .eq('normalization_status', 'done')
    .eq('product_family_key', familyKey)
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[ProductFamily] load error:', error.message);
    return null;
  }

  if (!data || data.length === 0) return null;

  console.log('[ProductDetail] family rows loaded:', data.length);

  // Use the first row with a valid image as the representative; fall back to data[0]
  const representative =
    (data.find((r: any) => !!r.primary_image) ?? data[0]) as any;

  // Build one ProductVariant per family row
  const variants: ProductVariant[] = (data as any[]).map(r => ({
    sku: r.sku_custom as string,
    color: (r.color as string) || 'Default',
    size: '',
    price: (r.selling_price ?? r.price) as number,
    stock: 999,
    images: rowImages(r),
    enabled: true,
  }));

  const colors = variants.map(v => v.color);
  console.log('[ProductDetail] colors:', colors);

  // Base product from the representative row; override variants with the full family set
  const base = adaptStandardizedRow(representative);
  return { ...base, variants };
}
