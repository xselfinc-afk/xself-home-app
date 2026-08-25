-- 20260825_pickup_reservation_sweep.sql
--
-- Pickup reservation lifecycle (Phase 1, item J wiring). Additive / reversible / fail-safe.
--
-- Fixed policy:
--   * A pickup_hold reservation is NOT released by the 10-min payment sweep (that sweep only
--     touches reservation_policy='payment_10min' — Delivery is completely untouched here).
--   * When a supplier order is created, the supplier order owns the inventory fact → release
--     the pickup_hold reservation immediately (trigger).
--   * If no supplier order appears within 24h (pickup_release_deadline), the hold lapses →
--     released by release_due_pickup_reservations() (callable; NOT scheduled this phase).

BEGIN;

-- ── 1. Release pickup_hold reservations when a supplier order is recorded ────────
CREATE OR REPLACE FUNCTION public.release_pickup_reservation_on_supplier_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.inventory_reservations
     SET status = 'released', updated_at = now()
   WHERE order_id = NEW.order_id
     AND reservation_policy = 'pickup_hold'   -- 🔒 never touches Delivery's payment_10min rows
     AND status = 'reserved';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_release_pickup_reservation ON public.supplier_orders;
CREATE TRIGGER trg_release_pickup_reservation
  AFTER INSERT ON public.supplier_orders
  FOR EACH ROW EXECUTE FUNCTION public.release_pickup_reservation_on_supplier_order();

-- ── 2. 24h sweep: release pickup_hold reservations past deadline with no supplier order ──
-- Callable (e.g. by a future shared scheduler in Phase 2). NOT scheduled here. Returns the
-- number of reservations released. Delivery reservations are never considered.
CREATE OR REPLACE FUNCTION public.release_due_pickup_reservations()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE released_count integer;
BEGIN
  WITH due AS (
    UPDATE public.inventory_reservations r
       SET status = 'released', updated_at = now()
     WHERE r.reservation_policy = 'pickup_hold'
       AND r.status = 'reserved'
       AND r.pickup_release_deadline IS NOT NULL
       AND r.pickup_release_deadline <= now()
       AND NOT EXISTS (
         SELECT 1 FROM public.supplier_orders s WHERE s.order_id = r.order_id
       )
    RETURNING 1
  )
  SELECT count(*) INTO released_count FROM due;
  RETURN released_count;
END;
$$;

COMMENT ON FUNCTION public.release_due_pickup_reservations() IS
  'Releases pickup_hold reservations past their 24h deadline that never got a supplier order. '
  'Callable; NOT scheduled in Phase 1. Never touches Delivery (payment_10min) reservations.';

COMMIT;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_release_pickup_reservation ON public.supplier_orders;
-- DROP FUNCTION IF EXISTS public.release_pickup_reservation_on_supplier_order();
-- DROP FUNCTION IF EXISTS public.release_due_pickup_reservations();
-- COMMIT;
