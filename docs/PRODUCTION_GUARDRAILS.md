# Production Guardrails

Every change that ships to the Xself Home production app must pass:

```bash
npm run guard:prod
```

## Why this exists

In a single month we paid for three production incidents that shared a root cause shape — a focused fix in one area silently broke an unrelated production path:

1. An `expo prebuild --clean` regeneration deleted `ios/XselfHome/XselfHome.entitlements`. **Apple Pay broke for every customer** until the entitlement and `CODE_SIGN_ENTITLEMENTS` pointer were restored.
2. The `xselfhome` URL scheme drifted out of `Info.plist`. **Affirm purchases silently failed** mid-redirect — users were stranded in Safari with no return path.
3. The GIGA inventory sync workflow expired its session. The plan-fulfillment edge function correctly returned `inventory_unavailable`, but `CheckoutScreen.tsx` misclassified that status as a geocode error. **Customers on perfectly valid addresses were told "we couldn't verify this address."**

Each had a one-line root cause and each lost real revenue. This guardrail script encodes every regression we've already paid for, so the same break can never ship twice.

## How to run

```bash
npm run guard:prod
# or, when wrapping the final step of a task:
npm run verify:before-final
```

Output is a sectioned report. Exit code `0` = all guards pass; exit code `1` = at least one guard failed (with the failing file + missing pattern printed).

## When to run

- **Before every commit** that touches: payment, checkout, inventory, fulfillment, admin, or native iOS configuration.
- **Before every release** — TestFlight, production EAS build, App Store submission.
- **At the end of every Claude Code / Codex / external-agent task** — see [Agent rule](#agent-rule) below.

## What each section protects

| Section | Failure mode it prevents |
|---|---|
| **Apple Pay iOS capability** | Entitlement file deletion (the May-17 incident); merchant id drift between `app.json` Stripe plugin block and `XselfHome.entitlements`; missing `CODE_SIGN_ENTITLEMENTS` after a manual or auto pbxproj regeneration. |
| **Affirm redirect** | `xselfhome` URL scheme missing from `Info.plist` → users stranded in Safari after Affirm authorization; `urlScheme` missing from `<StripeProvider>` in `App.tsx`. |
| **Stripe safety** | Server secrets (`STRIPE_SECRET_KEY`, `sk_live_*`, `sk_test_*`) leaking into the React Native bundle or the admin static page; `StripeProvider` accidentally removed from `App.tsx`; `create-checkout-order` losing `payment_method_types[]` for card or affirm; Affirm rejecting orders because shipping was stripped from the PaymentIntent. |
| **Supabase safety** | Service-role key checked into client code; `EXPO_PUBLIC_*` env var names renamed without updating `src/lib/supabase.ts`. |
| **Checkout inventory error handling** | The server's `inventory_unavailable` / `warehouse_data_unavailable` / `stale_inventory` / `no_inventory` / `insufficient_qty` statuses falling through to a "couldn't verify this address" error in the UI. |
| **Inventory sync automation** | Missing GIGA sync scripts; missing OOS detection signals; the daily launchd runner losing its auto-refresh + AUTO_RECOVERED / ACTION_REQUIRED state machine. |
| **Admin backend** | Secrets in `admin/orders.html`; missing edge functions (`admin-create-payment-link`, `admin-update-order-status`); missing audit-log schema (`admin_order_status_events.sql`). |
| **Fulfillment rules** | `PICKUP_THRESHOLD_MILES` reverting to 30; stale "30 mile" / "Within 30 mi of warehouse" phrasing surfacing in user-visible strings. |
| **Splash / prebuild blocker** | `app.json` referencing a splash image file that doesn't exist — this blocks `expo prebuild` from re-injecting both the Apple Pay entitlement and the `xselfhome` URL scheme. |
| **TypeScript** | Type errors that would otherwise crash at runtime or get past CI. |

## Agent rule

**Every Claude Code, Codex, or other automated coding agent task that touches Xself Home source code MUST run `npm run guard:prod` before its final report.**

- If all guards pass, the agent's final report should explicitly state `guard:prod → PASS`.
- If any guard fails, the agent must either fix the failure or escalate it explicitly in the final report — never quietly ship a passing report while guards fail.

This rule is non-negotiable for changes that touch:
- Stripe / payment code
- `CheckoutScreen.tsx` or any file under `supabase/functions/`
- The inventory sync pipeline (`scripts/syncGigaFurnitureInventory.ts`, `scripts/runGigaInventorySync.sh`, related launchd / auto-refresh logic)
- The admin dashboard (`admin/orders.html`, admin edge functions, admin SQL migrations)
- Native iOS config (`ios/`, `app.json` plugins or `scheme`)

For changes outside that scope, running guards is still strongly recommended — they take under a minute.

## Extending the guardrails

When you fix a regression that *could plausibly recur*, add a guard. Each guard is a single `check('Category', () => string[])` block in `scripts/productionGuardrails.ts` that returns an empty array on success or a list of `<file>: <missing pattern>` strings on failure. Keep guards file-oriented and regex-driven so they stay fast and don't need a running app to evaluate.

Rule of thumb: if you wrote the words "should never happen again" in the post-mortem, the next commit should add a guard for it.
