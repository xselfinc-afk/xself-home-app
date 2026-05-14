# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Xself Home is an Expo / React Native furniture commerce app (iOS, Android, Web) backed by Supabase. Bundle id: `com.xself.home`. The codebase ships a single user-facing app plus a large suite of TypeScript scripts that scrape and normalize supplier inventory (GIGA warehouse) into Supabase.

## Required reading before changes

Three repo-root docs are authoritative and override task instructions on conflict:

- `CLAUDECODE_RULES.md` — minimal-change rules, "Protected Systems — DO NOT TOUCH" list (Review, Recommendation, Category, Search systems), and the required after-task report format (files changed / reason / what was NOT changed / protected systems untouched).
- `DESIGN.md` — Apple-foundation + Wayfair commerce UI system. Defines the warm color palette (`#F3F1EB` canvas, gold `#EAB320`/`#CA8A04` accent — never `#000000` or `#0071e3`), typography, spacing, the floating glass tab bar, and a long list of forbidden patterns (yellow icon background blocks, competing CTAs, dashboard density, full-screen redesigns when a targeted fix was asked for).
- `NORMALIZATION_ENGINE.md` — source of truth for product title / features / description / specifications / image / family logic. **No UI-side cleaning or formatting** — the app only renders pre-normalized rows from `standardized_products`.

If a UI change would conflict with `DESIGN.md`, follow `DESIGN.md`. If a change feels like a full redesign when a targeted fix was asked, stop and ask.

## Commands

```bash
# Dev
npm start              # expo start (Metro)
npm run ios            # expo run:ios   (native build)
npm run android        # expo run:android

# Type check (this is the project's "test" — there is no jest/test runner)
npx tsc --noEmit --skipLibCheck

# Inventory pipeline (GIGA warehouse → Supabase)
npm run inventory:save-session    # one-time Playwright login, writes scripts/.giga-session.json
npm run inventory:sync            # full launchd-style scraper + verifier run
npm run inventory:sync:dry        # DRY_RUN=1 INVENTORY_LIMIT=2
npm run inventory:verify          # freshness check only
npm run inventory:http:sync       # alternate XHR/HTTP-based sync paths (see package.json)
npm run inventory:xhr:sync
```

`tsc` is configured via `tsconfig.json` extending `expo/tsconfig.base` and excludes `supabase/functions` (those are Deno edge functions, see below).

The inventory shell script `scripts/runGigaInventorySync.sh` is wired into `~/Library/LaunchAgents/com.xselfhome.giga-inventory-sync.plist`. It loads `.env.local` for `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (service-role key is **only** for scripts — never used in app code) and requires `scripts/.giga-session.json` to exist.

## Environment

Two env files, distinct roles:

- `.env` — `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`. `EXPO_PUBLIC_` prefix is required so Metro inlines them at bundle time. Used by the app at runtime via `src/lib/supabase.ts`.
- `.env.local` — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` for scripts. **Never imported by app code.**

`src/lib/supabase.ts` detects unfilled placeholder values and falls back to a non-throwing stub client so the app does not crash at module load. Use `supabaseConfigured` for conditional feature gating.

## Architecture

### The monolith: `App.tsx`

`App.tsx` is **~3,300 lines** and is the navigation + most-screens entry point. It owns:

- All providers, in order: `StripeProvider` → `AuthProvider` → `OrdersProvider` → `CartProvider` → `CartAnimProvider` → `RewardsProvider` → `RecommendationProvider` → `ConversationProvider` → `ToastProvider`.
- The bottom-tab navigator + native stack navigator.
- Home, Saved, Account, Product Detail screens (inline), plus the home category circle row, hero banner wiring, and search bar.
- Crisp chat SDK boot, splash-screen gate, expo-image variant helpers.

Larger or evolving screens live in `src/screens/*` (Discover, Checkout, Collection, Earn, Inbox, Orders, OrderSuccess, ProductConversation, Chat, Support, SupplierProducts). New screens go in `src/screens/`, not in `App.tsx`.

### Data layer

```
supplier_products (raw scrape)
  → normalizeProduct()                    src/services/normalizationPipeline.ts
  → standardized_products (Supabase)      upsert on supplier_product_id
  → adaptStandardizedRow()                src/services/detailProductAdapter.ts
  → Product (app shape)                   src/data/products.ts (Product interface)
  → UI
```

Normalization runs **outside** the app via `scripts/normalizeProducts.ts`. The app reads `standardized_products` and trusts every field — do not add cleaning/formatting in components. Adding new derived data means extending the pipeline + the `standardized_products` schema, then re-running normalization, then exposing via `adaptStandardizedRow`.

`LIST_SELECT` (from `detailProductAdapter.ts`) is the canonical Supabase column projection for list views — reuse it instead of hand-rolling selects.

### State (React Context)

Each `src/context/*Provider` owns a single concern: auth session, cart, cart-fly animation, rewards/referral, recommendations (with `diversify` helper), orders, conversations, toasts. Consume via the `useX()` hook exported next to each provider. There is no Redux / Zustand / Query — provider trees + Supabase calls in services.

### Services

`src/services/*` is the "what the app does" layer. Notable ones:

- `bootGate.ts` — `isHomeReady` / `markHomeReady` / `onHomeReady` gate the splash screen until the first home payload resolves.
- `homeCache.ts` — read/write cached home content for instant boot.
- `homeContentService.ts` — Supabase-driven home section titles.
- `gigaApiClient.ts`, `gigaService.ts`, `supplierProductService.ts`, `inventoryCacheService.ts`, `supplierPickupService.ts`, `pickupDateService.ts` — supplier + inventory.
- `productFamilyService.ts`, `familyKeyGenerator.ts` — product variants/family grouping.
- `reviewSubmitter.ts`, `reviewModerator.ts`, `reviewGenerator.ts`, `seedGeneratedReviews.ts` + `src/components/ReviewSection.tsx` — **Protected Review System.** Do not touch unless the task explicitly says so.
- `titleGenerator.ts`, `featureGenerator.ts`, `specFormatter.ts`, `normalizationPipeline.ts`, `dirtyTextFilters.ts` — content generation, called from `scripts/normalizeProducts.ts`.

### Edge functions (`supabase/functions/`)

Deno functions, not bundled with the app, **excluded from `tsconfig.json`**:

- `create-payment-intent`, `create-checkout-order`, `stripe-webhook` — Stripe flow.
- `validate-checkout-inventory`, `plan-fulfillment` — server-side fulfillment authority (see `PHASE3_*` / `PHASE4_*` / `PHASE5_*` audit docs).
- `dynamic-pricing` — server-driven pricing.
- `giga-warehouse-stock` — public stock endpoint.
- `support-chat`, `delete-account`.

The server is the source of truth for fulfillment and pricing; client must not recompute these.

### Native config

`app.json` declares plugins for `expo-image-picker` (camera + photo permissions wired for image search), `expo-secure-store` (Supabase session storage), `@stripe/stripe-react-native` (merchant id `merchant.com.xself.home`, Apple Pay only — Google Pay disabled), and `react-native-crisp-chat-sdk`. Native folders (`ios/`, `android/`, `apple/`) exist — this is a bare-style Expo project, not pure managed.

`babel.config.js` strips `console.log/info/debug` in production but keeps `console.error` / `console.warn`.

## Conventions

- TypeScript strict mode comes from `expo/tsconfig.base`.
- Imports in `App.tsx` are grouped roughly: screens, React, vector icons, RN core, expo-image + variant helpers, navigation, expo plugins, then app modules. Match this when editing.
- Image URLs go through `variantUrl` / `originalUrl` in `src/utils/imageVariant.ts` — do not hardcode CDN URLs.
- `src/data/products.ts` defines `Product`, `ProductVariant`, `MediaItem`, `formatPrice` and a fallback mock product list. Production data flows through `adaptStandardizedRow`, not the mock list.
- Numerous `PHASE*.md` and audit docs at repo root record decisions for fulfillment, payment, inventory source-of-truth, and RLS migrations — consult them before changing anything in those domains.
