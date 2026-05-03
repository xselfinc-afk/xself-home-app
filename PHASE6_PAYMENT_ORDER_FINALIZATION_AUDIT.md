# Phase 6 Payment & Order Finalization Audit
**Date:** 2026-04-30  
**Scope:** Read-only analysis — no code changes made  
**Files reviewed:**
- `src/screens/CheckoutScreen.tsx` (full)
- `src/context/OrdersContext.tsx` (full)
- `supabase/functions/create-payment-intent/index.ts` (full)
- `supabase/functions/validate-checkout-inventory/index.ts` (full)

---

## 1. Inventory Validation BEFORE PaymentIntent

### Status: ✅ Correctly implemented on both payment paths

Both payment paths call `validate-checkout-inventory` before `createPendingOrder` and before any Stripe API call.

**Affirm path** (`CheckoutScreen.tsx:508–531`):
```
validate-checkout-inventory → [block if invalid]
→ createPendingOrder
→ create-payment-intent (Affirm)
→ confirmPayment
→ finishOrder
```

**Card / Apple Pay path** (`CheckoutScreen.tsx:1044–1068`):
```
validate-checkout-inventory → [block if invalid]
→ createPendingOrder
→ create-payment-intent (Card/ApplePay)
→ confirmPayment / confirmPlatformPayPayment
→ finishOrder
```

The gate checks real `inventory_cache` data (website_scrape only, fresher than 24h) and blocks both `createPendingOrder` and all Stripe calls when `valid=false`.

**Note:** There is a time window between the inventory check and the actual charge. See Risk #1 (no reservation).

---

## 2. Inventory Validation AFTER Successful Payment

### Status: ❌ NOT performed — explicit risk

After `confirmPayment` / `confirmPlatformPayPayment` returns success, neither path re-validates inventory. The post-payment code path is:

```
confirmPayment → ok
→ finishOrder(paymentIntentId)
  → confirmOrder(orderId, paymentIntentId) — sets status='processing', payment_status='paid'
  → navigate to OrderSuccess
```

There is no second `validate-checkout-inventory` call after payment is confirmed.

**Risk:** If another customer checks out the same item in the window between the first user's inventory check and their payment confirmation, both payments can succeed for the same unit of stock. This is the standard "oversell race condition" in ecommerce.

**Likelihood:** Low in current catalog size; increases with traffic. At scale, this is a production incident waiting to happen.

---

## 3. Idempotency Protection

### Status: ✅ Reasonably protected — one gap noted

**Strengths:**

| Mechanism | Where | Effect |
|-----------|-------|--------|
| `placing` state flag | `CheckoutScreen.tsx:1026` | Prevents double-tap / duplicate button press |
| `orderId` as Stripe `Idempotency-Key` | `create-payment-intent/index.ts:104` | Retrying the same checkout session reuses the existing PaymentIntent; no duplicate charge |
| `upsert(..., { ignoreDuplicates: true })` | `OrdersContext.tsx:219` | Duplicate `createPendingOrder` calls for the same `order_id` are silently no-ops in DB |
| `applyLocalOptimistic` dedup | `OrdersContext.tsx:192–195` | Prevents duplicate entries in local React state |
| `orderId` via `useRef` | `CheckoutScreen.tsx` | Stable per screen mount — doesn't regenerate on re-renders |

**Gap:** `orderId` is generated fresh on each `CheckoutScreen` mount. If the user navigates back and returns, they get a new `orderId`, potentially leaving an orphaned 'pending' order record in Supabase from the first mount. There is no cleanup of abandoned pending orders.

---

## 4. Inventory Reservation / Deduction

### Status: ❌ Neither exists — critical gap

**No reservation before payment:** The app does not write to `inventory_cache`, `standardized_products`, or any other table to reserve units when checkout begins or when `validate-checkout-inventory` passes. Multiple simultaneous shoppers see the same available quantity.

**No deduction after payment:** `finishOrder` → `confirmOrder` only updates `status` and `payment_status` on the `orders` table. No inventory decrement is applied to `inventory_cache` or any other table.

**Current inventory source of truth:** `inventory_cache` is updated exclusively by the Playwright scraper running against the supplier website. The scraper is the only write path.

**Gap summary:**

| Operation | Exists? | Location |
|-----------|---------|----------|
| Reserve inventory when checkout starts | ❌ No | — |
| Reserve inventory after validate-checkout-inventory passes | ❌ No | — |
| Decrement inventory after payment succeeds | ❌ No | — |
| Scraper sync (only update path) | ✅ Yes | External scraper → inventory_cache |

**Consequence:** If the scraper last ran 6 hours ago and showed qty=1, two customers can both check out that item successfully. Neither payment is blocked. Both orders are confirmed. The physical unit ships to one and the other receives a cancellation or delay.

---

## 5. Guest Order Persistence

### Status: ❌ Not persisted to DB — not acceptable for production

**Current behavior (`OrdersContext.tsx:204–227`):**

```typescript
const createPendingOrder = async (order: PlacedOrder): Promise<void> => {
  applyLocalOptimistic(order);          // in-memory only
  if (!user) {
    console.log('[Orders] Guest order kept locally; skipping Supabase write');
    return;                             // ← no DB write for guests
  }
  // ... Supabase upsert for authenticated users only
};
```

**`confirmOrder` for guests (`OrdersContext.tsx:241–242`):**

```typescript
if (!user) return;  // local state already updated above — no DB write
```

**What exists for a guest order after payment:**
- ✅ Local React state (in-memory) — visible until app is killed
- ✅ Stripe PaymentIntent with `order_id` in metadata
- ✅ OrderSuccess screen is shown
- ❌ No order record in Supabase `orders` table
- ❌ No server-side fulfillment record
- ❌ No order confirmation email (no server has the order)
- ❌ Order is lost when app is closed or backgrounded long enough to be evicted

**Practical consequences:**

| Scenario | Impact |
|----------|--------|
| Guest closes app after payment | Order is gone — cannot show order history |
| Support team looks up order | Cannot find it — only Stripe PaymentIntent exists |
| Warehouse team needs to fulfill | No record — cannot fulfill without manual reconciliation |
| Guest requests refund | Support must manually reconcile Stripe PaymentIntent with no DB order record |
| Guest wants to track shipping | No order in app — tracking screen shows nothing |

**Assessment:** Acceptable for a closed-beta or demo environment. Not acceptable for production ecommerce. Any payment that succeeds should produce a durable server-side record regardless of who the customer is.

---

## 6. Failure Handling — Payment Succeeds, Order Write Fails

### Status: ⚠️ Recovery UI exists but has significant gaps

**The failure scenario:**
1. Payment confirmed by Stripe → `paymentIntentId` returned
2. `finishOrder(paymentIntentId)` called → `confirmOrder` throws
3. `setRecoveryRef(paymentIntentId)` is set

**Recovery mechanism (`CheckoutScreen.tsx:1001–1023`, `OrdersContext.tsx:229–268`):**

The checkout screen shows a recovery banner:
> "Payment received — order not confirmed. Please contact support with reference: `pi_xxx`"

A "Try Again" button calls `handleRecoveryRetry()` → `confirmOrder` again.

**Gaps in the recovery mechanism:**

| Gap | Risk |
|-----|------|
| `recoveryRef` is in-memory React state | If user kills the app or swipes it away, `recoveryRef` is gone — the order is permanently unconfirmed in DB (status stays 'pending') |
| Guest checkout: `confirmOrder` returns immediately without DB write | For guests, this path never fails (no DB write attempted), so no recovery needed — but also no durable record |
| No background retry or push notification | If the user dismisses the recovery banner and closes the app, the order stays as 'pending' forever |
| `cancelOrder` called on payment failure — but not on `confirmOrder` failure | If the DB write to confirm an order fails AFTER payment succeeds, `cancelOrder` is NOT called (correct — the payment went through). But the DB record stays as 'pending' with `payment_status='pending'` — inconsistent with the Stripe side showing 'succeeded' |
| No server-side webhook confirmation | `stripe-webhook` function exists but this audit did not confirm it updates order status server-side. If it does not, Stripe-side success with client-side DB failure is an unrecoverable divergence without manual support intervention |

**The critical scenario:**
```
Stripe charge succeeds ($1,200 charged)
↓
Network drops between confirmPayment() and finishOrder()
↓
confirmOrder() never called OR throws
↓
User closes app
↓
Order stays as 'pending' / 'payment_status=pending' in DB
↓
Stripe shows payment_status='succeeded'
↓
No fulfillment triggered
↓
Customer charged, no order processed
```

---

## Risk Priority Matrix

| # | Risk | Severity | Likelihood | Impact |
|---|------|----------|-----------|--------|
| R1 | No inventory reservation or deduction — oversell race condition | **CRITICAL** | Medium (grows with traffic) | Oversell, cancellations, customer complaints |
| R2 | Guest orders not persisted to DB | **HIGH** | Certain (every guest order) | Unfulfillable orders, support burden, compliance |
| R3 | `recoveryRef` is in-memory — lost on app kill | **HIGH** | Low (network failure timing) | Customer charged, no order, no support ref |
| R4 | No post-payment inventory revalidation | **MEDIUM** | Low-Medium | Same as R1 but narrower window |
| R5 | Abandoned pending orders from multi-mount | **LOW** | Medium | DB clutter; status confusion |
| R6 | No confirmed server-side webhook order flow | **MEDIUM** | Low | Divergence between Stripe and DB on failure |

---

## Recommendations (No Implementation — Analysis Only)

### R1 — Inventory reservation/deduction
**Option A (server-side deduction):** After `confirmOrder`, call an Edge Function that decrements `inventory_cache.quantity` for the purchased SKUs. The scraper's next run will overwrite these with fresh values — acceptable since the supplier site reflects the sale.

**Option B (DB-level soft reservation):** Add a `reservations` table. Insert a reservation row when `validate-checkout-inventory` passes. Expire reservations after 10 minutes. The validate function subtracts active reservations from available qty. Delete reservation after payment fails; mark reservation fulfilled after payment succeeds.

**Option B is strongly preferred** as it closes the oversell window. Option A only applies after the fact.

### R2 — Guest order persistence
Write guest orders to Supabase with `user_id = null` (requires RLS policy that allows insert with null user_id). Store a `guest_token` (random UUID generated client-side) that the guest can use to look up their order. Send a confirmation email via the order webhook.

### R3 + R6 — Server-side order confirmation via Stripe webhook
The `stripe-webhook` Edge Function should handle `payment_intent.succeeded` events and update the matching order record to `payment_status='paid', status='processing'` server-side. This makes `finishOrder` non-critical — even if the client-side call fails, the webhook catches it. Requires storing the `paymentIntentId` on the pending order row before calling Stripe (currently done: `orderId` is in Stripe metadata, and the pending order is written before payment).

### R4 — Post-payment inventory revalidation
Lower priority given R1 (reservation). If reservation is implemented, this gap closes automatically. Without reservation, a second `validate-checkout-inventory` call immediately after payment adds minimal protection (still a race, just narrower).

### R5 — Orphaned pending orders
Add a Supabase scheduled job (pg_cron) to mark orders older than 30 minutes with `status='pending'` and `payment_status='pending'` as 'abandoned'. This keeps the DB clean and makes dashboards accurate.
