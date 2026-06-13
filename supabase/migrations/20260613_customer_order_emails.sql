-- ============================================================================
-- Customer-facing order-confirmation email queue (Phase C1).
-- ============================================================================
-- Additive only. Idempotent. Safe to re-run.
--
-- WHAT THIS DOES:
--   * Creates public.customer_order_emails: one durable "a customer confirmation
--     is owed" row per order. A separate sender (send-customer-order-email)
--     reads the row, emails the customer, and advances the status.
--   * order_id is the PRIMARY KEY → at most one customer email per order
--     (built-in duplicate prevention).
--   * Service-role only via RLS — customers must never read this table.
--
-- WHAT THIS DOES NOT DO:
--   * Does NOT touch order_notifications (the internal ops queue), orders,
--     order_items, checkout/payment tables, or any existing RLS policy.
--   * Does NOT send anything.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customer_order_emails (
  order_id        text PRIMARY KEY REFERENCES public.orders(order_id) ON DELETE CASCADE,
  recipient_email text,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- Bound the enum values + attempts (idempotent guards).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_order_emails_status_check') THEN
    ALTER TABLE public.customer_order_emails
      ADD CONSTRAINT customer_order_emails_status_check
      CHECK (status IN ('pending', 'sent', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_order_emails_attempts_check') THEN
    ALTER TABLE public.customer_order_emails
      ADD CONSTRAINT customer_order_emails_attempts_check
      CHECK (attempts >= 0);
  END IF;
END $$;

-- Partial index for the future sender's queue scan (pending/failed only).
CREATE INDEX IF NOT EXISTS idx_customer_order_emails_status
  ON public.customer_order_emails (status)
  WHERE status IN ('pending', 'failed');

COMMENT ON TABLE public.customer_order_emails IS
  'Customer-facing order-confirmation email queue. One row per order_id (PK → dedupes). '
  'send-customer-order-email delivers and updates status. Separate from order_notifications (internal ops).';

-- ── RLS: service-role only (default deny for authenticated/anon) ────────────
ALTER TABLE public.customer_order_emails ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'customer_order_emails'
       AND policyname = 'service_role_all_customer_order_emails'
  ) THEN
    CREATE POLICY service_role_all_customer_order_emails
      ON public.customer_order_emails
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
-- Deliberately NO policy for authenticated/anon → default deny (customers cannot read).

-- ============================================================================
-- ROLLBACK (operator-run, NOT auto-executed):
--   DROP POLICY IF EXISTS service_role_all_customer_order_emails ON public.customer_order_emails;
--   DROP INDEX  IF EXISTS public.idx_customer_order_emails_status;
--   DROP TABLE  IF EXISTS public.customer_order_emails;
-- ============================================================================
