-- ============================================================================
-- Visibility freshness enforcement  (NOT YET APPLIED — DANGEROUS UNTIL GATED)
--
-- ⚠️  DO NOT RUN THIS UNTIL A FULL LIVE AVAILABILITY SCAN HAS POPULATED
--     product_availability_checks FOR SUBSTANTIALLY ALL PUBLISHED SKUS.
--
--     Applied against today's data it would reduce sellable_products from 353 rows to 0,
--     because no product currently has any Open API availability evidence at all.
--
--     Required order:  20260802_open_api_availability.sql  →  one approved live scan
--                   →  verify coverage ≥ 95% and failure rate < 20%  →  THEN this file.
--
-- WHAT IT CHANGES
-- ---------------
-- sellable_products currently computes `inventory_freshness` and then ignores it, so a product
-- stays visible forever on inventory evidence of any age. This adds the missing requirement:
-- recent CONFIRMED supplier availability.
--
-- The 72-hour grace window (not 48) is deliberate. The scan runs every 48h, so a 48h cutoff would
-- hide the catalogue on any scheduler delay — indistinguishable, from the view's perspective, from
-- a genuine supplier outage. 72h absorbs one missed cycle; alerting fires at 48h.
--
-- FAILURE SAFETY
-- --------------
-- latest_product_availability excludes failure rows, so an auth/network/parse failure cannot make a
-- product disappear: the last confirmed answer keeps standing until it ages out of the grace window.
-- Suppression is reversible the moment a good read lands; nothing is delisted by this view.
-- ============================================================================

CREATE OR REPLACE VIEW public.sellable_products AS
SELECT sp.*,
  CASE
    WHEN sp.inventory_last_synced_at IS NULL THEN 'missing'::text
    WHEN sp.inventory_last_synced_at > (now() - '24:00:00'::interval) THEN 'fresh'::text
    WHEN sp.inventory_last_synced_at > (now() - '7 days'::interval) THEN 'stale'::text
    ELSE 'expired'::text
  END AS inventory_freshness
FROM standardized_products sp
JOIN public.latest_product_availability la
  ON la.supplier_product_id = sp.supplier_product_id
WHERE sp.normalization_status = 'done'::text
  AND sp.published = true
  AND sp.inventory_status = 'in_stock'::text
  AND sp.total_available_qty > 0
  AND sp.product_title IS NOT NULL
  AND sp.primary_image IS NOT NULL
  AND sp.primary_image <> ''::text
  AND sp.price > 0::numeric
  AND sp.selling_price IS NOT NULL
  AND sp.selling_price > 0::numeric
  -- NEW: the supplier must currently consider the SKU available …
  AND la.available IS TRUE
  -- … and that answer must be recent enough to trust (72h grace, see header).
  AND la.within_grace IS TRUE;

COMMENT ON VIEW public.sellable_products IS
  'Customer-visible catalogue. A product appears only when published, normalized, priced, imaged, '
  'flagged in_stock with positive qty, AND carrying a confirmed Open API availability answer within '
  'the 72-hour grace window. API failures never remove a product — latest_product_availability '
  'ignores failure rows, so the last confirmed answer stands.';

-- ============================================================================
-- ROLLBACK — restores the exact pre-change definition verbatim
-- ============================================================================
-- CREATE OR REPLACE VIEW public.sellable_products AS
-- SELECT sp.*,
--   CASE
--     WHEN inventory_last_synced_at IS NULL THEN 'missing'::text
--     WHEN inventory_last_synced_at > (now() - '24:00:00'::interval) THEN 'fresh'::text
--     WHEN inventory_last_synced_at > (now() - '7 days'::interval) THEN 'stale'::text
--     ELSE 'expired'::text
--   END AS inventory_freshness
-- FROM standardized_products sp
-- WHERE normalization_status = 'done'::text AND published = true
--   AND inventory_status = 'in_stock'::text AND total_available_qty > 0
--   AND product_title IS NOT NULL AND primary_image IS NOT NULL AND primary_image <> ''::text
--   AND price > 0::numeric AND selling_price IS NOT NULL AND selling_price > 0::numeric;
--
-- Rollback is instant and total: one CREATE OR REPLACE VIEW restores every previously visible
-- product. No data is altered by either direction.
-- ============================================================================
