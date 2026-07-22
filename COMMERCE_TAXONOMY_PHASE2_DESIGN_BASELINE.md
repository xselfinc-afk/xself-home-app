# Xself Home — Commerce Taxonomy Phase 2 Design Baseline (FROZEN)

Visual reference: [`prototype/taxonomy-preview/index.html`](prototype/taxonomy-preview/index.html) — the approved **Experience v4** prototype (isolated, non-production).
Data foundation: **Commerce Taxonomy Phase 1** (`src/utils/commerceTaxonomy.ts`, tag `xself-home-commerce-taxonomy-phase1-v1`).
Architectural rule (frozen in the Product Bible): the experience is **two separate but connected layers** — see below. This document is the single design contract for Phase 2 production implementation.

---

## 1. Experience Layer vs Commerce Layer
- **Experience Layer** — inspiration, browsing, storytelling, collections, shopping mood, AI discovery. Sits *above* commerce and only guides users *into* the hierarchy. Editorial tone. Must never *become* the taxonomy.
- **Commerce Layer** — Department → Category → Product Type → Search / Filters / Results / Inventory / Pricing / Checkout, on the Phase 1 hierarchy. Functional tone. Must never *feel* like a database.
- "Users **browse** through experiences; users **purchase** through commerce." As the user moves closer to products, editorial storytelling decreases and functional clarity increases.
- Every department (Furniture, Bathroom, and future Kitchen/Cleaning/Travel/Pet/Outdoor/Fitness…) must support **both** experience-first and commerce-first entry. Rooms are attributes, never departments.

## 2. Approved Home structure
- Top bar: **wordmark + full-width search field only** — no top-right search icon, no cart/bag icon (Cart lives in the bottom tab). No new top-right action without a unique confirmed purpose.
- **Hero** (editorial, serif headline) at ~80% of the earlier height, so the first viewport also reveals the browse entry.
- Persistent **"Browse all categories"** row = the commerce-first entry (always available; never gated behind an editorial journey).
- **"Shop your way"** = scalable parent section with modes (Shop by Room / Shop by Product / Shop by Need). Furniture currently exposes Room + Product; future departments may add other modes. This replaces "Shop by room" as the universal architecture.
- Preserve existing Home rhythm: "Shop the look" collections, "New this season," "Recommended for you" product rails.
- Inspiration-first, but not the only path.

## 3. Approved Furniture (Department) flow
- Editorial hero (serif): "Pieces that anchor a home."
- **"Shop by category"** (section title matches the labels): **Living Room Furniture, Bedroom Furniture, Cabinets & Storage, Dining Furniture, Home Office Furniture** — full customer-facing Category names, subtle counts. Scene cards: real photo where strong imagery exists, warm wash + consistent illustration otherwise. One visual language per level.
- **"Browse by product"**: high-intent Product Types as compact rows with the consistent illustration system (Sofas, Dressers, TV Stands, Sideboards, Beds, Desks).
- "Rooms we love" editorial collections.

## 4. Approved Bedroom (Category) flow
- Parent-oriented header: `‹ Furniture` / **Bedroom Furniture** / `91 items` (single count).
- **"Browse by product"** — hybrid: 2 featured Product-Type cards + the remainder as compact rows (Dresser, Wardrobe, Nightstand, Bed, Makeup Vanity, Mirror). Standardized illustrations (same line weight, front view, bounding box, background; unique silhouette per type).
- "View all N items" + a bestselling-bedroom preview rail.
- Tapping a Product Type opens **Results directly** — no standalone product-type context page.

## 5. Approved Results / Discover / Search / All Categories / Filter patterns
- **Results:** one hierarchy-context pattern only — `‹ Bedroom Furniture` / **Dressers** / `49 items`. No second category label, no breadcrumb chain, no delivery line in the title. Compact **Sort** + **Filters** pills. Existing real product cards. **No Favourites/heart** (not implemented in the app). Bottom inset clears the tab bar.
- **Discover (Experience):** exactly **three** stable tabs — For You / Collections / Shop by Space. Cards are **typed** (PRODUCT / COLLECTION / ROOM STORY) so users know what opens. Taxonomy stays in the background (a single Filters affordance).
- **Search (Commerce):** field unchanged; taxonomy is a *quiet* refinement — **Filters (N)** + at most **two** visible active chips; the result count (`49 results`) appears **once**.
- **All Categories:** structured **Department sections** (not a tag cloud); Categories in a controlled two-column list with subtle counts; active departments first, low-inventory ones under **"Also available,"** zero-product departments hidden.
- **Filter sheet (progressive):** single title **"Filters"**; rows Department → Category → **Product Type** (never "Piece"); tapping a row drills into that level's options (gold selected state, subtle counts). One back control (top-left) + bottom **Done**; **"Show N results."** Standardized overlay opacity, corner radius, drag handle, safe-area, button layout.

## 6. Typography boundaries
- **Serif (editorial) is Experience-only:** brand wordmark, Home hero, department editorial hero, campaign/collection headings.
- **Sans (existing Xself Home UI type) everywhere else:** navigation titles, All Categories, Discover, Search, Category/Product-Type titles, Filters, Results, buttons, counts, product cards. Do not create a second full UI type system.

## 7. Navigation & safe-area rules
- **Parent-oriented navigation** ("‹ Furniture") rather than long breadcrumb chains. Never combine a full breadcrumb with filter chips on the same screen.
- One consistent **floating glass bottom tab bar** across Experience and Commerce screens.
- **Global bottom inset** = tab-bar height + safe-area bottom + clearance, applied to every scrollable surface (grids, rails, category lists, skeletons, empty-state recommendations, sheet buttons). No content may sit under the tab bar.
- Loading = stable results header + skeletons that match the real card dimensions (no "Loading…" copy). Empty = same context pattern as Results; illustration drawn from the Product-Type illustration system; corrective CTA + recommendations.
- Count language platform-wide: **"items" / "results"** (never "pieces").

## 8. Features explicitly marked as FUTURE CONCEPTS (not production in Phase 2)
- **AI natural-language discovery** ("Describe your space…") — prototype shows it badged **"Concept."** Do not ship as a working feature in Phase 2.
- **Discover personalisation / "For You" ranking, "Shop the look" decomposition, room stories** — editorial placeholders; real intelligence is later-phase.
- **Favourites/heart** — omitted until the real app supports it.

## 9. Known prototype limitation (MUST NOT enter production)
The prototype reuses the single local **linen-sofa** photo set as stand-in product imagery — so Dresser/other result grids currently show sofas. **This is a prototype-only limitation.** Production must use **real live product images and product data** per product type; **no sofa stand-in imagery, stand-in product titles, or stand-in copy** may enter production.

---

*Frozen as the Phase 2 production design baseline. Tag: `xself-home-commerce-taxonomy-phase2-design-v1`.*
