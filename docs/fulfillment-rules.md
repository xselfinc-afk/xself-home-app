# Fulfillment Rules

This document is the source of truth for **Pickup** behavior. **Pickup is LOCKED.**
**Delivery is being redesigned separately** — Delivery changes must **not** alter any
Pickup rule below.

> ⚠️ **Do NOT change Pickup unless explicitly requested.** A Delivery redesign that
> touches pickup radius, fee, window, option, status flow, or the Pickup Pass is a
> regression. The test + guardrail listed below will fail if you do.

## 🔒 Locked Pickup rules

| Rule | Value | Authoritative source |
|------|-------|----------------------|
| Pickup radius | **CA warehouses 100 mi / approved out-of-state warehouses 50 mi** (dual-radius, approved 2026-07) | `supabase/functions/_shared/fulfillmentEligibility.ts` → `pickupRadiusMiles(state)` (`PICKUP_RADIUS_MILES_BY_STATE = { CA: 100 }`, `DEFAULT_PICKUP_RADIUS_MILES = 50`), consumed by `plan-fulfillment` (server-authoritative). Client no longer computes a radius. |
| Pickup fee | **Free ($0)** | `supabase/functions/create-checkout-order/index.ts` → `shippingCents = usePickup ? 0 : …`; `src/types/fulfillment.ts` → `PICKUP_FEE = 0` |
| Pickup time window | **10:00 AM – 2:00 PM** | `src/services/pickupDateService.ts` → `PICKUP_TIME_WINDOW` |
| Pickup date window | **+1 to +4 business days** after order day | `src/services/pickupDateService.ts` → `getPickupWindow` / `PICKUP_EARLIEST_BUSINESS_DAYS = 1`, `PICKUP_LATEST_BUSINESS_DAYS = 4` |
| No same-day pickup | Day 1 = order day; earliest = +1 business day | `getPickupWindow` |
| Weekdays only | Monday–Friday; weekends skipped | `addBusinessDays` / `isWeekend` |
| Customer-facing label | **"Warehouse Pickup" / "Pickup"** | `src/screens/CheckoutScreen.tsx`, `OrderSuccessScreen.tsx`, `OrdersScreen.tsx` |
| Pickup option gate | shown when `planHasPickup` + `setFulfillmentChoice('pickup')` | `src/screens/CheckoutScreen.tsx` |
| Pickup Pass flow | "View Pickup Pass" + statuses "Preparing Pickup" / "Pickup Ready" + Ordered → Ready for Pickup → Picked Up | `src/screens/OrdersScreen.tsx`, `src/screens/PickupPassScreen.tsx` |

### Notes
- Pickup radius is now **per warehouse state** (CA 100 mi, approved out-of-state 50 mi),
  centralized in `_shared/fulfillmentEligibility.ts` and consumed by `plan-fulfillment`. The old
  "two places must stay equal" client/server radius sync no longer applies — the client does not
  compute pickup eligibility; it calls the server advisory endpoint (see the section below).

## Dual-radius pickup & per-child eligibility (approved 2026-07)

- **Out-of-state pickup is an approved business capability.** Pickup is offered at a warehouse
  only when it stocks the SELECTED child SKU (qty > 0), is active, `supports_pickup = true`, has
  valid coordinates, and the buyer is within that warehouse's radius (CA 100 mi / approved OOS 50 mi).
- **Eligibility is selected-child and buyer-location dependent** — it cannot be a static per-SKU
  flag. `standardized_products.has_ca_pickup` is **legacy/coarse only** (CA-stock capability) and is
  NOT the final authority.
- **The server is authoritative.** `plan-fulfillment` (checkout) and the `fulfillment-eligibility`
  advisory endpoint (PDP/Cart) both resolve via the shared `_shared/fulfillmentEligibility.ts`.
  Checkout/order creation remains the final authority; advisory results are cached by
  (childSku + normalized ZIP, ~5 min) and never reused across siblings.
- **Family cards must not make per-child fulfillment claims** (no pickup/shipping/warehouse/
  distance/delivery-fee on a collapsed card) — those depend on the selected child + buyer location.
- Approved out-of-state pickup warehouses (`supports_pickup = true`): GA `AT1 AT2 AT3 AT4 AT5 ATN1
  ATX4 ATX6`, MD `NJX3`, NJ `NJ1 NJ2 NJ3 NJ4 NJ5 NJX6`, TX `TX1 TXX1 TXX2` (18 total). CA warehouses
  unchanged. See the 18-code migration in `supabase/migrations/`.
- The edge function's ETA string says "Pickup available in 2–5 days"; the actual date
  math is **+1 to +4 business days**. If the wording is ever reconciled, keep the
  date math (the locked rule) unchanged.

## Delivery (NOT locked — being redesigned)
- Delivery / "shipping" fee: `SHIPPING_FEE = 99` (`src/types/fulfillment.ts`) and
  `plan-fulfillment` `SHIPPING_FEE = 99`. This may change with the Delivery redesign.
- Changing the delivery fee or eligibility must **not** touch any Pickup rule above.

## Protecting these rules

```bash
# Pure-function unit test (constants + pickup date window):
npx tsx src/__tests__/pickupRules.test.ts

# Static guardrails (radius/fee/window sync + checkout pickup branch + Orders pickup pass):
npm run guard:prod      # "Pickup rule lock" = Check 13
```

Both must pass before shipping any Delivery change. They fail loudly if a locked
Pickup rule is altered.
