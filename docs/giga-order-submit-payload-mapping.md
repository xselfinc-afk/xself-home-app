# GIGA Order Submit — Payload Mapping (Phase 2c.1 Step 2)

> **⛔ PHASE 2c.1 SUBMIT-TO-GIGA IS DEFERRED (decision date 2026-06-05).**
> No edge function will be built from this design until the carrier BOL workflow
> is resolved. See **Section 0 — Deferral notice** below for the full reasoning
> and the production workflow that remains in effect.

**Status**: Design-review document. No code has been written. No GIGA call has been
made. The `admin-submit-approved-order` edge function is **NOT being built** at
this time; this document remains in place as a reference for future resumption.

**Scope**: Defines the exact source for every field that a future
`admin-submit-approved-order` edge function would send to GIGA, based on read-only
probes of the two existing approved test orders (ORD-42F8AF32 / ORD-2FE8C1EF).

---

## 0. Deferral notice (2026-06-05) — current production workflow

Phase 2c.1 (`admin-submit-approved-order`) is **paused**. The decision is
operational, not technical:

- **Submit-to-GIGA is deferred.** No automated GIGA order-creation function will be
  built at this time. The mapping captured in the rest of this document remains
  valid as a reference for when the work resumes.
- **Current production workflow is MANUAL after admin approval.** Once an order is
  paid (Stripe) and approved (`admin-approve-order`), an operator coordinates
  supplier fulfillment manually — e.g. via the GIGA dashboard, direct carrier
  arrangements, or other channels outside this codebase.
- **Admin approval does NOT create a supplier order.** The `admin-approve-order`
  function only sets `orders.admin_approval_status='approved'`. It does not call
  GIGA. It does not change `supplier_sync_status` from its default `'not_submitted'`.
  It does not assign `supplier_order_id`.
- **`supplier_sync_status` should remain `'not_submitted'`** for every approved
  order until a future Submit-to-GIGA phase is explicitly resumed. The Phase 1
  schema already enforces this default; no code or data action is required to
  maintain it.
- **Carrier BOL workflow must be designed before automated GIGA LTL submission can
  resume.** The GIGA `pickUpSelfLabel-sync/v1` endpoint requires a base64-encoded
  carrier BOL when `shipMethod="LTL"` AND `salesChannel≠"Amazon"` (catalog field
  `bolFile`, lines 4682–4690 of `scripts/debug-output/giga-openapi-catalog.json`).
  Until we have a workflow to obtain that BOL from an LTL carrier and pipe it into
  the submit request, no automated submission path can succeed for our furniture
  pickup model.

### 0.1 What still applies / what is still safe

- The Phase 2a/2b/2b.3 admin workflow (Approve, Reject, audit log) remains live and
  fully functional. Approved orders sit safely in `admin_approval_status='approved'
  · supplier_sync_status='not_submitted' · supplier_order_id=NULL` indefinitely.
- The mapping in §3–§7 of this document remains accurate against the catalog as of
  the 2026-05-28 snapshot. When work resumes, the updates likely needed are:
  - confirm a valid `shipServiceLevel` value from the GIGA account rep (no published
    enum exists in the catalog for LTL service levels)
  - decide whether `bolFile` is supplied (a) by an upload-before-submit operator
    workflow, (b) by a carrier API integration, or (c) by switching to a parcel
    flow that uses `labelFile` instead
  - re-verify that the `selectedWarehouse.code` (e.g. `CA11`) is accepted by GIGA
    natively or requires External Platform Mapping setup
- All safety controls already specified in §8 remain part of the design and will
  apply if and when Phase 2c.1 is resumed.

### 0.2 What is explicitly NOT permitted in the meantime

- No edge function named `admin-submit-approved-order` will be created
- No deploy with `GIGA_SUBMIT_ENABLED=true` will occur
- No call to any GIGA order-create endpoint
- No assignment of `supplier_order_id` to any order
- No transition of `supplier_sync_status` away from `'not_submitted'` for any order
- No UI Submit-to-GIGA button on `admin/orders.html`
- No batch-submit, no auto-submit-after-approve, no auto-retry

---

## 1. Endpoints

| Our `orders.fulfillment_method` | GIGA endpoint path | Title in GIGA catalog |
|---|---|---|
| `pickup` (this phase) | `/b2b-overseas-api/v1/buyer/order/pickUpSelfLabel-sync/v1` | Sync Self-arranged Shipping Orders (Buyer Supplied Label) |
| `delivery` (deferred to Phase 2c.1b) | `/b2b-overseas-api/v1/buyer/order/dropShip-sync/v1` | Sync Drop Shipping Orders |

Hosts:
- Sandbox: `https://openapi-sandbox.gigab2b.com`
- Production: `https://openapi.gigab2b.com`

Method: POST. Content-Type: `application/json`. HMAC headers identical to existing
inventory client (`src/services/gigaApiClient.ts:22-28`):

| Header | Value |
|---|---|
| `client-id` | `SUPPLIER_CLIENT_ID` env |
| `timestamp` | `Date.now().toString()` (ms since epoch) |
| `nonce` | 10-char lowercase alphanumeric, random per request |
| `sign` | base64-of-hex HMAC-SHA256 — message `clientId&path&ts&nonce`, key `clientId&secret&nonce` |

GIGA only processes requests within 20 minutes of `timestamp`.

---

## 2. Phase 2c.1 scope decision

**Pickup only first.** Both existing approved test orders (ORD-42F8AF32 + ORD-2FE8C1EF)
are pickup. Implementing pickup first lets us shake out the auth/transition/HMAC
scaffolding against orders we already understand. Delivery (`dropShip-sync/v1`) is a
Phase 2c.1b follow-up that reuses 95% of the same code path with a different endpoint
+ different field set.

---

## 3. Probe results summary (read-only)

### orders row shape (relevant subset)
Both ORD-42F8AF32 and ORD-2FE8C1EF returned **identical** structure (same customer
account, same address):

| Field | Value | Notes |
|---|---|---|
| `order_number` | ORD-42F8AF32 / ORD-2FE8C1EF | |
| `fulfillment_method` | `pickup` | |
| `customer_email` | `xselfinc@gmail.com` | |
| `guest_email` | `null` | |
| `customer_phone` | **`null`** | ⚠ Pickup phone optional — see Decision 3 |
| `created_at` | 2026-06-04T23:07:50.551Z / 2026-06-04T23:08:27.056Z | needs format conversion |
| `address_json` | `{ zip:"91730", city:"Rancho Cucamonga", line1:"8345 White Oak Ave", state:"CA", country:"US" }` | **5 keys only — no name, no line2, no phone, no email** |

### orders.fulfillment_plan (single object — single warehouse for these orders)
```jsonc
{
  "valid": true,
  "usePickup": true,
  "pickupEligible": true,
  "selectedWarehouse": {
    "code": "CA11",                  // ← GIGA warehouse code (use directly)
    "city": "Ontario",
    "label": "Ontario Warehouse (4)",
    "state": "CA",
    "address": "3510 E Francis St., Ontario, CA 91761, United States"
  },
  "pickupWindow": { "earliest": "2026-06-05", "latest": "2026-06-10" },
  ...
}
```

`fulfillment_groups_json` is an empty array on both orders. So per-line warehouseCode
is not in that field; the order-level `selectedWarehouse.code` is the authoritative
source for these single-warehouse orders.

### order_items table — actual column inventory
Confirmed via PostgREST `select=*` probe. The table has **these columns only**:

```
id, order_id, product_id, supplier_sku, title, quantity, unit_price_cents, total_cents, created_at
```

**No `warehouse_code` column on order_items.** **No `supplier_product_id` column on
order_items.**

Sample row for ORD-2FE8C1EF:
| Column | Value |
|---|---|
| `id` | 14d5e5d9-4898-4c70-a912-cf3fe4865168 |
| `order_id` | 2fe8c1ef-fd61-4036-9315-43d416ed5cbc |
| `product_id` | **`W1706P280672`** ← W-prefix format, matches GIGA's supplier_product_id pattern |
| `supplier_sku` | `XH-CB-LR-280672` ← internal Xself SKU, NOT GIGA |
| `title` | `Walnut Wood Buffet Cabinet with Line Groove` |
| `quantity` | `1` |
| `unit_price_cents` | `7000` |
| `total_cents` | `7000` |

### Catalog cross-reference
- `standardized_products` table has column **`supplier_product_id`** (e.g. `W714S01114`).
  Its column **`item_code` does not exist** — GIGA's "item code" terminology lives
  inside `supplier_products.item_code`, which equals the same W-prefixed format.
- `supplier_products` table sample: `{ id, product_id: "N725S412541K", item_code: "N725S412541K", ... }` — `item_code === product_id` for catalog rows.
- Existing inventory probes (`scripts/probeInventoryQuantityV2.ts:120-133`,
  `src/services/gigaApiClient.ts:80-94`) send these W/N-prefixed values to GIGA as
  `skus: [...]`. **GIGA accepts the W-prefixed format as the canonical SKU.**

### Resolved: GIGA's `orderLines[].sku` source
**`order_items.product_id`** (the W/N-prefixed value, e.g. `W1706P280672`).

The `order_items.supplier_sku` field (`XH-CB-LR-280672`) is an **internal Xself SKU**
and must NOT be sent to GIGA.

### Resolved: GIGA's `orderLines[].warehouseCode` source
**`orders.fulfillment_plan.selectedWarehouse.code`** (e.g. `CA11`).

For single-warehouse orders (all current orders are single-warehouse), every line in
the request uses the same warehouseCode. If multi-warehouse orders appear in the
future, the function will need to split lines per warehouse — out of scope for
Phase 2c.1.

### Remaining uncertainty
- Whether `CA11` is a GIGA-native warehouse code or an external-platform code (per
  GIGA catalog: "External Platform Mapping → Warehouse Mapping" must be set up for
  external codes). The first sandbox call will resolve this; the GIGA response will
  either accept the code or return a mapping error.

---

## 4. Full pickup payload mapping table

GIGA endpoint: `POST /b2b-overseas-api/v1/buyer/order/pickUpSelfLabel-sync/v1`

| # | GIGA field | Required? | Type | Source | Transform | Risk / notes |
|---|---|---|---|---|---|---|
| 1 | `orderNo` | ✅ | string | `orders.order_id` | as-is (UUID-text, dashes allowed per catalog regex "letters, digits, `-`, `_`") | **Idempotency key.** Critical that this matches across retries. Must equal `supplier_order_id` we store back on the orders row. |
| 2 | `orderDate` | ✅ | string | `orders.created_at` | `YYYY-MM-DD HH:MM:SS` (UTC, no timezone suffix) | Convert from ISO timestamptz |
| 3 | `shipEmail` | optional | string | `COALESCE(orders.customer_email, orders.guest_email)` | as-is | safe |
| 4 | `shipName` | optional | string | **OPERATOR DECISION (Decision 1)** — see §6 | n/a | `address_json` has no name field |
| 5 | `shipAddress1` | optional | string | `orders.address_json.line1` | trim to ≤35 chars (catalog limit) | If >35, truncate or fail-fast — recommend fail-fast in 2c.1; revisit later |
| 6 | `shipAddress2` | optional | string | (none — `address_json` has no line2) | omit field | safe (optional) |
| 7 | `shipCity` | optional | string | `orders.address_json.city` | as-is | safe |
| 8 | `shipState` | optional | string | `orders.address_json.state` | as-is (already 2-letter, e.g. `CA`) | safe |
| 9 | `shipZipCode` | optional | string | `orders.address_json.zip` | as-is | safe |
| 10 | `shipCountry` | optional | string | `orders.address_json.country` ("US") | as-is | Currently only US supported per catalog |
| 11 | `shipPhone` | optional | string | `orders.customer_phone` | omit if null | NULL on existing test orders; OK to omit (optional) |
| 12 | `hasOtherLabel` | optional | boolean | constant `false` | n/a | We don't add carton labels |
| 13 | `shipMethod` | ✅ | string | **OPERATOR DECISION (Decision 2)** — most likely `"LTL"` | n/a | LTL or one of {FedEx, UPS, GOFO Express, GOFO Ground, OnTrac, Amazon Shipping, USPS, ATS}. For furniture pickups, `LTL` is the expected value. |
| 14 | `shipServiceLevel` | conditional | string | required only if `shipMethod === "LTL"` | n/a | If LTL, operator must supply the LTL service tier. **Decision 2 follow-up.** |
| 15 | `shipCompany` | optional | string | constant `"Xself Home"` | n/a | Safe default |
| 16 | `salesChannel` | optional | string | constant `"Other"` | n/a | We are not Amazon/Wayfair/etc.; catalog explicitly allows "Other" |
| 17 | `orderLines[].itemPrice` | ✅ | number | `order_items.unit_price_cents / 100` | divide by 100 to dollars; catalog sample uses dollar amounts (`100`, not `10000`) | Verify cents-to-dollars in sandbox |
| 18 | `orderLines[].qty` | ✅ | integer | `order_items.quantity` | as-is | safe |
| 19 | `orderLines[].sku` | ✅ | string | `order_items.product_id` (W/N-prefixed format, e.g. `W1706P280672`) | as-is | **NOT `order_items.supplier_sku`** (that's our internal Xself SKU `XH-CB-LR-280672`) |
| 20 | `orderLines[].productName` | optional | string | `order_items.title` | as-is | Optional truthful pass-through |
| 21 | `orderLines[].warehouseCode` | optional | string | `orders.fulfillment_plan.selectedWarehouse.code` (e.g. `CA11`) | same value for every line in the order (single-warehouse only in 2c.1) | If GIGA returns mapping error in sandbox, we may need External Platform Mapping setup on GIGA's side — operator task, not code change |
| 22 | `orderLines[].currencyCode` | optional | string | constant `"USD"` | n/a | Our buyer account is US |

---

## 5. Worked example — synthetic pickup order

Assumes:
- A hypothetical pickup order with `order_id="11111111-2222-3333-4444-555555555555"`
- `created_at=2026-06-05T16:00:00Z`
- `address_json={zip:"91730",city:"Rancho Cucamonga",line1:"8345 White Oak Ave",state:"CA",country:"US"}`
- `customer_email=test@xself.local`, `customer_phone=null`
- One line item: `{ product_id:"W1706P280672", supplier_sku:"XH-CB-LR-280672", title:"Walnut Wood Buffet Cabinet with Line Groove", quantity:1, unit_price_cents:7000 }`
- `fulfillment_plan.selectedWarehouse.code="CA11"`
- Operator pre-decisions: `shipMethod="LTL"`, `shipServiceLevel="LTL Standard"`, `shipName="Xself Home"` (placeholder pending Decision 1)

```json
{
  "orderNo":      "11111111-2222-3333-4444-555555555555",
  "orderDate":    "2026-06-05 16:00:00",
  "shipEmail":    "test@xself.local",
  "shipName":     "Xself Home",
  "shipAddress1": "8345 White Oak Ave",
  "shipCity":     "Rancho Cucamonga",
  "shipState":    "CA",
  "shipZipCode":  "91730",
  "shipCountry":  "US",
  "hasOtherLabel":false,
  "shipMethod":      "LTL",
  "shipServiceLevel":"LTL Standard",
  "shipCompany":     "Xself Home",
  "salesChannel":    "Other",
  "orderLines": [
    {
      "itemPrice":     70.00,
      "qty":           1,
      "sku":           "W1706P280672",
      "productName":   "Walnut Wood Buffet Cabinet with Line Groove",
      "warehouseCode": "CA11",
      "currencyCode":  "USD"
    }
  ]
}
```

Fields explicitly omitted (all optional per catalog and either NULL on the order or
not applicable):
- `shipAddress2` — `address_json` has no `line2`
- `shipPhone` — `customer_phone` is null on these orders
- `shipServiceLevel` if `shipMethod` is not `LTL` (catalog only requires it for LTL)
- `customerComments`, `orderFrom`, `orderTotal`, `sellManager`, `payAccountNumber`, `payAccountPostalCode` — operator/system fields we don't currently track
- `packingSlip` — Home Depot–specific
- `ebayTransactionID` — dropShip-only

---

## 6. Operator decisions still required

| # | Decision | Default I'd recommend | Why it can't be auto-resolved |
|---|---|---|---|
| **1** | `shipName` for pickup orders | `"Xself Home"` (the buyer name, since the BOL is issued to the buyer and the customer is identified by `customerComments` if needed) | `address_json` has no name field. Could also use a hardcoded `"Xself Home"` or pull from a separate operator-configured value. |
| **2a** | `shipMethod` | `"LTL"` (most likely for furniture freight) | The choice is operational (LTL vs UPS Ground vs ATS), depends on the warehouse and item dimensions |
| **2b** | `shipServiceLevel` if Decision 2a is `LTL` | needs operator's preferred LTL tier (catalog says "If the shipMethod is LTL, this field is required") | LTL service tiers are carrier- and contract-specific |
| **3** | `shipPhone` policy when `orders.customer_phone` is null | omit the field (it's optional) | Existing test orders have null phone |
| **4** | Whether to send `customer_phone` or `xself company phone` when present | recommend `customer_phone` if present, omit otherwise | Identity question |

Until Decisions 1, 2a, 2b are made, the function cannot send a valid request to
GIGA. These should be either:
- (a) hardcoded constants in the function (simplest), or
- (b) Supabase secrets (`GIGA_SUBMIT_SHIP_METHOD`, `GIGA_SUBMIT_SHIP_SERVICE_LEVEL`, `GIGA_SUBMIT_SHIP_NAME`) that an operator can flip without redeploy

**Recommendation: Supabase secrets** — same posture as the kill switch / feature flag.
Operators can rotate the LTL tier without a code change.

---

## 7. Fields that must NOT be guessed

These have **no defensible default**; the function should either source them from
DB columns or refuse to send the request:

- `orderNo` — must equal `orders.order_id` (idempotency key)
- `orderLines[].sku` — must equal `order_items.product_id`. Sending `supplier_sku`
  (`XH-CB-LR-280672`) would invent a SKU that GIGA's catalog does not recognize.
- `orderLines[].qty` — must equal `order_items.quantity`
- `orderLines[].itemPrice` — must equal `order_items.unit_price_cents / 100`
- `orderLines[].warehouseCode` — must equal `fulfillment_plan.selectedWarehouse.code`
  (or omit, but for single-warehouse pickup this is the source of truth)
- `shipAddress1` / `shipCity` / `shipState` / `shipZipCode` — must equal the
  corresponding `address_json` fields. Falling back to a generic Xself address would
  send goods to the wrong warehouse.

If any of the above are missing or fail validation, the function MUST refuse to
submit (return `400 bad_request` to caller, write `submit_error` audit row, do NOT
call GIGA, do NOT take the `submitting` lease, do NOT increment attempt_count).

---

## 8. Safety constraints for future implementation (locked-in for Phase 2c.1)

The future `admin-submit-approved-order` edge function MUST honor:

1. **Feature flag default OFF** — `GIGA_SUBMIT_ENABLED=true` required to permit any submission
2. **Kill switch** — `GIGA_SUBMIT_KILLSWITCH=on` returns 503 even if feature flag is on
3. **Sandbox default** — `SUPPLIER_API_BASE_URL` defaults to sandbox host
4. **One order at a time** — single `order_id` input; no batch endpoint
5. **No auto-submit after approve** — the approval gate and the submit gate are two separate human actions
6. **No auto-retry on failure** — `failed` state requires operator investigation
7. **No UI button in Phase 2c.1** — first deployment is curl-only against sandbox; UI button deferred to Phase 2c.2
8. **Daily cap** — `GIGA_SUBMIT_DAILY_CAP` env var (recommended default 5) counts `submit_attempt` audit rows in the last 24h
9. **Per-order attempt cap** — `MAX_SUBMIT_ATTEMPTS=3` constant; pre-flight rejects 4th attempt
10. **Lease via 'submitting' state** — atomic WHERE-belt UPDATE takes the lease before the GIGA call; failure transitions to `failed`, NEVER auto-back-to-`not_submitted`
11. **`supplier_order_id = orders.order_id`** — our UUID is the buyer-supplied idempotency key
12. **Audit log on success AND failure** — `submit_attempt` always, plus `submit_success` or `submit_error`
13. **No DB schema change** — all Phase-1 columns + CHECKs already in place
14. **No customer UI change**, **no Stripe / checkout change**, **no BOL change**, **no migration**

---

## 9. Risks specific to this mapping (in addition to general Phase 2c.1 risks)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | `CA11` warehouse code might require GIGA's External Platform Mapping setup | Medium | First sandbox response will say `mapping not found` if so. Operator task on GIGA dashboard, not a code fix. |
| 2 | `shipAddress1` may exceed 35-char catalog limit on edge cases | Low | Test orders' line1 is 19 chars — safe. Function should validate ≤35 and reject if violated. |
| 3 | `orderDate` timezone interpretation by GIGA | Low | Catalog sample shows no timezone suffix. Send UTC formatted as `YYYY-MM-DD HH:MM:SS`. |
| 4 | `customer_phone` null on real production orders | Medium | Optional in catalog — omit. Long-term, we should require phone at checkout for pickup orders. |
| 5 | `address_json.line2` never populated by our checkout flow | Low | Catalog says optional; omit. |
| 6 | Operator picks wrong `shipMethod` for a non-furniture item | Medium | LTL is freight; small items may need UPS Ground. Phase 2c.2 UI should let operator review/override before clicking Submit. |
| 7 | `itemPrice` granularity — we have cents (7000), catalog sample uses dollars (100) | Low | Divide by 100. Sandbox call will confirm the unit interpretation. |
| 8 | Multi-line orders all share the same `warehouseCode` (cross-warehouse splits not supported) | Medium | Pre-flight: if more than one distinct warehouse across order_items / fulfillment_plan, refuse submission. For Phase 2c.1 we assume single-warehouse (matches reality of both test orders). |
| 9 | GIGA's `requestId` is the only post-call identifier (no `supplierOrderNo`) | Low | We capture it in `supplier_sync_response_json`. Our `orders.order_id` remains the cross-system identifier. |

---

## 10. Out of scope (deferred to follow-up phases)

- Delivery (`dropShip-sync/v1`) endpoint — Phase 2c.1b
- Status polling (`/b2b-overseas-api/v1/buyer/order/status/v1`) — Phase 2c.3
- Order cancellation via GIGA cancel API — Phase 2c.4
- UI Submit button + typed-confirmation modal — Phase 2c.2
- Multi-warehouse line splitting within one order — TBD
- Auto-retry on `failed` rows — never (intentional)
- Customer notifications — not in scope
- BOL fetching from GIGA's shipping-label endpoint — separate workflow (Phase 1B is buyer-uploads-BOL today)
- LTL contract carrier configuration — operator dashboard task on GIGA side

---

## 11. Strict-rules compliance for Step 2

- ✅ Read-only PostgREST probes only (no DB writes)
- ✅ Read-only code inspection
- ✅ One documentation file created/updated (this file)
- ✅ Zero edge-function code written
- ✅ No deploy
- ✅ No GIGA call
- ✅ No supplier order created
- ✅ No DB schema change
- ✅ No customer UI change
- ✅ No `admin/orders.html` change
- ✅ No Stripe / checkout / BOL change
- ✅ No commit

---

## 12. Decision summary requested before Phase 2c.1 Step 3

Step 3 = write `supabase/functions/admin-submit-approved-order/index.ts` plus optional
runbook. Step 3 cannot start until these five items are answered:

| # | Decision | My recommendation |
|---|---|---|
| 1 | `shipName` policy | `"Xself Home"` constant (or Supabase secret `GIGA_SUBMIT_SHIP_NAME`) |
| 2a | `shipMethod` | `"LTL"` (Supabase secret `GIGA_SUBMIT_SHIP_METHOD` so it can be flipped without redeploy) |
| 2b | `shipServiceLevel` for LTL | TBD by operator (Supabase secret `GIGA_SUBMIT_SHIP_SERVICE_LEVEL`) |
| 3 | Pickup-only first vs pickup+delivery together | **Pickup only** in Phase 2c.1; delivery in Phase 2c.1b |
| 4 | First sandbox test order | Use a synthetic test order (NOT ORD-42F8AF32 / ORD-2FE8C1EF) — design the synthetic-order setup as part of Step 3 |
| 5 | Operator decisions exposed as constants vs Supabase secrets | **Supabase secrets** — flippable without redeploy, consistent with feature flag / kill switch posture |
