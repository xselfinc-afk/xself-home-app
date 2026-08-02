-- ============================================================================
-- Availability freshness windows: 72h/96h → 48h/72h
--
-- WHY THIS IS A SEPARATE MIGRATION
-- -------------------------------
-- `20260802_open_api_availability.sql` was already applied to production with fresh=72h and
-- grace=96h, sized against the original 3-day scan cadence. The cadence is now 48 hours, so the
-- windows must move with it. Editing the historical migration in place would leave the repository
-- describing a state production never had, and re-running an edited historical file is exactly the
-- kind of drift that makes migration history untrustworthy. 20260802 has been restored to the
-- definition that was actually applied; this file carries the change forward.
--
-- WHY 48h / 72h
-- -------------
--   fresh = 48h  — one scan cadence. Evidence older than one full cycle is no longer "current".
--   grace = 72h  — one missed cycle of slack. A 48h cutoff would hide products on ordinary
--                  scheduler delay, which the view cannot distinguish from a supplier outage.
--
-- SCOPE — this migration replaces ONE view definition and its comment. Nothing else.
-- It does NOT touch:
--   * product_availability_checks / product_availability_current rows (no evidence is altered)
--   * inventory_workflow_states (no lifecycle state or counter is altered)
--   * standardized_products.published or any publication field
--   * sellable_products (which does not yet reference this view — the visibility migration
--     20260803 remains UNAPPLIED)
--
-- Column list, order and types are unchanged, so CREATE OR REPLACE VIEW is valid and no dependent
-- object needs rebuilding.
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
  (checked_at > now() - interval '72 hours') AS within_grace
FROM public.product_availability_current;

COMMENT ON VIEW public.latest_product_availability IS
  'Confirmed availability per SKU with freshness flags. 48h = fresh (one scan cadence), '
  '72h = grace window absorbing one missed cycle.';

-- ============================================================================
-- ROLLBACK — restores the 72h/96h windows exactly as 20260802 applied them
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
--   (checked_at > now() - interval '72 hours') AS is_fresh,
--   (checked_at > now() - interval '96 hours') AS within_grace
-- FROM public.product_availability_current;
--
-- COMMENT ON VIEW public.latest_product_availability IS
--   'Confirmed availability per SKU with freshness flags. 72h = fresh (the scan runs every 3 days), '
--   '96h = grace window absorbing scheduler delay.';
--
-- Rollback is a pure definition swap. No row is read or written in either direction.
-- ============================================================================
