-- Phase 5.0 — Read-only MVP Admin Order Dashboard.
--
-- Adds an admin whitelist, two read-only views, and minimal RLS allowances
-- so designated users can see all orders / order_items / inventory_reservations
-- via the /admin/orders.html static page. No write actions. Service-role key
-- is never exposed to the client; the page authenticates as a real user and
-- the views enforce access via the admin_users allowlist + RLS.
--
-- IDEMPOTENT: re-runnable in the Supabase SQL editor.
--
-- HOW TO APPLY
--   1. Open Supabase Studio → SQL Editor for this project.
--   2. Paste the entire contents of this file and click Run.
--   3. Add yourself to the admin whitelist:
--        INSERT INTO public.admin_users (email)
--        VALUES ('xselfinc@gmail.com')
--        ON CONFLICT (email) DO NOTHING;
--   4. Make sure you have signed into Supabase Auth with that email at
--      least once (a row must exist in auth.users for that address).
--   5. Open /admin/orders.html, paste the project URL + ANON key into the
--      setup form, sign in, and verify the orders list renders.
--
-- ROLLBACK (paste into SQL editor):
--   DROP VIEW IF EXISTS public.admin_order_detail;
--   DROP VIEW IF EXISTS public.admin_orders_summary;
--   DROP POLICY IF EXISTS "admins_select_all_inventory_reservations" ON public.inventory_reservations;
--   DROP POLICY IF EXISTS "admins_select_all_order_items"            ON public.order_items;
--   DROP POLICY IF EXISTS "admins_select_all_orders"                 ON public.orders;
--   DROP FUNCTION IF EXISTS public.is_admin();
--   DROP POLICY IF EXISTS "admin_users_read_self" ON public.admin_users;
--   DROP TABLE IF EXISTS public.admin_users;

-- ── admin_users whitelist ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Each admin can see only their own row (used by the page to confirm
-- whitelist membership). The service-role key writes new admin rows
-- and bypasses RLS as usual.
DROP POLICY IF EXISTS "admin_users_read_self" ON public.admin_users;
CREATE POLICY "admin_users_read_self" ON public.admin_users
  FOR SELECT TO authenticated
  USING (lower(email) = lower(auth.jwt() ->> 'email'));

-- ── is_admin() helper ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so the function can read admin_users regardless of
-- the caller's row-level access. Email comparison is case-insensitive.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ── RLS: admins may SELECT all order data ────────────────────────────────────
-- These policies coexist with the existing per-user policies
-- (users_select_own_orders, etc.). Non-admin users continue to see only
-- their own rows. Admins see everything.

DROP POLICY IF EXISTS "admins_select_all_orders" ON public.orders;
CREATE POLICY "admins_select_all_orders" ON public.orders
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "admins_select_all_order_items" ON public.order_items;
CREATE POLICY "admins_select_all_order_items" ON public.order_items
  FOR SELECT TO authenticated
  USING (public.is_admin());

DROP POLICY IF EXISTS "admins_select_all_inventory_reservations" ON public.inventory_reservations;
CREATE POLICY "admins_select_all_inventory_reservations" ON public.inventory_reservations
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ── Read-only views ──────────────────────────────────────────────────────────
-- `security_invoker = true` means the view runs with the calling user's
-- permissions. Combined with the admin RLS policies above:
--   • Non-admins: zero rows (the underlying RLS blocks them).
--   • Admins:     full visibility.
-- No service-role key is ever needed by the client.

CREATE OR REPLACE VIEW public.admin_orders_summary
  WITH (security_invoker = true) AS
SELECT
  o.id,
  o.order_id,
  o.order_number,
  o.status,
  o.payment_status,
  COALESCE(o.payment_intent_id, o.stripe_payment_intent_id) AS payment_intent_id,
  o.fulfillment_method,
  COALESCE(o.customer_email, o.guest_email) AS contact_email,
  o.customer_phone,
  o.total,
  o.subtotal,
  o.shipping_total,
  o.tax,
  o.total_cents,
  o.subtotal_cents,
  o.shipping_cents,
  o.tax_cents,
  o.date,
  o.created_at,
  o.updated_at,
  o.user_id,
  (SELECT count(*)::int FROM public.order_items
     WHERE order_id = o.order_id) AS line_count,
  (SELECT count(*)::int FROM public.inventory_reservations
     WHERE order_id = o.order_id AND status = 'reserved') AS active_reservations
FROM public.orders o;

CREATE OR REPLACE VIEW public.admin_order_detail
  WITH (security_invoker = true) AS
SELECT
  o.id,
  o.order_id,
  o.order_number,
  o.status,
  o.payment_status,
  COALESCE(o.payment_intent_id, o.stripe_payment_intent_id) AS payment_intent_id,
  o.stripe_payment_intent_id,
  o.stripe_customer_id,
  o.fulfillment_method,
  o.fulfillment_plan,
  o.fulfillment_groups_json,
  COALESCE(o.customer_email, o.guest_email) AS contact_email,
  o.customer_phone,
  o.user_id,
  o.guest_email,
  o.guest_token,
  o.total,
  o.subtotal,
  o.shipping_total,
  o.tax,
  o.total_cents,
  o.subtotal_cents,
  o.shipping_cents,
  o.tax_cents,
  o.date,
  o.address_json,
  o.items_json,
  o.checkout_session_id,
  o.created_at,
  o.updated_at,
  (SELECT jsonb_agg(oi ORDER BY oi.created_at)
     FROM public.order_items oi
     WHERE oi.order_id = o.order_id) AS items,
  (SELECT jsonb_agg(ir ORDER BY ir.warehouse_code)
     FROM public.inventory_reservations ir
     WHERE ir.order_id = o.order_id) AS reservations
FROM public.orders o;

GRANT SELECT ON public.admin_orders_summary, public.admin_order_detail TO authenticated;
