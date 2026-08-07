/**
 * Supplier SKU → website numeric product_id resolution — pure, deterministic, side-effect free.
 *
 * The wishlist XHR carries the site's numeric product_id, not the SKU. A product_id shared by two
 * SKUs, or a SKU with two product_ids, would act on the wrong item — and both add and remove are
 * outward-facing and hard to walk back. So the mapping is verified in REVERSE and anything short of
 * a clean one-to-one match resolves to a status the caller must treat as an exception.
 *
 * Source of truth is the existing `inventory_cache`, which already stores both identifiers side by
 * side. No second product identity model is introduced, and this module never writes.
 */

export interface ProductIdMapping {
  product_id: number | null;
  /** The SKU the product_id resolves back to. Null when the reverse lookup is not unique. */
  verified_sku: string | null;
  status: 'unique' | 'multiple_product_ids' | 'shared_product_id' | 'not_mapped';
}

/**
 * Resolve one supplier SKU to the website's numeric product_id, and verify it in REVERSE.
 *
 * Reuses `inventory_cache`, which already stores both identifiers side by side — no second product
 * identity model is introduced. READ ONLY: this chain never writes that table, and the isolation
 * test enforces it.
 *
 * The reverse check matters more than the forward one. Removing a Favorite is irreversible and the
 * request carries the product_id, not the SKU, so a product_id shared by two SKUs would remove the
 * wrong item. Anything short of a clean one-to-one match is reported for human review.
 */
export function resolveProductIdMapping(
  sku: string,
  cache: ReadonlyArray<{ supplier_product_id: string | null; product_id: string | number | null }>,
): ProductIdMapping {
  const forward = new Set<string>();
  const reverse = new Map<string, Set<string>>();
  for (const row of cache) {
    if (!row.supplier_product_id || row.product_id === null || row.product_id === undefined) continue;
    const id = String(row.product_id);
    // `inventory_cache.product_id` 在生产中只是 supplier_product_id 的副本，不是网站的数字
    // product_id。个别 SKU 本身全是数字，照收会把一个 SKU 当成网站 id 发给 wishlist 接口，
    // 从而作用到毫不相干的商品上。自我副本一律不算映射。
    if (id === row.supplier_product_id) continue;
    if (row.supplier_product_id === sku) forward.add(id);
    if (!reverse.has(id)) reverse.set(id, new Set());
    reverse.get(id)!.add(row.supplier_product_id);
  }
  if (forward.size === 0) return { product_id: null, verified_sku: null, status: 'not_mapped' };
  if (forward.size > 1) return { product_id: null, verified_sku: null, status: 'multiple_product_ids' };

  const id = [...forward][0];
  const owners = reverse.get(id) ?? new Set();
  if (owners.size !== 1) return { product_id: null, verified_sku: null, status: 'shared_product_id' };
  const numeric = Number(id);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return { product_id: null, verified_sku: null, status: 'not_mapped' };
  }
  return { product_id: numeric, verified_sku: [...owners][0], status: 'unique' };
}
