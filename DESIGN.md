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
# 2. XSELF HOME UI DESIGN SYSTEM
# =========================================================

## Core Philosophy

- Premium, clean, commerce-first UI
- Apple-like spacing, typography, and restraint
- Wayfair-like ecommerce clarity
- Warm, home-oriented feel — never cold or tech-minimal
- One primary action per screen
- Product-first: image leads, price is clear, CTA is single

---

## Colors

- Background: `#F3F1EB` (warm off-white — use everywhere)
- Card: `#FFFFFF`
- Primary text: `#1C1917`
- Secondary text: `#6B7280`
- Muted text: `#9CA3AF`
- Brand gold (primary accent): `#EAB320` / `#CA8A04`
- Divider: `rgba(0,0,0,0.06)`

### Color Rules

- Use warm tones only
- Do NOT use `#000000` or `#0071e3`
- Avoid high-contrast cold black/white UI
- Brand gold used ONLY for:
  - Primary CTA button fill
  - Active tab icon + label
  - Reward amounts and key numbers
  - Small inline gold accents
- Never overuse gold — one dominant gold element per section

---

## Typography

- SF Pro Display / Text (system font)
- Screen titles: `fontSize 22, fontWeight '700'`
- Section titles: `fontSize 15–16, fontWeight '600'`
- Body: `fontSize 13–15, fontWeight '400'`
- Labels/captions: `fontSize 10–12, color #9CA3AF`
- Weight range: 400 / 500 / 600 / 700 only

---

## Spacing

- Base unit: 8px
- Screen horizontal padding: 16–20px
- Card internal padding: 16–20px
- Section gap: 20–24px
- Bottom scroll padding: `insets.bottom + 100–120px` minimum

---

## Cards

- Background: white (`#FFFFFF`)
- Border radius: **6–8px**
- Shadow: `shadowOpacity 0.05–0.08`, `shadowRadius 6–8`, `shadowOffset {0,1}`
- No heavy borders
- No colored card backgrounds (except the membership/premium dark card)
- Dividers between rows: `StyleSheet.hairlineWidth`, `rgba(0,0,0,0.06)`

---

## Buttons

- **Primary**: gold fill (`#EAB320`), height 52–60, borderRadius 14–16, white text, fontWeight '700'
- **Secondary**: outline or text-only style — `borderColor rgba(202,138,4,0.4)`, no fill
- Only ONE strong primary CTA per screen
- No two competing filled gold buttons on the same screen

---

## Icons

- Outline style (`-outline` suffix from Ionicons)
- Consistent size: 18–22px for nav/actions, 14–16px for inline
- Active/selected state: gold color only (`#CA8A04` or `#EAB320`)
- **No background highlight circles or blocks behind icons**
- Cart add button: clean icon only, no yellow background

---

## Bottom Tab Bar

- Floating glass pill, centered horizontally
- Background: `rgba(255,255,255,0.82)` (semi-transparent warm white)
- Border radius: 36–40px
- Subtle shadow: `shadowOpacity 0.08`, `shadowRadius 18`, `shadowOffset {0,8}`
- Light border: `borderColor rgba(0,0,0,0.06)`, `borderWidth 1`
- Height: 72–80px
- Selected tab: **gold icon + gold label only** — no background, no circle, no pill
- Unselected tab: gray icon + gray label (`#9CA3AF`)
- Tab bar must NEVER overlap page content or CTAs

---

## Product Cards

- Image first
- Title: max 2 lines, `fontSize 13–14`
- Price: clear, `fontWeight '700'`
- Cart icon: **no yellow background block** — outline icon only
- Card radius: 10–16px depending on context
- Soft shadow only

---

## Empty States

- Must guide the next action — never a dead end
- Use a clean white card with: icon, title, subtitle, CTA
- No gray hero image placeholders
- No giant blank pages
- Include relevant product recommendations if data is available

---

## Screen-Specific Rules

### Cart
- Product confirmation + browsing environment
- Summary card at bottom with one "Checkout · $XXX" CTA
- Tab bar stays visible
- Floating tab bar must not cover CTA

### Checkout
- Decision screen: place order
- Do not mix browsing and checkout
- CTA at bottom of scroll content, not floating absolute

### Account / Membership
- One premium dark membership card as the focal point
- White system cards below (benefits, actions)
- No avatar-heavy profile pages
- Rewards balance is the main data point

### Referral / Earn
- One primary action: "Start Sharing"
- Balance card is the anchor
- Everything else secondary
- Must not feel like a dashboard

---

## Forbidden Design Patterns

- Too many gold elements on one screen
- Yellow icon background blocks (`rgba(234,179,32,0.12)` etc.)
- Heavy or large shadows
- Dense dashboard-style layouts
- Competing CTAs (two filled gold buttons)
- Multiple visual focal points per screen
- Selected-state background circles or pills in tab bar
- Gray hero image placeholders when image fails to load
- Generic template-app styling
- Pure flat black backgrounds (`#000000`)
- Random full-screen redesigns when a targeted fix was requested

---

# =========================================================
# 3. CLAUDECODE UI TASK TEMPLATE
# =========================================================

Use this exact structure for all future UI tasks:

---

TASK:
[One clear sentence describing the task]

IMPORTANT:
- Follow DESIGN.md strictly
- Do NOT redesign the whole screen unless explicitly requested
- Do NOT change business logic unless explicitly required
- Preserve existing navigation and data flow
- Make minimal, targeted, production-safe changes

CONTEXT:
[Current issue and why it feels wrong]

GOAL:
[Desired visual / UX outcome]

REQUIRED CHANGES:
1. [Specific change]
2. [Specific change]
3. [Specific change]

DO NOT:
- [Specific forbidden change]
- [Specific forbidden change]

VERIFICATION:
- Run: npx tsc --noEmit --skipLibCheck
- Manually inspect affected screen
- Confirm no unrelated UI changed

FINAL RESULT:
[Clear expected final state]

---

## Conflict Resolution

If a requested UI change conflicts with DESIGN.md:
→ Prioritize DESIGN.md unless the user explicitly overrides it in the task.

If a change feels like a full redesign when a small fix was requested:
→ STOP and ask for clarification before proceeding.
