# Capturing the GIGA seller-portal warehouse-stock request

We can't ask GIGA for a feed, so we reuse the exact HTTP request their own
seller portal makes from your browser. Once we have it captured as cURL, we
can replay it from a Node script with `fetch` and read per-warehouse stock
the same way the website does.

This is a one-time capture (and a 5-minute redo whenever the request shape
changes).

---

## What you'll produce

A single file at:

```
tmp/giga_inventory_request.curl
```

containing the raw `curl …` line that DevTools generated from the warehouse
view request. That file is the input to:

- `scripts/importGigaInventoryCurl.ts` (Phase 2 — replay verbatim)
- `scripts/fetchGigaWarehouseInventoryFromCurl.ts` (Phase 3 — substitute the
  SKU and fetch any product)
- `scripts/syncGigaWarehouseInventoryHttp.ts` (Phase 4 — batch over every
  sellable product, write to `inventory_cache`)

---

## Manual steps

> Use your **normal Google Chrome**, not Chrome for Testing / Playwright.

### 1. Sign in to GIGA

1. Open Chrome.
2. Go to <https://www.gigab2b.com/index.php?route=common/home>.
3. Log in. Complete the captcha if shown. Stay on the dashboard.

### 2. Open the warehouse view for a known SKU

We use `W1445P146389` because it's the test product in our sync code; any
in-stock SKU works.

1. In the GIGA portal top bar, search for `W1445P146389` and open the
   product page. (If GIGA hides the search box, click **My Account → Search
   Product**, or paste the direct URL the scraper uses:
   `https://www.gigab2b.com/index.php?route=product/search&search=W1445P146389`,
   then click the result.)
2. Scroll until you see the **Warehouse Option** block.
3. Click **Specified Warehouse (additional fee applies)**.
4. Wait for the *Warehouse Quantity* table (CA / NJ / AT / TX rows + qty) to
   render below the radio.

### 3. Capture the network call

1. With the product page open, press **⌘⌥I** to open DevTools.
2. Switch to the **Network** tab.
3. Click the **Clear network log** ⨂ icon — start with an empty list.
4. **Tick "Preserve log"** (top of the panel) so we don't lose the request
   when the page re-renders after the click.
5. Toggle the radio off and back **on** ("Specified Warehouse") so the
   request fires again with a fresh entry visible in the list.
6. In the Network filter box, type one of these search terms one at a time
   and watch for a request that looks promising:

   - `stock`
   - `inventory`
   - `warehouse`
   - `qty`
   - `route=product` (GIGA OpenCart pattern)
   - the product id itself: `W1445P146389`

   The right request usually:
   - Returns `application/json` or HTML containing warehouse codes
     (`CA2`, `AT3`, `NJ1`, etc.) and integer quantities (`10`, `100+`, `141`).
   - Is sent to a path under `gigab2b.com/index.php?route=…` or a similar
     `/api/…` route.
   - Is **POST** in most observed cases — but check both.

7. **Right-click → Copy → Copy as cURL** on the request you believe is the
   real warehouse-stock call. (On macOS, "Copy as cURL" without "(bash)" is
   fine.)

### 4. Save it to the repo

```
mkdir -p tmp
pbpaste > tmp/giga_inventory_request.curl
```

Then verify it has content and looks like a cURL command:

```
head -c 400 tmp/giga_inventory_request.curl
```

### 5. Replay it once to be sure

```
npx tsx scripts/importGigaInventoryCurl.ts
```

You should see:

- `HTTP 200` (or 302/304 — investigate if it's 401/403)
- a content-type
- a preview of the response body
- a line like `Detected warehouse codes: CA2, CA3, AT3 …` and  
  `Detected qty-shaped tokens: 10, 4, 1, 49 …`

If the importer says **"No warehouse codes detected"**, you probably captured
a wrapper page request instead of the warehouse JSON. Go back to step 6 and
try a different request — typically the one that fires right after you
click the "Specified Warehouse" radio.

---

## Troubleshooting

| Symptom                                  | Likely cause                                                                                  |
|------------------------------------------|-----------------------------------------------------------------------------------------------|
| Response is HTML with a login form       | Cookies missing. Re-export — make sure you copied AFTER the dashboard loaded.                 |
| Response is 403 / "access denied"        | Origin or Referer is being checked. The cURL keeps those headers — re-copy from DevTools.     |
| Response is JSON but no warehouse codes  | Wrong endpoint. Try the request fired immediately after the "Specified Warehouse" click.      |
| Response is gzipped binary garbage       | `fetch` mishandled `Accept-Encoding`. Re-run the importer; it strips that header.             |
| Quantities are `10+` / `100+`            | Expected. GIGA hides exact counts above 10 for some warehouses; we treat `10+` as floor 10.   |

---

## Security

- `tmp/giga_inventory_request.curl` includes your **session cookies**. It
  should already be ignored by git via the existing `.env*` / `.giga-*`
  patterns; an explicit `tmp/` entry is added to `.gitignore` by this task.
- Never paste the captured cURL into a public issue, chat, or screenshot.
- When you rotate your GIGA password, recapture the cURL — the existing one
  becomes useless within a few minutes once the server-side session is
  invalidated.
