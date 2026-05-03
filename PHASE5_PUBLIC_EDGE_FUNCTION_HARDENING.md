# Phase 5 Public Edge Function Hardening
**Date:** 2026-04-30  
**Status:** ✅ COMPLETE — Both public Edge Functions hardened with strict input validation

---

## Why verify_jwt = false Is Required

Guest checkout requires `plan-fulfillment` and `validate-checkout-inventory` to run without JWT verification because:

- This project uses Supabase's new key format: `sb_publishable_...`
- This key is **not a JWT** — it is an opaque token
- Supabase's edge function gateway rejects it with `UNAUTHORIZED_INVALID_JWT_FORMAT`
- Guest users have no session JWT (they are not authenticated)
- `supabase.functions.invoke()` sends the anon key as the Bearer token when no session exists

**Confirmed:** Deploying `validate-checkout-inventory` with JWT on during this task caused all guest checkout calls to fail with 401. It was immediately reverted.

**Status of all functions:**

| Function | verify_jwt | Reason |
|----------|-----------|--------|
| `plan-fulfillment` | false | Guest checkout — anon key not a JWT |
| `validate-checkout-inventory` | false | Guest checkout — anon key not a JWT |
| `create-payment-intent` | false | Pre-existing — Stripe-facing |
| `dynamic-pricing` | false | Pre-existing |
| `giga-warehouse-stock` | false | Pre-existing |
| `stripe-webhook` | false | Pre-existing — receives Stripe calls |

Both new functions are explicitly set in `supabase/config.toml` to prevent future accidental re-enablement.

---

## Hardening Applied

### Constants added to both functions

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_CART_ITEMS` | 20 | Caps item count per request |
| `MAX_QTY_PER_ITEM` | 99 | Caps qty per line item |
| `SKU_PATTERN` | `/^[A-Za-z0-9_-]{1,60}$/` | Rejects malformed/path-traversal productIds |

### Additional constants in `plan-fulfillment` only

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_FIELD_LENGTH` | 200 chars | Caps address field length (prevents geocode spam with giant strings) |
| `US_STATE_PATTERN` | `/^[A-Z]{2}$/` | Requires valid 2-letter state code |
| `ZIP_PATTERN` | `/^\d{5}(-\d{4})?$/` | Requires valid US ZIP (5-digit or ZIP+4) |

### Error message cleanup (`plan-fulfillment`)

Two responses previously leaked internal stock quantities:
- `"Insufficient stock for W714S00550: need 2, have 1"` → `"One or more items have insufficient available stock"`
- `"No inventory data for product W714S00550"` → `"One or more items are not currently available"`

Callers receive enough information to show a user-facing message without revealing inventory levels or product IDs.

---

## Mutation Audit

| Function | Reads | Writes | Notes |
|----------|-------|--------|-------|
| `validate-checkout-inventory` | `inventory_cache` | None | Pure read — no user data touched |
| `plan-fulfillment` | `inventory_cache`, `warehouses` | `warehouses.lat/lng` | Only writes system geocoding cache on first warehouse geocode (not user data) |

Neither function creates orders, modifies user records, charges payments, or touches any user-owned data.

---

## Validation Test Results

### plan-fulfillment (v4)

| Test | Input | Expected | Result |
|------|-------|----------|--------|
| Valid guest request | W714S00550, Mountain View CA | 200 valid=true | ✅ 200 valid=true |
| >20 items | 21 identical items | 400 | ✅ 400 "Cart cannot exceed 20 items" |
| qty=100 | qty > MAX_QTY_PER_ITEM | 400 | ✅ 400 "Quantity cannot exceed 99 per item" |
| Path-traversal productId | `../../etc/passwd` | 400 | ✅ 400 "Invalid product ID format" |
| Multi-char state | `"California"` | 400 | ✅ 400 "state must be a 2-letter US state code" |
| Non-numeric zip | `"ABCDE"` | 400 | ✅ 400 "zip must be a valid US ZIP code" |

### validate-checkout-inventory (v3)

| Test | Input | Expected | Result |
|------|-------|----------|--------|
| Valid guest request | W714S00550 qty=1 | 200 valid=true | ✅ 200 valid=true |
| >20 items | 21 items | 400 | ✅ 400 "Cart cannot exceed 20 items" |
| qty=100 | qty > MAX_QTY_PER_ITEM | 400 | ✅ 400 "Quantity cannot exceed 99 per item" |
| Path-traversal productId | `../../etc/passwd` | 400 | ✅ 400 "Invalid product ID format" |
| Empty items array | `[]` | 400 | ✅ 400 "items array is required" |

---

## Rate-Limit Recommendation

These functions are public (`verify_jwt = false`) and perform external API calls (Google Maps geocoding in `plan-fulfillment`). Supabase does not currently support per-function rate limiting in the CLI.

**Recommended next steps:**

1. **Supabase Dashboard → Edge Functions → plan-fulfillment**: Enable rate limiting if available for your plan tier.

2. **Google Maps API key restriction**: In Google Cloud Console, restrict the `GOOGLE_MAPS_API_KEY` secret to only the Supabase project's egress IP range. This caps geocoding abuse at the API key level regardless of request volume.

3. **Supabase WAF / Cloudflare**: If the project is proxied through Cloudflare or similar, add a rate-limit rule on `/functions/v1/plan-fulfillment` and `/functions/v1/validate-checkout-inventory` (e.g., 30 requests/minute per IP).

4. **Request cost**: `validate-checkout-inventory` is DB-only (no external API calls) — its blast radius is limited to Supabase query volume. `plan-fulfillment` geocodes on every call if the address isn't cached; the Google Maps quota is the primary cost surface.

---

## Phase 5 Complete ✅

| Deliverable | Status |
|-------------|--------|
| Strict cart item count limit (≤20) | ✅ Both functions |
| Strict qty per item limit (≤99) | ✅ Both functions |
| SKU/productId format validation (alphanumeric + `-_`, max 60 chars) | ✅ Both functions |
| Address field length limits (≤200 chars) | ✅ plan-fulfillment |
| State format validation (2-letter US code) | ✅ plan-fulfillment |
| ZIP format validation (US 5-digit or ZIP+4) | ✅ plan-fulfillment |
| Abuse-safe error messages (no stock qty leakage) | ✅ plan-fulfillment |
| Mutation audit: neither function mutates user data | ✅ Confirmed |
| Rate-limit recommendation documented | ✅ See above |
| Guest checkout unaffected | ✅ Verified (anon key + W714S00550 → 200 valid=true) |
| Both functions deployed and live | ✅ plan-fulfillment v4, validate-checkout-inventory v3 |
