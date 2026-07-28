-- Enable customer PICKUP at the 18 approved, currently-active out-of-state GIGA warehouses
-- (GA / MD / NJ / TX). Under the dual-radius rule these become pickup-eligible within 50 miles
-- of the buyer (CA warehouses stay 100 miles and are NOT touched here).
--
-- Explicit allowlist only. Idempotent + asserted: updates EXACTLY the 18 allowlisted active
-- out-of-state rows that are currently supports_pickup=false, or raises and aborts the
-- transaction (no partial change). Leaves CA, inactive, unknown, and future warehouses unchanged.
--
-- Applied 2026-07-28 in the dual-radius rollout AFTER the dual-radius plan-fulfillment was
-- deployed and verified CA-equivalent (deploy-before-data). In-session it was applied via an
-- equivalent scoped PostgREST UPDATE (no psql / interactive DB password available); this file is
-- the canonical, replayable source of truth and matches that change exactly.

DO $$
DECLARE affected int;
BEGIN
  UPDATE public.warehouses
     SET supports_pickup = true
   WHERE active = true
     AND state <> 'CA'
     AND supports_pickup = false
     AND code IN ('AT1','AT2','AT3','AT4','AT5','ATN1','ATX4','ATX6',
                  'NJX3','NJ1','NJ2','NJ3','NJ4','NJ5','NJX6',
                  'TX1','TXX1','TXX2');
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 18 THEN
    RAISE EXCEPTION 'OOS pickup allowlist: expected 18 rows, updated % — aborting (allowlist/data drift)', affected;
  END IF;
END $$;

-- ── ROLLBACK (run manually to revert; CA untouched) ──────────────────────────────────────────
-- UPDATE public.warehouses SET supports_pickup = false
--  WHERE state <> 'CA'
--    AND code IN ('AT1','AT2','AT3','AT4','AT5','ATN1','ATX4','ATX6',
--                 'NJX3','NJ1','NJ2','NJ3','NJ4','NJ5','NJX6',
--                 'TX1','TXX1','TXX2');
