# Admin Custom Payment Links — operator guide

Phase 5.2. Lets a whitelisted admin generate a one-off Stripe Payment Link at a negotiated price and send it to a customer. No catalog mutation. No refund or status actions. Read-only dashboard behavior elsewhere is preserved.

## Architecture

```
Browser (admin/orders.html)                    Supabase Edge Function           Stripe API           Supabase DB
─────────────────────────────                  ─────────────────────────────    ─────────────        ─────────────
1. Admin signs in via Supabase Auth
   (anon key only, never service role)
2. Admin clicks "Create payment link"
   in an open order's detail panel
3. fetch(.../admin-create-payment-link)  ──▶   verify JWT (auth.getUser)
   with Authorization: Bearer <jwt>             check admin_users allowlist
                                                validate unit_price / quantity
                                                POST /v1/prices ─────────────▶  create Price
                                                POST /v1/payment_links ──────▶  create Payment Link
                                                INSERT row ──────────────────────────────────▶  admin_custom_payment_links
4. Response { url, ... } shown in UI   ◀──     return JSON (no secrets)
5. Admin copies URL, sends to customer
```

Browser never touches: `STRIPE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## Required secrets (Edge Function env)

| Secret | Used by |
|---|---|
| `STRIPE_SECRET_KEY`        | The function, for Stripe REST calls |
| `SUPABASE_URL`             | The function, to build the admin client |
| `SUPABASE_SERVICE_ROLE_KEY`| The function, to verify the JWT and write the DB row |

Set them once:

```bash
supabase secrets set STRIPE_SECRET_KEY=sk_test_...           # or sk_live_...
supabase secrets set SUPABASE_URL=https://<project>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
```

The function logs the Stripe key mode at startup so you can confirm `LIVE` vs `test` in the Studio function logs.

## Apply the SQL (one-time)

```
1. Supabase Studio → SQL Editor → New query
2. Paste supabase/admin_custom_payment_links.sql in full
3. Run
   Expected: "Success. No rows returned."
```

Verify the table exists:

```sql
SELECT count(*) FROM public.admin_custom_payment_links;   -- expect 0
```

Depends on `supabase/admin_order_dashboard.sql` (Phase 5.0) being applied first — that file defines `public.is_admin()` and `public.admin_users`.

## Deploy the Edge Function

From the project root:

```bash
supabase functions deploy admin-create-payment-link
```

The CLI will package `supabase/functions/admin-create-payment-link/index.ts` and upload it. Verify in Studio → Edge Functions that the function shows status `Deployed` with the version timestamp.

## Test the endpoint

You can smoke-test from any terminal where you have your admin JWT (the page persists it in localStorage under `sb-<projectref>-auth-token`; or sign in via `supabase auth login`).

```bash
# Read your admin JWT (paste from devtools → Application → localStorage)
ADMIN_JWT=eyJhbGciOi...

# 1. 401 without auth
curl -i -X POST "$SUPABASE_URL/functions/v1/admin-create-payment-link" \
  -H "Content-Type: application/json" \
  -d '{"negotiated_unit_price_cents": 4999}'
# Expect: HTTP/2 401, body: {"ok":false,"error":"unauthorized","detail":"Missing Authorization: Bearer <jwt>"}

# 2. 403 for non-admin JWT
NON_ADMIN_JWT=...
curl -i -X POST "$SUPABASE_URL/functions/v1/admin-create-payment-link" \
  -H "Authorization: Bearer $NON_ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"negotiated_unit_price_cents": 4999}'
# Expect: HTTP/2 403, body: {"ok":false,"error":"forbidden","detail":"Caller is not on the admin allowlist"}

# 3. 400 for invalid price (zero / negative / non-integer)
curl -i -X POST "$SUPABASE_URL/functions/v1/admin-create-payment-link" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"negotiated_unit_price_cents": 0}'
# Expect: HTTP/2 400, "negotiated_unit_price_cents must be a positive integer (cents)"

curl -i -X POST "$SUPABASE_URL/functions/v1/admin-create-payment-link" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{"negotiated_unit_price_cents": -100}'
# Expect: HTTP/2 400

# 4. 200 OK — creates a $49.99 link
curl -i -X POST "$SUPABASE_URL/functions/v1/admin-create-payment-link" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "order_id": "ORD-0E3C9572",
    "order_number": "ORD-0E3C9572",
    "customer_email": "you@example.com",
    "title": "Negotiated price for the 30\" vanity",
    "quantity": 1,
    "negotiated_unit_price_cents": 4999
  }'
# Expect: HTTP/2 200, body:
#   {"ok":true,"url":"https://buy.stripe.com/...","payment_link_id":"plink_...",
#    "price_id":"price_...","amount_cents":4999,"quantity":1}
```

Open the returned `url` in a browser to confirm the Stripe Payment Link page renders.

## Using it from the dashboard

1. `python3 -m http.server 8080` from project root.
2. Open `http://localhost:8080/admin/orders.html`.
3. Sign in as your whitelisted admin.
4. Click any order row.
5. Scroll to **Custom Payment Link** in the detail panel.
6. Enter:
   - Unit price (USD) — required
   - Quantity — default 1
   - Title — optional (defaults to "Xself Home Custom Order")
   - Note — optional, attached to the Payment Link metadata
7. Click **Create payment link**.
8. The result panel shows the URL + a Copy button + an Open button.
9. Paste the URL into your customer message.

The dashboard does not send the URL to the customer automatically (no email/SMS in this phase). It also does not change order status — that remains read-only.

## Operational notes

- **One link per negotiation.** Each click creates a fresh Stripe Price + Payment Link. Old links remain valid in Stripe until you deactivate them in the Stripe dashboard.
- **No catalog mutation.** This flow never updates `standardized_products.selling_price`. It writes only `admin_custom_payment_links`.
- **Refunds / cancellations** still happen manually in the Stripe dashboard. The dashboard does not surface refund actions (Phase 5.6 territory).
- **Webhook integration**: Stripe Payment Link checkouts arrive at the existing `stripe-webhook` function. The `metadata.source = admin_negotiated_price` and the included `order_id` / `order_number` let you trace the payment back to the originating order without changing any webhook logic.
- **Audit trail**: every successful link is persisted with `created_by_email`. Query:
  ```sql
  SELECT order_number, created_by_email, negotiated_total_cents, stripe_url, created_at
    FROM public.admin_custom_payment_links
    ORDER BY created_at DESC LIMIT 20;
  ```
- **Stripe minimum charge**: $0.50 USD. Any unit_price * quantity below 50 cents will be rejected with HTTP 400.

## Rollback

```sql
-- Revoke the SQL:
DROP POLICY IF EXISTS "admins_select_payment_links" ON public.admin_custom_payment_links;
DROP TABLE IF EXISTS public.admin_custom_payment_links;
```

```bash
# Delete the function:
supabase functions delete admin-create-payment-link
```

Existing Stripe Payment Links continue to work after rollback — they live in Stripe, not in your DB. Deactivate them in the Stripe dashboard if needed.
