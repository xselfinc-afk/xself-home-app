-- ============================================================================
-- Visibility enforcement v2  (NOT APPLIED — Step 3 applies this LAST)
--
-- Supersedes 20260803, which is superseded-in-place and must never be applied: it had no coverage
-- guard, so running it would silently take `sellable_products` from 353 rows to roughly 23.
--
-- THE DIFFERENCE THAT MATTERS
-- ---------------------------
-- This migration REFUSES TO APPLY ITSELF unless availability coverage is real. The guard runs first,
-- inside the same transaction, and raises. A premature apply therefore fails loudly and changes
-- nothing, instead of emptying the storefront and being discovered by customers.
--
-- WHAT MAKES A PRODUCT VISIBLE AFTERWARDS
--   published = true                     (the lifecycle may set this false; see 20260806)
--   … every existing quality gate, unchanged …
--   AND a CONFIRMED Open API answer of available = true
--   AND that answer is within the 72-hour grace window
--
-- FAILURE SAFETY
-- `latest_product_availability` is built only from confirmed answers, so an auth/network/parse
-- failure cannot remove a product: the last good answer keeps standing until it ages out. Products
-- suppressed by grace expiry return the instant a good read lands — suppression is reversible and
-- never writes `published`. Only the two-confirmation lifecycle delists.
-- ============================================================================

DO $guard$
DECLARE
  v_published integer;
  v_covered   integer;
  v_pct       numeric;
  v_min       numeric := 95;   -- keep in sync with inventory_min_coverage_percent
BEGIN
  SELECT count(*) INTO v_published FROM public.standardized_products WHERE published = true;

  SELECT count(*) INTO v_covered
  FROM public.standardized_products sp
  JOIN public.product_availability_current pac ON pac.supplier_product_id = sp.supplier_product_id
  WHERE sp.published = true
    AND pac.checked_at > now() - interval '72 hours';

  v_pct := CASE WHEN v_published = 0 THEN 0 ELSE (v_covered::numeric / v_published) * 100 END;

  IF v_published = 0 THEN
    RAISE EXCEPTION 'Visibility enforcement refused: no published products to evaluate.';
  END IF;

  -- PL/pgSQL RAISE has no printf specifiers (% is a positional placeholder, %% a literal percent,
  -- and '%%%' parses as literal-then-placeholder). Round first and spell out 'percent'.
  IF v_pct < v_min THEN
    RAISE EXCEPTION
      'Visibility enforcement refused: availability coverage % percent of % published products (% covered) is below the required % percent. Run a full availability scan first; applying now would hide % products.',
      round(v_pct, 2), v_published, v_covered, round(v_min, 0), (v_published - v_covered);
  END IF;

  RAISE NOTICE 'Coverage gate passed: % percent (% of % published).', round(v_pct, 2), v_covered, v_published;
END $guard$;

-- DROP + CREATE rather than CREATE OR REPLACE.
--
-- 20260805 added `delist_reason` to standardized_products, and this view selects `sp.*`, so the
-- trailing computed column `inventory_freshness` shifts position. CREATE OR REPLACE VIEW can only
-- APPEND columns, never reposition them, and fails with 42P16. Verified: zero dependent views, so
-- the drop is safe. Wrapped in a transaction with the coverage guard above, so a failure at any
-- point leaves the previous view intact.
BEGIN;

DROP VIEW IF EXISTS public.sellable_products;

CREATE VIEW public.sellable_products AS
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
  -- … on evidence recent enough to trust (72h grace absorbs one missed 48h cycle).
  AND la.within_grace IS TRUE;

-- Restore the grants the view carried before the drop.
GRANT ALL ON public.sellable_products TO anon, authenticated, service_role, postgres;

COMMENT ON VIEW public.sellable_products IS
  'Customer-visible catalogue. Requires published, normalized, priced, imaged, a verified '
  'fulfillment path, AND a confirmed Open API availability answer within the 72-hour grace window. '
  'API failures never remove a product — latest_product_availability contains only confirmed '
  'answers, so the last good answer stands until it ages out.';

COMMIT;

-- ============================================================================
-- ROLLBACK — restores the pre-enforcement definition verbatim, instantly
-- ============================================================================
-- BEGIN;
-- DROP VIEW IF EXISTS public.sellable_products;
-- CREATE VIEW public.sellable_products AS
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
-- GRANT ALL ON public.sellable_products TO anon, authenticated, service_role, postgres;
-- COMMIT;
--
-- No data touched in either direction; zero dependent views.
-- ============================================================================
