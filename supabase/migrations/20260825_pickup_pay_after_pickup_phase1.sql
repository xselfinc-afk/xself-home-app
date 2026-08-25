-- 20260825_pickup_pay_after_pickup_phase1.sql
--
-- Phase 1 — Pay-After-Pickup on the SHARED backend.
--
-- Design invariants (do not violate in later migrations):
--   * `public.orders` stays the ONE authoritative order table. No second order source.
--   * Everything here is ADDITIVE: new nullable columns, superset CHECKs, new tables.
--     Delivery rows never take a new value, so Delivery behaviour is byte-unchanged.
--   * `payment_status` must NEVER equate "authorized" with "paid". A held card is not
--     collected money. We extend the CHECK with 'card_saved' and 'authorized' as states
--     strictly BELOW 'paid'; capture is the only thing that writes 'paid'.
--   * App-facing `status` is left exactly as-is (pending_pickup / ready_for_pickup /
--     picked_up already exist). The fine-grained pickup lifecycle lives in the NEW
--     `pickup_stage` column so no existing status mapping changes.
--
-- Reversible: every statement has an inverse in the ROLLBACK block at the bottom.
-- Fail-safe: IF NOT EXISTS throughout; re-runnable.

BEGIN;

-- ── 1. orders: additive Pay-After-Pickup columns ────────────────────────────────
ALTER TABLE public.orders
  -- SetupIntent / card-on-file (checkout_setup phase)
  ADD COLUMN IF NOT EXISTS setup_intent_id                text,
  ADD COLUMN IF NOT EXISTS payment_method_saved_at        timestamptz,
  -- fine-grained pickup lifecycle (does NOT replace status)
  ADD COLUMN IF NOT EXISTS pickup_stage                   text,
  -- authorization hold (pickup_authorization phase)
  ADD COLUMN IF NOT EXISTS authorization_payment_intent_id text,
  ADD COLUMN IF NOT EXISTS authorization_status           text,
  ADD COLUMN IF NOT EXISTS authorization_amount_cents      integer,
  -- provider-reported hold expiry (capture_before)
  ADD COLUMN IF NOT EXISTS capture_before                 timestamptz,
  -- pickup confirmation + due policy (24h starts ONLY at Confirm Pickup)
  ADD COLUMN IF NOT EXISTS picked_up_at                   timestamptz,   -- actual pickup instant, if known
  ADD COLUMN IF NOT EXISTS pickup_confirmed_at            timestamptz,   -- ops recorded pickup here
  ADD COLUMN IF NOT EXISTS payment_due_at                 timestamptz,
  ADD COLUMN IF NOT EXISTS payment_due_basis              text;

COMMENT ON COLUMN public.orders.pickup_stage IS
  'Pay-After-Pickup sub-lifecycle (NULL for delivery & legacy). '
  'AWAITING_SUPPLIER_ORDER→BOL_READY→AUTHORIZED→BOL_RELEASED→PICKED_UP→CONFIRMED→CAPTURED.';
COMMENT ON COLUMN public.orders.authorization_status IS
  'Manual-capture hold state. NONE/REQUIRES_ACTION/AUTHORIZED/CAPTURED/VOIDED/FAILED. '
  'AUTHORIZED is a hold, NOT payment — payment_status stays below paid until capture.';
COMMENT ON COLUMN public.orders.payment_due_basis IS
  'EXACT_PICKUP_TIME (24h from real pickup instant) or END_OF_NEXT_DAY (fallback).';

-- ── 2. payment_status: superset CHECK (authorized != paid) ──────────────────────
-- Old: ('pending','paid','failed'). New adds two states that rank BELOW paid.
-- Delivery only ever writes pending/paid/failed, so this cannot change Delivery.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status = ANY (ARRAY[
    'pending'::text,
    'card_saved'::text,    -- SetupIntent succeeded; $0 collected
    'authorized'::text,    -- manual-capture hold placed; still $0 collected
    'paid'::text,          -- capture succeeded — the ONLY collected state
    'failed'::text
  ]));

-- ── 3. pickup_stage / authorization_status / payment_due_basis value guards ─────
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_pickup_stage_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_pickup_stage_check
  CHECK (pickup_stage IS NULL OR pickup_stage = ANY (ARRAY[
    'AWAITING_SUPPLIER_ORDER'::text,'BOL_READY'::text,'AUTHORIZED'::text,
    'BOL_RELEASED'::text,'PICKED_UP'::text,'CONFIRMED'::text,'CAPTURED'::text
  ]));

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_authorization_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_authorization_status_check
  CHECK (authorization_status IS NULL OR authorization_status = ANY (ARRAY[
    'NONE'::text,'REQUIRES_ACTION'::text,'AUTHORIZED'::text,
    'CAPTURED'::text,'VOIDED'::text,'FAILED'::text
  ]));

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_due_basis_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_due_basis_check
  CHECK (payment_due_basis IS NULL OR payment_due_basis = ANY (ARRAY[
    'EXACT_PICKUP_TIME'::text,'END_OF_NEXT_DAY'::text
  ]));

-- ── 4. inventory_reservations: pickup policy (delivery untouched) ────────────────
-- Delivery keeps the existing 10-min expires_at sweep. Pickup rows get a distinct
-- policy the sweep must skip, plus a 24h fallback deadline used only until a
-- supplier order takes over the inventory fact.
ALTER TABLE public.inventory_reservations
  ADD COLUMN IF NOT EXISTS reservation_policy      text NOT NULL DEFAULT 'payment_10min',
  ADD COLUMN IF NOT EXISTS pickup_release_deadline timestamptz;

ALTER TABLE public.inventory_reservations DROP CONSTRAINT IF EXISTS inv_res_policy_check;
ALTER TABLE public.inventory_reservations
  ADD CONSTRAINT inv_res_policy_check
  CHECK (reservation_policy = ANY (ARRAY['payment_10min'::text,'pickup_hold'::text]));

COMMENT ON COLUMN public.inventory_reservations.reservation_policy IS
  'payment_10min = legacy delivery/immediate-pay 10-min TTL sweep. '
  'pickup_hold = Pay-After-Pickup: NOT released by the 10-min sweep; released when a '
  'supplier order takes over, or by pickup_release_deadline (24h) if none appears.';

-- ── 5. supplier_orders ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.supplier_orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           text NOT NULL,                 -- FK-by-value to orders.order_id (no hard FK: additive/reversible)
  supplier_name      text,
  supplier_order_ref text,
  status             text NOT NULL DEFAULT 'created',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_orders_status_check
    CHECK (status = ANY (ARRAY['created'::text,'confirmed'::text,'cancelled'::text]))
);
CREATE INDEX IF NOT EXISTS idx_supplier_orders_order ON public.supplier_orders (order_id);

-- ── 6. pickup_documents (BOL) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pickup_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      text NOT NULL,
  document_type text NOT NULL,                       -- ORIGINAL_BOL | SIGNED_BOL
  file_name     text,
  storage_path  text,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,                         -- set ONLY by the release gate; never at capture
  superseded_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pickup_documents_type_check
    CHECK (document_type = ANY (ARRAY['ORIGINAL_BOL'::text,'SIGNED_BOL'::text]))
);
CREATE INDEX IF NOT EXISTS idx_pickup_documents_order ON public.pickup_documents (order_id);

-- ── 7. pickup_payment_authorizations (hold ledger) ──────────────────────────────
-- One row per authorization attempt. Idempotency key prevents duplicate holds on retry.
CREATE TABLE IF NOT EXISTS public.pickup_payment_authorizations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  text NOT NULL,
  provider_payment_intent_id text,
  status                    text NOT NULL DEFAULT 'REQUIRES_ACTION',
  amount_cents              integer NOT NULL,
  capture_before            timestamptz,
  tax_calculation_id        text,                    -- Stripe Tax quote behind this hold
  idempotency_key           text NOT NULL,
  void_reason               text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ppa_status_check
    CHECK (status = ANY (ARRAY['REQUIRES_ACTION'::text,'REQUIRES_CONFIRMATION'::text,
                               'AUTHORIZED'::text,'CAPTURED'::text,'VOIDED'::text,'FAILED'::text])),
  CONSTRAINT ppa_idem_unique UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_ppa_order ON public.pickup_payment_authorizations (order_id);

-- ── 8. pickup_audit_events (append-only) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pickup_audit_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   text NOT NULL,
  event_type text NOT NULL,
  actor      text,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pickup_audit_order ON public.pickup_audit_events (order_id);

-- ── 9. pickup_issues (open issue blocks capture) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pickup_issues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    text NOT NULL,
  kind        text NOT NULL,
  detail      text,
  status      text NOT NULL DEFAULT 'OPEN',
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT pickup_issues_status_check
    CHECK (status = ANY (ARRAY['OPEN'::text,'RESOLVED'::text]))
);
CREATE INDEX IF NOT EXISTS idx_pickup_issues_order_open ON public.pickup_issues (order_id) WHERE status = 'OPEN';

-- Service-role only for the new tables (no anon/authenticated grants); matches the
-- giga_warehouse_directory isolation pattern. RLS on, no policies -> default deny.
ALTER TABLE public.supplier_orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_documents               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_payment_authorizations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_audit_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_issues                  ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ── ROLLBACK (run manually to revert; Delivery never touched any of this) ───────
-- BEGIN;
-- DROP TABLE IF EXISTS public.pickup_issues;
-- DROP TABLE IF EXISTS public.pickup_audit_events;
-- DROP TABLE IF EXISTS public.pickup_payment_authorizations;
-- DROP TABLE IF EXISTS public.pickup_documents;
-- DROP TABLE IF EXISTS public.supplier_orders;
-- ALTER TABLE public.inventory_reservations DROP CONSTRAINT IF EXISTS inv_res_policy_check;
-- ALTER TABLE public.inventory_reservations DROP COLUMN IF EXISTS pickup_release_deadline, DROP COLUMN IF EXISTS reservation_policy;
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_due_basis_check;
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_authorization_status_check;
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_pickup_stage_check;
-- ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
-- ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_check
--   CHECK (payment_status = ANY (ARRAY['pending','paid','failed']));
-- ALTER TABLE public.orders
--   DROP COLUMN IF EXISTS payment_due_basis, DROP COLUMN IF EXISTS payment_due_at,
--   DROP COLUMN IF EXISTS pickup_confirmed_at, DROP COLUMN IF EXISTS picked_up_at,
--   DROP COLUMN IF EXISTS capture_before, DROP COLUMN IF EXISTS authorization_amount_cents,
--   DROP COLUMN IF EXISTS authorization_status, DROP COLUMN IF EXISTS authorization_payment_intent_id,
--   DROP COLUMN IF EXISTS pickup_stage, DROP COLUMN IF EXISTS payment_method_saved_at,
--   DROP COLUMN IF EXISTS setup_intent_id;
-- COMMIT;
