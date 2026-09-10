-- Three fulfillment methods, two-value storage contract (phase 1).
--
-- API / Checkout speak three values: pickup | local_delivery | third_party_shipping.
-- orders.fulfillment_method deliberately STAYS 'pickup' | 'delivery' in this phase —
-- XOne Fulfillment (ecommerceOrder.ts maps any other value to null), the customer /
-- ops emails, admin-update-order-status and the production guardrails all branch on
-- that two-value contract. The sub-type of a 'delivery' order is carried here:
--
--   delivery_kind = 'local'        → XSELF-operated Local Delivery, shipping_cents = 0
--   delivery_kind = 'third_party'  → GIGA drop-ship, shipping_cents = Σ charged_fee_cents × qty
--   delivery_kind = NULL           → pickup (and every pre-existing row)
--
-- Reversible: see ROLLBACK at the bottom.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS delivery_kind text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_kind_check') THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_delivery_kind_check
      CHECK (delivery_kind IS NULL OR delivery_kind IN ('local', 'third_party'));
  END IF;
END $$;

COMMENT ON COLUMN public.orders.delivery_kind IS
  'Sub-type of a fulfillment_method=''delivery'' order: local (XSELF Local Delivery, free) | third_party (GIGA drop-ship). NULL for pickup and for rows created before 2026-09-10.';

-- ── ROLLBACK (run manually to revert) ────────────────────────────────────────────
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_delivery_kind_check;
-- ALTER TABLE public.orders DROP COLUMN IF EXISTS delivery_kind;
