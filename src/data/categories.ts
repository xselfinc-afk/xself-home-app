/**
 * Canonical product category list — single source of truth for both
 * the Home screen filter row and the Discover screen filter row.
 *
 * Labels are short keywords that match real standardized_products category
 * values via name-substring or category-substring matching (see matchesCategory).
 * 'All' is the "no filter" sentinel.
 *
 * Real DB categories include: 'Storage Cabinet', 'Sideboard', 'Dresser',
 * 'Bookshelf', 'TV Stand', 'Nightstand', 'Dining Chair', 'Coffee Table',
 * 'Console Table', 'Bathroom Cabinet'.
 */
export const PRODUCT_CATEGORIES: string[] = [
  'All',
  'Cabinet',
  'Dresser',
  'Table',
  'Chair',
  'Bookshelf',
  'TV Stand',
  'Nightstand',
  'Sideboard',
];

/**
 * Shared category match rule — used by both HomeScreen and DiscoverScreen.
 *
 * Returns true if the product name OR category field contains categoryLabel
 * as a case-insensitive substring. Always returns true for 'All'.
 *
 * Examples:
 *   matchesCategory({ name: 'Homfa Storage Cabinet', category: 'Storage Cabinet' }, 'Cabinet') → true
 *   matchesCategory({ name: 'Modern Dining Chair', category: 'Dining Chair' }, 'Chair') → true
 *   matchesCategory({ name: 'Wooden Bookshelf', category: 'Bookshelf' }, 'Bookshelf') → true
 */
export function matchesCategory(
  product: { name: string; category?: string },
  categoryLabel: string,
): boolean {
  if (categoryLabel === 'All') return true;
  const label = categoryLabel.toLowerCase();
  return (
    product.name.toLowerCase().includes(label) ||
    (product.category?.toLowerCase().includes(label) ?? false)
  );
}

/**
 * Strips all non-alphanumeric characters and uppercases the result.
 * Mirrors the sku_search DB column normalization rule.
 * Example: "XH-DR-BD-307539" → "XHDRBD307539", "307539" → "307539"
 */
export function normalizeForSkuMatch(q: string): string {
  return q.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

type SearchableProduct = {
  id: string;
  name: string;
  displayTitle?: string;
  category?: string;
  categoryLabel?: string;
  skuCustom?: string;
  skuSearch?: string;
};

/**
 * Combined OR search — used by both DiscoverScreen and SearchScreen (via HomeScreen).
 * Matches against: product_title, product_title_display, category, sku_custom (raw),
 * sku_search (normalized), and supplier_product_id (product.id).
 *
 * Title/category use case-insensitive raw query.
 * SKU fields use both raw and normalized forms so partial fragments like
 * "DR-BD", "307539", "XH-DR", "DRBD" all match "XH-DR-BD-307539".
 */
export function matchesSearch(product: SearchableProduct, rawQuery: string): boolean {
  const q = rawQuery.trim();
  if (!q) return true;
  const qLower = q.toLowerCase();

  // Title & category — case-insensitive substring (raw query)
  if (product.name.toLowerCase().includes(qLower)) return true;
  if (product.displayTitle?.toLowerCase().includes(qLower)) return true;
  if (product.categoryLabel?.toLowerCase().includes(qLower)) return true;
  if (product.category?.toLowerCase().includes(qLower)) return true;

  // SKU partial match — raw form ("DR-BD", "307539", "XH-DR")
  if (product.skuCustom?.toLowerCase().includes(qLower)) return true;

  // SKU partial match — normalized form ("DRBD", "307", "BD307")
  const qNorm = normalizeForSkuMatch(q);
  if (qNorm.length >= 2) {
    if (product.skuSearch?.includes(qNorm)) return true;
    // supplier_product_id is stored as product.id
    if (product.id.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(qNorm)) return true;
  }

  return false;
}
