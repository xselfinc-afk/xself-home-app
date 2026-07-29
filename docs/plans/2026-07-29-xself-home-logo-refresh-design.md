# XSelf Home Logo Refresh Design

Date: 2026-07-29

## Goal

Use `/Users/heliu/Desktop/XselfHome App /LogoBcc_200KB.jpg` as the single approved
visual source for XSelf Home branding across:

- the XSelf Home mobile app;
- XOne surfaces that identify the XSelf Home product;
- the local XSelf Home website source.

The artwork must not be redrawn, recolored, regenerated, or replaced with a
look-alike.

## Approved scope

### XSelf Home mobile app

- Preserve the supplied square artwork as the brand master.
- Refresh Expo, iOS, Android, and web icon derivatives from that master.
- Replace the legacy horizontal `XselfHome` logo asset.
- Keep the existing editorial splash-screen composition. It is a launch
  illustration, not the reusable logo source.
- Existing in-app uses of `assets/icon.png`, including the concierge avatar,
  inherit the new approved asset automatically.

### XOne

- Add a repository-local XSelf Home logo asset.
- Use it for the XSelf Home product entry in the sidebar.
- Use it for the XSelf Home product-owner node in the organization canvas.
- Do not replace XOne's own logo or the generic icons for unrelated roles and
  products.
- Preserve the existing organization layout, node positions, connectors, and
  interactions.

### XSelf Home website

- Add a repository-local copy of the approved logo.
- Replace the text-only brand mark in the site header with the logo plus the
  existing accessible XSelf Home name.
- Replace the synthetic `X` app mark with the approved logo.
- Apply the same treatment to Home, Support, Privacy, and app-link pages.
- Do not change copy, routes, SEO, canonical tags, manifest behavior, or
  Cloudflare configuration.
- Do not deploy Preview or Production as part of this change.

## Asset strategy

Each repository owns a checked-in copy of the approved artwork. No runtime
reference may point to the Desktop source path or to another repository.

Derived launcher assets are deterministic resizes or format conversions of the
approved artwork. They must:

- remain square;
- preserve the complete composition;
- avoid added rounded corners because operating systems apply their own masks;
- remain opaque for native app icons;
- use lossless PNG where required by native tooling.

## Visual behavior

Small XOne and website placements show the complete square logo inside the
existing visual rhythm. The logo must not be cropped to only the door symbol.
Text labels remain visible beside or below the logo so product identity does not
depend on tiny artwork details.

## Safety and rollout

- No App Store submission.
- No EAS production update.
- No website deployment.
- No Cloudflare, DNS, Supabase, Meta, or Seller Automation changes.
- Preserve unrelated dirty files in XOne.
- Validate mobile configuration and native asset dimensions.
- Run XSelf Home tests/type checks, XOne frontend/Rust tests and build, and local
  static-site link/render checks.

## Rollback

Each repository change is isolated to brand assets and their direct rendering
references. Reverting the corresponding commit restores the prior visuals. The
original user-supplied file remains untouched.
