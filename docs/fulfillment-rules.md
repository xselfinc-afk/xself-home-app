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
| Pickup radius | **100 miles** | `supabase/functions/plan-fulfillment/index.ts` → `PICKUP_THRESHOLD_MILES = 100` (server-enforced); mirrored in `src/config/delivery.ts` → `PICKUP_RADIUS_MILES = 100` |
| Pickup fee | **Free ($0)** | `supabase/functions/create-checkout-order/index.ts` → `shippingCents = usePickup ? 0 : …`; `src/types/fulfillment.ts` → `PICKUP_FEE = 0` |
| Pickup time window | **10:00 AM – 2:00 PM** | `src/services/pickupDateService.ts` → `PICKUP_TIME_WINDOW` |
| Pickup date window | **+1 to +4 business days** after order day | `src/services/pickupDateService.ts` → `getPickupWindow` / `PICKUP_EARLIEST_BUSINESS_DAYS = 1`, `PICKUP_LATEST_BUSINESS_DAYS = 4` |
| No same-day pickup | Day 1 = order day; earliest = +1 business day | `getPickupWindow` |
| Weekdays only | Monday–Friday; weekends skipped | `addBusinessDays` / `isWeekend` |
| Customer-facing label | **"Warehouse Pickup" / "Pickup"** | `src/screens/CheckoutScreen.tsx`, `OrderSuccessScreen.tsx`, `OrdersScreen.tsx` |
| Pickup option gate | shown when `planHasPickup` + `setFulfillmentChoice('pickup')` | `src/screens/CheckoutScreen.tsx` |
| Pickup Pass flow | "View Pickup Pass" + statuses "Preparing Pickup" / "Pickup Ready" + Ordered → Ready for Pickup → Picked Up | `src/screens/OrdersScreen.tsx`, `src/screens/PickupPassScreen.tsx` |

### Notes
- The 100-mile radius lives in **two** places (Deno edge function + frontend config)
  because they're across a runtime boundary and can't share an import. They must stay
  equal — the guardrail enforces sync.
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
