# Xself Home Manual Test Checklist

All debug flags live in `src/config/debugFlags.ts`.
Set a flag to `true`, run the test, then reset to `false`.

---

## Before Testing

- Confirm git backup exists (`git log --oneline -3`)
- Confirm all flags are `false` in `debugFlags.ts`
- Run: `npx tsc --noEmit --skipLibCheck`

---

## Inventory Fallback Test (P1-B)

**Flag:** `forceInventoryFallback: true`

1. Set `forceInventoryFallback = true` in `debugFlags.ts`
2. Open Checkout screen
3. Confirm **DEBUG MODE** badge appears at top
4. Confirm fallback banner appears: "Live inventory unavailable…"
5. Confirm **Retry** button is visible inside banner
6. Confirm CTA reads: **"Inventory Unavailable — Try Again"**
7. Confirm CTA is disabled (opacity 0.6, tap does nothing)
8. Tap **Retry** — confirm loading spinner appears, then fallback banner returns
9. Reset `forceInventoryFallback = false`
10. Confirm normal checkout CTA ("Place Order · $X.XX") is restored

---

## Address Save Failure Test (P1-C)

**Flag:** `forceAddressSaveFailure: true`

1. Set `forceAddressSaveFailure = true` in `debugFlags.ts`
2. Open Checkout → tap address section → add new address
3. Fill in all required fields with valid data
4. Tap **Save & Use**
5. Confirm modal stays open (does not dismiss)
6. Confirm error message appears: **"Failed to save address. Please try again."**
7. Confirm tapping Save again shows the error again (not a duplicate)
8. Reset `forceAddressSaveFailure = false`
9. Confirm address saves normally and modal closes

---

## Payment Failure Test (P1-B / Stripe gate)

**Flag:** `forcePaymentFailure: true`

1. Set `forcePaymentFailure = true` in `debugFlags.ts`
2. Add a shipping address and select delivery
3. Select **Credit/Debit Card** payment method
4. Enter test card `4242 4242 4242 4242`
5. Tap **Place Order**
6. Confirm no network call to Stripe is made (check Metro logs — no `[Payment] create-payment-intent` log)
7. Confirm error appears: **"Payment failed. Please try again."**
8. Repeat steps 3–7 with **Apple Pay** selected
9. Set payment method to **Affirm** → tap the Affirm button
10. Confirm Affirm error appears: **"Payment failed. Please try again."**
11. Reset `forcePaymentFailure = false`
12. Confirm normal payment flow resumes

---

## Order Save Failure Test (P1-A prerequisite)

**Flag:** `forceOrderSaveFailure: true`

> This test verifies the post-payment error path. No real payment is made
> because this flag fires inside `completeOrder`, after a successful payment.
> To safely test this without a real charge, combine with `forcePaymentFailure`
> in a future integration test. For now, this only tests the error message path.

1. Set `forceOrderSaveFailure = true` in `debugFlags.ts`
2. Also set `forcePaymentFailure = true` to prevent a real Stripe charge
3. Attempt checkout — confirm payment error appears (from `forcePaymentFailure`)
4. Reset `forcePaymentFailure = false` (leave `forceOrderSaveFailure = true`)
5. Attempt checkout with a test card — if Stripe is in test mode, payment confirms
6. Confirm error appears referencing `DEBUG_FORCE_ORDER_SAVE_FAILURE`
7. Confirm no navigation to OrderSuccess
8. Reset `forceOrderSaveFailure = false`

---

## Final Safety Check

After all tests:

1. Open `src/config/debugFlags.ts`
2. Confirm every `force*` flag reads `false`
3. Run: `npx tsc --noEmit --skipLibCheck`
4. Confirm no TypeScript errors
5. Run a normal checkout — confirm CTA, address save, and payment work as expected

---

## Flag Reference

| Flag | Default | Tests |
|------|---------|-------|
| `forceInventoryFallback` | `false` | Fallback banner, disabled CTA, Retry button |
| `forceInventoryUnavailable` | `false` | Reserved for future inventory-block path |
| `forceAddressSaveFailure` | `false` | Address modal error message |
| `forcePaymentFailure` | `false` | Payment error before Stripe call |
| `forceOrderSaveFailure` | `false` | Post-payment order-save error path |
| `showDebugBadges` | `__DEV__` | Amber DEBUG MODE badge when any force flag is active |
