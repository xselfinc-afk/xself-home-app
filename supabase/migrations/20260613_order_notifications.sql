-- ============================================================================
-- Phase 1 — Paid-order notification queue (enqueue-only; no sending in this phase)
-- ============================================================================
-- Additive only. Idempotent. Safe to re-run.
--
-- WHAT THIS DOES:
--   * Creates public.order_notifications: one durable "a notification is owed" row per
--     paid order. stripe-webhook enqueues a 'pending' row after marking the order paid
--     (Phase 2). A separate Edge Function (Phase 3+) will read pending rows and send.
--   * order_id is the PRIMARY KEY → duplicate Stripe webhook deliveries cannot create
--     duplicate jobs (the webhook upserts ON CONFLICT DO NOTHING).
--   * Service-role only via RLS — customers must never read this table.
--
-- WHAT THIS DOES NOT DO:
--   * Does NOT send anything (no Crisp/email here).
--   * Does NOT modify orders / order_items / checkout / payment / webhook tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.order_notifications (
  order_id      text PRIMARY KEY REFERENCES public.orders(order_id) ON DELETE CASCADE,
  channel       text        NOT NULL DEFAULT 'crisp',
  status        text        NOT NULL DEFAULT 'pending',
  attempts      integer     NOT NULL DEFAULT 0,
  last_error    text,
  customer_name text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

-- Bound the enum values (matches the sender lifecycle).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_notifications_status_check') THEN
    ALTER TABLE public.order_notifications
      ADD CONSTRAINT order_notifications_status_check
      CHECK (status IN ('pending', 'sent', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_notifications_attempts_check') THEN
    ALTER TABLE public.order_notifications
      ADD CONSTRAINT order_notifications_attempts_check
      CHECK (attempts >= 0);
  END IF;
END $$;

-- Partial index for the future sender's queue scan (pending/failed only).
CREATE INDEX IF NOT EXISTS idx_order_notifications_status
  ON public.order_notifications (status)
  WHERE status IN ('pending', 'failed');

COMMENT ON TABLE public.order_notifications IS
  'Paid-order notification queue. One row per order_id (PK → dedupes duplicate Stripe events). '
  'stripe-webhook enqueues status=pending after payment; a separate sender Edge Function delivers and updates status.';

-- ── RLS: service-role only (default deny for authenticated/anon) ────────────
ALTER TABLE public.order_notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'order_notifications'
       AND policyname = 'service_role_all_order_notifications'
  ) THEN
    CREATE POLICY service_role_all_order_notifications
      ON public.order_notifications
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
-- Deliberately NO policy for authenticated/anon → default deny (customers cannot read).

-- ============================================================================
-- ROLLBACK (operator-run, NOT auto-executed):
--   DROP POLICY IF EXISTS service_role_all_order_notifications ON public.order_notifications;
--   DROP INDEX  IF EXISTS public.idx_order_notifications_status;
--   DROP TABLE  IF EXISTS public.order_notifications;
-- ============================================================================
