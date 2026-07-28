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
 * Verified pilot families — all 8 READY_FOR_PILOT authoritative `-vg-` families
 * from reports/product-family/pilot-family-precheck.md. Each is a clean 2-child
 * colour pair with unique colour labels and complete per-child content/price/
 * inventory/delivery-fee. Two of the original ten are deliberately EXCLUDED (see
 * the Held note below). Exercises both uniform-price and per-child-varying-price.
 */
export const PRODUCT_FAMILY_PILOT_KEYS: ReadonlySet<string> = new Set<string>([
  'dr-vg-w409p266778-2door2drawer-w32', // 2-Door Wardrobe — Black / Natural (uniform $279)
  'dr-vg-n733p307938b',                 // Mirrored Nightstand — Black / White (uniform $199)
  'cb-vg-w409p327399-4door-w63',        // Buffet Cabinet 62.6" — Walnut $279 / Natural $219 (per-child price)
  'cb-vg-w331s00057-6door1drawer-w39',  // 70.87" Tall Wardrobe — Black $219 / Walnut $209 (per-child price)
  'dr-vg-w1445s00002',                  // 6-Drawer Double-Wide Dresser — Antique/Light Brown / Deep Rustic Brown (uniform $479)
  'dr-vg-w1820s00068',                  // 6-Drawer 55" Dresser — Oak / Walnut (uniform $349)
  'dr-vg-w409p387577',                  // 9-Drawer Dresser — White / Natural (uniform $349)
  'dr-vg-w409s00014',                   // 9-Drawer 63" Dresser — White / Black (uniform $289)
]);

/**
 * HELD OUT (do NOT add without manual confirmation) — the 2 remaining multi-child
 * `-vg-` families carry an unresolved config/width axis in the key, a documented
 * fragmentation risk (a future sibling could parse a config and split the group):
 *   dr-vg-xw000032aaa-5drawer-wmissing, sb-vg-sp000075aac-cfgmissing-wmissing
 * Title-derived families are never eligible for the pilot.
 */

/** True only for a family key explicitly approved for the multi-SKU PDP pilot. */
export function isPilotFamily(key: string | null | undefined): boolean {
  return PRODUCT_FAMILY_PILOT_ENABLED && !!key && PRODUCT_FAMILY_PILOT_KEYS.has(key);
}
