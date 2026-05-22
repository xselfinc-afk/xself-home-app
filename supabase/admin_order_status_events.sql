-- Phase Admin 1.0B — Order status state machine + admin audit log.
--
-- One row is appended per order-status transition performed via the
-- admin-update-order-status Edge Function. Read-only for admin clients;
-- writes happen via the Edge Function only (it uses the service-role key,
-- which bypasses RLS, so no INSERT/UPDATE/DELETE policy is granted to
-- authenticated users here).
--
-- DEPENDS ON:
--   supabase/admin_order_dashboard.sql  (Phase 5.0 — admin_users + is_admin)
--
-- IDEMPOTENT: re-runnable in the Supabase SQL editor.
--
-- HOW TO APPLY
--   1. Open Supabase Studio → SQL Editor for this project.
--   2. Paste the entire contents of this file and click Run.
--
-- ROLLBACK
--   DROP POLICY IF EXISTS "admins_select_order_status_events" ON public.order_status_events;
--   DROP INDEX IF EXISTS public.order_status_events_admin_email_created_at_idx;
--   DROP INDEX IF EXISTS public.order_status_events_order_id_created_at_idx;
--   DROP TABLE IF EXISTS public.order_status_events;

-- NOTE on the order_id column type
-- ---------------------------------
-- `orders.order_id` in this project is a UUID-formatted **text** column (see
-- `admin_custom_payment_links.order_id text` from Phase 5.2 — same shape).
-- We therefore declare the FK-shaped column as `text` rather than `uuid` so
-- this migration applies cleanly against the existing schema. A real foreign
-- key with ON DELETE CASCADE would require both columns to be uuid; if the
-- `orders.order_id` type is migrated to uuid in a future phase, change this
-- column to `uuid REFERENCES public.orders(order_id) ON DELETE CASCADE` and
-- re-run this migration.

CREATE TABLE IF NOT EXISTS public.order_status_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     text        NOT NULL,
  order_number text,
  from_status  text,
  to_status    text        NOT NULL,
  reason       text,
  admin_email  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_status_events_order_id_created_at_idx
  ON public.order_status_events (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS order_status_events_admin_email_created_at_idx
  ON public.order_status_events (admin_email, created_at DESC);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.order_status_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_select_order_status_events" ON public.order_status_events;
CREATE POLICY "admins_select_order_status_events" ON public.order_status_events
  FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT ON public.order_status_events TO authenticated;
