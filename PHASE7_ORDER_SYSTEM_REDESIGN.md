# Phase 7 Order System Redesign — Architecture
**Date:** 2026-04-30  
**Status:** Design only — no implementation  
**Principle:** Server authority > client control. Stripe is the source of truth.

---

## Executive Summary

The current system is client-authoritative: the app creates orders, confirms payments, and writes order records. If the client dies mid-flow, the order is lost. Guest orders never reach the DB. No inventory is ever reserved or decremented.

The redesign inverts this: the client initiates payment and the Stripe webhook finalizes everything. The client's post-payment write becomes a performance optimization, not the authoritative path.

```
CURRENT (client-authoritative)
  Client → validate → createPendingOrder → Stripe → confirmOrder → done
                                              ↓
                                         [client dies] → broken state

REDESIGNED (server-authoritative)
  Client → validate → reserve → Stripe → [client tries to confirm]
                                    ↓
                             stripe-webhook → upsert order → deduct inventory → email
                                    ↓
                             [client dies] → webhook still completes everything
```

---

## Current vs New: Behavior Comparison

| Behavior | Current System | Redesigned System |
|----------|---------------|-------------------|
| Order record created | After payment succeeds (client-side) | Before payment begins (server-side) |
| Guest order in DB | ❌ Never written — local React state only | ✅ Written pre-payment with `user_id=null`, `guest_token` for lookup |
| Order ID before Stripe | ✅ Yes (used as Idempotency-Key) | ✅ Yes (same) |
| Inventory reserved | ❌ Never | ✅ TTL soft lock on `inventory_reservations` after validation passes |
| Inventory decremented after payment | ❌ Never | ✅ Reservation marked `fulfilled` in webhook; permanent deduction via scraper |
| Authoritative order confirmation | Client `finishOrder()` → DB write | Stripe `payment_intent.succeeded` webhook → upsert |
| Client crash after payment | Order stays `pending` in DB forever | Webhook fires regardless → order confirmed, inventory settled |
| Webhook signature verification | ❌ Missing | ✅ Required — rejects unsigned POSTs |
| Idempotency | Partial (Stripe PI key; no DB constraint) | Full — `payment_intent_id UNIQUE` on `orders` table |
| Guest order recovery | ❌ Impossible (no DB record) | ✅ Query by `guest_token` or `payment_intent_id` |
| Abandoned cart cleanup | ❌ Orphaned `pending` rows accumulate | ✅ `pg_cron` expires stale reservations; pending orders aged >30min → `abandoned` |
| Payment failure handling | Client error state only | Webhook marks order `failed`, releases reservation |
| Duplicate webhook safety | No protection | `ON CONFLICT (payment_intent_id) DO UPDATE` is a no-op for duplicate events |

---

## 1. Inventory Reservation Strategy

### Option A — Reserve before payment (TTL soft lock)

Insert a `reservations` row per SKU when `validate-checkout-inventory` passes. The validation function subtracts active reservations from available qty. Reservations expire automatically (TTL) if payment is abandoned.

```
validate-checkout-inventory:
  available = inventory_cache.quantity - active_reservations.qty
  if available >= requested_qty → pass + insert reservation (TTL=10min)
  else → fail

payment_intent.succeeded webhook:
  → mark reservation as fulfilled (permanent deduction)

payment_intent.payment_failed / canceled:
  → release reservation

pg_cron (every 5 min):
  → DELETE FROM reservations WHERE expires_at < now() AND status = 'pending'
```

### Option B — Atomic check-and-deduct after payment

No reservation. On `payment_intent.succeeded`, atomically check qty and deduct. If qty is zero at that moment, issue a Stripe refund and set order status to `refund_pending`.

```sql
UPDATE inventory_cache
SET quantity = quantity - requested_qty
WHERE product_id = $pid AND warehouse_code = $wh AND quantity >= requested_qty
RETURNING quantity;
-- 0 rows updated → oversold → trigger refund
```

### Recommendation: **Option A (Soft Reservation)**

**Reasoning:**

For a furniture/home goods store, items are expensive and per-SKU quantities are typically low (often 1–5 units per warehouse). The cost of an oversell is:
- Fulfillment team picks a sold-out item
- Customer is charged and then refunded — extremely damaging to trust
- At $500–$2,000 per order, a refund feels like a scam to the customer

Option B may result in charging a customer for something that can't be shipped. Option A prevents the charge from happening. This is the model used by all major furniture retailers (IKEA, Wayfair, Article).

The downside of Option A (phantom unavailability during cart abandonment) is a business operations concern, not a correctness concern. Cart abandonment TTLs of 10 minutes are industry standard and acceptable.

**The reservation does NOT replace `validate-checkout-inventory`.** The reservation is created only after the validation passes. The edge function both validates AND inserts the reservation in a single DB transaction.

---

## 2. Order Persistence Model

### Core principle: guest orders are first-class orders

The only difference between a guest order and an authenticated order is `user_id = null`. RLS must allow inserts with `user_id = null` for the webhook service role.

### Schema additions / changes

**`orders` table — additional columns needed:**

| Column | Type | Notes |
|--------|------|-------|
| `payment_intent_id` | `text UNIQUE` | Stripe PI ID — the idempotency key for order confirmation. NULL until PI is created. |
| `guest_token` | `uuid` | Random UUID for guest order lookup. Generated client-side, stored pre-payment. |
| `checkout_session_id` | `text` | App-level session ID (already exists in metadata) — for debugging |
| `source` | `text` | `'guest'` or `'authenticated'` — for analytics |

**`user_id` must become nullable** if it isn't already. RLS policy: service role (webhook) bypasses RLS; anon role cannot insert with `user_id = null` directly (webhook handles all writes for guest orders).

**`inventory_reservations` table (new):**

```sql
CREATE TABLE inventory_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      text NOT NULL,          -- FK → orders.order_id
  product_id    text NOT NULL,          -- FK → inventory_cache.product_id
  warehouse_code text NOT NULL,
  qty           integer NOT NULL CHECK (qty > 0),
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'fulfilled', 'released')),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id, warehouse_code)
);

CREATE INDEX ON inventory_reservations (status, expires_at);
CREATE INDEX ON inventory_reservations (order_id);
```

**Minimal order creation payload (server-side, via webhook):**

```json
{
  "order_id": "<uuid>",
  "payment_intent_id": "pi_xxx",
  "user_id": null,
  "guest_token": "<uuid>",
  "status": "processing",
  "payment_status": "paid",
  "total": 1299.00,
  "items_json": [...],
  "address_json": {...},
  "fulfillment_groups_json": [...],
  "financials": {...}
}
```

### Guest order lookup flow (post-redesign)

1. Client generates `guest_token` (UUID) before checkout begins
2. `guest_token` is stored in `AsyncStorage` on device before payment
3. Client sends `guest_token` to `create-payment-intent` edge function → stored in PI metadata
4. Webhook extracts `guest_token` from metadata → writes to `orders` table
5. Guest can look up order at any time via `guest_token` (no auth required)
6. Optional: confirmation email sent server-side with order link containing `guest_token`

---

## 3. Stripe Webhook as Source of Truth

### Webhook events to handle

| Event | Action |
|-------|--------|
| `payment_intent.succeeded` | Upsert order (paid), mark reservation fulfilled, send confirmation email |
| `payment_intent.payment_failed` | Update order status to 'failed', release reservation |
| `payment_intent.canceled` | Update order status to 'cancelled', release reservation |
| `payment_intent.processing` | Update payment_status to 'processing' (rare — bank delays) |

### `payment_intent.succeeded` handler (full logic)

```
1. Verify Stripe webhook signature (STRIPE_WEBHOOK_SECRET)
   → Return 400 on signature failure

2. Extract from PaymentIntent metadata:
   - order_id
   - guest_token
   - user_email
   - sku_list
   - fulfillment_choice
   - checkout_session_id

3. Upsert order row:
   INSERT INTO orders (..., payment_intent_id, payment_status, status)
   VALUES (...)
   ON CONFLICT (payment_intent_id) DO UPDATE SET
     status = EXCLUDED.status,
     payment_status = EXCLUDED.payment_status,
     stripe_payment_intent_id = EXCLUDED.stripe_payment_intent_id
   -- Idempotent: safe to call multiple times

4. Mark reservations as fulfilled:
   UPDATE inventory_reservations
   SET status = 'fulfilled'
   WHERE order_id = $order_id AND status = 'pending'

5. Send confirmation email (via Resend/SendGrid/Supabase email)

6. Return HTTP 200 to Stripe
```

**Critical:** Return 200 to Stripe even if steps 4–5 fail (after step 3 succeeds). Stripe interprets non-2xx as "retry me." If order write succeeded but email failed, retrying the entire webhook would re-attempt an idempotent upsert (safe) and resend the email (acceptable — guard with a sent_at timestamp).

### `payment_intent.payment_failed` handler

```
1. Verify signature
2. Find order by payment_intent_id
3. UPDATE orders SET status='failed', payment_status='failed' WHERE payment_intent_id = $pi
4. UPDATE inventory_reservations SET status='released' WHERE order_id = $order_id
5. Return 200
```

### Webhook signature verification (required — currently missing)

The existing `stripe-webhook` function must validate the `Stripe-Signature` header using `STRIPE_WEBHOOK_SECRET`. Without this, any attacker can POST a fake `payment_intent.succeeded` event to create fraudulent orders.

```typescript
const sig = req.headers.get('stripe-signature');
const event = Stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
```

---

## 4. Idempotency Model

### Three-level idempotency chain

```
Level 1 — Stripe PI creation:
  orderId used as Stripe Idempotency-Key
  → Same orderId always returns same PI, never creates a second charge

Level 2 — Order row creation:
  payment_intent_id as UNIQUE constraint
  → Webhook can fire 10 times; first write wins; all subsequent are no-ops

Level 3 — Reservation fulfillment:
  ON CONFLICT (order_id, product_id, warehouse_code) DO NOTHING on insert
  UPDATE ... WHERE status='pending' is idempotent (already-fulfilled row unchanged)
```

### Full sequence (no race conditions)

```
[Client]
  1. Generate: orderId (UUID), guestToken (UUID), checkoutSessionId
  2. Store orderId + guestToken in AsyncStorage (pre-payment)
  3. Call validate-checkout-inventory + create reservation (atomic, single edge fn call)
  4. Call create-payment-intent with Idempotency-Key=orderId
  5. Call confirmPayment() via Stripe SDK

[Client — optimistic, non-authoritative]
  6. Try finishOrder() → attempts DB write to confirm order
     → Success: order confirmed early, user sees OrderSuccess immediately
     → Failure: show recovery banner, but webhook will finish it anyway

[Stripe — authoritative]
  7. payment_intent.succeeded fires
  8. stripe-webhook: upsert order, fulfill reservation, send email
  9. Returns 200

[Client — on next app open, if step 6 failed]
  10. Read orderId from AsyncStorage
  11. Query orders table WHERE order_id = $orderId
  12. If status='processing' → show OrderSuccess (webhook completed it)
  13. If status='pending' → payment may still be processing (check Stripe PI status)
```

---

## 5. Recovery Model

### Client-side persistence (pre-payment)

Before calling `create-payment-intent`, store the following in `AsyncStorage`:

```json
{
  "pendingCheckout": {
    "orderId": "uuid",
    "guestToken": "uuid",
    "amount": 129900,
    "itemCount": 2,
    "startedAt": "2026-04-30T22:00:00Z",
    "ttl": "2026-04-30T22:30:00Z"
  }
}
```

On app launch, if `pendingCheckout` exists and TTL has not expired:
1. Query `orders` table by `orderId`
2. If `payment_status = 'paid'` → webhook already finished → show OrderSuccess
3. If not found or `status = 'pending_payment'` → Stripe payment may be processing → show "Checking order status..." UI
4. If TTL expired → clear `pendingCheckout` — treat as abandoned

### No reliance on in-memory state

The `recoveryRef` React state variable can remain as a fast-path UI optimization but is not the recovery mechanism. The authoritative recovery path is:

```
Stripe webhook fires → DB updated → app queries DB on next open → order found
```

This works even if:
- App is killed during `confirmPayment`
- Device loses network after Stripe succeeds
- User is a guest (order written to DB by webhook, not by client)
- `finishOrder` throws on the client side

---

## 6. Failure Handling Matrix

| Scenario | Detection | Server Action | Client UX |
|----------|-----------|--------------|-----------|
| Client dies after PI created, before payment confirmed | Stripe has PI in 'requires_payment_method' or 'requires_confirmation' | None — PI not confirmed | App restart reads AsyncStorage → PI not succeeded → show "payment didn't complete" |
| Client dies after payment succeeds | Stripe has PI in 'succeeded' | Webhook fires → upsert order, fulfill reservation | App restart → query DB → order found → show OrderSuccess |
| Webhook fires, DB write fails | Stripe gets non-200 | Stripe retries with exponential backoff (up to 72 hours) | User already paid — recovery banner if client `finishOrder` also failed |
| Webhook fires, DB write succeeds, email fails | 200 returned to Stripe (email failure is non-fatal) | Alert/log email failure | User receives no email — support can resend manually |
| Payment succeeds, inventory at zero (option A reservation expired) | Deduct step in webhook finds no active reservation | Webhook logs alert — fulfillment team notified | Order is confirmed (payment taken) — ops team must contact customer |
| Payment fails | `payment_intent.payment_failed` event | Release reservation, mark order failed | Error message in checkout |
| Payment cancelled by user | `payment_intent.canceled` event | Release reservation, mark order cancelled | User remains on checkout screen |
| Same webhook fires twice | Duplicate PI ID | Upsert ON CONFLICT is no-op | No effect |
| Fake webhook POST (no valid signature) | Signature verification fails → 400 | Request rejected | No effect |
| Reservation TTL expires before user pays | pg_cron deletes expired reservation | Next `validate-checkout-inventory` call returns insufficient_qty | Checkout screen shows "Item no longer available" |

### Stripe webhook retry strategy

Stripe retries failed webhooks at: 5s, 30s, 2m, 10m, 30m, 2h, 5h, 10h, 24h, 48h, 72h.

The webhook must be idempotent at every step. Any transient DB failure resolves on Stripe's next retry. The only unrecoverable failure is a permanent DB outage lasting >72 hours — in that case, reconcile manually via Stripe Dashboard.

---

## Architecture Diagram (Full Redesigned Flow)

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (App)                            │
│                                                                 │
│  1. generate orderId, guestToken                                │
│  2. AsyncStorage.setItem('pendingCheckout', {...})              │
│  3. invoke('validate-and-reserve', {items, address, orderId})   │
│     ↓ reservation created in DB (TTL=10min)                     │
│  4. invoke('create-payment-intent', {orderId, amount, ...})     │
│     ↓ Stripe PI created with Idempotency-Key=orderId            │
│  5. stripe.confirmPayment(clientSecret)                         │
│     ↓ Stripe processes payment                                  │
│  6. [optimistic] invoke finishOrder() → updateOrder in DB       │
│     ↓ may succeed or fail — not authoritative                   │
│  7. navigate to OrderSuccess (optimistic)                       │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Stripe events (authoritative)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    stripe-webhook (Edge Function)               │
│                                                                 │
│  payment_intent.succeeded:                                      │
│    1. verify signature                                          │
│    2. upsert orders ON CONFLICT (payment_intent_id)            │
│    3. UPDATE reservations SET status='fulfilled'                │
│    4. send confirmation email                                   │
│    5. return 200 to Stripe                                      │
│                                                                 │
│  payment_intent.payment_failed / canceled:                      │
│    1. verify signature                                          │
│    2. UPDATE orders SET status='failed'                         │
│    3. UPDATE reservations SET status='released'                 │
│    4. return 200 to Stripe                                      │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    pg_cron (scheduled)                          │
│  every 5 min: DELETE FROM reservations                          │
│               WHERE expires_at < now() AND status='pending'     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Edge Function Changes Required

| Function | Change |
|----------|--------|
| `validate-checkout-inventory` | **Split or extend:** also insert reservation atomically on success. New name: `validate-and-reserve`. Returns `reservationId` alongside `valid`. |
| `stripe-webhook` | **Major rewrite:** add signature verification, handle `payment_intent.succeeded/failed/canceled`, upsert guest orders, fulfill/release reservations. |
| `create-payment-intent` | **Minor:** add `guest_token` to PI metadata. No other changes. |
| `plan-fulfillment` | **No change.** |

---

## What Does NOT Change

| Component | Status |
|-----------|--------|
| `plan-fulfillment` edge function | Unchanged |
| Checkout UI layout, colors, payment UI | Unchanged |
| Stripe SDK integration (`confirmPayment`, `confirmPlatformPayPayment`) | Unchanged |
| Address flow | Unchanged |
| Authenticated user order history | Unchanged behavior — gains webhook confirmation as backup path |
| RLS on `standardized_products` | Unchanged |
| `validate-checkout-inventory` validation rules | Unchanged — only gains the reservation insert step |

---

## Implementation Sequence (When Ready)

1. **DB migrations:** Add `payment_intent_id` (UNIQUE) and `guest_token` to `orders`. Create `inventory_reservations` table. Add pg_cron job.
2. **`validate-and-reserve` edge function:** Merge validation + reservation insert in one DB transaction.
3. **`stripe-webhook` rewrite:** Add signature verification + order upsert + reservation fulfillment/release.
4. **CheckoutScreen:** Send `guest_token` in PI metadata. Store `pendingCheckout` in AsyncStorage pre-payment. Add startup recovery check.
5. **OrdersContext:** Allow `createPendingOrder` to write guest orders to DB (requires RLS relaxation or edge function write path for pending order creation).
6. **Test:** Simulate client kill mid-flow, duplicate webhook delivery, zero-inventory at webhook time, TTL expiry during checkout.
