-- ============================================================
-- Phase 1: Inventory Source of Truth Migration
-- ============================================================
-- Run once in the Supabase SQL Editor (project already linked).
-- All statements use IF NOT EXISTS / OR REPLACE — safe to re-run.
--
-- IMPORTANT: Do NOT apply the RLS policy change (Section 6) until
-- the Playwright scraper has been run and at least one product has
-- real website_scrape inventory data AND has_valid_inventory = true.
-- Applying Section 6 before the scraper runs will hide all products.
-- ============================================================

-- ── 1. Add inventory columns to standardized_products ─────────────────────────
-- The app never writes these columns.
-- They are set only by refresh_product_inventory_status() and sweep_stale_inventory().

ALTER TABLE public.standardized_products
  ADD COLUMN IF NOT EXISTS published                 boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inventory_status          text         NOT NULL DEFAULT 'unknown',
  -- 'in_stock' | 'out_of_stock' | 'stale' | 'unknown'
  ADD COLUMN IF NOT EXISTS total_available_qty       integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_warehouse_count integer      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS has_ca_pickup             boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_valid_inventory       boolean      NOT NULL DEFAULT false,
  -- has_valid_inventory = true only when source_type='website_scrape', fresh, qty > 0
  ADD COLUMN IF NOT EXISTS inventory_last_synced_at  timestamptz  NULL;

-- ── 2. Supporting indexes ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_standardized_inventory_status
  ON public.standardized_products (inventory_status);

CREATE INDEX IF NOT EXISTS idx_standardized_published
  ON public.standardized_products (published)
  WHERE published = true;

CREATE INDEX IF NOT EXISTS idx_standardized_last_synced
  ON public.standardized_products (inventory_last_synced_at DESC)
  WHERE inventory_last_synced_at IS NOT NULL;

-- ── 3. warehouses table ───────────────────────────────────────────────────────
-- Replaces src/data/warehouses.ts (app bundle).
-- lat/lng are populated separately by a geocoding script (run once).
-- The plan-fulfillment edge function reads pre-geocoded lat/lng — no
-- Google Maps calls at checkout request time.

CREATE TABLE IF NOT EXISTS public.warehouses (
  code              text PRIMARY KEY,
  label             text NOT NULL,
  address           text NOT NULL,
  state             text NOT NULL,         -- 'CA' | 'NJ' | 'MD' | 'GA' | 'TX'
  city              text,
  lat               numeric(9,6),          -- pre-geocoded; NULL until geocoding script runs
  lng               numeric(9,6),
  supports_pickup   boolean NOT NULL DEFAULT false,
  supports_shipping boolean NOT NULL DEFAULT true,
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.warehouses TO anon, authenticated;

-- Populate from src/data/warehouses.ts (34 entries)
-- supports_pickup = true for all CA-prefixed codes (matches existing /^CA/i gate)
INSERT INTO public.warehouses (code, label, address, state, city, supports_pickup) VALUES
  ('CA2',  'City of Industry Warehouse',        '108-118 Brea Canyon Road, City of Industry, CA 91789, United States',             'CA', 'City of Industry',  true),
  ('CA3',  'Fontana Warehouse',                 '10850 Business Dr, Fontana, CA 92337, United States',                             'CA', 'Fontana',           true),
  ('CA4',  'Rancho Cucamonga Warehouse',        '11599 Arrow Route, Rancho Cucamonga, CA 91730, United States',                    'CA', 'Rancho Cucamonga',  true),
  ('CA5',  'Ontario Warehouse',                 '1670 Etiwanda Ave #A, Ontario, CA 91761, United States',                          'CA', 'Ontario',           true),
  ('CA6',  'Rancho Cucamonga Warehouse (2)',    '8595 Milliken Ave Unit B-101, Rancho Cucamonga, CA 91730, United States',          'CA', 'Rancho Cucamonga',  true),
  ('CA7',  'Fontana Warehouse (2)',             '13521 Santa Ana Ave, Fontana, CA 92337, United States',                            'CA', 'Fontana',           true),
  ('CA8',  'Fontana Warehouse (3)',             '10721 Jasmine Street, Fontana, CA 92337-8200, United States',                      'CA', 'Fontana',           true),
  ('CA9',  'Ontario Warehouse (2)',             '800 N. Barrington Avenue, Ontario, CA 91764, United States',                       'CA', 'Ontario',           true),
  ('CA10', 'Ontario Warehouse (3)',             '5140 E Santa Ana St, Ontario, CA 91761, United States',                            'CA', 'Ontario',           true),
  ('CA11', 'Ontario Warehouse (4)',             '3510 E Francis St., Ontario, CA 91761, United States',                             'CA', 'Ontario',           true),
  ('CAN1', 'El Monte Warehouse',               '4388 Shirle Avenue, El Monte, CA 91731, United States',                            'CA', 'El Monte',          true),
  ('CAX1', 'Rancho Cucamonga Warehouse (3)',    '8345 White Oak Ave, Rancho Cucamonga, CA 91730, United States',                    'CA', 'Rancho Cucamonga',  true),
  ('CAN2', 'Ontario Warehouse (5)',             '3655 E. Philadelphia Street, Ontario, CA 91761, United States',                    'CA', 'Ontario',           true),
  ('CAN3', 'Compton Warehouse',                '1714 S. Anderson Ave, Compton, CA 90220, United States',                           'CA', 'Compton',           true),
  ('CAX2', 'Rancho Cucamonga Warehouse (4)',    '9189 Utica Ave, Cucamonga, CA 91730, United States',                               'CA', 'Rancho Cucamonga',  true),
  ('CAX8', 'Carson Warehouse',                 '970 E 236th St, Carson, CA 90745, United States',                                  'CA', 'Carson',            true),
  ('CAX3', 'Rancho Cucamonga Warehouse (5)',    '8291 Milliken Avenue, Rancho Cucamonga, CA 91730, United States',                  'CA', 'Rancho Cucamonga',  true),
  ('CAL1', 'La Puente Warehouse',              '515 S 6th Ave, La Puente, CA 91746, United States',                                'CA', 'La Puente',         true),
  ('NJ1',  'Cranbury Warehouse',               '114 Melrich Rd, Suite A, B, C, Cranbury, NJ 08512, United States',                  'NJ', 'Cranbury',          false),
  ('NJ2',  'Dayton Warehouse',                 '121 Herrod Blvd. Suite 1, Dayton, NJ 08810, United States',                        'NJ', 'Dayton',            false),
  ('NJ3',  'Dayton Warehouse (2)',              '1165 Cranbury South River Rd, Dayton, NJ 08810, United States',                    'NJ', 'Dayton',            false),
  ('NJ4',  'Cranbury Warehouse (2)',            '311 Cranbury Half Acre Rd, Cranbury, NJ 08512, United States',                     'NJ', 'Cranbury',          false),
  ('NJX3', 'Elkton Warehouse',                 '1003B Kanica Dr, Elkton, MD 21921, United States',                                 'MD', 'Elkton',            false),
  ('AT1',  'Lithia Springs Warehouse',         '850 Douglas Hills Rd, Lithia Springs, GA 30122, United States',                    'GA', 'Lithia Springs',    false),
  ('AT2',  'Lithia Springs Warehouse (2)',      '965 Douglas Hills Rd, Lithia Springs, GA 30122, United States',                    'GA', 'Lithia Springs',    false),
  ('AT3',  'Braselton Warehouse',              '1380 Jesse Cronic Road, Braselton, GA 30517, United States',                       'GA', 'Braselton',         false),
  ('AT4',  'Savannah Warehouse',               '133 Coleman Blvd. Suite 200, Savannah, GA 31408, United States',                   'GA', 'Savannah',          false),
  ('AT5',  'Bloomingdale Warehouse',           '301 Jimmy Deloach Parkway, Bloomingdale, GA 31302, United States',                 'GA', 'Bloomingdale',      false),
  ('ATX4', 'Commerce Warehouse',               '100 Pottery Road, Commerce, GA 30529, United States',                              'GA', 'Commerce',          false),
  ('ATX6', 'Buford Warehouse',                 '4651 Distribution Parkway, Buford, GA 30519, United States',                       'GA', 'Buford',            false),
  ('ATN1', 'Savannah Warehouse (2)',            '425 Jimmy Deloach Parkway, Savannah, GA 31407, United States',                     'GA', 'Savannah',          false),
  ('TX1',  'Grand Prairie Warehouse',          '1113 West Oakdale Road, Grand Prairie, TX 75050, United States',                   'TX', 'Grand Prairie',     false),
  ('TXX1', 'Houston Warehouse',                '2425 Broad St, Houston, TX 77087, United States',                                  'TX', 'Houston',           false),
  ('TXX2', 'Pearland Warehouse',               '3702 Knapp Rd, Pearland, TX 77581, United States',                                 'TX', 'Pearland',          false)
ON CONFLICT (code) DO NOTHING;

-- ── 4. refresh_product_inventory_status(p_supplier_product_id) ────────────────
-- Called by the Playwright scraper after writing inventory_cache rows.
-- ONLY reads source_type = 'website_scrape' — never uses price_synthesis data.
-- Uses ic.product_id (indexed) for the lookup; standardized_products uses the
-- same value in its supplier_product_id column.

CREATE OR REPLACE FUNCTION public.refresh_product_inventory_status(p_supplier_product_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total_qty    integer;
  v_wh_count     integer;
  v_has_ca       boolean;
  v_last_synced  timestamptz;
  v_status       text;
BEGIN
  SELECT
    COALESCE(SUM(GREATEST(ic.quantity, 0)), 0),
    COUNT(*) FILTER (WHERE ic.quantity > 0),
    bool_or(ic.warehouse_state = 'CA' AND ic.quantity > 0 AND ic.supports_pickup),
    MAX(ic.last_synced_at)
  INTO v_total_qty, v_wh_count, v_has_ca, v_last_synced
  FROM public.inventory_cache ic
  WHERE ic.product_id  = p_supplier_product_id   -- product_id column has the index
    AND ic.source_type = 'website_scrape'
    AND ic.sync_status = 'ok';

  -- Determine status
  IF v_last_synced IS NULL THEN
    v_status := 'unknown';       -- no website_scrape rows exist for this product
  ELSIF v_last_synced < now() - interval '24 hours' THEN
    v_status := 'stale';         -- data exists but is too old
  ELSIF v_total_qty = 0 THEN
    v_status := 'out_of_stock';  -- fresh data, all warehouses have qty = 0
  ELSE
    v_status := 'in_stock';      -- fresh data, at least one warehouse has qty > 0
  END IF;

  UPDATE public.standardized_products SET
    inventory_status          = v_status,
    total_available_qty       = v_total_qty,
    available_warehouse_count = v_wh_count,
    has_ca_pickup             = COALESCE(v_has_ca, false),
    has_valid_inventory       = (v_status = 'in_stock'),
    published                 = (v_status = 'in_stock'),
    inventory_last_synced_at  = v_last_synced,
    updated_at                = now()
  WHERE supplier_product_id   = p_supplier_product_id;
END;
$$;

-- ── 4b. refresh_all_inventory_status() ────────────────────────────────────────
-- Bulk variant: iterates every product that has at least one website_scrape row.
-- Used for manual backfills and recovery after scraper runs.
-- Returns: count of products updated.

CREATE OR REPLACE FUNCTION public.refresh_all_inventory_status()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer := 0;
  v_row   record;
BEGIN
  FOR v_row IN
    SELECT DISTINCT product_id
    FROM public.inventory_cache
    WHERE source_type = 'website_scrape'
  LOOP
    PERFORM public.refresh_product_inventory_status(v_row.product_id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- ── 4c. sweep_stale_inventory() ───────────────────────────────────────────────
-- Marks products as stale when their last scrape age exceeds 24 hours.
-- Called hourly by pg_cron. Does NOT delete any data.
-- Returns: count of products flipped to stale.

CREATE OR REPLACE FUNCTION public.sweep_stale_inventory()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count integer;
BEGIN
  WITH updated AS (
    UPDATE public.standardized_products
    SET
      inventory_status    = 'stale',
      has_valid_inventory = false,
      -- published is intentionally NOT set to false here.
      -- Products stay visible even when inventory is stale.
      -- Checkout enforces its own 24h freshness gate via validate-checkout-inventory.
      updated_at          = now()
    WHERE inventory_status        = 'in_stock'
      AND inventory_last_synced_at < now() - interval '7 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM updated;
  RETURN v_count;
END;
$$;

-- ── 5. sellable_products view ─────────────────────────────────────────────────
-- Resilient filter: normalized + published (in_stock) + data-quality guards.
-- Hard freshness gate removed (2026-05-04): a single missed sync no longer
-- blanks the app. Core visibility is still governed by published + in_stock,
-- which are materialized by refresh_product_inventory_status() and
-- sweep_stale_inventory(). inventory_freshness is a soft computed column for
-- UI badges and monitoring use — it is NOT a visibility gate.

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
  AND sp.price                > 0;

GRANT SELECT ON public.sellable_products TO anon, authenticated;

-- ── 6. RLS policy update ──────────────────────────────────────────────────────
-- !! WARNING: APPLY THIS SECTION ONLY AFTER the scraper has run and
-- !! at least one product has inventory_status = 'in_stock'.
-- !! Applying this before the scraper runs will hide ALL products from the app.
--
-- When ready, run these two statements:
--
--   DROP POLICY IF EXISTS "Public can read normalized products" ON public.standardized_products;
--
--   CREATE POLICY "Public can read sellable products"
--     ON public.standardized_products FOR SELECT
--     USING (
--       normalization_status = 'done'
--       AND published = true
--       AND inventory_status = 'in_stock'
--       AND total_available_qty > 0
--       AND inventory_last_synced_at IS NOT NULL
--       AND inventory_last_synced_at > now() - interval '24 hours'
--     );

-- ── 7. pg_cron: hourly staleness sweep ────────────────────────────────────────
-- Requires pg_cron extension. Enable in: Dashboard → Database → Extensions → pg_cron.
-- Run this block only after enabling pg_cron:
--
--   SELECT cron.schedule(
--     'sweep-stale-inventory',
--     '0 * * * *',
--     $$ SELECT public.sweep_stale_inventory(); $$
--   );
