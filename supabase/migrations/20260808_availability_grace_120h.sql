-- ============================================================================
-- Availability grace window: 72h → 120h   (NOT APPLIED — apply as a separate approved action)
--
-- WHY
-- ---
-- 20260804 set grace = 72h and described it as "absorbing one missed cycle". With a 48h scan
-- cadence that is arithmetically false:
--
--     evidence written   T
--     next scan due      T+48h
--     grace expires      T+72h
--     if T+48h fails, the next attempt is T+96h — which is AFTER expiry
--
-- So a single failed scan guaranteed a storefront outage. That is exactly what happened on
-- 2026-08-05: the scheduled scan exited 127 (npx not on launchd's PATH), grace closed 24h later,
-- and sellable_products fell from ~310 rows to 1 while every product was still published = true.
--
-- To absorb N missed cycles the window must satisfy:  grace >= cadence * (N + 1)
--     N = 1  ->  >=  96h
--     N = 2  ->  >= 144h
--
-- 120h absorbs two missed cycles with margin on the first, without stretching the window so far
-- that genuinely stale evidence keeps products visible. The cadence stays at 48h.
--
-- `is_fresh` (48h = one cadence) is deliberately unchanged: it still means "current".
--
-- SCOPE — replaces ONE view definition and its comment. Nothing else.
-- It does NOT touch:
--   * product_availability_checks / product_availability_current rows (no evidence altered)
--   * inventory_workflow_states (no lifecycle state or counter altered)
--   * standardized_products.published or any publication field
--   * sellable_products — it reads within_grace from this view, so it inherits the new window
--     automatically and needs no rebuild of its own
--
-- Column list, order and types are unchanged, so CREATE OR REPLACE VIEW is valid and no dependent
-- object needs rebuilding.
--
-- KEEP IN SYNC: scripts/xoneInventoryLifecycleBridge.ts :: AVAILABILITY_GRACE_HOURS
-- ============================================================================

CREATE OR REPLACE VIEW public.latest_product_availability AS
SELECT
  supplier_product_id,
  source,
  available,
  status,
  last_run_id AS run_id,
  checked_at,
  last_confirmed_available_at,
  last_confirmed_unavailable_at,
  (checked_at > now() - interval '48 hours') AS is_fresh,
  (checked_at > now() - interval '120 hours') AS within_grace
FROM public.product_availability_current;

COMMENT ON VIEW public.latest_product_availability IS
  'Confirmed availability per SKU with freshness flags. 48h = fresh (one scan cadence), '
  '120h = grace window absorbing two missed 48h cycles.';

-- ============================================================================
-- ROLLBACK — restores the 48h/72h windows exactly as 20260804 applied them
-- ============================================================================
-- CREATE OR REPLACE VIEW public.latest_product_availability AS
-- SELECT
--   supplier_product_id,
--   source,
--   available,
--   status,
--   last_run_id AS run_id,
--   checked_at,
--   last_confirmed_available_at,
--   last_confirmed_unavailable_at,
--   (checked_at > now() - interval '48 hours') AS is_fresh,
--   (checked_at > now() - interval '72 hours') AS within_grace
-- FROM public.product_availability_current;
--
-- COMMENT ON VIEW public.latest_product_availability IS
--   'Confirmed availability per SKU with freshness flags. 48h = fresh (one scan cadence), '
--   '72h = grace window absorbing one missed cycle.';
--
-- Rollback is a pure definition swap. No row is read or written in either direction.
-- Rolling back re-creates the single-failure outage described above.
-- ============================================================================
