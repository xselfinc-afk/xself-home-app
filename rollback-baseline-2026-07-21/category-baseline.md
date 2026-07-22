# Category Behavior Baseline — 2026-07-21

Total sellable products: **349**

## Home category circles (App.tsx:75-84), in order
1. Storage
2. Living Room
3. Bedroom
4. Dining & Kitchen
5. Office
6. Outdoor & Garden
7. Bathroom
8. Pet Furniture

## Discover pills (categories.ts:8-18), in order
1. All
2. Storage
3. Living Room
4. Bedroom
5. Dining & Kitchen
6. Office
7. Outdoor & Garden
8. Bathroom
9. Pet Furniture

## Mapping logic
Discover filter: keep product iff product.categoryPath.level1 === selectedLevel1 (fallback: categoryLabel === sel || category === sel). DiscoverScreen.tsx:271-277. categoryPath is runtime-inferred by inferCategoryPath({name, category, categoryLabel}) in adaptStandardizedRow (detailProductAdapter.ts:351), where category = specifications_json['Category'] || category_code. A product resolves to exactly ONE level1 (single-valued) — it cannot appear under two pills. Home circles navigate to Discover with initialCategory=label (App.tsx:946).

## Product count per visible Level-1 category
| Level 1 | Count | Reachable pill? |
|---|---:|---|
| Storage | 205 | yes |
| Living Room | 53 | yes |
| Bathroom | 44 | yes |
| Bedroom | 22 | yes |
| Dining & Kitchen | 11 | yes |
| Office | 8 | yes |
| Other | 4 | NO (Other) |
| Pet Furniture | 1 | yes |
| Outdoor & Garden | 1 | yes |

## Level1 > Level2 (level2 internal only, not navigable)
| Path | Count |
|---|---:|
| Storage > Sideboard | 72 |
| Storage > Dresser | 62 |
| Living Room > Sofa | 40 |
| Storage > Cabinet | 33 |
| Bathroom > Vanity | 29 |
| Storage > Bookshelf | 19 |
| Storage > TV Stand | 17 |
| Bedroom > Nightstand | 14 |
| Bathroom > (none) | 10 |
| Dining & Kitchen > Dining Table | 9 |
| Office > Desk | 7 |
| Bedroom > Bed | 7 |
| Living Room > Coffee Table | 6 |
| Living Room > Console Table | 5 |
| Bathroom > Bathroom Cabinet | 5 |
| Other > (none) | 4 |
| Storage > (none) | 2 |
| Dining & Kitchen > Dining Chair | 2 |
| Living Room > Side Table | 2 |
| Office > Office Chair | 1 |
| Pet Furniture > Pet Furniture | 1 |
| Bedroom > (none) | 1 |
| Outdoor & Garden > Patio Furniture | 1 |

## Products unreachable via any visible pill: 4
- W2987P289172 — label=Other — "360° Rotating 69"x20" Multifunctional Full Length"
- W3258P293190 — label=Chair — "37" Left Bedside LED Dressing Table + Cushioned Stool, Large Sliding, Touch"
- W2987P288952 — label=Other — "360° Rotating 66"x17.8" Multifunctional Full Length"
- W2987P289196 — label=Other — "47.6 x 15.7 inch multi-functional design panel"

## Products reachable via multiple categories
None — mapping is single-valued (one level1 per product).
