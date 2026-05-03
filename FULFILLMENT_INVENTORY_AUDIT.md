# Fulfillment & Inventory Audit
**Date:** 2026-04-30  
**Auditor:** Claude Code  
**Scope:** Checkout inventory check, warehouse-distance logic, fulfillment selection, order protection

---

## Files Inspected

| File | Purpose |
|------|---------|
| `src/screens/CheckoutScreen.tsx` | Orchestrates inventory fetch, fulfillment planning, payment, order creation |
| `src/services/fulfillmentPlanner.ts` | Geocodes addresses, ranks warehouses by distance, assigns items to warehouses |
| `src/services/gigaInventoryService.ts` | Client wrapper that calls `giga-warehouse-stock` edge function |
| `src/services/gigaApiClient.ts` | HMAC-signed client for GIGA B2B API (product details, prices, SKU lists) |
| `src/services/geocodingService.ts` | Google Maps Geocoding API wrapper |
| `src/utils/distance.ts` | Haversine formula for straight-line distance |
| `src/data/warehouses.ts` | Hardcoded list of 35 warehouses with addresses |
| `supabase/functions/giga-warehouse-stock/index.ts` | Edge function: fetches/caches stock data, returns warehouse-level quantities |
| `supabase/functions/create-payment-intent/index.ts` | Creates Stripe PaymentIntent with idempotency key = orderId |
| `supabase/functions/stripe-webhook/index.ts` | Marks orders as paid after Stripe confirms |
| `supabase/functions/dynamic-pricing/index.ts` | Pricing engine reading inventory cache for demand signals |

---

## Section 1 — Inventory Check

### Current Behavior

1. **CheckoutScreen** calls `fetchSkuWarehouseStock(gigaSkus)` (line ~233) via `gigaInventoryService.ts`.
2. That invokes the Supabase edge function `giga-warehouse-stock` with the cart's SKU list.
3. The edge function runs a 3-tier cache strategy:
   - **Tier 1 — Fresh cache** (≤60 min): queries `inventory_cache` table; returns immediately if all SKUs are cached and fresh.
   - **Tier 2 — Live GIGA API**: calls `POST /b2b-overseas-api/v1/buyer/product/price/v1` (the **price** endpoint, not a stock endpoint).
   - **Tier 3 — Stale cache** (≤24 hr): if GIGA API fails, returns cached data with `stale: true`.
4. The edge function **synthesizes** stock from the price response: `skuAvailable=true` → qty=**999**, `skuAvailable=false` → qty=**0**. This synthesized quantity is then duplicated across **all 35 warehouse codes**.
5. If the edge function returns `stale: true`, CheckoutScreen blocks checkout with "Inventory data is temporarily outdated."
6. Before Stripe payment is submitted (card and Affirm paths), CheckoutScreen rechecks the fulfillment plan fingerprint to detect warehouse reassignments.

### What Is Real vs Mock/Static

| Aspect | Real? | Notes |
|--------|-------|-------|
| API call to GIGA for SKU availability | ✅ Real | Uses price endpoint, HMAC-signed |
| Per-warehouse stock quantities | ❌ Synthesized | `availableQty` = 999 or 0, not actual counts |
| Quantity vs cart quantity check | ⚠️ Partial | `qty >= item.qty` check exists, but qty is always 999 (never fails for available items) |
| Warehouse-level stock check | ❌ Fake | All 35 warehouses receive identical qty (999 or 0) |
| Cache freshness enforcement | ✅ Real | 60-min TTL, stale flag blocks checkout |
| Guest checkout inventory check | ✅ Yes | Same code path; no guest exemption |

### Bugs Found

**BUG-1 (High): Price API used as stock proxy — no real quantities**  
`giga-warehouse-stock/index.ts` calls `/product/price/v1` and synthesizes `availableQty=999` for all warehouses when `skuAvailable=true`. There is no call to a dedicated stock/inventory endpoint. The 999 quantity is fabricated and means the `qty >= item.qty` check in `fulfillmentPlanner.ts` can never fail for available products. Actual warehouse-level stock could be 0.

**BUG-2 (High): No inventory reservation**  
No reservation is written to the database or GIGA API when an order is placed. Two simultaneous checkouts for the last unit of a product both "succeed" — both see qty=999 and both place orders. Race conditions are structurally unavoidable in the current architecture.

**BUG-3 (Medium): SKU bridge fragility**  
The edge function attempts two lookup strategies for each SKU (direct by `product_id`, then bridge via `giga_products.item_code`). If both fail for a SKU, that SKU is treated as having no inventory data. In `fulfillmentPlanner.ts` (line 113–116), missing inventory data is treated as **out of stock** (strict policy). This is correct behavior but depends entirely on the `giga_products` table being populated and current.

---

## Section 2 — Warehouse Distance Logic

### Current Behavior

1. `warehouses.ts` defines **35 warehouses** with hardcoded string addresses — 14 in CA, 5 in NJ, 8 in GA (AT-prefix), 3 in TX, plus regional variants.
2. When `planFulfillment` or `planFulfillmentFallback` runs, it calls `geocodeAddress(w.address)` via the Google Maps Geocoding API for each warehouse.
3. Geocoded warehouse coordinates are cached in a **module-level Map** (`warehouseCoordCache`) — persists for the lifetime of the JS bundle.
4. User's address string is assembled from form fields and passed to `geocodeAddress()`, returning real `lat/lng` from Google.
5. `getDistanceMiles()` uses the Haversine formula (Earth radius = 3958.8 mi) to compute straight-line distance.
6. Warehouses are ranked by distance, pickup preferred if ≤30 miles and warehouse code starts with `CA`.

### What Is Real vs Mock/Static

| Aspect | Real? | Notes |
|--------|-------|-------|
| Warehouse addresses | ❌ Static | Hardcoded in `src/data/warehouses.ts`, not fetched from GIGA API |
| Warehouse geocoding | ✅ Real | Google Maps API, cached in module memory |
| User address geocoding | ✅ Real | Google Maps API each checkout session |
| Distance calculation | ✅ Real | Haversine math, accurate for straight-line |
| 30-mile pickup threshold | ✅ Enforced | `PICKUP_THRESHOLD_MILES = 30` constant, applied correctly |
| Pickup restriction to CA warehouses | ✅ Enforced | `/^CA/i.test(code)` gate |
| Warehouse names from GIGA API | ❌ No | Names come from hardcoded `warehouses.ts` |

### Why 0.0 mi Appears

The displayed distance comes directly from `distanceMiles` in the `FulfillmentGroup` returned by `planFulfillment`. Two conditions produce 0.0:

**Cause A (most likely):** The user's address form is incomplete or empty when the initial checkout render triggers `planFulfillment`. Google Geocoding of a partial address (e.g., just a city name) can resolve to a centroid that coincidentally maps very close to a CA warehouse. The nearest warehouse is selected and its distance rounds to 0.0.

**Cause B:** If `geocodeAddress` throws for an empty address string, the checkout catch path at line ~286–290 should set `deliveryErrorKind = 'geocode_failed'`. But if a **previously cached warehouse coordinate** is co-located with the user's fallback coords, the result passes through as 0.0.

**Cause C:** The user's device location or entered address genuinely places them near the Rancho Cucamonga warehouse (a real CA warehouse in the hardcoded list).

The 0.0 mi value is **not inherently wrong** — it means the geocoding pipeline ran and calculated a near-zero distance. The issue is that this is confusing and may indicate the plan was built on an incomplete address.

### Bug Found

**BUG-4 (Medium): Fulfillment plan is built before address is complete**  
`planFulfillment` is called whenever the address string changes (including partially typed). A plan built on a partial address produces a `distanceMiles` that may not reflect the user's real location. The plan is not invalidated when the address becomes complete — only the fingerprint comparison on re-check detects changes.

---

## Section 3 — Fulfillment Selection

### Current Behavior

1. **Strategy 1 (single warehouse):** Find the nearest warehouse that has all cart SKUs in stock. Pickup candidates (≤30 mi, CA-only) are prioritized first; then all other warehouses for shipping.
2. **Strategy 2 (multi-warehouse split):** If no single warehouse covers all SKUs, each item is assigned to the nearest warehouse with sufficient stock. Items with no stock data anywhere are assigned to the globally nearest warehouse (optimistic fallback).
3. User can toggle between pickup and delivery via UI; the app respects the choice and recalculates shipping totals accordingly.
4. Selected fulfillment groups are passed into `createPendingOrder` → `OrdersContext` → Supabase `fulfillment_groups_json` column.

### What Is Real vs Mock/Static

| Aspect | Real? | Notes |
|--------|-------|-------|
| Pickup shown only when near enough | ✅ Yes | 30-mile threshold strictly enforced |
| Pickup shown only for CA warehouses | ✅ Yes | `/^CA/i` gate |
| Delivery fallback when no pickup qualifies | ✅ Yes | Strategy logic falls through to shipping |
| Mixed-cart multi-warehouse handling | ✅ Yes | Split fulfillment implemented |
| Fulfillment passed to order | ✅ Yes | `fulfillmentGroups` in `PlacedOrder` → Supabase |

### Bug Found

**BUG-5 (High): Optimistic no-stock assignment creates silent phantom orders**  
In `fulfillmentPlanner.ts` lines 188–199 (multi-warehouse Strategy 2 fallback): if no warehouse has stock for an item, the item is silently assigned to the nearest warehouse anyway with no stock, no warning, and `isFallback: false`. The plan looks legitimate but contains items assigned to a warehouse that can't fulfill them. This order reaches payment and is placed with no supplier ability to fulfill.

---

## Section 4 — Order Placement Protection

### Current Behavior

1. **Pre-payment recheck (card + Affirm):** Before calling Stripe, CheckoutScreen rebuilds the fulfillment plan from current address and live inventory. If the new plan fingerprint differs from the plan built at checkout load time, an error is shown and payment is blocked.
2. **Stale inventory blocks:** If the edge function returns `stale: true` at any point, checkout is blocked.
3. **Inventory API failure path:** If `fetchSkuWarehouseStock` throws, CheckoutScreen falls back to `planFulfillmentFallback` (geography-only, `isFallback: true`). This fallback plan **is used for payment** — the order is placed with `isFallback: true` in the plan.
4. **Payment can start before inventory is validated:** The initial checkout render starts an inventory fetch asynchronously. If the user taps "Place Order" before this fetch completes, the active plan is `null` and the button should be disabled — but this is UI-state dependent and not hard-gated.
5. **No second inventory check at final "Place Order" tap:** The fingerprint recheck happens at payment method entry, not at the final confirmation tap. There is a window between "enter card details" and "confirm" where inventory could change.

### What Is Real vs Mock/Static

| Aspect | Real? | Notes |
|--------|-------|-------|
| Inventory recheck before Stripe call | ✅ Yes | Fingerprint comparison on card + Affirm |
| Stale plan rejection | ✅ Yes | `stale: true` blocks checkout |
| Fallback plan used for orders | ❌ Risk | `isFallback: true` plan proceeds to payment with geography-only data |
| Final-tap stock gate | ❌ Missing | No inventory check at the moment the user confirms payment |
| Payment bypass when Stripe key missing | ⚠️ Dev only | `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` empty → skips payment entirely |

### Bugs Found

**BUG-6 (Medium): isFallback plan proceeds to payment**  
When `giga-warehouse-stock` fails (network error, API down), `planFulfillmentFallback` is used. This plan has `isFallback: true` but checkout does not block payment for fallback plans — it only blocks when `stale: true`. A user can pay for an order where no real inventory was confirmed.

**BUG-7 (Low): Race window at final confirmation**  
The fulfillment fingerprint recheck happens when the user enters/selects a payment method, not at the "Confirm" tap. If inventory or warehouse assignments change between those two moments, the stale plan is used.

---

## Summary Table

| Question | Answer | Confidence |
|----------|--------|-----------|
| Is live inventory checked before order placement? | ⚠️ Partial — GIGA price API confirms SKU exists, but quantities are synthesized (999/0); no real warehouse-level stock counts | High |
| Is warehouse distance real or fake/static? | ✅ Real math on static addresses — geocoding is real, Haversine is real, but warehouse address list is hardcoded | High |
| Why does pickup show 0.0 mi? | Incomplete/empty address geocodes to a point coinciding with or very near the nearest CA warehouse | Medium |
| Can a customer place an order for out-of-stock items? | ✅ Yes — via two paths: (1) fallback assigns items to nearest warehouse with no stock check, (2) no inventory is ever reserved | High |
| What exact files need fixing? | See below | High |

---

## Risk Assessment

| Risk | Level | Description |
|------|-------|-------------|
| Overselling out-of-stock products | 🔴 HIGH | Synthesis model + optimistic fallback means orders can be placed for items that have qty=0 |
| Race condition on last unit | 🔴 HIGH | No reservation system; two simultaneous checkouts for the same item both succeed |
| Geography-only fallback reaches payment | 🟠 MEDIUM | `isFallback: true` plan not blocked at payment |
| Stale warehouse addresses | 🟡 LOW | Warehouse addresses are hardcoded; if GIGA closes/moves a warehouse, the app doesn't know |
| 0.0 mi display confuses users | 🟡 LOW | Visual/UX issue; not a data integrity risk |

---

## Recommended Fixes

### Fix 1 — Replace price-synthesis with real stock data (HIGH priority)
**File:** `supabase/functions/giga-warehouse-stock/index.ts`  
**Issue:** BUG-1  
If GIGA B2B API offers a dedicated stock/inventory endpoint, call it instead of the price endpoint. If not available, keep the synthesis model but add a clear `isSynthesized: true` flag in the inventory response and surface this as a warning in CheckoutScreen (not a hard block, but an indication).

### Fix 2 — Block isFallback plans at payment (MEDIUM priority)
**File:** `src/screens/CheckoutScreen.tsx`  
**Issue:** BUG-6  
Before calling Stripe (card, Affirm, Apple Pay), check `activePlan.isFallback`. If true, show an error: "We couldn't verify real-time inventory for your order. Please try again." — same treatment as `stale: true`. This prevents orders being placed without any inventory confirmation.

```typescript
// Add to pre-payment guard (same location as stale check)
if (activePlan?.isFallback) {
  setRecheckError('Inventory data unavailable. Please refresh and try again.');
  return;
}
```

### Fix 3 — Block optimistic no-stock fallback assignment (HIGH priority)
**File:** `src/services/fulfillmentPlanner.ts` lines 188–199  
**Issue:** BUG-5  
When an item has no stock at any warehouse, currently it is silently assigned to the nearest warehouse. Instead, throw or return a plan with an `unfulfilledSkus` field so CheckoutScreen can show "One or more items are currently unavailable" and block payment.

```typescript
if (!assigned) {
  // Previously: silently assign to nearest warehouse
  // New: surface as unfulfillable
  unfulfilledSkus.push(item.sku);
}
// After loop: if unfulfilledSkus.length > 0, throw or return plan with unfulfilledSkus
```

### Fix 4 — Validate address completeness before building fulfillment plan (MEDIUM priority)
**File:** `src/screens/CheckoutScreen.tsx`  
**Issue:** BUG-4  
Only call `planFulfillment` when the address has all required fields (line1, city, state, zip) filled in. Show a placeholder plan UI with "Enter your address to see fulfillment options" rather than triggering a geocode on a partial address. This eliminates the 0.0 mi display.

### Fix 5 — Add a final inventory stamp at Place Order (LOW priority)
**File:** `src/screens/CheckoutScreen.tsx`  
**Issue:** BUG-7  
At the moment the user taps the final "Place Order" / "Pay" button (before `createPendingOrder`), perform one more lightweight inventory check or at minimum validate that `activePlan` was built within the last N minutes. Reject if the plan is too old.

---

## App Store Safety

**Is this App Store safe?**  
✅ Yes — the current code produces no crashes or hangs. The fulfillment logic errors are silent data issues, not UI crashes. App Store reviewers will not trigger these bugs during review.

## Production-Order Safety

**Is this production-order safe?**  
❌ **No** — for the following reasons:

1. Orders can be placed for items at qty=0 (BUG-5, optimistic fallback)
2. No inventory reservation means two users can buy the last unit simultaneously (BUG-2)
3. Geography-only fallback plans reach payment (BUG-6)
4. Actual warehouse stock levels are never fetched — only a binary available/unavailable signal from the price endpoint (BUG-1)

These are **fulfillment integrity risks**, not payment risks. Payment itself is handled by Stripe and is safe. The risks are: orders being received by suppliers that cannot be fulfilled, requiring manual cancellation and refund.

**Minimum fix before production orders:** Fix 2 (block isFallback plans) and Fix 3 (block no-stock optimistic assignment). These two changes prevent the worst-case scenario of placing an order with no real inventory backing.
