/**
 * Product Family pilot gate — the SMALLEST reversible allowlist of verified
 * authoritative `-vg-` family keys that render the multi-SKU color selector on the
 * Product Detail Page. Everything not in this set keeps the single-SKU
 * `loadProductDetail` path (one card per SKU) unchanged.
 *
 * Local config only — NO database flag, NO migration. To disable the pilot entirely,
 * empty this set (or flip PRODUCT_FAMILY_PILOT_ENABLED). To expand, add a family key
 * that passed reports/product-family/pilot-family-precheck.md (READY_FOR_PILOT).
 *
 * Keys were verified read-only against sellable_products + giga_delivery_fee_cache
 * (scripts/…/pilot-precheck.ts): each child has its own supplier_product_id, sku,
 * title, images, description, specs, price, sellable status, inventory, and a cached
 * delivery fee, with unique (non-duplicate) colour labels.
 */

/** Master kill-switch for the whole pilot (set false to force single-SKU everywhere). */
export const PRODUCT_FAMILY_PILOT_ENABLED = true;

/**
 * Initial verified pilot families (subset of the 8 READY_FOR_PILOT authoritative
 * `-vg-` families). Deliberately small; exercises both uniform-price and
 * per-child-varying-price ("From $X") rendering.
 */
export const PRODUCT_FAMILY_PILOT_KEYS: ReadonlySet<string> = new Set<string>([
  'dr-vg-w409p266778-2door2drawer-w32', // 2-Door Wardrobe — Black / Natural (uniform $279)
  'dr-vg-n733p307938b',                 // Mirrored Nightstand — Black / White (uniform $199)
  'cb-vg-w409p327399-4door-w63',        // Buffet Cabinet — Walnut $279 / Natural $219 (per-child price)
]);

/**
 * Staged for expansion after the initial pilot validates (all passed precheck):
 *   cb-vg-w331s00057-6door1drawer-w39, dr-vg-w1445s00002, dr-vg-w1820s00068,
 *   dr-vg-w409p387577, dr-vg-w409s00014
 * Held (unresolved config/width axis in key — fragmentation risk):
 *   dr-vg-xw000032aaa-5drawer-wmissing, sb-vg-sp000075aac-cfgmissing-wmissing
 */

/** True only for a family key explicitly approved for the multi-SKU PDP pilot. */
export function isPilotFamily(key: string | null | undefined): boolean {
  return PRODUCT_FAMILY_PILOT_ENABLED && !!key && PRODUCT_FAMILY_PILOT_KEYS.has(key);
}
