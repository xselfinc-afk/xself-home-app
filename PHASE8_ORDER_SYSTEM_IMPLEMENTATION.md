# Phase 8 Order System Implementation
**Date:** 2026-04-30  
**Status:** Backend complete — CheckoutScreen integration pending  
**Principle:** Server authority > client control. Order exists before payment.

---

## What Was Built

| Deliverable | File | Status |
|------------|------|--------|
| SQL migration | `supabase/migrations/20260430_phase8_order_system.sql` | ✅ Created |
| `create-checkout-order` edge function | `supabase/functions/create-checkout-order/index.ts` | ✅ Deployed |
| `stripe-webhook` (updated) | `supabase/functions/stripe-webhook/index.ts` | ✅ Deployed |
| `create-payment-intent` (deprecated) | `supabase/functions/create-payment-intent/index.ts` | ✅ Marked deprecated |
| `config.toml` | `supabase/config.toml` | ✅ Updated |

---

## 1. SQL Migration

**File:** `supabase/migrations/20260430_phase8_order_system.sql`

### Run command
```bash
# Apply to remote Supabase project:
npx supabase db push

# Or execute directly in Supabase Dashboard → SQL Editor
```

### Changes to `orders` table (additive — no existing columns removed)

```sql
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS guest_token        text,
  ADD COLUMN IF NOT EXISTS customer_email     text,
  ADD COLUMN IF NOT EXISTS customer_phone     text,
  ADD COLUMN IF NOT EXISTS payment_intent_id  text,   -- UNIQUE (partial index below)
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS fulfillment_method text,
  ADD COLUMN IF NOT EXISTS fulfillment_plan   jsonb,
  ADD COLUMN IF NOT EXISTS subtotal_cents     integer,
  ADD COLUMN IF NOT EXISTS shipping_cents     integer,
  ADD COLUMN IF NOT EXISTS tax_cents          integer,
  ADD COLUMN IF NOT EXISTS total_cents        integer,
  ADD COLUMN IF NOT EXISTS updated_at         timestamptz;

-- Unique index on payment_intent_id (null rows excluded — safe for pre-Phase-8 rows)
CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_intent_id_idx
  ON orders (payment_intent_id) WHERE payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_guest_token_idx
  ON orders (guest_token) WHERE guest_token IS NOT NULL;
```

### New table: `order_items`

```sql
CREATE TABLE IF NOT EXISTS order_items (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         text        NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id       text        NOT NULL,
  supplier_sku     text        NOT NULL,
  title            text        NOT NULL,
  quantity         integer     NOT NULL CHECK (quantity > 0),
  unit_price_cents integer     NOT NULL CHECK (unit_price_cents >= 0),
  total_cents      integer     NOT NULL CHECK (total_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);
```

RLS: service role full access; authenticated users can SELECT their own order items.

### New table: `inventory_reservations`

```sql
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       text        NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id     text        NOT NULL,
  supplier_sku   text        NOT NULL,
  warehouse_code text        NOT NULL,
  quantity       integer     NOT NULL CHECK (quantity > 0),
  status         text        NOT NULL DEFAULT 'reserved'
                               CHECK (status IN ('reserved', 'fulfilled', 'released', 'expired')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id, warehouse_code)
);
```

RLS: service role only (webhook + edge functions).

### pg_cron job (run once after enabling extension)

In Supabase Dashboard → Extensions, enable **pg_cron**, then run:

```sql
SELECT cron.schedule(
  'expire-inventory-reservations',
  '*/5 * * * *',
  $$
    UPDATE inventory_reservations
    SET status = 'expired', updated_at = now()
    WHERE status = 'reserved' AND expires_at < now();
  $$
);
```

---

## 2. `create-checkout-order` Edge Function

**File:** `supabase/functions/create-checkout-order/index.ts`

### What it does (in order)

1. Validates cart items (max 20, qty ≤ 99, SKU format)
2. Validates address fields (line1, city, state, zip required)
3. Queries `inventory_cache` for fresh stock (same logic as `validate-checkout-inventory`)
4. Calls `plan-fulfillment` edge function for warehouse selection + shipping
5. Calculates totals (subtotal, shipping, tax=0, total — all in cents)
6. Creates `orders` row with `status = 'pending_payment'`
7. Creates `order_items` rows (normalized line items)
8. Creates `inventory_reservations` rows (TTL = 10 min)
9. Creates Stripe PaymentIntent (idempotency key = orderId)
10. Updates order with `payment_intent_id`
11. Returns `{ orderId, guestToken, clientSecret, paymentIntentId, totals, fulfillmentPlan }`

### Input schema

```json
{
  "items": [
    {
      "sku": "W714S00550",
      "productId": "W714S00550",
      "qty": 1,
      "title": "Coastal Oak Dining Table",
      "unitPriceCents": 129900
    }
  ],
  "customer": {
    "email": "user@example.com",
    "phone": "4155551234"
  },
  "address": {
    "line1": "123 Main St",
    "city": "San Jose",
    "state": "CA",
    "zip": "95101",
    "country": "US"
  },
  "fulfillmentMethod": "delivery",
  "userId": null,
  "guestToken": null,
  "paymentMethodSelected": "card"
}
```

### Output schema

```json
{
  "orderId": "uuid",
  "orderNumber": "ORD-XXXXXXXX",
  "guestToken": "uuid-or-null",
  "clientSecret": "pi_xxx_secret_xxx",
  "paymentIntentId": "pi_xxx",
  "totalCents": 138800,
  "subtotalCents": 129900,
  "shippingCents": 9900,
  "taxCents": 0,
  "isPickup": false,
  "fulfillmentPlan": { ... }
}
```

### Guest token behavior

- Authenticated user (`userId` provided): `guestToken` = `null`
- Guest user (no `userId`): `guestToken` = UUID generated server-side
- Guest retry (provides `guestToken`): existing token reused
- Guest token is stored in `orders.guest_token` and Stripe PI metadata

---

## 3. `stripe-webhook` Changes

**File:** `supabase/functions/stripe-webhook/index.ts`

### Events now handled

| Event | Action |
|-------|--------|
| `payment_intent.succeeded` | Find order → mark `paid` (or `pending_pickup`) → mark reservations `fulfilled` |
| `payment_intent.payment_failed` | Find order → mark `failed` → release reservations |
| `payment_intent.canceled` | Find order → mark `canceled` → release reservations |

### Order lookup (backward-compatible dual-path)

```
1. SELECT order_id FROM orders WHERE payment_intent_id = $pi_id   ← Phase 8 flow
2. If not found: SELECT order_id FROM orders WHERE order_id = $metadata.order_id  ← pre-Phase-8 flow
```

Pre-Phase-8 orders (created by old `createPendingOrder` flow) are still confirmed correctly.

### Idempotency guarantees

| Event | Guard |
|-------|-------|
| `payment_intent.succeeded` | No-op if `order.status IN ('paid', 'pending_pickup')` |
| `payment_intent.payment_failed` | `WHERE NOT status IN ('paid', 'pending_pickup')` |
| `payment_intent.canceled` | `WHERE NOT status IN ('paid', 'pending_pickup')` |
| Reservation updates | `WHERE status = 'reserved'` — already-transitioned rows are no-ops |

### Return policy

- **200** on success, no-op, or non-fatal errors (email failure, reservation failure after order confirmed)
- **400** on invalid signature
- **500** on DB write failure — Stripe retries with exponential backoff

---

## 4. Test curl Commands

Replace `$SUPABASE_URL` and `$ANON_KEY` with your project values.

### Test: create-checkout-order (happy path)

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/create-checkout-order" \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  -d '{
    "items": [
      {
        "sku": "W714S00550",
        "productId": "W714S00550",
        "qty": 1,
        "title": "Test Item",
        "unitPriceCents": 129900
      }
    ],
    "customer": { "email": "test@example.com" },
    "address": {
      "line1": "1 Infinite Loop",
      "city": "Cupertino",
      "state": "CA",
      "zip": "95014"
    },
    "fulfillmentMethod": "delivery",
    "paymentMethodSelected": "card"
  }' | jq .
```

Expected: `200` with `orderId`, `clientSecret`, `guestToken` (UUID), `totalCents`.

### Test: inventory validation failure

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/create-checkout-order" \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  -d '{
    "items": [{ "sku": "FAKE-SKU", "productId": "FAKEPID123", "qty": 1, "title": "Fake", "unitPriceCents": 100 }],
    "customer": {},
    "address": { "line1": "123 St", "city": "SF", "state": "CA", "zip": "94102" },
    "fulfillmentMethod": "delivery"
  }' | jq .
```

Expected: `422` with `failures` array.

### Test: input validation

```bash
# Path-traversal productId → 400
curl -s -X POST "$SUPABASE_URL/functions/v1/create-checkout-order" \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  -d '{"items":[{"sku":"x","productId":"../../etc/passwd","qty":1,"title":"x","unitPriceCents":100}],"customer":{},"address":{"line1":"a","city":"b","state":"CA","zip":"94102"},"fulfillmentMethod":"delivery"}' | jq .

# Missing address → 400
curl -s -X POST "$SUPABASE_URL/functions/v1/create-checkout-order" \
  -H "Content-Type: application/json" \
  -H "apikey: $ANON_KEY" \
  -d '{"items":[{"sku":"W714S00550","productId":"W714S00550","qty":1,"title":"x","unitPriceCents":100}],"customer":{}}' | jq .
```

### Test: verify order in DB after create-checkout-order

```bash
# Replace ORDER_ID with the orderId from the create response
curl -s "$SUPABASE_URL/rest/v1/orders?order_id=eq.ORDER_ID&select=order_id,status,payment_intent_id,total_cents,guest_token" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" | jq .
```

Expected: `status = "pending_payment"`, `payment_intent_id` populated, `guest_token` non-null (for guest).

### Test: verify reservations created

```bash
curl -s "$SUPABASE_URL/rest/v1/inventory_reservations?order_id=eq.ORDER_ID&select=*" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" | jq .
```

Expected: one row per item, `status = "reserved"`, `expires_at` ~10 min from creation.

### Test: simulate webhook (payment_intent.succeeded)

```bash
# Requires STRIPE_WEBHOOK_SECRET for valid signature
# Use Stripe CLI for proper signature generation:
stripe trigger payment_intent.succeeded \
  --add payment_intent:metadata.order_id=ORDER_ID \
  --add payment_intent:metadata.fulfillment_method=delivery
```

Expected: order `status` → `paid`, reservations `status` → `fulfilled`.

---

## 5. Rollback Notes

### Edge functions: instant rollback

```bash
# Redeploy previous webhook version from git
git show HEAD:supabase/functions/stripe-webhook/index.ts > /tmp/webhook-rollback.ts
# Then deploy the rolled-back version manually

# Remove create-checkout-order (app not yet wired to it — no traffic impact)
# No rollback needed: existing checkout flow still uses create-payment-intent
```

### DB rollback

```sql
-- Safe to run; does not affect existing order data
DROP TABLE IF EXISTS inventory_reservations;
DROP TABLE IF EXISTS order_items;
DROP INDEX IF EXISTS orders_payment_intent_id_idx;
DROP INDEX IF EXISTS orders_guest_token_idx;

ALTER TABLE orders
  DROP COLUMN IF EXISTS guest_token,
  DROP COLUMN IF EXISTS customer_email,
  DROP COLUMN IF EXISTS customer_phone,
  DROP COLUMN IF EXISTS payment_intent_id,
  DROP COLUMN IF EXISTS stripe_customer_id,
  DROP COLUMN IF EXISTS fulfillment_method,
  DROP COLUMN IF EXISTS fulfillment_plan,
  DROP COLUMN IF EXISTS subtotal_cents,
  DROP COLUMN IF EXISTS shipping_cents,
  DROP COLUMN IF EXISTS tax_cents,
  DROP COLUMN IF EXISTS total_cents;
-- Note: do NOT drop updated_at — used by existing OrdersContext code.
```

---

## 6. What Remains Before App Integration

### Required before wiring CheckoutScreen to `create-checkout-order`

| Item | Notes |
|------|-------|
| **Run SQL migration** | `npx supabase db push` — adds columns and new tables |
| **Enable pg_cron** | Supabase Dashboard → Extensions → pg_cron, then run the cron schedule statement |
| **Test happy path with curl** | Verify `create-checkout-order` returns 200 with `clientSecret` and `orderId` |
| **Verify webhook** | Use `stripe trigger` to confirm order status transitions |
| **CheckoutScreen integration** | Replace `createPendingOrder` + `create-payment-intent` calls with single `create-checkout-order` call. Store `orderId` + `guestToken` in AsyncStorage pre-payment. |
| **OrdersContext: guest refresh** | Add logic to query orders by `guest_token` so guests can retrieve their orders |
| **Tax calculation** | `tax_cents` is 0 now — add state-based tax logic if required |
| **Confirmation email** | Webhook does not yet send email — add Resend/SendGrid call in `payment_intent.succeeded` handler |
| **Remove create-payment-intent** | After CheckoutScreen is migrated and tested in production |

### Architecture diagram (post-Phase-8, pre-CheckoutScreen integration)

```
[Current app flow — unchanged]
  CheckoutScreen
    → createPendingOrder()      → orders (old columns, user only)
    → create-payment-intent     → Stripe PI (no reservations)
    → confirmPayment()
    → confirmOrder()
    → stripe-webhook (now updated — handles both old + new order lookup)

[New backend-only flow — tested via curl]
  curl create-checkout-order
    → inventory check
    → plan-fulfillment
    → orders (new columns, guests supported)
    → order_items
    → inventory_reservations (TTL 10min)
    → Stripe PI (with order_id + guest_token in metadata)
    → stripe-webhook on payment → marks paid, fulfills reservations
```

---

## Files Changed in Phase 8

| File | Change |
|------|--------|
| `supabase/migrations/20260430_phase8_order_system.sql` | NEW |
| `supabase/functions/create-checkout-order/index.ts` | NEW |
| `supabase/functions/stripe-webhook/index.ts` | UPDATED (handles failed/canceled, dual-path lookup, reservation updates) |
| `supabase/functions/create-payment-intent/index.ts` | Deprecation comment added |
| `supabase/config.toml` | `[functions.create-checkout-order] verify_jwt = false` added |
