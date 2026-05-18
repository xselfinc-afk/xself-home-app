# Crisp Mobile — Special Offer Workflow

End-to-end guide for creating an Xself Concierge Special Offer from the **Crisp iPhone app**, in the middle of a customer conversation, without leaving Crisp.

> Reuses the existing Supabase Edge Function `agent-create-quote`. Does **not** introduce a new pricing system, a new admin auth model, or any change to the customer-facing app. The mobile form is a thin alternative UI in front of the same endpoint that `admin/create-quote.html` already calls.

---

## Architecture at a glance

```
Crisp mobile app (agent)
  └─ taps "Create Special Offer" Quicklink in customer conversation
       │
       │  URL prefilled with ?email=...&conversation_id=...
       ▼
Mobile-safe HTML form (hosted public URL)
  · agent enters SKU + negotiated price + expiration
  · token / setup pulled from device localStorage (per-device, once)
       │
       │  POST /functions/v1/agent-create-quote
       │  Headers: X-Agent-Token, Content-Type
       │  Body: { product_id, supplier_sku, customer_email, quoted_price_cents, agent_name, crisp_session_id }
       ▼
Supabase Edge Function: agent-create-quote
  · validates token, $50 floor, ≥50% of list
  · inserts row into support_quotes
  · posts a customer-facing system message into the Crisp conversation
    (NO redeem_token, NO server secrets)
       │
       ▼
Customer opens Xself Concierge in the app
  · SupportScreen calls get-active-quote with their JWT
  · banner appears, Buy Now uses the quoted price
  · create-checkout-order overrides line price server-side and marks the
    quote used atomically
```

Nothing in the customer-facing app changes. The mobile workflow is **purely** an alternative entry point for the existing tool.

---

## Files involved

| File | Role | New / Existing |
|---|---|---|
| `admin/mobile-create-quote.html` | iPhone-optimised single-page form. URL-prefill-aware. | **New** (this commit) |
| `admin/create-quote.html` | Desktop equivalent. Unchanged. | Existing |
| `supabase/functions/agent-create-quote/index.ts` | Server endpoint. Unchanged. | Existing |
| `supabase/functions/support-chat/index.ts` | Used by `agent-create-quote` to post the templated message into Crisp. | Existing |
| `docs/crisp-mobile-special-offer.md` | This document. | **New** |

---

## Hosting `mobile-create-quote.html`

The page is a single self-contained HTML file. No build step, no runtime dependencies. Pick whichever option is easiest for the team:

### Option A — Netlify drop (recommended for MVP, ~2 min)

1. Sign in to https://app.netlify.com.
2. Drag the `admin/` folder onto the deploys list, or `netlify deploy --prod --dir=admin`.
3. Note the assigned URL, e.g. `https://xself-concierge-admin.netlify.app/mobile-create-quote.html`.
4. **Add HTTP basic auth** (Netlify → Site settings → Visitor access → Password protection) so the URL is not crawlable. The page also enforces an `AGENT_ADMIN_TOKEN` check on submit, but extra defense at the edge is worth ~30 seconds.

### Option B — Vercel

1. `vercel --prod admin/` from repo root.
2. Same URL pattern: `https://<project>.vercel.app/mobile-create-quote.html`.
3. Vercel Authentication on the project keeps it private.

### Option C — Cloudflare Pages / GitHub Pages

Any static host works. Just upload the contents of `admin/`. Be sure the path the agents bookmark ends with `/mobile-create-quote.html`.

### Option D — Supabase Edge Function HTML responder

If you don't want to manage a separate host, you can add a tiny new Edge Function that serves the HTML body. Set `verify_jwt = false` for it in `supabase/config.toml`. The advantage is that one platform serves everything. The downside is that you'd have to deploy on every edit. Defer this unless it's truly desired.

> Whichever host you pick, **put the URL behind some form of public-facing access gate** (HTTP basic auth, Vercel Authentication, Cloudflare Access). The `AGENT_ADMIN_TOKEN` localStorage gate stops form submission, but it does not stop the page from being viewed.

---

## Crisp Quicklink configuration

> ⚠️ **Do NOT put the admin URL inside a Crisp Message Shortcut.** A "Message Shortcut" (the `!shortcut` quick-reply feature) **inserts text into the customer-visible conversation** — anything you put in there is shown to the customer. Pasting the admin URL into a message shortcut leaks an internal tool to every customer who triggers it. The mobile admin URL must only be reachable as a **Quicklink / Magic Link / browser bookmark** — these open a URL in the agent's own browser and **never** post into the chat.
>
> If you've already configured a `!offer` message shortcut that injects the admin URL into chat, delete it before using this tool with real customers.

### Preferred agent entry points

The two safe ways to reach the mobile admin URL from a Crisp conversation:

1. **Quicklink** (free Crisp plans support these): Crisp Dashboard → Settings → **Shortcuts** → **Magic Link** / **Quicklink**. The agent taps the link in the conversation toolbar; Safari opens the URL **on the agent's device only**. Nothing is posted to the customer.
2. **iPhone Home Screen shortcut / Safari bookmark**: The simplest, plan-agnostic option. The agent saves `https://<host>/mobile-create-quote.html` as a bookmark or "Add to Home Screen" in Safari, then taps it from outside Crisp when they need to create an offer. The Crisp conversation stays clean; only the templated customer-facing message (posted by `agent-create-quote` server-side) appears in chat.

The customer-facing message — posted by the Edge Function, never by the agent — contains only the product name, the quoted vs. list price, and the expiration timestamp. It has **no admin URL, no quote ID, no redeem token**. If your Crisp templates differ, check `supabase/functions/agent-create-quote/index.ts:postCrispMessage`.

### Quicklink setup — ultimate-simple URL template

The form auto-locks the product when Crisp passes both an identifier (`product_id` or `sku`) and a `title`. With the URL below, the agent's only required input becomes the quoted price.

```
https://<your-host>/mobile-create-quote.html
  ?email={{customer.email}}
  &conversation_id={{conversation.session_id}}
  &product_id={{conversation.data.product_id}}
  &sku={{conversation.data.product_sku}}
  &title={{conversation.data.product_title}}
```

`product_id`, `product_sku`, and `product_title` are set on the Crisp conversation `data` payload by `setSupportSessionMeta` in `src/screens/SupportScreen.tsx` every time the customer opens Concierge for a new product (see `data.product_id`, `data.product_sku`, `data.product_title`). When Crisp can substitute `{{conversation.data.product_id}}` etc. in Quicklink URLs (paid plans / Plugin tokens), the form receives the customer's current product instantly. When substitution fails — unsupported plan, dashboard version, or the customer hasn't opened Concierge yet — the literal `{{…}}` is detected and the form silently falls back to manual product search.

In **Crisp Dashboard → Settings → Shortcuts** (or **Quick Replies / Plugins** depending on your Crisp plan):

1. Create a new **Magic Link** / **Quicklink** / **Shortcut** named `create offer` (or whatever feels short to type on mobile). **Confirm the type is "Magic Link" / "Quicklink" — NOT "Message Shortcut".**
2. Set the URL to your hosted mobile page with Crisp's prefill macros:

```
https://<your-host>/mobile-create-quote.html?email={{customer.email}}&conversation_id={{conversation.session_id}}
```

3. The exact macro syntax differs slightly across Crisp products. Recent Crisp dashboards expose:

| Variable in URL | Substituted value | Crisp macro name (varies — verify in your dashboard) |
|---|---|---|
| `{{customer.email}}` | The customer's email from the conversation | `{{conversation.email}}` / `{{customer.email}}` / `{{user.email}}` |
| `{{conversation.session_id}}` | The Crisp session ID (`session_xxx`) | `{{conversation.session_id}}` / `{{session_id}}` |

If a macro doesn't expand, Crisp leaves it in the URL literally. The form treats unsubstituted macros as empty (no crash) — the agent will just have to type the email manually, which still works.

4. Set the action so it **opens in the mobile browser** (Safari) rather than the in-app webview. This way:
   - `localStorage` is preserved between offers (the in-app webview clears it per session on some Crisp versions).
   - Safari can autofill any saved values from a system password manager.

> **Optional SKU prefill.** If the agent already knows the SKU (e.g. the customer pasted it in chat), you can build a second Quicklink that pre-fills the SKU too:
> ```
> https://<your-host>/mobile-create-quote.html?email={{customer.email}}&conversation_id={{conversation.session_id}}&sku=XH-PASTE-SKU-HERE
> ```
> But this requires the agent to edit the URL, which is fiddly on mobile. The search field in-page is usually faster.

---

## Per-device setup (one time)

The first time an agent opens the page on their iPhone:

1. The **Setup** section is expanded automatically (because nothing is saved yet).
2. Agent fills in:
   - **Supabase Project URL** — `https://erbimgfbztkzmpamzwky.supabase.co` (or your project)
   - **Publishable Key** — `sb_publishable_...` (used only for the product search, read-only)
   - **Agent Admin Token** — the `AGENT_ADMIN_TOKEN` Function Secret value (long random string)
   - **Your Agent Name** — appears in `support_quotes.created_by_agent` for the audit log
3. Tap **Save setup**. All four values are stored in this device's Safari `localStorage` only. Nothing is sent to any third party at this stage.
4. Setup collapses; the page is ready.

Safari's localStorage persists across visits indefinitely (unless the agent clears site data). The agent never has to re-enter these values on the same device.

> **Token rotation.** If the `AGENT_ADMIN_TOKEN` secret is rotated server-side, every agent device's saved token stops working — they'll get `{"error":"unauthorized"}` on submit and need to re-paste the new value in Setup.

---

## Agent flow (per offer)

1. Open the customer conversation in the Crisp iPhone app.
2. Type the shortcut (`/create offer`) or tap the Quicklink chip.
3. Crisp opens the URL in Safari with the customer's email and `conversation_id` prefilled. A small gold banner near the top reads *"Email: customer@example.com — Crisp session prefilled — confirmation will post to chat."*
4. Type a few characters into the **product search** field. A list of matching products appears. Tap one to fill `Product ID`, `SKU`, and a helper line showing the list price + minimum allowed quote.
5. Confirm the customer email (already prefilled). Type the negotiated price in dollars. Adjust expiry hours if needed (default 7 days).
6. Tap **Create Special Offer**.
7. Within ~1 s the green success card appears with the quote details (price, expiration, ID). At the same moment, Crisp shows a new operator message in the conversation:
   > *"Your concierge has prepared a special price of $199.00 for "Modern Oak TV Stand" (was $499.00). The offer has been saved to your account — open the app and tap Buy Now to apply it. Offer expires …"*
8. Agent returns to Crisp. The customer reads the message and proceeds to the app.

If anything fails, the red error card shows the server-returned reason (e.g. `quoted_price_cents must be at least 50% of original price (list $499.00) — min allowed $249.50`). Adjust and try again.

---

## URL parameters

| Param | Required | Description |
|---|---|---|
| `email` | recommended | Pre-fills `customer_email`. If absent, the agent enters it manually. |
| `conversation_id` | recommended | The Crisp `session_xxx` id. Forwarded to `agent-create-quote` as `crisp_session_id`, which triggers the customer-facing system message in Crisp. |
| `sku` | optional | Pre-fills the SKU. Useful when the SKU was already pasted in chat. |
| `product_id` | optional | Pre-fills `productId` (the supplier_product_id). Almost always unneeded — the SKU search fills both. |

Unknown query params are ignored. Missing params silently fall through.

---

## Security model

| Secret | Where it lives | Where it is NOT |
|---|---|---|
| `AGENT_ADMIN_TOKEN` | Each agent's device localStorage. Sent only as `X-Agent-Token` header to `agent-create-quote`. | Not in the URL, not in Crisp, not in the customer-facing message body, not in source code. |
| `SUPABASE_SERVICE_ROLE_KEY` / `sb_secret_...` | Server Function Secrets only. | Never touches the admin form. |
| `Publishable Key` / `sb_publishable_...` | Agent device localStorage; used only for product search via PostgREST under RLS. | Not used for any write. |
| `redeem_token` (per quote) | Generated server-side. Returned in the agent's submit response (over HTTPS) but **not rendered in the UI** as a defense-in-depth measure. Stored only in `support_quotes.redeem_token`. The customer-facing app fetches it via `get-active-quote` under their JWT. | Not sent to Crisp. Not shown in any customer-facing surface. Not in the on-chat templated message. Not in URL bars. |

The customer-facing Crisp message is built server-side from a static template in `agent-create-quote/index.ts`: product title, quoted price, list price, expiration string. It contains no token, no IDs, no secrets.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `{"error":"unauthorized"}` on submit | `AGENT_ADMIN_TOKEN` wrong or stale (rotated server-side). | Re-open Setup, paste the current token, save. |
| `UNAUTHORIZED_INVALID_JWT_FORMAT` | Platform JWT gate is back on for `agent-create-quote`. | Verify `[functions.agent-create-quote] verify_jwt = false` in `supabase/config.toml` and redeploy. |
| `product_id not found` | Pasted ID doesn't exist in `standardized_products`. | Use the SKU search instead of pasting. |
| `quoted_price_cents must be at least 50% of original price` | Tried to discount more than half off. | Pricing policy guardrail. Use a higher price. |
| `quoted_price_cents cannot exceed original price` | Typed a higher price than list. | Lower the price. |
| Search returns nothing | Publishable key missing / wrong, or query is too narrow. | Confirm key in Setup; type more of the title. |
| Submit succeeds but customer sees no banner | Customer is not signed in, or signed in with a different email. | Customer must sign in with the same email used in the offer. |
| Crisp didn't post the templated system message | `conversation_id` was empty in the URL, or Crisp credentials missing on the function. | Verify the macro substitution worked. Check function logs. The quote is still valid even if the chat message fails. |

---

## Limitations / known follow-ups (not blocking MVP)

- **Search by category** — currently search is by title or SKU only. A category-scoped search would speed up large catalogs.
- **Multi-item offers** — MVP is single-item Buy Now. A cart-level quote requires server schema and validation changes.
- **Live offer refresh in-app** — the customer must re-open SupportScreen (or pull-to-refresh) to see a brand-new offer. A push notification could close that gap.
- **Manager approval queue** — large discounts (>50% off list) are blocked server-side. An approval workflow for borderline cases is future work.
- **In-Crisp plugin instead of an external URL** — Crisp Marketplace publishes custom plugins. That would replace the external Quicklink with a fully-embedded UI inside Crisp. Higher investment; matches enterprise expectations.
