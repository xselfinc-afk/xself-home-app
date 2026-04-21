# Xself Design System (Apple Foundation + Home Override)

IMPORTANT:
Read this entire file before making any change.

Execution priority:
1. Stable Module Protection Rules (highest)
2. Design & UI rules
3. Task instructions

If any conflict exists → follow protection rules.

---

# =========================================================
# 1. Stable Module Protection Rules (HIGHEST PRIORITY)
# =========================================================

## Core Constraint

Make minimal, targeted changes.
Do NOT modify anything outside the task scope.

---

## Forbidden Actions

- Do NOT modify working features
- Do NOT refactor unrelated files
- Do NOT optimize unrelated systems
- Do NOT fix "related issues"
- Do NOT rewrite stable modules

If a change may affect other systems:
→ STOP and explain first

If unsure:
→ ASK, do not guess

---

## Protected Systems — DO NOT TOUCH

### Review System
- ReviewSection.tsx
- reviewSubmitter.ts
- reviewModerator.ts
- reviewGenerator.ts
- seedGeneratedReviews.ts

### Recommendation System
- You May Also Like
- Frequently Bought Together
- ProductDetail recommendation logic

### Category System
- category_label
- category_priority
- is_new_arrival
- new_arrival_source

### Search System
- SKU search
- keyword search
- image search
- sku_search normalization

---

## Change Rules

- Only modify files directly related to the task
- Preserve layout, spacing, and behavior
- Prefer small patches over rewrites

---

## Required Output

After each task:

1. Files changed
2. Reason for change
3. What was NOT changed
4. Confirmation protected systems untouched

---

# =========================================================
# 2. Design System
# =========================================================

## Core Philosophy

- Clean, structured layout
- Product-first design
- Warm, home-oriented feel
- Avoid tech/minimal cold UI

---

## Colors

- Background: #F3F1EB
- Card: #FFFFFF
- Primary text: #403F3D
- Secondary text: #6B6A67
- Accent: #EAB320
- Secondary accent: #0D5F67

### Rules

- Use warm tones only
- Do NOT use #000000
- Do NOT use #0071e3
- Avoid high-contrast black/white UI

---

## Typography

- SF Pro Display / Text
- Weight: 400 / 600
- Tight spacing

---

## Layout

- 2-column grid
- Image ratio: 4:5
- Base spacing: 8px
- Screen padding: 16px

---

## Components

### Product Card
- White background
- Radius: 6–8px
- No borders
- Minimal shadow
- Max 2 lines title

### Button
- Gold primary
- Radius: 8px

### Tab Bar
- Floating
- Centered
- Must NOT block content

### Search Bar
- Consistent height
- Rounded pill
- Placeholder: "Search Xself"

---

## UX Rules

- Image-first
- Fast scroll
- No decorative UI

---

## Interaction Rules

- 1 primary action per screen
- Max 2 actions per product
- Hide complexity
- Show results, not explanations

---

## Hard Restrictions

- Do NOT redesign layout
- Do NOT change structure
- Only fix requested issues