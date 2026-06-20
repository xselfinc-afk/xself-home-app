-- ============================================================================
-- GIGA Delivery Fee Cache — Step 1 DB foundation
-- ============================================================================
-- Additive only. Idempotent. Safe to re-run.
--
-- WHY:
--   Official GIGA OpenAPI product/price/v1 is currently blocked by B20003 for
--   Buyer 82482447. As an interim source, a backend/admin refresh job reads the
--   GIGA portal internal price endpoint and stores the Drop Shipping Fulfillment
--   Fee here. Customer checkout will later read ONLY this cached, server-side fee.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   * Does NOT call GIGA in any way.
--   * Does NOT modify plan-fulfillment, create-checkout-order, CheckoutScreen,
--     orders, inventory_cache, Stripe, or any customer-facing client UI.
--   * Does NOT add any checkout-blocking expiration. Cached fees DO NOT hard
--     expire. Age/staleness is admin-only and never gates a customer.
--
-- WHAT IT DOES:
--   * Creates public.giga_delivery_fee_cache, keyed by supplier_product_id (SKU).
--   * Stores BOTH fulfillment_fee_cents (raw GIGA fee = packing + shipping) and
--     charged_fee_cents (customer-facing fee after 8% buffer, rounded up to $).
--   * Records admin-only refresh diagnostics (timestamps / error / failure count)
--     that NEVER affect checkout. A row is "usable at checkout" iff
--     charged_fee_cents IS NOT NULL — regardless of how old it is.
--   * Service-role-only RLS — the customer app client must never read this table;
--     the fee stays server-authoritative (read by plan-fulfillment in a later step).
-- ============================================================================

-- ── 1. Table ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.giga_delivery_fee_cache (
  supplier_product_id   text PRIMARY KEY,                       -- app SKU, e.g. W3204P484603
  giga_product_id       text,                                   -- resolved numeric portal id, e.g. 1420191
  packing_fee_cents     integer,                                -- from drop_ship.package_fee_show
  shipping_fee_cents    integer,                                -- from drop_ship.shipping_fee_show
  fulfillment_fee_cents integer,                                -- round(drop_ship.total_amount*100) — raw GIGA Fulfillment Fee
  charged_fee_cents     integer,                                -- fulfillment + 8% buffer, round up to $ — customer display + Stripe charge
  currency              text    NOT NULL DEFAULT 'USD',
  source                text    NOT NULL DEFAULT 'giga_portal_price_list',
  -- ── admin-only diagnostics (NONE of these gate checkout) ──
  fetched_at            timestamptz,                            -- when the fee value was last written
  last_success_at       timestamptz,                            -- last successful refresh for this SKU
  last_attempt_at       timestamptz,                            -- last refresh attempt (success or failure)
  last_error_at         timestamptz,                            -- null when the last attempt succeeded
  last_error_code       text,                                   -- aliyun_captcha|session_expired|sku_not_found|no_drop_ship|parse_error|currency_mismatch|http_error|fee_mismatch
  last_error_msg        text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  is_stale_admin_flag   boolean NOT NULL DEFAULT false,         -- ADMIN DISPLAY ONLY — never read by checkout
  raw_hash              text,                                   -- sha256 of the parsed drop_ship snapshot (drift / no-op detection)
  raw_snapshot          jsonb,                                  -- fee-safe subset only (no URLs/cookies/tokens/images)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.giga_delivery_fee_cache IS
  'Interim cached GIGA Drop Shipping Fulfillment Fee per SKU (portal source, B20003 workaround). Service-role only. Cached fees DO NOT hard expire — age is admin-only and never blocks checkout. charged_fee_cents (8% buffer, rounded up) is the customer display + Stripe charge basis.';
COMMENT ON COLUMN public.giga_delivery_fee_cache.fulfillment_fee_cents IS
  'Raw GIGA Drop Shipping Fulfillment Fee = packing + shipping, from drop_ship.total_amount * 100.';
COMMENT ON COLUMN public.giga_delivery_fee_cache.charged_fee_cents IS
  'Customer-facing Delivery fee = ceil((fulfillment_fee_cents*1.08)/100)*100. Display and Stripe charge MUST use this, not fulfillment_fee_cents.';
COMMENT ON COLUMN public.giga_delivery_fee_cache.is_stale_admin_flag IS
  'Admin display only. NEVER read by plan-fulfillment / create-checkout-order. A non-null charged_fee_cents is always usable at checkout regardless of age.';

-- ── 2. CHECK constraints ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giga_delivery_fee_cache_failures_check') THEN
    ALTER TABLE public.giga_delivery_fee_cache
      ADD CONSTRAINT giga_delivery_fee_cache_failures_check CHECK (consecutive_failures >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'giga_delivery_fee_cache_cents_check') THEN
    ALTER TABLE public.giga_delivery_fee_cache
      ADD CONSTRAINT giga_delivery_fee_cache_cents_check CHECK (
        (packing_fee_cents     IS NULL OR packing_fee_cents     >= 0) AND
        (shipping_fee_cents    IS NULL OR shipping_fee_cents    >= 0) AND
        (fulfillment_fee_cents IS NULL OR fulfillment_fee_cents >= 0) AND
        (charged_fee_cents     IS NULL OR charged_fee_cents     >= 0)
      );
  END IF;
END $$;

-- ── 3. Indexes ────────────────────────────────────────────────────────────────
-- Partial: checkout-usable rows are exactly those with a stored charged fee.
CREATE INDEX IF NOT EXISTS idx_gdfc_has_charged_fee
  ON public.giga_delivery_fee_cache (supplier_product_id)
  WHERE charged_fee_cents IS NOT NULL;

-- Admin queues: failing refreshes and oldest-success first.
CREATE INDEX IF NOT EXISTS idx_gdfc_failures
  ON public.giga_delivery_fee_cache (consecutive_failures)
  WHERE consecutive_failures > 0;

CREATE INDEX IF NOT EXISTS idx_gdfc_last_success
  ON public.giga_delivery_fee_cache (last_success_at);

-- ── 4. updated_at trigger ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.giga_delivery_fee_cache_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_gdfc_touch_updated_at ON public.giga_delivery_fee_cache;
CREATE TRIGGER trg_gdfc_touch_updated_at
  BEFORE UPDATE ON public.giga_delivery_fee_cache
  FOR EACH ROW EXECUTE FUNCTION public.giga_delivery_fee_cache_touch_updated_at();

-- ── 5. RLS — service role only ────────────────────────────────────────────────
ALTER TABLE public.giga_delivery_fee_cache ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'giga_delivery_fee_cache'
       AND policyname = 'service_role_all_giga_delivery_fee_cache'
  ) THEN
    CREATE POLICY service_role_all_giga_delivery_fee_cache
      ON public.giga_delivery_fee_cache
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Note: deliberately NO policy for anon / authenticated — the customer app client
-- cannot read this table at all (RLS enabled + no permissive policy = default deny).
-- plan-fulfillment will read it server-side via the service role in a later step.

-- ============================================================================
-- ROLLBACK (operator-run, NOT auto-executed)
-- ============================================================================
-- DROP POLICY IF EXISTS service_role_all_giga_delivery_fee_cache ON public.giga_delivery_fee_cache;
-- DROP TRIGGER IF EXISTS trg_gdfc_touch_updated_at ON public.giga_delivery_fee_cache;
-- DROP FUNCTION IF EXISTS public.giga_delivery_fee_cache_touch_updated_at();
-- DROP INDEX IF EXISTS public.idx_gdfc_last_success;
-- DROP INDEX IF EXISTS public.idx_gdfc_failures;
-- DROP INDEX IF EXISTS public.idx_gdfc_has_charged_fee;
-- DROP TABLE IF EXISTS public.giga_delivery_fee_cache;
