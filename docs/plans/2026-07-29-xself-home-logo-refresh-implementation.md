# XSelf Home Logo Refresh Implementation Plan

Date: 2026-07-29

## Phase 1 — Create deterministic brand assets

1. Record the SHA-256 and dimensions of the approved JPG.
2. Add a repository-local master copy to each scoped repository.
3. Produce opaque, square PNG derivatives without cropping or recoloring.
4. Verify dimensions, color space, and visual equivalence.

## Phase 2 — XSelf Home mobile app

Files:

- `assets/brand/xself-home-logo-master.jpg` (new)
- `assets/icon.png`
- `assets/logo.png`
- `assets/favicon.png` (new; already referenced by `app.json`)
- `ios/XselfHome/Images.xcassets/AppIcon.appiconset/App-Icon-1024x1024@1x.png`
- Android `mipmap-*` launcher images and `drawable-*` splash logo derivatives
- `scripts/gen-brand.js`

Actions:

- Make the approved master the generator input instead of drawing the obsolete
  X mark.
- Refresh Expo and native launcher derivatives.
- Keep `assets/splash/splash-screen.jpg` and iOS launch artwork unchanged.
- Verify the concierge avatar still resolves through `assets/icon.png`.

Validation:

- TypeScript check and mobile test suite.
- Expo configuration inspection.
- Native icon dimension and opacity checks.
- Git diff limited to approved brand resources and documentation.

## Phase 3 — XOne product identity

Files:

- `src/assets/xself-home-logo.jpg` (new)
- `src/components/shell/XOneSidebar.tsx`
- `src/components/shell/xone-shell.css`
- `src/components/organization/EmployeeNode.tsx`
- `src/components/organization/organization.css`
- focused sidebar/organization tests

Actions:

- Render the logo for only the `xself-home` sidebar item.
- Render the logo for only the `xself-owner` employee node.
- Preserve all existing fallback role icons.
- Preserve organization data, positions, edges, and selection behavior.
- Do not touch unrelated dirty design/QA files.

Validation:

- Frontend tests and TypeScript build.
- Rust tests.
- Desktop production build.
- Open/install the local XOne app for visual inspection.

## Phase 4 — Local XSelf Home website source

Files:

- `public/assets/xself-home-logo.jpg` (new)
- `public/index.html`
- `public/support.html`
- `public/privacy.html`
- `public/app-page.html`

Actions:

- Add an accessible logo-plus-name brand link to the three site headers.
- Replace the synthetic app-page `X` tile with the approved logo.
- Preserve all routes, page content, CTA targets, metadata, and production
  configuration.
- Do not deploy Preview or Production.

Validation:

- Local static-server route checks.
- Desktop and mobile screenshots.
- Asset reference and broken-link checks.
- Confirm Cloudflare production state is untouched.

## Phase 5 — Final integrity check

- Search all three repositories for stale reusable XSelf Home logo references.
- Confirm the user-supplied Desktop file is unchanged.
- Report commits and dirty-worktree state per repository.
- Report any pre-existing unrelated worktree changes separately.
