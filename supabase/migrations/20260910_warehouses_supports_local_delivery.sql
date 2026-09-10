-- Local Delivery (XSELF-operated, free) — warehouse capability flag.
--
-- Adds `supports_local_delivery` alongside the existing `supports_pickup` /
-- `supports_shipping` booleans. It is an explicit, per-warehouse capability so
-- that a future warehouse (any state) is NOT silently pulled into XSELF's own
-- delivery footprint just because it allows pickup.
--
-- Allowlist: the 18 active CA warehouses (all pre-geocoded; verified 2026-09-10
-- via warehouses table: 18 CA rows, 18 active, 18 with lat/lng). Same
-- assert-exact-count pattern as 20260728_enable_oos_pickup_allowlist.sql so a
-- data drift aborts the transaction instead of half-applying.
--
-- Radius is NOT stored here. The Local Delivery radius lives in
-- supabase/functions/_shared/fulfillmentEligibility.ts (LOCAL_DELIVERY_RADIUS_MILES)
-- and is independent of the locked pickup radius (CA 100 / OOS 50).
--
-- Reversible: see ROLLBACK at the bottom.

ALTER TABLE public.warehouses
  ADD COLUMN IF NOT EXISTS supports_local_delivery boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.warehouses.supports_local_delivery IS
  'XSELF-operated Local Delivery (free) may originate from this warehouse. Independent of supports_pickup / supports_shipping. Radius is enforced in plan-fulfillment (LOCAL_DELIVERY_RADIUS_MILES), never here.';

DO $$
DECLARE affected int;
BEGIN
  UPDATE public.warehouses
     SET supports_local_delivery = true
   WHERE active = true
     AND state = 'CA'
     AND supports_local_delivery = false
     AND code IN ('CA2','CA3','CA4','CA5','CA6','CA7','CA8','CA9','CA10','CA11',
                  'CAL1','CAN1','CAN2','CAN3','CAX1','CAX2','CAX3','CAX8');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 18 THEN
    RAISE EXCEPTION 'Local Delivery CA allowlist: expected 18 rows, updated % — aborting (allowlist/data drift)', affected;
  END IF;
END $$;

-- ── ROLLBACK (run manually to revert) ────────────────────────────────────────────
-- UPDATE public.warehouses SET supports_local_delivery = false WHERE state = 'CA';
-- ALTER TABLE public.warehouses DROP COLUMN IF EXISTS supports_local_delivery;
