-- ============================================================================
-- Open API availability persistence  (Phase 1 — evidence + audit only)
--
-- WHY A NEW TABLE RATHER THAN inventory_cache
-- -------------------------------------------
-- `inventory_cache` is warehouse-shaped: every row carries warehouse_code, quantity and
-- supports_pickup. The GIGA Open API returns a single boolean (`skuAvailable`) and NO warehouse,
-- quantity, or state data. Writing Open API results into inventory_cache would require inventing a
-- warehouse code and a quantity — fabricated evidence that would then flow into
-- refresh_product_inventory_status(), total_available_qty, and California pickup claims.
--
--   inventory_cache             → per-warehouse quantities, California detail, pickup eligibility
--   product_availability_checks → append-only audit of every API answer, including failures
--   product_availability_current→ ONE authoritative confirmed answer per SKU (idempotent upsert)
--   inventory_workflow_states   → lifecycle state + consecutive counters (ALREADY EXISTS, unchanged)
--
-- Lifecycle state is deliberately NOT duplicated here. `inventory_workflow_states` already stores
-- workflow_state, consecutive_out_of_stock, consecutive_in_stock, last_observation_key and version,
-- with UNIQUE(supplier_product_id). This migration adds only what does not yet exist.
--
-- ADDITIVE ONLY. No existing table, view, function, policy or row is altered. Nothing here can
-- change a publication field.
-- ============================================================================

-- ── 1. Append-only audit of EVERY API answer, successes and failures alike ───────────────────
CREATE TABLE IF NOT EXISTS public.product_availability_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_product_id text        NOT NULL,
  source              text        NOT NULL DEFAULT 'open_api',
  -- NULL is meaningful and common: every failure mode leaves availability unknown.
  available           boolean     NULL,
  status              text        NOT NULL,
  failure_reason      text        NULL,
  run_id              text        NOT NULL,
  checked_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pac_source_chk CHECK (source IN ('open_api', 'official_api')),
  CONSTRAINT pac_status_chk CHECK (status IN (
    'confirmed_available', 'confirmed_out_of_stock', 'api_failed', 'rate_limited',
    'network_failed', 'malformed_response', 'missing_sku', 'supplier_unavailable')),
  -- The invariant the whole feature rests on: `available` may be non-NULL ONLY when the supplier
  -- actually answered. No failure row can ever masquerade as a zero.
  CONSTRAINT pac_available_only_when_confirmed_chk CHECK (
    (status = 'confirmed_available'    AND available IS TRUE)  OR
    (status = 'confirmed_out_of_stock' AND available IS FALSE) OR
    (status NOT IN ('confirmed_available', 'confirmed_out_of_stock') AND available IS NULL)
  ),
  -- Idempotency: re-running the same run for the same SKU cannot duplicate audit rows.
  CONSTRAINT pac_run_sku_uniq UNIQUE (run_id, supplier_product_id)
);

CREATE INDEX IF NOT EXISTS pac_sku_checked_idx ON public.product_availability_checks (supplier_product_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS pac_status_idx      ON public.product_availability_checks (status) WHERE status <> 'confirmed_available';

COMMENT ON TABLE public.product_availability_checks IS
  'Append-only audit of every GIGA Open API availability answer, failures included. NOT warehouse '
  'stock: carries no quantity, warehouse or California data.';

-- ── 2. ONE authoritative CONFIRMED answer per SKU ────────────────────────────────────────────
-- `available` is NOT NULL and `status` admits only the two confirmed values. A failure therefore
-- CANNOT be written here at all — it is structurally impossible for an auth/network/parse error to
-- overwrite the last good answer with a zero. Failures update only the last_failure_* columns.
CREATE TABLE IF NOT EXISTS public.product_availability_current (
  supplier_product_id           text        PRIMARY KEY,
  source                        text        NOT NULL DEFAULT 'open_api',
  available                     boolean     NOT NULL,
  status                        text        NOT NULL,
  last_run_id                   text        NOT NULL,
  checked_at                    timestamptz NOT NULL,
  last_confirmed_available_at   timestamptz NULL,
  last_confirmed_unavailable_at timestamptz NULL,
  -- Failure telemetry, kept alongside without ever displacing the confirmed answer.
  consecutive_failures          integer     NOT NULL DEFAULT 0,
  last_failure_status           text        NULL,
  last_failure_reason           text        NULL,
  last_failure_at               timestamptz NULL,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pav_source_chk CHECK (source IN ('open_api', 'official_api')),
  CONSTRAINT pav_confirmed_only_chk CHECK (status IN ('confirmed_available', 'confirmed_out_of_stock')),
  CONSTRAINT pav_status_matches_available_chk CHECK (
    (status = 'confirmed_available' AND available IS TRUE) OR
    (status = 'confirmed_out_of_stock' AND available IS FALSE)
  ),
  CONSTRAINT pav_failures_nonneg_chk CHECK (consecutive_failures >= 0)
);

CREATE INDEX IF NOT EXISTS pav_checked_idx ON public.product_availability_current (checked_at DESC);
CREATE INDEX IF NOT EXISTS pav_unavailable_idx ON public.product_availability_current (supplier_product_id) WHERE available IS FALSE;

COMMENT ON TABLE public.product_availability_current IS
  'One authoritative CONFIRMED availability answer per SKU. Failures can never be stored here — '
  'available is NOT NULL and status admits only confirmed values — so a failed read cannot displace '
  'the last trustworthy answer. Lifecycle counters live in inventory_workflow_states.';

-- ── 3. Freshness view consumed later by the visibility migration ─────────────────────────────
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
  'Confirmed availability per SKU with freshness flags. 48h = fresh (the scan cadence), '
  '72h = grace window absorbing one missed cycle.';

-- ── 4. RLS: service-role only. The app never reads these directly. ───────────────────────────
ALTER TABLE public.product_availability_checks  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_availability_current ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pac_service_role_all ON public.product_availability_checks;
CREATE POLICY pac_service_role_all ON public.product_availability_checks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pav_service_role_all ON public.product_availability_current;
CREATE POLICY pav_service_role_all ON public.product_availability_current
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- ROLLBACK  (complete and lossless — nothing else references these objects)
-- ============================================================================
-- DROP VIEW  IF EXISTS public.latest_product_availability;
-- DROP TABLE IF EXISTS public.product_availability_current;  -- drops its indexes + policy
-- DROP TABLE IF EXISTS public.product_availability_checks;   -- drops its indexes + policy
--
-- No existing table, view, function, policy or row is modified by this migration, so rollback
-- restores the database to exactly its prior state.
-- ============================================================================
