-- 20260609_sellable_products_require_selling_price.sql
--
-- Close the cost-exposure gap in the storefront visibility gate.
--
-- The app's price ladder is `selling_price > 0 ? selling_price : price`, and
-- `standardized_products.price` holds the SUPPLIER COST (set by the
-- normalization pipeline). The sellable_products view previously gated only on
-- `price > 0`, so a product that was normalized + in-stock + published but not
-- yet priced by the `dynamic-pricing` function would surface at COST until the
-- next pricing run.
--
-- This migration adds two predicates so a product can NOT appear in
-- sellable_products (and therefore the app) until it has a positive
-- selling_price:
--   AND sp.selling_price IS NOT NULL
--   AND sp.selling_price > 0
--
-- Source of truth for the rest of the definition: supabase/inventory_source_of_truth.sql
-- Only the two selling_price predicates are added; all other gates are unchanged.
--
-- Read-only impact verified before writing this migration (2026-06-09):
--   current sellable_products: 151 visible; selling_price NULL or <= 0: 0
--   → applying this gate hides 0 currently-visible products.
--
-- Reversible: re-apply the prior definition (drop the two selling_price lines).

CREATE OR REPLACE VIEW public.sellable_products AS
SELECT
  sp.*,
  CASE
    WHEN sp.inventory_last_synced_at IS NULL                          THEN 'missing'
    WHEN sp.inventory_last_synced_at > (now() - interval '24 hours') THEN 'fresh'
    WHEN sp.inventory_last_synced_at > (now() - interval '7 days')   THEN 'stale'
    ELSE 'expired'
  END AS inventory_freshness
FROM public.standardized_products sp
WHERE sp.normalization_status = 'done'
  AND sp.published            = true
  AND sp.inventory_status     = 'in_stock'
  AND sp.total_available_qty  > 0
  AND sp.product_title        IS NOT NULL
  AND sp.primary_image        IS NOT NULL
  AND sp.primary_image        != ''
  AND sp.price                > 0
  AND sp.selling_price        IS NOT NULL   -- NEW: must be priced
  AND sp.selling_price        > 0;          -- NEW: positive selling price only

GRANT SELECT ON public.sellable_products TO anon, authenticated;
