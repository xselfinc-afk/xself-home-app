-- Phase 5.4 — Sync admin Payment Link status from Stripe webhooks.
--
-- Adds three nullable columns to the existing admin_custom_payment_links
-- table so the Stripe webhook can mark rows as paid and persist the Stripe
-- checkout session + payment-intent identifiers for audit.
--
-- IDEMPOTENT: re-runnable in the Supabase SQL editor.
--
-- DEPENDS ON:
--   supabase/admin_order_dashboard.sql         (Phase 5.0 — is_admin, admin_users)
--   supabase/admin_custom_payment_links.sql    (Phase 5.2 — base table)
--
-- HOW TO APPLY
--   1. Supabase Studio → SQL Editor → New query.
--   2. Paste this file and click Run.
--   3. Verify with the queries at the bottom of this file.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS admin_custom_payment_links_session_id_idx;
--   DROP INDEX IF EXISTS admin_custom_payment_links_payment_intent_id_idx;
--   DROP INDEX IF EXISTS admin_custom_payment_links_paid_at_idx;
--   ALTER TABLE public.admin_custom_payment_links
--     DROP COLUMN IF EXISTS stripe_payment_intent_id,
--     DROP COLUMN IF EXISTS stripe_checkout_session_id,
--     DROP COLUMN IF EXISTS paid_at;

ALTER TABLE public.admin_custom_payment_links
  ADD COLUMN IF NOT EXISTS paid_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id   text;

CREATE INDEX IF NOT EXISTS admin_custom_payment_links_session_id_idx
  ON public.admin_custom_payment_links (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_custom_payment_links_payment_intent_id_idx
  ON public.admin_custom_payment_links (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_custom_payment_links_paid_at_idx
  ON public.admin_custom_payment_links (paid_at DESC)
  WHERE paid_at IS NOT NULL;

-- ── SAFE VERIFICATION QUERIES ───────────────────────────────────────────────
-- All read-only. Paste any of these into the SQL editor after applying the
-- migration to confirm the schema is in place and to inspect sync state.
--
-- 1. Columns are present:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'admin_custom_payment_links'
--      AND column_name IN ('paid_at','stripe_checkout_session_id','stripe_payment_intent_id')
--    ORDER BY column_name;
--
-- 2. Indexes are present:
--    SELECT indexname
--    FROM pg_indexes
--    WHERE schemaname = 'public' AND tablename = 'admin_custom_payment_links'
--    ORDER BY indexname;
--
-- 3. Per-row sync state (newest first):
--    SELECT
--      order_number,
--      status,
--      negotiated_total_cents,
--      created_at,
--      paid_at,
--      stripe_payment_link_id,
--      stripe_checkout_session_id,
--      stripe_payment_intent_id
--    FROM public.admin_custom_payment_links
--    ORDER BY created_at DESC
--    LIMIT 20;
--
-- 4. Counts by status (should show 'created' for unpaid, 'paid' for paid):
--    SELECT status, count(*) FROM public.admin_custom_payment_links GROUP BY status;
--
-- 5. Find any paid rows missing session/PI identifiers (data-integrity check):
--    SELECT order_number, status, stripe_payment_link_id, stripe_checkout_session_id, stripe_payment_intent_id, paid_at
--    FROM public.admin_custom_payment_links
--    WHERE status = 'paid'
--      AND (stripe_checkout_session_id IS NULL OR stripe_payment_intent_id IS NULL);
