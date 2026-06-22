-- 20260622_product_reviews_user_insert_policy.sql
--
-- PURPOSE: Let LOGGED-IN (authenticated) users submit their own product review.
-- Today product_reviews allows anon SELECT of active rows and service-role writes
-- (the 2185 AI-generated seed rows were inserted by the service role), but there is
-- NO INSERT policy for the app's authenticated client — so every user submission
-- fails at RLS (reviewSubmitter hits its db_error path) and no real review is ever saved.
--
-- This migration ADDS an INSERT policy scoped to the row's own user_id. It does NOT
-- change the existing active-review SELECT behavior, does NOT allow anonymous inserts,
-- and touches no data.
--
-- VERIFY CURRENT POLICIES FIRST (run in the SQL editor, read-only):
--   SELECT polname, cmd, roles::regrole[] , qual, with_check
--   FROM pg_policy WHERE polrelid = 'public.product_reviews'::regclass;
--   -- or:
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies WHERE schemaname='public' AND tablename='product_reviews';

-- RLS should already be enabled (anon SELECT is governed). Safe/idempotent if so:
ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;

-- Authenticated users may INSERT only a row whose user_id is their own auth uid.
-- (Anonymous/guest inserts remain blocked — no anon INSERT policy is created.)
DROP POLICY IF EXISTS users_insert_own_review ON public.product_reviews;
CREATE POLICY users_insert_own_review
  ON public.product_reviews
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

-- NOTE: This does NOT grant UPDATE/DELETE to users, and does NOT alter SELECT.
-- Moderation still applies app-side (reviewModerator) — disallowed content is
-- inserted as status='hidden' and remains invisible to the active-only SELECT.

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS users_insert_own_review ON public.product_reviews;
