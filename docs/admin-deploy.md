# Deploying the Special Offer Admin Tool

End-to-end deployment guide for `admin/mobile-create-quote.html` (and its desktop sibling `admin/create-quote.html`).

> The file is a single self-contained HTML — no build step, no runtime dependencies. The only deployment work is "drop the folder on a static host and put an access gate in front of it."

---

## TL;DR

1. Deploy the **`admin/` directory only** as the publish root of a static site host.
2. Enable **HTTPS** (default on all three hosts below).
3. Enable an **access gate** (Netlify password, Vercel Authentication, or Cloudflare Access).
4. Final URL to paste into Crisp (ultimate-simple flow — agent only enters price):
   ```
   https://<your-host>/mobile-create-quote.html
     ?email={{customer.email}}
     &conversation_id={{conversation.session_id}}
     &product_id={{conversation.data.product_id}}
     &sku={{conversation.data.product_sku}}
     &title={{conversation.data.product_title}}
   ```
   The form silently falls back to manual product search when Crisp can't substitute the macros (free plans may not expose `conversation.data` fields in Quicklink URLs).

---

## URL path decision

**Publish the `admin/` directory as the host root.** Resulting public path:

```
✅  https://<host>/mobile-create-quote.html        (preferred)
❌  https://<host>/admin/mobile-create-quote.html  (only if you publish the whole repo, which would also expose source)
```

Reasons to publish only the `admin/` folder (not the whole repo):

- Shorter URL → easier to type if a Crisp macro fails to substitute.
- No risk of leaking `src/`, `supabase/`, `ios/`, `.env*`, etc.
- Faster deploys.
- The `admin/` folder already contains both the mobile and the desktop variants — both reachable behind your access gate, both safe to expose.

> If for some reason you must serve the whole repo (e.g. an existing Netlify site), set the publish base directory to `admin/` in the host's build settings rather than uploading everything.

---

## Option A — Netlify (drag-and-drop, ~2 min)

**Recommended for MVP.**

1. Sign in at https://app.netlify.com → **Sites** → **Add new site** → **Deploy manually**.
2. Drag the local `admin/` folder onto the drop zone.
3. Netlify assigns a URL like `https://timely-pony-xx2.netlify.app`.
4. Site Settings → **Domain management** → **Edit site name** to rename to something memorable, e.g. `xself-concierge-admin` → URL becomes `https://xself-concierge-admin.netlify.app`.
5. Site Settings → **Visitor access** → **Password protection** → set a password (Pro plan) or use **OAuth login** if available on your plan.
6. Done. Mobile URL: `https://xself-concierge-admin.netlify.app/mobile-create-quote.html`.

CLI alternative:

```bash
npx netlify-cli deploy --dir=admin --prod
# Follow the prompts; pick a new site or an existing one.
```

---

## Option B — Vercel

1. Sign in at https://vercel.com → **Add New…** → **Project** → **Import** any source (or use CLI).
2. CLI deploy:

```bash
cd admin
npx vercel --prod
# When asked "What's your project's name?", pick e.g. xself-concierge-admin.
# When asked "In which directory is your code located?", accept ./ (you're inside admin/).
# When asked "Want to override the settings?", choose No.
```

3. Vercel assigns a URL like `https://xself-concierge-admin.vercel.app`.
4. Project Settings → **Deployment Protection** → **Vercel Authentication** → toggle ON. Now visitors must be logged into your Vercel team to view the page.
5. Mobile URL: `https://xself-concierge-admin.vercel.app/mobile-create-quote.html`.

> Vercel Authentication is the easiest gate, but it requires every agent to have a free Vercel account on your team. If that's friction, use Option A (Netlify password) or Option C (Cloudflare Access with email-OTP).

---

## Option C — Cloudflare Pages

1. Sign in at https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Upload assets** → name the project `xself-concierge-admin`.
2. Drag the local `admin/` folder onto the drop zone (or zip it first and upload).
3. Cloudflare assigns `https://xself-concierge-admin.pages.dev`.
4. Project → **Settings** → **General** → **Access policy**. Enable **Cloudflare Access** with a one-time-PIN email policy:
   - Select **Bypass** if not yet set up; otherwise **Allow**.
   - Add the agents' emails to the allow list.
5. Mobile URL: `https://xself-concierge-admin.pages.dev/mobile-create-quote.html`.

CLI alternative:

```bash
npx wrangler pages deploy admin/ --project-name=xself-concierge-admin --commit-dirty=true
```

---

## Crisp Shortcut configuration

> ⚠️ **Use a Quicklink / Magic Link — never a Message Shortcut.** Crisp's "Message Shortcut" feature (`!shortcut` quick reply) **posts text into the customer-visible conversation**; pasting the admin URL there leaks an internal tool to every customer who triggers it. The safe surfaces are a Quicklink (opens in the agent's browser only) or an iPhone Home Screen / Safari bookmark.
>
> Verify in Crisp Dashboard that the entry you're creating is labeled **Magic Link** / **Quicklink** — NOT "Message Shortcut" or "Quick Reply".

Once the URL is live and the gate is on:

1. **Crisp Dashboard** → workspace → **Settings** → **Shortcuts** (path varies slightly between Crisp products; the canonical names are `Magic Links`, `Quick Replies`, or `Shortcuts`).
2. Add a new shortcut:
   - **Trigger** (mobile-typed): `create offer`
   - **URL**:
     ```
     https://<your-host>/mobile-create-quote.html?email={{customer.email}}&conversation_id={{conversation.session_id}}
     ```
   - **Open in**: external browser (Safari) — NOT the in-app webview. This preserves `localStorage` between offers.
3. Each agent installs the Crisp iOS app and signs in. The shortcut becomes available in every conversation.

> **Macro variance.** Different Crisp products / dashboard versions use slightly different macro names. If `{{customer.email}}` arrives literally (unsubstituted) in the URL, try `{{conversation.email}}` / `{{user.email}}` / `{{visitor.email}}`. If `{{conversation.session_id}}` doesn't resolve, try `{{session_id}}`. The mobile form treats unresolved macros as empty — the agent just types the missing value manually.

---

## Production checklist

Run through this list **once after deploying** and **once per agent device** before going live with real customer offers.

### Hosting

- [ ] **HTTPS enabled.** All three hosts above default to HTTPS with auto-renewed certificates. Confirm the URL starts with `https://`. If you bring a custom domain, ensure SSL is provisioned and HTTPS-only redirect is on.
- [ ] **Access protection enabled.** One of:
  - Netlify password protection, OR
  - Vercel Authentication, OR
  - Cloudflare Access (one-time PIN per agent email).
- [ ] **No public crawler exposure.** Open the URL in a fresh incognito window with no auth — the page should be blocked before any HTML loads.
- [ ] **`admin/` folder only is published.** Confirm by browsing `https://<host>/` — should serve either the desktop form (`create-quote.html`) or a 404 if `index.html` doesn't exist. Should NOT list directory contents, never serve `src/`, `supabase/`, `package.json`, etc.

### Function-side configuration

- [ ] `AGENT_ADMIN_TOKEN` is set in Supabase Function Secrets and is a long random value (recommend 32+ URL-safe chars).
- [ ] `verify_jwt = false` is set in `supabase/config.toml` for both `agent-create-quote` and `get-active-quote`. (Confirm with `grep -A1 "agent-create-quote\|get-active-quote" supabase/config.toml`.)
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **never** exposed to the admin tool. The publishable key (`sb_publishable_...`) is what the form uses for product search, and the agent token is what authenticates writes.

### Per-agent device setup

- [ ] Agent opens `https://<host>/mobile-create-quote.html` on their iPhone Safari (not the Crisp in-app webview).
- [ ] Setup section expands automatically. Agent fills in:
  - Supabase Project URL
  - Publishable Key
  - Agent Admin Token
  - Agent Name
- [ ] Tap **Save setup**. Section collapses. Reload the page — values persist (Safari `localStorage`).

### Crisp Shortcut test

- [ ] Open a real (or test) customer conversation in Crisp iOS.
- [ ] Tap or type the shortcut you configured. Safari opens the URL.
- [ ] The gold "prefill" banner near the top shows `Email: <customer's actual email>` — confirms `{{customer.email}}` is substituting.
- [ ] The banner also says `Crisp session prefilled — confirmation will post to chat` — confirms `{{conversation.session_id}}` is substituting.
- [ ] If either is missing, try alternate macro names per the variance note above.

### Offer-creation smoke test

- [ ] Search a known product by SKU or title. Results appear within ~1 s. Tap one.
- [ ] `Product ID` and `SKU` auto-fill. Helper line shows the list price + minimum allowed quote.
- [ ] Enter a quoted price ≥ $50 and ≥ 50% of list. Leave expiration at 168 h.
- [ ] Tap **Create Special Offer**. Within ~1 s a green card appears with the quote ID, quoted price, customer email, expiry.
- [ ] Return to the Crisp conversation. A system message has been posted: *"Your concierge has prepared a special price of $X for "<title>" (was $Y)…"*. Confirm the message contains no token, no IDs, no secrets.
- [ ] Verify the row landed in Supabase: `select id, status, quoted_price_cents, original_price_cents, expires_at from support_quotes where customer_email = '<email>' order by created_at desc limit 1;` → status `active`, expires within the configured window.

### Customer-side verification

- [ ] Sign into the Xself Home app on a real device using the customer email used for the quote.
- [ ] Open Product Detail for the quoted product → tap the Concierge FAB.
- [ ] **Special Offer banner appears** above the compact product strip: `SPECIAL OFFER` eyebrow (gold), quoted price (charcoal), strikethrough list price (muted), `Expires in …` (muted).
- [ ] **Add to Cart** is disabled with the hint "Use Buy Now to apply your special price."
- [ ] **Buy Now** label reads `Buy Now · $X` (the quoted price).

### Checkout / payment verification

- [ ] Tap Buy Now → CheckoutScreen opens. Address + Stripe flow proceeds normally.
- [ ] Place Order. Confirm Stripe was charged the quoted price exactly (Stripe dashboard → recent payment → check `amount`).
- [ ] In Supabase: `select status, order_id from support_quotes where id = '<quote-id>';` → status is now `used`, `order_id` matches the new orders row.
- [ ] `select total, quote_id from orders where order_id = '<order-id>';` → `quote_id` matches the quote, `total` equals the quoted price (plus any shipping/tax).
- [ ] Re-open SupportScreen for the same product → no banner; Buy Now reverts to "Buy Now"; Add to Cart re-enabled. (Quote is single-use.)

---

## What the final URL looks like

After completing the deploy + Crisp shortcut configuration, the URL Crisp opens is:

```
https://xself-concierge-admin.netlify.app/mobile-create-quote.html?email=alice@example.com&conversation_id=session_e1f7a...
```

(Hostname varies by host; `email` and `conversation_id` are substituted by Crisp from the active conversation.)

The Crisp Shortcut **URL template** to paste into the dashboard:

```
https://<your-host>/mobile-create-quote.html?email={{customer.email}}&conversation_id={{conversation.session_id}}
```

That's the only string the agent needs in Crisp. Everything else (product search, quote validation, customer-side display, checkout pricing) is already wired and tested in Phases A and B.

---

## Rollback

If a deployment goes sideways:

- **Netlify**: Site Settings → **Deploys** → **Restore previous deploy**.
- **Vercel**: Project → **Deployments** → click an older deploy → **Promote to Production**.
- **Cloudflare Pages**: Project → **Deployments** → click an older deploy → **Rollback**.

The Supabase functions and `support_quotes` table are unaffected by any HTML rollback. Worst case for a bad HTML deploy: the form is unreachable for a few minutes; existing active quotes still work, and customers can still complete purchases.

---

## Out of scope (and intentionally so)

- App UI changes — banner / Buy Now / SupportScreen behavior unchanged from Phase B.
- Checkout — `create-checkout-order` quote validation unchanged from Phase A.
- Customer-facing pricing controls — there are none, and that's the point.
- Service-role key exposure — service-role never touches the admin tool. Only the publishable key (read-only via RLS) and the `AGENT_ADMIN_TOKEN` shared secret.
- Crisp plugin marketplace integration — the external-URL Quicklink is the MVP entry point.
