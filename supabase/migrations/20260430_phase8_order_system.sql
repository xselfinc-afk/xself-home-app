-- Phase 8: Server-authoritative order system
-- Additive migration — no destructive changes to existing schema
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. orders — add Phase 8 columns
-- ─────────────────────────────────────────────────────────────────────────────
-- Existing columns preserved: order_id, order_number, user_id, status,
-- payment_status, stripe_payment_intent_id, total, subtotal, shipping_total,
-- tax, date, address_json, items_json, fulfillment_groups_json, created_at, updated_at

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS guest_token        text,
  ADD COLUMN IF NOT EXISTS customer_email     text,
  ADD COLUMN IF NOT EXISTS customer_phone     text,
  -- payment_intent_id: the new authoritative Stripe PI reference (unique per order)
  -- distinct from legacy stripe_payment_intent_id which may not carry UNIQUE constraint
  ADD COLUMN IF NOT EXISTS payment_intent_id  text,
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS fulfillment_method text,           -- 'delivery' | 'pickup'
  ADD COLUMN IF NOT EXISTS fulfillment_plan   jsonb,          -- full plan-fulfillment response
  ADD COLUMN IF NOT EXISTS subtotal_cents     integer,
  ADD COLUMN IF NOT EXISTS shipping_cents     integer,
  ADD COLUMN IF NOT EXISTS tax_cents          integer,
  ADD COLUMN IF NOT EXISTS total_cents        integer,
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz;    -- ADD IF NOT EXISTS is safe

-- Unique constraint on payment_intent_id (idempotency key for webhook)
-- Partial index: only non-NULL values are indexed (pre-Phase-8 rows have NULL)
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_intent_id_idx
  ON orders (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;

-- Index for guest order lookup by token
CREATE INDEX IF NOT EXISTS orders_guest_token_idx
  ON orders (guest_token)
  WHERE guest_token IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. order_items — normalized line items (supplements existing items_json)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         text        NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id       text        NOT NULL,   -- supplier_product_id
  supplier_sku     text        NOT NULL,   -- GIGA display SKU
  title            text        NOT NULL,
  quantity         integer     NOT NULL CHECK (quantity > 0),
  unit_price_cents integer     NOT NULL CHECK (unit_price_cents >= 0),
  total_cents      integer     NOT NULL CHECK (total_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items (order_id);

-- RLS: service role has full access; authenticated users can read their own order items
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'service_role_all_order_items'
  ) THEN
    CREATE POLICY service_role_all_order_items ON order_items
      FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'order_items' AND policyname = 'users_read_own_order_items'
  ) THEN
    CREATE POLICY users_read_own_order_items ON order_items
      FOR SELECT TO authenticated
      USING (
        order_id IN (
          SELECT order_id FROM orders WHERE user_id = auth.uid()
        )
      );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. inventory_reservations — TTL soft locks preventing oversell
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       text        NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id     text        NOT NULL,   -- supplier_product_id
  supplier_sku   text        NOT NULL,
  warehouse_code text        NOT NULL,
  quantity       integer     NOT NULL CHECK (quantity > 0),
  status         text        NOT NULL DEFAULT 'reserved'
                               CHECK (status IN ('reserved', 'fulfilled', 'released', 'expired')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- One reservation per (order, product, warehouse) — ON CONFLICT DO NOTHING for idempotency
  UNIQUE (order_id, product_id, warehouse_code)
);

-- Efficient expiry scan for pg_cron cleanup job
CREATE INDEX IF NOT EXISTS inventory_reservations_status_expires_idx
  ON inventory_reservations (status, expires_at);

CREATE INDEX IF NOT EXISTS inventory_reservations_order_id_idx
  ON inventory_reservations (order_id);

-- RLS: service role only (webhook + edge functions; no direct client access)
ALTER TABLE inventory_reservations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'inventory_reservations' AND policyname = 'service_role_all_reservations'
  ) THEN
    CREATE POLICY service_role_all_reservations ON inventory_reservations
      FOR ALL TO service_role USING (true);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. pg_cron: expire stale reservations every 5 minutes
-- ─────────────────────────────────────────────────────────────────────────────
-- Requires pg_cron extension enabled in Supabase Dashboard → Extensions → pg_cron
-- Run this block manually once after enabling the extension:
--
-- SELECT cron.schedule(
--   'expire-inventory-reservations',
--   '*/5 * * * *',
--   $$
--     UPDATE inventory_reservations
--     SET status = 'expired', updated_at = now()
--     WHERE status = 'reserved' AND expires_at < now();
--   $$
-- );
--
-- To remove: SELECT cron.unschedule('expire-inventory-reservations');

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK NOTES
-- ─────────────────────────────────────────────────────────────────────────────
-- To roll back Phase 8 without affecting existing orders:
--
-- DROP TABLE IF EXISTS inventory_reservations;
-- DROP TABLE IF EXISTS order_items;
-- DROP INDEX IF EXISTS orders_payment_intent_id_idx;
-- DROP INDEX IF EXISTS orders_guest_token_idx;
-- ALTER TABLE orders
--   DROP COLUMN IF EXISTS guest_token,
--   DROP COLUMN IF EXISTS customer_email,
--   DROP COLUMN IF EXISTS customer_phone,
--   DROP COLUMN IF EXISTS payment_intent_id,
--   DROP COLUMN IF EXISTS stripe_customer_id,
--   DROP COLUMN IF EXISTS fulfillment_method,
--   DROP COLUMN IF EXISTS fulfillment_plan,
--   DROP COLUMN IF EXISTS subtotal_cents,
--   DROP COLUMN IF EXISTS shipping_cents,
--   DROP COLUMN IF EXISTS tax_cents,
--   DROP COLUMN IF EXISTS total_cents;
-- Note: do NOT drop updated_at — it may be used by existing code.
