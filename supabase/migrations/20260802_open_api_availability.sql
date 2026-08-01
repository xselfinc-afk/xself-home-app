-- ============================================================================
-- Open API availability persistence  (NOT YET APPLIED — review before running)
--
-- WHY A NEW TABLE RATHER THAN inventory_cache
-- -------------------------------------------
-- `inventory_cache` is warehouse-shaped: every row carries warehouse_code, quantity and
-- supports_pickup. The GIGA Open API returns a single boolean (`skuAvailable`) and NO warehouse,
-- quantity, or state data. Writing Open API results into inventory_cache would require inventing a
-- warehouse code and a quantity — fabricated evidence that would then flow into
-- refresh_product_inventory_status(), total_available_qty, and California pickup claims.
--
-- The two signals therefore stay semantically distinct:
--   inventory_cache            → per-warehouse quantities, California detail, pickup eligibility
--   product_availability_checks→ supplier-level "is this SKU available at all", the delist authority
--
-- This migration is ADDITIVE ONLY. It creates one table and one view. It does not alter
-- inventory_cache, standardized_products, sellable_products, or any function.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.product_availability_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_product_id text        NOT NULL,
  -- 'open_api' today. Kept open so a future official feed can coexist without a schema change.
  source              text        NOT NULL DEFAULT 'open_api',
  -- NULL is meaningful and common: every failure mode leaves availability unknown.
  available           boolean     NULL,
  -- Adapter status: confirmed_available | confirmed_out_of_stock | api_failed | rate_limited |
  -- network_failed | malformed_response | missing_sku | supplier_unavailable
  status              text        NOT NULL,
  failure_reason      text        NULL,
  run_id              text        NOT NULL,
  checked_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pac_source_chk CHECK (source IN ('open_api', 'official_api')),
  CONSTRAINT pac_status_chk CHECK (status IN (
    'confirmed_available', 'confirmed_out_of_stock', 'api_failed', 'rate_limited',
    'network_failed', 'malformed_response', 'missing_sku', 'supplier_unavailable')),
  -- The invariant this whole feature rests on: `available` may be non-NULL ONLY when the supplier
  -- actually answered. No failure row can ever masquerade as a zero.
  CONSTRAINT pac_available_only_when_confirmed_chk CHECK (
    (status = 'confirmed_available'    AND available IS TRUE)  OR
    (status = 'confirmed_out_of_stock' AND available IS FALSE) OR
    (status NOT IN ('confirmed_available', 'confirmed_out_of_stock') AND available IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS pac_sku_checked_idx  ON public.product_availability_checks (supplier_product_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS pac_run_idx          ON public.product_availability_checks (run_id);
CREATE INDEX IF NOT EXISTS pac_status_idx       ON public.product_availability_checks (status) WHERE status <> 'confirmed_available';

COMMENT ON TABLE public.product_availability_checks IS
  'Supplier-level availability evidence from the GIGA Open API (browser-free). NOT warehouse stock: '
  'carries no quantity, warehouse, or California data. Authority for delist/relist only.';

-- Latest confirmed answer per SKU. Failure rows are deliberately EXCLUDED, so a run of network
-- errors can never overwrite a good answer with "unknown" — the last real answer stands.
CREATE OR REPLACE VIEW public.latest_product_availability AS
SELECT DISTINCT ON (supplier_product_id)
  supplier_product_id,
  source,
  available,
  status,
  run_id,
  checked_at,
  (checked_at > now() - interval '72 hours')  AS is_fresh,
  (checked_at > now() - interval '96 hours')  AS within_grace
FROM public.product_availability_checks
WHERE status IN ('confirmed_available', 'confirmed_out_of_stock')
ORDER BY supplier_product_id, checked_at DESC;

COMMENT ON VIEW public.latest_product_availability IS
  'Most recent CONFIRMED availability answer per SKU. Failures are excluded by design: a failed '
  'read must never displace the last trustworthy answer. 72h = fresh (scan runs every 3 days), '
  '96h = grace window absorbing scheduler delay.';

ALTER TABLE public.product_availability_checks ENABLE ROW LEVEL SECURITY;

-- Service-role only. The app never reads this table directly; it consumes sellable_products.
DROP POLICY IF EXISTS pac_service_role_all ON public.product_availability_checks;
CREATE POLICY pac_service_role_all ON public.product_availability_checks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- ROLLBACK
-- ============================================================================
-- DROP VIEW  IF EXISTS public.latest_product_availability;
-- DROP TABLE IF EXISTS public.product_availability_checks;   -- drops its indexes and policy too
--
-- Rollback is complete and lossless for the rest of the system: nothing else references either
-- object, and no existing table, view, function, or row is modified by this migration.
-- ============================================================================
