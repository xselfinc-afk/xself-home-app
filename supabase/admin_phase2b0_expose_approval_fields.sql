-- ============================================================================
-- Phase 2b.0 — Expose admin approval + supplier sync fields to the dashboard
-- ============================================================================
-- DATA-LAYER ONLY. NO UI CHANGE. NO EDGE FUNCTION CHANGE.
--
-- WHAT THIS PATCH DOES
--   1. Extends public.admin_orders_summary to include the 12 columns added in
--      supabase/migrations/20260604_admin_approval_supplier_sync.sql.
--   2. Extends public.admin_order_detail with the same 12 columns plus the
--      raw supplier_sync_response_json for forensic inspection.
--   3. Grants authenticated admins SELECT-only access to
--      public.supplier_purchase_log (the audit log written by
--      admin-approve-order and the future admin-submit-approved-order).
--
-- WHAT THIS PATCH DOES NOT DO
--   * Does NOT modify admin/orders.html (UI change deferred to Phase 2b.2).
--   * Does NOT modify the admin-approve-order edge function or its auth
--     model (deferred to Phase 2b.1).
--   * Does NOT call GIGA, submit supplier orders, upload BOLs, or touch
--     Stripe / checkout / customer UI in any way.
--   * Does NOT grant any INSERT / UPDATE / DELETE on supplier_purchase_log —
--     writes remain service-role only.
--
-- DEPENDS ON
--   supabase/admin_order_dashboard.sql               (Phase 5.0 — admin_users + is_admin)
--   supabase/migrations/20260604_admin_approval_supplier_sync.sql (Phase 1 — the 12 columns + log table)
--
-- IDEMPOTENT: re-runnable. Both views use CREATE OR REPLACE VIEW (which
-- requires only that previously-present columns stay in the same position
-- with the same types — we only APPEND new columns at the end). The RLS
-- policy uses DROP POLICY IF EXISTS + CREATE POLICY, matching the
-- established style in admin_order_dashboard.sql.
--
-- HOW TO APPLY
--   1. Open Supabase Studio → SQL Editor for this project.
--   2. Paste the entire contents of this file and click Run.
--   3. Re-open /admin/orders.html → the new fields will appear in
--      `admin_orders_summary` and `admin_order_detail` query results
--      (the existing UI ignores unknown columns harmlessly).
--
-- ROLLBACK
--   See the ROLLBACK section at the bottom of this file (commented out).
-- ============================================================================


-- ── 1. admin_orders_summary — extended ──────────────────────────────────────
-- All existing columns preserved in their exact original order. 12 new
-- columns appended at the end so CREATE OR REPLACE VIEW succeeds without
-- a DROP-and-recreate (which would invalidate dependent grants and could
-- briefly leave the dashboard unable to query the view).
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
     WHERE order_id = o.order_id AND status = 'reserved') AS active_reservations,
  -- ── Phase 2b.0 additions ─────────────────────────────────────────────────
  o.admin_approval_status,
  o.admin_approval_rejected_reason,
  o.admin_approved_at,
  o.admin_approved_by,
  o.supplier_sync_status,
  o.supplier_order_id,
  o.supplier_submitted_at,
  o.supplier_sync_error,
  o.supplier_last_checked_at,
  o.supplier_status_code,
  o.supplier_purchase_attempt_count
FROM public.orders o;


-- ── 2. admin_order_detail — extended ────────────────────────────────────────
-- Same approach: preserve existing column order verbatim, append new columns
-- at the end. The detail view additionally includes
-- supplier_sync_response_json — the raw last-response payload from GIGA — so
-- admins inspecting a single order can see the full server reply. Listings
-- use admin_orders_summary, which deliberately omits the jsonb body.
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
     WHERE ir.order_id = o.order_id) AS reservations,
  -- ── Phase 2b.0 additions ─────────────────────────────────────────────────
  o.admin_approval_status,
  o.admin_approval_rejected_reason,
  o.admin_approved_at,
  o.admin_approved_by,
  o.supplier_sync_status,
  o.supplier_order_id,
  o.supplier_submitted_at,
  o.supplier_sync_response_json,
  o.supplier_sync_error,
  o.supplier_last_checked_at,
  o.supplier_status_code,
  o.supplier_purchase_attempt_count
FROM public.orders o;


-- Re-grant SELECT on both views. CREATE OR REPLACE preserves grants, but
-- re-issuing the grant is harmless and matches the pattern in
-- admin_order_dashboard.sql.
GRANT SELECT ON public.admin_orders_summary, public.admin_order_detail TO authenticated;


-- ── 3. supplier_purchase_log — admin SELECT-only access ─────────────────────
-- RLS is already enabled by the Phase 1 migration. Today the only policy is
-- `service_role_all_supplier_purchase_log`, which permits the edge functions
-- to write/read. Authenticated users (including admins) cannot read it at
-- all — default deny.
--
-- This block adds a SELECT-only policy gated by public.is_admin() so the
-- dashboard can render audit history per order. INSERT / UPDATE / DELETE
-- intentionally have NO policy for authenticated users — writes remain
-- service-role only via the edge functions.
--
-- Verify RLS is still on (it should be — Phase 1 enabled it):
--   SELECT relrowsecurity FROM pg_class
--    WHERE oid = 'public.supplier_purchase_log'::regclass;
ALTER TABLE public.supplier_purchase_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_select_supplier_purchase_log" ON public.supplier_purchase_log;
CREATE POLICY "admins_select_supplier_purchase_log" ON public.supplier_purchase_log
  FOR SELECT TO authenticated
  USING (public.is_admin());

GRANT SELECT ON public.supplier_purchase_log TO authenticated;


-- ============================================================================
-- VERIFICATION QUERIES (read-only — paste into the SQL editor after applying)
-- ============================================================================
--
-- 1. Confirm both views expose the new columns:
--    SELECT column_name
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'admin_orders_summary'
--      AND column_name IN ('admin_approval_status','admin_approved_at',
--                          'admin_approved_by','supplier_sync_status',
--                          'supplier_order_id','supplier_submitted_at',
--                          'supplier_sync_error','supplier_last_checked_at',
--                          'supplier_status_code','supplier_purchase_attempt_count',
--                          'admin_approval_rejected_reason')
--    ORDER BY column_name;
--    -- expect 11 rows.
--
--    SELECT column_name
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name   = 'admin_order_detail'
--      AND column_name IN ('admin_approval_status','admin_approved_at',
--                          'admin_approved_by','supplier_sync_status',
--                          'supplier_order_id','supplier_submitted_at',
--                          'supplier_sync_response_json','supplier_sync_error',
--                          'supplier_last_checked_at','supplier_status_code',
--                          'supplier_purchase_attempt_count',
--                          'admin_approval_rejected_reason')
--    ORDER BY column_name;
--    -- expect 12 rows.
--
-- 2. Confirm the two approved orders surface as approved + not_submitted:
--    SELECT order_number, admin_approval_status, admin_approved_by,
--           supplier_sync_status, supplier_order_id
--    FROM   public.admin_orders_summary
--    WHERE  order_number IN ('ORD-42F8AF32', 'ORD-2FE8C1EF');
--    -- expect 2 rows, both with admin_approval_status='approved',
--    -- supplier_sync_status='not_submitted', supplier_order_id=NULL.
--
-- 3. Confirm RLS + policy on supplier_purchase_log:
--    SELECT polname, polcmd, polroles::regrole[]
--    FROM   pg_policy
--    WHERE  polrelid = 'public.supplier_purchase_log'::regclass
--    ORDER  BY polname;
--    -- expect 2 rows:
--    --   admins_select_supplier_purchase_log   r (SELECT)   {authenticated}
--    --   service_role_all_supplier_purchase_log *           {service_role}
--
--    SELECT relrowsecurity FROM pg_class
--    WHERE  oid = 'public.supplier_purchase_log'::regclass;
--    -- expect: t (RLS enabled)
--
-- 4. As a signed-in admin, the audit-log SELECT should work:
--    SELECT order_id, event, caller, http_status,
--           response_json->>'approved' AS approved,
--           created_at
--    FROM   public.supplier_purchase_log
--    ORDER  BY created_at DESC
--    LIMIT  5;
--    -- expect 2 'approve_attempt' rows from Phase 2a smoke-test (ORD-42F8AF32,
--    -- ORD-2FE8C1EF), each with approved='true'.
-- ============================================================================


-- ============================================================================
-- ROLLBACK (operator-run, NOT auto-executed)
-- ============================================================================
-- Run the following statements in reverse order to revert this patch. The
-- two CREATE OR REPLACE VIEW statements revert by re-running
-- supabase/admin_order_dashboard.sql, which re-creates the views in their
-- original (pre-Phase-2b.0) shape.
--
-- -- Drop the admin SELECT policy on the audit log:
-- DROP POLICY IF EXISTS "admins_select_supplier_purchase_log" ON public.supplier_purchase_log;
-- REVOKE SELECT ON public.supplier_purchase_log FROM authenticated;
--
-- -- Restore the views to their pre-Phase-2b.0 shape by re-running:
-- --   supabase/admin_order_dashboard.sql
-- -- (the two CREATE OR REPLACE VIEW blocks there will recreate them without
-- -- the Phase 2b.0 columns).
-- ============================================================================
