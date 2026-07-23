/**
 * Commerce Taxonomy — Phase 1 feature flag.
 *
 * DEFAULT OFF. While false, the app behaves EXACTLY as it did before Phase 1:
 * the product adapter does not attach `product.commerce`, nothing in the UI
 * reads it, and the legacy `inferCategoryPath` / Home circles / Discover pills
 * are the sole category system.
 *
 * Phase 1 keeps this as a compile-time constant so there is ZERO runtime or
 * database dependency and rollback is trivial (flip to false / revert the
 * commit). Phase 2 will (a) flip it on, (b) build the Department → Product Type
 * → Room UI, and (c) optionally promote it to a remote flag sourced from
 * `home_content_config` (screen 'taxonomy') via adsConfigService's pattern.
 *
 * Rollback anchor: git tag xself-home-pre-commerce-taxonomy-phase1-2026-07-21.
 */
export const COMMERCE_TAXONOMY_ENABLED = false;

/**
 * Commerce Taxonomy — Phase 2 NAVIGATION feature flag.
 *
 * DEFAULT OFF. While false, the app behaves EXACTLY as before Phase 2: the
 * legacy Home "Shop by Category" circles and the legacy Discover pill row are
 * the sole browse UI, and none of the new Experience/Commerce taxonomy screens
 * are reachable. Turning it OFF instantly restores the legacy experience with
 * no database rollback.
 *
 * When true, the Home Experience entry ("Browse all categories" + "Shop your
 * way") and the Commerce browse/results screens (Department → Category →
 * Product Type → Results) become available. Data is derived at runtime from the
 * live sellable_products catalog via Phase 1 classifyCommerce — no schema or
 * product-data changes.
 *
 * Compile-time constant in Phase 2 (zero runtime/DB dependency); a later phase
 * may promote it to a remote flag (home_content_config, screen 'taxonomy').
 * Rollback anchor: git tag xself-home-commerce-taxonomy-phase2-design-v1.
 */
export const COMMERCE_TAXONOMY_NAVIGATION_ENABLED = false;
