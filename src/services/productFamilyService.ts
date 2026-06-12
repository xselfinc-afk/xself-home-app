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
  'primary_image, gallery_images_json, product_family_key, price, selling_price, original_price, ' +
  'normalization_status, total_available_qty, ' +
  // extra fields so adaptStandardizedRow() can build a COMPLETE per-sibling Product (variant-
  // specific title/specs/images), not just the thin variant used by the color selector.
  'product_title_display, optimized_title, sku_search, category_label, category_priority, ' +
  'is_new_arrival, new_arrival_added_at, new_arrival_source, ' +
  'primary_image_blurhash, primary_image_w, primary_image_h, primary_image_aspect, primary_image_mirror_path';

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
 * Independent-SKU detail loader. Loads ONE sellable SKU's full row (including
 * gallery_images_json) and adapts it to a Product with the COMPLETE image gallery.
 * Used by ProductDetailScreen so the detail opens exactly the tapped supplier_product_id,
 * shows all its images, and renders no family color selector (adaptStandardizedRow builds a
 * single self-variant → the picker's >1 guard hides it). product.id === supplier_product_id,
 * so Add to Cart / Buy Now / Checkout use the exact tapped SKU.
 */
export async function loadProductDetail(supplierProductId: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('sellable_products')
    .select(FAMILY_SELECT)
    .eq('supplier_product_id', supplierProductId)
    .limit(1);
  if (error) { console.warn('[ProductDetail] load error:', error.message); return null; }
  if (!data || data.length === 0) return null;
  try { return adaptStandardizedRow(data[0] as any); }
  catch (e) { console.warn('[ProductDetail] adapt error:', e instanceof Error ? e.message : e); return null; }
}

/**
 * Loads all rows with the given product_family_key and merges them into one
 * Product with a real ProductVariant per color.
 *
 * Returns null if the family cannot be loaded or has no rows.
 */
export async function loadProductFamily(familyKey: string): Promise<Product | null> {
  // Load from sellable_products so detail variants are actually sellable/in-stock
  // (the view already enforces published + normalization_status=done + in_stock +
  // qty>0 + image + price>0). Prevents offering a color the customer cannot buy.
  const { data, error } = await supabase
    .from('sellable_products')
    .select(FAMILY_SELECT)
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

  // Build one ProductVariant per family row. supplierProductId is the authoritative
  // fulfillment key (sku stays sku_custom for display). stock is the real per-variant
  // availability so an out-of-stock color is reflected, not a hardcoded 999.
  const variants: ProductVariant[] = (data as any[]).map(r => {
    const qty = Number(r.total_available_qty ?? 0);
    return {
      sku: r.sku_custom as string,
      supplierProductId: r.supplier_product_id as string,
      color: (r.color as string) || 'Default',
      size: '',
      price: (r.selling_price ?? r.price) as number,
      originalPrice: (r.original_price ?? undefined) as number | undefined,
      stock: Number.isFinite(qty) && qty > 0 ? qty : 0,
      images: rowImages(r),
      enabled: Number.isFinite(qty) ? qty > 0 : true,
    };
  });

  const colors = variants.map(v => v.color);
  console.log('[ProductDetail] colors:', colors);

  // Full per-sibling Products so the detail page can render the SELECTED variant's own
  // title/description/features/specs (matched by Product.id === variant.supplierProductId).
  const variantProducts: Product[] = (data as any[])
    .map(r => { try { return adaptStandardizedRow(r); } catch { return null; } })
    .filter((p): p is Product => !!p);

  // Base product from the representative row; override variants with the full family set
  const base = adaptStandardizedRow(representative);
  return { ...base, variants, variantProducts };
}
