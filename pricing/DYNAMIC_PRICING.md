# Dynamic Pricing System

**Version:** 2.0  
**Engine:** `supabase/functions/dynamic-pricing/index.ts`  
**Schema:** `supabase/dynamic_pricing.sql`  
**Table:** `public.standardized_products`

---

## 1. Overview

The dynamic pricing engine converts supplier wholesale costs into customer-facing retail prices. It runs as a Supabase Edge Function on a scheduled interval (every 6 hours) and updates pricing columns directly in `standardized_products`.

**Business goal:** Balance profit margin and conversion rate. Prices are meaningfully above supplier cost while remaining competitive for real customers in the home furnishings market.

**Pipeline:**

```
supplier cost (price)
  → base retail price  (markup × cost + buffer, grossed up for payment fees)
  → dynamic adjustment (demand signals + stock pressure)
  → final selling_price (psychologically rounded)
  → original_price     (anchor/MSRP = selling_price × 1.35)
```

---

## 2. Data Model

All fields live on `public.standardized_products`.

| Column | Type | Description |
|---|---|---|
| `price` | numeric(10,2) | Supplier wholesale cost. Never shown to customers. Source of truth for all pricing math. |
| `base_retail_price` | numeric(10,2) | Calculated retail price before dynamic adjustments. Written by the engine each run. |
| `selling_price` | numeric(10,2) | Final customer-facing price after dynamic adjustments. NULL = not yet priced. |
| `original_price` | numeric(10,2) | Anchor/MSRP shown as strikethrough. Set to `selling_price × 1.35`. |
| `pricing_markup` | numeric(6,4) | Markup multiplier applied to cost (e.g. 1.80). Written for transparency. |
| `fulfillment_buffer` | numeric(10,2) | Flat dollar amount added to cost before payment-fee gross-up. |
| `estimated_payment_fee` | numeric(10,2) | Stripe + CA tax portion of selling_price at current rate (3.556%). |
| `estimated_net_profit` | numeric(10,2) | `selling_price − cost − buffer − payment_fee`. |
| `estimated_net_margin` | numeric(8,4) | `estimated_net_profit / selling_price`. Stored as ratio (e.g. 0.401 = 40.1%). |
| `last_priced_at` | timestamptz | Timestamp of last engine run for this product. |

**Analytics columns** (read by engine to compute demand state):

| Column | Description |
|---|---|
| `view_count` | Incremented on card mount (ProductCard useEffect). |
| `click_count` | Incremented on card tap. |
| `add_to_cart_count` | Incremented on Add to Cart. |
| `order_count` | Incremented per line item on successful Stripe payment. |

---

## 3. Base Pricing Logic

### 3.1 Markup Tiers

Applied to `price` (supplier cost). Higher-cost items get lower multipliers to keep prices competitive.

| Cost range | Markup multiplier |
|---|---|
| ≤ $50 | 2.20× |
| $51 – $150 | 1.80× |
| $151 – $400 | 1.55× |
| $401 – $800 | 1.40× |
| > $800 | 1.28× |

### 3.2 Fulfillment Buffer

Flat dollar amount added after applying markup. Covers shipping, handling, and return risk.

| Cost range | Buffer |
|---|---|
| ≤ $100 | $20 |
| $101 – $300 | $30 |
| $301 – $800 | $50 |
| > $800 | $80 |

### 3.3 Payment Fee Gross-Up

After computing `rawBase = cost × markup + buffer`, the price is grossed up so that after Stripe takes its cut the net yield still equals `rawBase`.

```
STRIPE_FEE_RATE      = 0.033
SALES_TAX_ON_FEE     = 0.0775   (CA rate applied to Stripe fee)
PAYMENT_FEE_RATE     = 0.033 × (1 + 0.0775) ≈ 0.03556

grossed = rawBase / (1 − PAYMENT_FEE_RATE)
```

### 3.4 Psychological Rounding

Applied to `grossed` to produce the final `base_retail_price`.

| Price range | Rounding rule | Example |
|---|---|---|
| < $100 | `floor(price) + 0.99` | $47.23 → $47.99 |
| $100 – $299 | Nearest decade + 9 | $134.80 → $139 |
| $300+ | Nearest hundred + {49, 79, 99} | $344.55 → $349 |

If no suffix fits within the current hundred, spill to the next hundred's 49 (e.g. $399.10 → $449).

### 3.5 Margin Floor

After rounding, a hard gross-margin floor of 25% is enforced:

```
min_price = cost / 0.75
if base_retail_price < min_price:
    base_retail_price = psychologicalRound(min_price)
```

This floor rarely triggers in practice because the markup tiers already exceed it.

---

## 4. Dynamic Pricing Logic

### 4.1 Engagement Metrics

Computed per product from analytics counters. All divisions guard against zero.

```
CTR      = click_count / view_count        (click-through rate)
ATC_rate = add_to_cart_count / click_count (add-to-cart rate)
conv_rate = order_count / click_count      (conversion rate)
```

### 4.2 Demand State Detection

States are evaluated in priority order (first match wins):

| Priority | State | Condition |
|---|---|---|
| 1 | `high_demand` | `conv_rate > 0.05` |
| 2 | `medium_demand` | `atc_rate > 0.10` |
| 3 | `low_interest` | `CTR < 0.02` |
| 4 | `overstock` | `stock > 200 AND order_count == 0` |
| 5 | `neutral` | (none of the above) |

New products with zero engagement counters fall into `low_interest` (CTR=0 < 0.02).

### 4.3 Demand Multipliers

Applied to `base_retail_price`:

| State | Multiplier | Effect |
|---|---|---|
| `high_demand` | 1.08 | +8% |
| `medium_demand` | 1.05 | +5% |
| `neutral` | 1.00 | no change |
| `low_interest` | 0.90 | −10% |
| `overstock` | 0.88 | −12% |

### 4.4 Stock Pressure Override

Applied after the demand multiplier, independent of demand state:

```
if stock < 20:
    price × 1.10   (scarcity premium)
    stock_override = true
```

Stock totals are summed across all warehouses from `inventory_cache` (keyed by `product_id`).

### 4.5 Hard Floor (Dynamic Phase)

After all multipliers, the price is clamped to prevent extreme markdowns:

```
hard_floor = cost × 1.30
if adjusted_price < hard_floor:
    adjusted_price = hard_floor
    margin_protected = true
```

Psychological rounding is then applied to the final adjusted price.

---

## 5. Pricing Constraints

| Constraint | Rule |
|---|---|
| Minimum price | `selling_price >= cost × 1.30` (hard floor in dynamic phase) |
| Gross margin floor | `base_retail_price >= cost / 0.75` (25% gross margin) |
| Rounding | All final prices are psychologically rounded — no plain round numbers |
| Original price | Always `selling_price × 1.35`, psychologically rounded |
| Skip condition | If `selling_price` and `original_price` are both unchanged from prior run, skip the DB write |

---

## 6. Final Price Output

### selling_price

```
selling_price = psychologicalRound(
    applyDynamic(base_retail_price, demand_state, stock)
)
```

### original_price

```
original_price = psychologicalRound(selling_price × 1.35)
```

The `1.35` multiplier is defined as `ORIGINAL_PRICE_MULTIPLIER` in the function. It represents the implied "full MSRP" shown as a strikethrough to communicate discount to the customer.

### Implied discount

```
discount_pct = (original_price − selling_price) / original_price
             ≈ 26% (constant at neutral demand)
```

---

## 7. Execution Flow

```
1. Fetch all products
   WHERE normalization_status = 'done' AND price > 0

2. Fetch stock totals
   FROM inventory_cache
   SUM(quantity) GROUP BY product_id

3. For each product:
   a. Compute engagement metrics (CTR, ATC rate, conv rate)
   b. Determine demand state (priority-ordered rules)
   c. calculateBaseRetail(cost)
      - markup × cost + buffer
      - gross up for payment fees
      - psychological rounding
      - enforce 25% margin floor
   d. applyDynamic(base_retail_price, demand_state, stock)
      - apply demand multiplier
      - apply stock premium if stock < 20
      - enforce hard floor (cost × 1.30)
      - psychological rounding
   e. calcOriginalPrice(selling_price)
      - selling_price × 1.35, psychologically rounded
   f. Compute transparency values
      - estimated_payment_fee = selling_price × 0.03556
      - estimated_net_profit  = selling_price − cost − buffer − payment_fee
      - estimated_net_margin  = net_profit / selling_price

4. If price or original_price changed (or never priced):
   UPDATE standardized_products SET
     selling_price, original_price, base_retail_price,
     pricing_markup, fulfillment_buffer,
     estimated_payment_fee, estimated_net_profit, estimated_net_margin,
     last_priced_at

5. Batch INSERT into pricing_audit_log
   (supplier_product_id, sku, old_price, new_price, state,
    margin, stock_override, margin_protected, triggered_at)

6. Return JSON summary
   { processed, updated, states, triggered_at }
```

---

## 8. Example Calculations

### Example 1 — Low-cost item (cost = $50)

```
Inputs:
  cost              = $50.00
  demand_state      = neutral
  stock             = 45 units

Base retail:
  markup            = 2.20  (cost ≤ $50 tier)
  buffer            = $20   (cost ≤ $100 tier)
  rawBase           = 50 × 2.20 + 20 = $130.00
  grossed           = 130 / 0.96444 = $134.80
  base_retail_price = psychRound(134.80) = $139

Dynamic:
  demand_state = neutral → ×1.00
  stock = 45 → no scarcity premium
  selling_price = $139

Anchor:
  original_price = psychRound(139 × 1.35) = psychRound(187.65) = $189

Financials:
  payment_fee       = 139 × 0.03556 = $4.94
  estimated_net_profit = 139 − 50 − 20 − 4.94 = $64.06
  estimated_net_margin = 64.06 / 139 = 46.1%
```

### Example 2 — Mid-range item (cost = $75)

```
Inputs:
  cost              = $75.00
  demand_state      = neutral
  stock             = 80 units

Base retail:
  markup            = 1.80  ($51–$150 tier)
  buffer            = $20   (cost ≤ $100 tier)
  rawBase           = 75 × 1.80 + 20 = $155.00
  grossed           = 155 / 0.96444 = $160.71
  base_retail_price = psychRound(160.71) = $169

Dynamic:
  demand_state = neutral → ×1.00
  stock = 80 → no scarcity premium
  selling_price = $169

Anchor:
  original_price = psychRound(169 × 1.35) = psychRound(228.15) = $229

Financials:
  payment_fee       = 169 × 0.03556 = $6.01
  estimated_net_profit = 169 − 75 − 20 − 6.01 = $67.99
  estimated_net_margin = 67.99 / 169 = 40.2%
```

### Example 3 — High-cost item (cost = $195, low stock)

```
Inputs:
  cost              = $195.00
  demand_state      = low_interest (new product, CTR < 0.02)
  stock             = 12 units

Base retail:
  markup            = 1.55  ($151–$400 tier)
  buffer            = $30   ($101–$300 tier)
  rawBase           = 195 × 1.55 + 30 = $332.25
  grossed           = 332.25 / 0.96444 = $344.55
  base_retail_price = psychRound(344.55) = $349

Dynamic:
  demand_state = low_interest → ×0.90 → $349 × 0.90 = $314.10
  stock = 12 < 20 → scarcity premium ×1.10 → $314.10 × 1.10 = $345.51
  hard floor = 195 × 1.30 = $253.50  (not triggered)
  selling_price = psychRound(345.51) = $349

Anchor:
  original_price = psychRound(349 × 1.35) = psychRound(471.15) = $479

Financials:
  payment_fee       = 349 × 0.03556 = $12.41
  estimated_net_profit = 349 − 195 − 30 − 12.41 = $111.59
  estimated_net_margin = 111.59 / 349 = 32.0%
```

---

## 9. Deployment and Execution

### Deploy

```bash
supabase functions deploy dynamic-pricing
```

Requires Docker for local bundling, or will upload the file directly if Docker is unavailable.

### Run immediately via HTTP

```bash
curl -X POST \
  "https://erbimgfbztkzmpamzwky.supabase.co/functions/v1/dynamic-pricing" \
  -H "Authorization: Bearer <service_role_key>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response:
```json
{ "processed": 172, "updated": 171, "states": { "low_interest": 161, "neutral": 9, "overstock": 1 }, "triggered_at": "..." }
```

### Scheduled execution (pg_cron)

Requires `pg_cron` and `pg_net` extensions enabled in the Supabase dashboard.

```sql
select cron.schedule(
  'dynamic-pricing-6h',
  '0 */6 * * *',
  $$
  select net.http_post(
    url     := 'https://erbimgfbztkzmpamzwky.supabase.co/functions/v1/dynamic-pricing',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <service_role_key>'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

Verify schedule: `select * from cron.job;`  
Unschedule: `select cron.unschedule('dynamic-pricing-6h');`

### Schema migration

Run `supabase/dynamic_pricing.sql` in the Supabase SQL Editor when deploying to a new project or adding new columns. All `ALTER TABLE` statements use `ADD COLUMN IF NOT EXISTS` — safe to re-run.

---

## 10. Frontend Usage Rules

### Always use selling_price with price fallback

```typescript
// detailProductAdapter.ts
const customerPrice = r.selling_price != null && r.selling_price > 0
  ? r.selling_price
  : r.price;
```

This ensures that if the engine has not yet run (selling_price = NULL), the app falls back to `price` rather than showing nothing. Once the engine runs, `selling_price` takes precedence.

### Never expose supplier cost as the retail price

If `selling_price` is non-null and > 0, `price` must never be shown in the UI. The `price` column is internal cost data.

### All queries must select selling_price

Every Supabase query that populates product display must include `selling_price` and `original_price` in the select string:

```typescript
.select(
  '..., price, selling_price, original_price, ...'
)
```

Files that currently include these fields:
- `App.tsx` (4 queries)
- `src/screens/DiscoverScreen.tsx`
- `src/screens/CollectionScreen.tsx`
- `src/services/productFamilyService.ts` (FAMILY_SELECT constant)

### Displaying the discount

```typescript
// Show strikethrough if original_price > customerPrice
const showDiscount = product.originalPrice != null && product.originalPrice > product.price;
```

---

## 11. Notes for Future Optimization

### Adjusting markup for conversion

Markup tiers are defined in `getMarkup()`. To reduce prices across a cost band, lower the multiplier for that tier. Each 0.10 reduction in markup corresponds to roughly $10–$20 less per product in the $50–$200 cost range.

Current tiers represent approximately 2.2–2.8× effective ratio after buffer and payment fee gross-up.

### Adjusting demand sensitivity

Demand multipliers are in `applyDynamic()`. The current range is −12% (overstock) to +8% (high_demand). Widening this range increases price variance. Narrowing it stabilizes prices at the cost of less demand-responsive pricing.

To make the system more reactive to conversion signals, lower the `conv_rate > 0.05` threshold for `high_demand` or raise the multiplier from 1.08.

### Adjusting the original_price anchor

`ORIGINAL_PRICE_MULTIPLIER = 1.35` sets the implied discount at ~26%. Raising it increases the perceived discount (e.g. 1.50 = ~33% off), which may improve conversion on high-ticket items. Lowering it makes the discount appear smaller but more credible.

### Adding category-specific markup

The current markup is cost-based only. A future version could add a category multiplier:

```typescript
const categoryMultiplier = { 'sofa': 1.05, 'lamp': 1.15, 'bed': 1.00 };
const adjusted = rawBase * (categoryMultiplier[category] ?? 1.00);
```

### Improving demand state for new products

New products default to `low_interest` because CTR=0 < 0.02. This triggers a −10% discount on new inventory, which is intentional to drive initial sales. Once a product accumulates views and clicks, it will graduate to `neutral` or higher on the next engine run.

To suppress the low_interest discount for brand-new listings, add a `days_since_listed < 7` guard before the `low_interest` check in `demandState()`.
