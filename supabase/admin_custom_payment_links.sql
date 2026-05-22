-- Phase 5.2 — Admin-only custom Stripe Payment Links for negotiated pricing.
--
-- One row per Payment Link the admin generates from /admin/orders.html via
-- the `admin-create-payment-link` Edge Function. The Edge Function:
--   1. Verifies the calling user's JWT via Supabase Auth.
--   2. Confirms the user's email is in public.admin_users (Phase 5.0).
--   3. Calls the Stripe API with STRIPE_SECRET_KEY (server-side only) to
--      create a one-time Price + Payment Link.
--   4. Inserts a row here using the service-role key.
-- The browser never sees Stripe secret keys or the service-role key.
--
-- DEPENDS ON: supabase/admin_order_dashboard.sql (provides public.is_admin()
-- and the admin_users table). Apply that file first.
--
-- IDEMPOTENT: re-runnable in the Supabase SQL editor.
--
-- HOW TO APPLY
--   1. Open Supabase Studio → SQL Editor.
--   2. Paste this entire file and click Run.
--
-- ROLLBACK
--   DROP POLICY IF EXISTS "admins_select_payment_links" ON public.admin_custom_payment_links;
--   DROP TABLE IF EXISTS public.admin_custom_payment_links;

CREATE TABLE IF NOT EXISTS public.admin_custom_payment_links (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Optional linkage to an existing order (when the link was generated from a
  -- specific order detail page). Both fields are nullable for stand-alone
  -- negotiated quotes that don't yet correspond to an order row.
  order_id                    text,
  order_number                text,
  -- Customer contact at the time the link was created (snapshot).
  customer_email              text,
  customer_phone              text,
  -- Product context (optional — admin may sell a bespoke bundle).
  product_id                  text,
  supplier_sku                text,
  title                       text,
  -- Negotiated terms.
  quantity                    integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  negotiated_unit_price_cents integer NOT NULL CHECK (negotiated_unit_price_cents > 0),
  negotiated_total_cents      integer NOT NULL CHECK (negotiated_total_cents > 0),
  currency                    text NOT NULL DEFAULT 'usd',
  -- Stripe artifacts.
  stripe_payment_link_id      text,
  stripe_price_id             text,
  stripe_product_id           text,
  stripe_url                  text NOT NULL,
  -- Lifecycle. Only 'created' for now; later phases may add 'paid' / 'expired'.
  status                      text NOT NULL DEFAULT 'created'
                              CHECK (status IN ('created','paid','expired','cancelled')),
  created_by_email            text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_custom_payment_links_order_id_idx
  ON public.admin_custom_payment_links (order_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS admin_custom_payment_links_created_at_idx
  ON public.admin_custom_payment_links (created_at DESC);
CREATE INDEX IF NOT EXISTS admin_custom_payment_links_payment_link_id_idx
  ON public.admin_custom_payment_links (stripe_payment_link_id)
  WHERE stripe_payment_link_id IS NOT NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────────
-- Admins can SELECT (so the dashboard can show prior links per order).
-- No INSERT/UPDATE/DELETE policy for any user role — only the service-role
-- key (used by the Edge Function) bypasses RLS, so writes are server-only.

ALTER TABLE public.admin_custom_payment_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_select_payment_links" ON public.admin_custom_payment_links;
CREATE POLICY "admins_select_payment_links" ON public.admin_custom_payment_links
  FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT ON public.admin_custom_payment_links TO authenticated;
