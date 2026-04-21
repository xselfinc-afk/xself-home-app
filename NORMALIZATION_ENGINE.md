# Xself Product Normalization Engine

## Overview

The normalization engine converts raw supplier product data (`supplier_products`) into clean, retail-ready records (`standardized_products`). All content generation happens at normalization time — the app only reads pre-processed data from Supabase.

---

## Data Flow

```
supplier_products (raw B2B row)
  → normalizeProduct()               [normalizationPipeline.ts]
  → StandardizedProductInsert
  → standardized_products (upsert)   [Supabase]
  → adaptStandardizedRow()           [detailProductAdapter.ts]
  → Product (app shape)
  → UI renders clean data
```

---

## Running Normalization

```bash
npx tsx scripts/normalizeProducts.ts
```

Requires `.env` at project root:
```
SUPABASE_URL=https://<id>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service role key>
```

- Fetches all `published = true` rows from `supplier_products`
- Runs `normalizeProduct()` on each row
- Upserts into `standardized_products` on conflict `supplier_product_id`
- No skip logic — every row is always fully re-normalized

---

## Key Files

| File | Role |
|---|---|
| `scripts/normalizeProducts.ts` | Batch runner — fetches, normalizes, upserts |
| `src/services/normalizationPipeline.ts` | Core normalization logic, `normalizeProduct()` |
| `src/utils/contentGenerator.ts` | Content generation utilities (title, description, bullets) |
| `src/services/detailProductAdapter.ts` | DB→app adapter, `adaptStandardizedRow()` |
| `src/data/products.ts` | `Product` interface (app shape) |

---

## standardized_products Fields

| Column | Type | Source | Notes |
|---|---|---|---|
| `supplier_product_id` | text | `supplier_products.id` | Conflict key for upsert |
| `product_title` | text | `cleanTitle(row.title)` | Full cleaned retail title, ≤80 chars |
| `product_title_display` | text | `buildDisplayTitle(product_title)` | Shorter UI title, ≤55 chars |
| `short_description` | text | `buildDescription(desc, characteristics)` | 1–2 clean retail sentences |
| `key_features_json` | text[] | `buildBulletPoints(characteristics, desc)` | 4–6 usage-focused bullets |
| `specifications_json` | jsonb | Structured spec fields | `{SKU, Color, Material, Dimensions, Weight, Category}` |
| `sku_custom` | text | `XH-{CC}-{SC}-{SUFFIX}` | e.g. `XH-DR-BD-A3F2B1` |
| `category_code` | text | Keyword-mapped from title/category | `DR`, `CB`, `NS`, `TV`, `BK`, `CT`, `SF`, etc. |
| `scene_code` | text | Keyword-mapped | `BD` (bedroom), `LR` (living room), `HM` (general) |
| `color` | text | `raw_payload.mainColor` | |
| `color_options_json` | text[] | Derived from color | |
| `has_multiple_colors` | bool | `color_options_json.length > 1` | |
| `show_color_selector` | bool | Same as `has_multiple_colors` | |
| `material` | text | `raw_payload.mainMaterial` | |
| `dimensions` | text | `W {L}" × D {W}" × H {H}"` | Pre-formatted retail string |
| `weight` | text | `{N} lb` | Pre-formatted retail string |
| `primary_image` | text | `raw_payload.mainImageUrl` or `imageUrls[0]` | Never uses `fileUrls` (may contain PDFs) |
| `gallery_images_json` | text[] | Remaining ranked images | |
| `product_family_key` | text | `{cc}-{title-words-minus-color}` | Groups same-style color variants |
| `normalization_status` | text | Always `'done'` | Used as query filter |
| `price` | numeric | `row.price` | |

---

## Title Pipeline

### `cleanTitle(raw)` → `product_title`
- Strips promotional noise: "brand new", "hot sale", "luxury", "discount", etc.
- Strips trailing brand/category separators: `- Brand Name`, `(long parenthetical)`
- Collapses whitespace artifacts
- Hard-truncates at word boundary to **≤80 chars**

### `buildDisplayTitle(product_title)` → `product_title_display`
- Strips leading `[Tag]` prefixes (e.g. `[Video]`, `[Photo]`)
- Strips leading SKU references: `OLD SKU XXXX`, `new sku: ...`, `same sku`
- Moves leading "Set of N" to end: `"Set of 2 Chairs"` → `"Chairs, Set of 2"`
- Hard-truncates at word boundary to **≤55 chars**

### App display priority
```
product.displayTitle ?? product.name
```
Used in: Product Detail header, ProductCard listing titles.

---

## Description Pipeline

### `buildDescription(desc, characteristics, productTitle)` → `short_description`

1. Tries to extract 1–2 clean sentences from `row.description`
2. Falls back to first 1–2 usable `characteristics` strings
3. Returns `''` if nothing passes filters

**Filters applied (`isCleanSentence`):**
- Length ≥ 15 chars
- Not matched by `SKIP_DESC_PATTERNS` (assembly required, warning, note:, etc.)
- Not matched by `SKIP_BULLET_PATTERNS` (dimensions, weights — see below)
- Does not start with the first 4 words of `productTitle` (prevents title-repeat descriptions)

---

## Key Features Pipeline

### `buildBulletPoints(characteristics, desc, opts)` → `key_features_json`

1. Filters `characteristics` through `isUsableBullet`
2. If ≥4 clean bullets found, returns up to 6
3. Supplements from `desc` sentences if sparse
4. If still <4, fills from category-aware Wayfair-style templates (function, storage, usability, scenario, style, stability)

### `removeSpecDuplicates(features, specValues)` → deduped features
- Removes bullets that merely restate a known spec value (color, material, category)
- Reverts to original list if deduplication leaves fewer than 4

---

## SKIP_BULLET_PATTERNS — What Gets Blocked

Applied by `isUsableBullet` (key features) and `isUsableSentence` (short description).

| Pattern | Catches |
|---|---|
| `/assembly\s+required/i` | "Assembly required" |
| `/^please\s+(note\|read\|check)/i` | "Please note..." |
| `/^warning/i` | "Warning:..." |
| `/^note:/i` | "Note:..." |
| `/do\s+not\s+(wash\|bleach\|iron)/i` | Care instructions |
| `/^[\d\s.x×*-]+$/` | Bare number strings |
| `/^\s*(material\|color\|weight\|dimensions\|length\|width\|height\|...)/i` | Lines starting with spec field names |
| `/^\d+(\.\d+)?\s*['"]\s*[×xX]\s*\d+/` | Raw WxHxD strings |
| `/^\d+(\.\d+)?\s*(lbs?\|kg\|oz\|g)\s*$/i` | Bare weight values |
| `/\d+\s*['"]\s*[Hh]\s*[Xx×]\s*\d/` | `30"H x 20"W` style |
| `/^\s*(particle\s*board\|mdf\|engineered\s*wood\|...)\s*$/i` | Material-only lines |
| `/\b[WHDwhd]\s*\d+(\.\d+)?\s*[×xX]/` | `W48 x D20 x H30` format |
| `/^\s*\d+(\.\d+)?\s*(wide\|deep\|tall\|high\|long)\s*$/i` | Bare size descriptions |
| `/\b\d+(\.\d+)?\s*(lbs?\|lb\|pounds?)\b/i` | Mid-sentence weight values |
| `/\bproduct\s+(dimensions?\|size\|weight)\b/i` | "Product Dimensions", "Product Size" |
| `/\b(overall\|assembled)\s+(dimensions?\|size\|weight)\b/i` | "Overall Dimensions", "Assembled Weight" |
| `/\b(measures?\|measuring)\s+\d/i` | "measures 43 inches" |
| `/\b\d+(\.\d+)?\s*(inches?\|in\.)\s*(wide\|tall\|deep\|long\|high)\b/i` | "43 inches wide" |
| `/^selling\s+points?\s*[:：]/i` | Supplier section headers |
| `/^assembly\s+(kit\|steps?\|instructions?\|guide\|manual\|time)\b/i` | "Assembly Kit: Yes" |
| `/^(internal\|external\|interior\|exterior)\s+(space\s+)?(size\|dimensions?)\b/i` | "Internal space size:" |
| `/^package\s+(size\|dimensions?\|weight)\b/i` | "Package size:" |
| `/\b\d+(\.\d+)?\s*[""']?\s*[LWDHlwdh]\s*[xX×]/` | `18.7"W x 18.3"D` supplier format |

---

## SKU Format

```
XH-{CATEGORY_CODE}-{SCENE_CODE}-{LAST6}
```

Examples: `XH-DR-BD-A3F2B1`, `XH-TV-LR-C7D9E2`

**Category codes:** `DR` dresser, `CB` cabinet, `SB` sideboard, `NS` nightstand, `TV` TV stand, `BK` bookshelf, `CT` coffee table, `CO` console table, `SF` sofa, `DC` dining chair, `DK` desk, `WR` wardrobe, `BA` bathroom, `GH` general home

**Scene codes:** `BD` bedroom, `LR` living room, `HM` general home

**Suffix:** last 6 chars of original SKU (alphanumeric), or djb2 hash of row ID if no SKU

---

## Product Family Key

Groups same-style, different-color products. Built from:
```
{category_code_lowercase}-{title-words-minus-color-words-first-6}
```

Color variant words stripped: white, black, gray, brown, beige, oak, walnut, espresso, natural, dark, light, navy, blue, green, red, yellow, pink, purple, cream, ivory, gold, silver, charcoal, washed, rustic, vintage, antique, matte, glossy, frosted.

---

## Image Sourcing

Images are collected exclusively from `raw_payload`:
- `raw_payload.mainImageUrl` — primary image
- `raw_payload.imageUrls[]` — gallery images

**`row.images` (the `fileUrls` column) is never used** — it may contain PDF files from suppliers.

---

## Dimensions & Weight Format

Pre-formatted at normalization time for direct display:

```
Dimensions: W 43.66" × D 15.74" × H 74.00"
Weight:     134 lb
```

The app's `formatSpecValue()` in `App.tsx` is idempotent for these — it passes through values that already start with `W ` or are already formatted.
