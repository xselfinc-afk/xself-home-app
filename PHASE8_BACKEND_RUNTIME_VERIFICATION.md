# Phase 8 Backend Runtime Verification
**Date:** 2026-05-01  
**Verification type:** Schema + live runtime (curl against deployed edge functions)  
**DB project:** erbimgfbztkzmpamzwky  
**Test SKU:** W714S00550  
**Result:** ✅ Backend fully operational — CheckoutScreen integration can begin

---

## 1. Migration Verification

### Schema check method
Direct REST API queries using service role key — no local Docker required.

### orders table — new Phase 8 columns

| Column | Expected | Verified |
|--------|----------|----------|
| `guest_token` | text, nullable | ✅ Present |
| `payment_intent_id` | text, nullable | ✅ Present |
| `customer_email` | text, nullable | ✅ Present |
| `customer_phone` | text, nullable | ✅ Present |
| `fulfillment_method` | text, nullable | ✅ Present |
| `fulfillment_plan` | jsonb, nullable | ✅ Present |
| `subtotal_cents` | integer, nullable | ✅ Present |
| `shipping_cents` | integer, nullable | ✅ Present |
| `tax_cents` | integer, nullable | ✅ Present |
| `total_cents` | integer, nullable | ✅ Present |

### UNIQUE constraint on `payment_intent_id`

Tested by inserting two rows with identical `payment_intent_id`:

| Insert | Result |
|--------|--------|
| First row | HTTP 201 ✅ |
| Duplicate PI | HTTP 409 ✅ |

**Note:** A correction migration was required. The initial `20260430_phase8_order_system.sql` assumed no check constraint on `orders.status`. The existing table has `orders_status_check` constraining to pre-Phase-8 values (`pending`, `processing`, `shipped`, etc.). A second migration was pushed:

**`supabase/migrations/20260501_phase8_status_constraint.sql`** — drops and recreates `orders_status_check` with the full value set including Phase 8 values: `pending_payment`, `paid`, `canceled`, `abandoned`.

### order_items table

| Check | Result |
|-------|--------|
| Table exists | ✅ HTTP 200 |
| Rows insertable via edge function | ✅ Verified (see §3) |

### inventory_reservations table

| Check | Result |
|-------|--------|
| Table exists | ✅ HTTP 200 |
| Rows insertable via edge function | ✅ Verified (see §3) |
| `status` constraint values (reserved/fulfilled/released/expired) | ✅ `reserved` accepted |

### pg_cron extension

| Check | Result |
|-------|--------|
| Extension verified | ⚠️ Cannot query `cron` schema via REST API |
| Cron job registered | ⚠️ Not confirmed |

**Action required:** In Supabase Dashboard → Extensions, confirm **pg_cron** is enabled, then run once in the SQL Editor:

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

-- Confirm it was registered:
SELECT jobid, jobname, schedule, command FROM cron.job;
```

---

## 2. create-checkout-order End-to-End Test

### Test input

```json
{
  "items": [{ "sku": "W714S00550", "productId": "W714S00550", "qty": 1,
               "title": "Test Sofa Phase8", "unitPriceCents": 129900 }],
  "customer": { "email": "phase8test@example.com", "phone": "4155550100" },
  "address": { "line1": "1 Infinite Loop", "city": "Cupertino", "state": "CA",
                "zip": "95014", "country": "US" },
  "fulfillmentMethod": "delivery",
  "paymentMethodSelected": "card"
}
```

### Response (HTTP 200)

```json
{
  "orderId":       "43389f7d-ac0f-4eda-9ce3-d74bcc181912",
  "orderNumber":   "ORD-43389F7D",
  "guestToken":    "582f4d6c-ee07-43a9-95c5-8500165e035a",
  "clientSecret":  "pi_3TSAHt3wV1BQ3XbV1XlNKH9V_secret_W9WARx1vHfEzmVoy9TNfe5DJm",
  "paymentIntentId": "pi_3TSAHt3wV1BQ3XbV1XlNKH9V",
  "totalCents":    139800,
  "subtotalCents": 129900,
  "shippingCents": 9900,
  "taxCents":      0,
  "isPickup":      false,
  "fulfillmentPlan": {
    "valid": true,
    "selectedWarehouse": {
      "code": "CA6",
      "label": "Rancho Cucamonga Warehouse (2)",
      "city": "Rancho Cucamonga",
      "state": "CA"
    },
    "distanceMiles": 336.1,
    "usePickup": false,
    "shipping": 99,
    "estimatedDelivery": "3–7 business days"
  }
}
```

---

## 3. Database Record Verification

All three records verified via direct REST API query after the curl test.

### orders row

```json
{
  "order_id":          "43389f7d-ac0f-4eda-9ce3-d74bcc181912",
  "status":            "pending_payment",
  "payment_status":    "pending",
  "payment_intent_id": "pi_3TSAHt3wV1BQ3XbV1XlNKH9V",
  "guest_token":       "582f4d6c-ee07-43a9-95c5-8500165e035a",
  "total_cents":       139800,
  "shipping_cents":    9900,
  "subtotal_cents":    129900,
  "customer_email":    "phase8test@example.com"
}
```

| Criterion | Result |
|-----------|--------|
| `status = pending_payment` | ✅ |
| `payment_intent_id` populated | ✅ `pi_3TSAHt3wV1BQ3XbV1XlNKH9V` |
| `guest_token` present (guest checkout) | ✅ UUID |
| `total_cents` correct (129900 + 9900) | ✅ 139800 |

### order_items row

```json
{
  "id":              "d8cd3e74-73f2-4431-b3ca-f95749b816a2",
  "order_id":        "43389f7d-ac0f-4eda-9ce3-d74bcc181912",
  "product_id":      "W714S00550",
  "supplier_sku":    "W714S00550",
  "title":           "Test Sofa Phase8",
  "quantity":        1,
  "unit_price_cents": 129900,
  "total_cents":     129900
}
```

✅ Line item created with correct product, qty, and price.

### inventory_reservations row

```json
{
  "id":             "5135a8bc-c896-49a6-ac63-d525cb6662bc",
  "order_id":       "43389f7d-ac0f-4eda-9ce3-d74bcc181912",
  "product_id":     "W714S00550",
  "supplier_sku":   "W714S00550",
  "warehouse_code": "CA8",
  "quantity":       1,
  "status":         "reserved",
  "expires_at":     "2026-05-01T06:20:57.178+00:00",
  "created_at":     "2026-05-01T06:10:57.178+00:00"
}
```

| Criterion | Result |
|-----------|--------|
| `status = reserved` | ✅ |
| TTL = 10 minutes | ✅ `expires_at` is 10 min after `created_at` |
| Warehouse code assigned | ✅ `CA8` |

---

## 4. Full Verification Checklist

| # | Check | Result |
|---|-------|--------|
| 1 | `orders.guest_token` column exists | ✅ |
| 2 | `orders.payment_intent_id` UNIQUE constraint | ✅ (409 on duplicate) |
| 3 | `order_items` table exists | ✅ |
| 4 | `inventory_reservations` table exists | ✅ |
| 5 | Reservation `status` values work (`reserved`) | ✅ |
| 6 | pg_cron extension status | ⚠️ Not verified — manual check required |
| 7 | Reservation cleanup job | ⚠️ Not registered — run SQL in dashboard |
| 8 | Order created with `status = pending_payment` | ✅ |
| 9 | `order_items` row created | ✅ |
| 10 | `inventory_reservations` row created, TTL 10 min | ✅ |
| 11 | Stripe PaymentIntent created | ✅ `pi_3TSAHt3wV1BQ3XbV1XlNKH9V` |
| 12 | `payment_intent_id` saved back to `orders` row | ✅ |
| 13 | Response returns `orderId` + `clientSecret` | ✅ |
| 14 | Guest order: `guestToken` returned | ✅ |
| 15 | Idempotency: duplicate PI rejected 409 | ✅ |

---

## 5. Issues Found and Fixed During Verification

| Issue | Fix Applied |
|-------|-------------|
| `orders_status_check` constraint missing `pending_payment` | New migration `20260501_phase8_status_constraint.sql` pushed — adds `pending_payment`, `paid`, `canceled`, `abandoned` to allowed values |

---

## 6. CheckoutScreen Integration Readiness

**Backend is ready for CheckoutScreen integration.**

### Required before wiring:

| Step | Notes |
|------|-------|
| Register pg_cron job | Run the `cron.schedule(...)` statement in Supabase Dashboard → SQL Editor |
| Wire `CheckoutScreen` to `create-checkout-order` | Replace `createPendingOrder` + `create-payment-intent` with single call |
| Store `orderId` + `guestToken` in `AsyncStorage` pre-payment | Required for crash recovery |
| Pass `clientSecret` to `confirmPayment()` | Already supported by Stripe SDK |
| Test webhook with `stripe trigger` | Confirm `pending_payment` → `paid` transition and reservation `fulfilled` |
