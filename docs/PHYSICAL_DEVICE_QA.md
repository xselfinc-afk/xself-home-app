# Physical iPhone QA — Full Bundle Reload Rule

Operational rule for physical-device (dev-client) React Native QA on this project.
Recorded after a Commerce-Taxonomy Phase 2.5 QA incident (2026-07-23).

> Scope: dev-time QA only. Committed production flag defaults remain `false`
> (`src/config/commerceTaxonomy.ts`). Enabling the flags below is a **local QA
> override**, never a committed change.

---

## Verified Home composition (both flags `true`)

With `COMMERCE_TAXONOMY_ENABLED = true` and `COMMERCE_TAXONOMY_NAVIGATION_ENABLED = true`,
the connected iPhone renders the approved new Home, in order:

1. Xself Home wordmark
2. Search field — with divider + camera image-search
3. Fixed sofa Hero
4. "Explore the collection" → existing **Furniture department** (`CommerceBrowse`, `level: 'department'`, `department: 'furniture'`)
5. Browse all categories
6. Shop your way — Shop by room / Shop by product / Shop by need
7. New This Season
8. Remaining curated / product sections

**"Shop by department" is intentionally removed from Home.**

---

## Operational lesson (what went wrong)

The earlier "missing modules" was **not** deleted code. The source and the
Metro-served bundle both had the flags `true`, but the physical iPhone was still
executing an **older full bundle built while the flags were `false`**. A Fast
Refresh / 1-module HMR delta did **not** reliably make the already-running device
adopt a module-level flag change. Static checks (TypeScript, tests, bundle HTTP
200) and the flag-independent `[Home] perf` log all passed while the device UI was
still stale — so none of them proved what the device was actually rendering.

---

## Recovery procedure (confirmed working)

1. Keep both flags `true` (local QA override).
2. Stop the existing Metro process.
3. Start a fresh Metro with cleared cache: `npx expo start -c --dev-client`
4. Confirm Metro produces a **full multi-module** iOS bundle build (~1377 modules
   here), not only a `Bundled … (1 module)` HMR delta. Verify the served bundle
   compiled `COMMERCE_TAXONOMY_NAVIGATION_ENABLED = true`.
5. **Ensure the iPhone is unlocked** — a locked device fails `devicectl` launch
   with `BSErrorCodeDescription = Locked`.
6. Fully terminate and cold-launch Xself Home
   (`xcrun devicectl device process launch --terminate-existing --device <UDID> com.xself.home`).
7. Let the device download the fresh complete bundle, then visually confirm on-device.

---

## Rule for future physical-device RN QA

When a **module-level feature flag, hook structure, or exported component shape**
changes during physical-device QA:

- Do **not** infer the device UI from source values, TypeScript, bundle HTTP 200,
  or generic Home performance logs alone.
- Do **not** claim a flag-gated module is visible unless it is **visually confirmed
  on the physical device**.
- If the device UI disagrees with the current source/bundle, **first suspect a
  stale device JS runtime** — force a clean Metro restart + full cold reload
  **before** changing source code.
- Confirm the iPhone is **unlocked** before attempting a `devicectl` launch.
- A direct/manual bundle request proves Metro can build the graph; it does **not**
  prove the device downloaded that graph.
- Keep three values distinct:
  1. source flag value,
  2. Metro-served bundle value,
  3. bundle actually executing on the physical device.
