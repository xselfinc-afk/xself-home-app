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
