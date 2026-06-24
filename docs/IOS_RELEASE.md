# iOS Release — Canonical Policy & Runbook

**This is the single source of truth for iOS releases.** Other docs should link here, not repeat these
rules. The machine-enforced gates live in one place too: `scripts/iosReleasePlan.ts` (`evaluateGates`),
reused by every release command. This is an Expo **bare** workflow (an `ios/` project exists), so
`app.json` alone is NOT authoritative — the native files must agree.

## Final daily App Store release flow (3 commands)
```bash
cd /Users/heliu/xself-home-app
npm run release:ios:prepare -- --version 1.0.10 --build 31   # align version/build/runtime files + focused commit
npm run release:ios:build   -- --confirm-build               # gated EAS production build (no submit)
npm run release:ios:submit  -- --confirm-submit              # verify the recorded EAS build artifact == prepared, then submit that build id
```
`prepare` runs the same gates internally (before and after writing), so **`release:ios:plan` is NOT
required in the daily flow** — it is a **read-only diagnostic/preflight** you can run anytime (or in
CI) to check "is the tree releasable?": `npm run release:ios:plan -- --version 1.0.10`.

**Build and submit are intentionally separate.** The gap between them is where you wait for the EAS
build, eyeball it, and confirm the App Store Connect build number is free. They are never merged.

## App Store version vs iOS build number
- **version** (`app.json` `expo.version`, pbxproj `MARKETING_VERSION`) = the user-visible marketing
  semver, e.g. `1.0.10`.
- **build number** (`app.json` `expo.ios.buildNumber`, pbxproj `CURRENT_PROJECT_VERSION`) = an integer
  that **must strictly increase for every binary uploaded under the same marketing version**. App
  Store Connect rejects a re-upload of an existing `version + build`.
- **Same version, new upload ⇒ bump the build:** if `1.0.10 (build 31)` was already uploaded
  (App Store or TestFlight), prepare the next build before building again:
  `npm run release:ios:prepare -- --version 1.0.10 --build 32`.
- `app.json ios.buildNumber` and pbxproj `CURRENT_PROJECT_VERSION` must always match (gated).
- **Build-number freshness is checked manually.** Tooling cannot know what's already in ASC without
  ASC credentials, so `release:ios:build` prints a manual checkpoint and proceeds only with
  `--confirm-build` (which asserts you confirmed the build number is free).

## runtimeVersion / Expo.plist / OTA relationship
- `app.json` `runtimeVersion` **must be a string** in this bare workflow (a policy object is rejected).
- `app.json runtimeVersion` and `ios/.../Expo.plist` `EXUpdatesRuntimeVersion` **must match** — the
  SHIPPED binary's OTA runtime comes from `Expo.plist`. (This is the mismatch the gates caught and
  `prepare` fixed: `1.0.9 → 1.0.10`.)
- For a new binary release, `runtimeVersion` tracks the native version (e.g. `1.0.10`).
- An OTA update reaches **only** binaries whose embedded runtime + channel match the update's
  `runtimeVersion` + channel (`production`). Bumping the runtime per native release cleanly segments
  OTA lanes by version.

## When to use an App Store binary release
Any **native** change (native code/deps/config, or a `runtimeVersion` bump) **or** any time you need a
new installable binary. OTA cannot ship native changes or cross a runtime boundary — those always
require an EAS build + the Apple developer account.

## When OTA is allowed / forbidden
- **Allowed:** JS/asset-only changes for the **same `runtimeVersion` as an already-LIVE App Store
  binary**, on `channel=production`.
- **Forbidden:** native changes (→ new binary); publishing to a `runtimeVersion` whose binary is not
  yet live/installed; attempting to change `runtimeVersion` via OTA (impossible).
- **Do NOT publish an OTA update for runtime `1.0.10` before the App Store `1.0.10` binary is
  live/installed.** No device has a `1.0.10` binary yet, so the update reaches no one — and if a
  `1.0.10` build is in review/TestFlight, you'd be mutating the JS reviewers/testers run and shipping
  JS that was never reviewed with the binary.
- OTA gets its own staged commands **later** (Phase 6): `release:ota:plan` and
  `release:ota:publish -- --confirm-ota`. Not implemented yet.

## Release gates (enforced by every command)
`runtimeVersion` is a string · `Expo.plist` runtime == `app.json` runtime · pbxproj
`MARKETING_VERSION` == `app.json` version · pbxproj `CURRENT_PROJECT_VERSION` == `app.json` build ·
`app.json updates.url` == `Expo.plist EXUpdatesURL` · `Expo.plist` channel == `production` · eas.json
`production.channel` == `production` · eas.json `appVersionSource` == `local` · submit `ascAppId`
present · no version downgrade. `release:ios:build` additionally requires `--confirm-build`, a clean
tree (no modified tracked files outside the release files), and **`guard:prod` passing**, and records
the produced EAS build id to `reports/release/ios-release-state.json` for submit.

## Hard rules (do NOT)
- **Do not auto-bump** version or build number — always pass `--version` / `--build` explicitly.
- **Do not merge** build and submit into one command.
- **Do not silently push or tag** — the tools warn and recommend, but the operator pushes/tags.
- **Do not publish OTA** before the matching binary is live.
- **Do not print** Apple credentials, EAS tokens, ASC API keys, env values, or provisioning details.

## Legacy one-shot — DEPRECATED
`scripts/releaseIosProduction.sh` is a **deprecated** one-shot that **auto-bumps + builds + submits** in
a single command. **Do not use it for new releases** — use the staged flow above. As of Phase 5,
`npm run release:ios:submit` is **repointed to the staged submit** (`scripts/iosReleaseSubmit.ts`); the
one-shot has **no npm alias** and is kept only as a runnable-by-path reference (with a deprecation
banner). It will be retired after the staged flow ships a real release.

## Phase status
- Phase 1 ✅ `release:ios:plan` (read-only gates)
- Phase 2 ✅ `release:ios:prepare` (align files + commit)
- Phase 4 ✅ `release:ios:build` (gated EAS production build; no submit)
- Phase 5 ✅ `release:ios:submit` (verify the recorded EAS build artifact, submit that specific id; one-shot deprecated + de-aliased) ← this doc
- (later) retire `scripts/releaseIosProduction.sh` once the staged flow ships a real release
- Phase 6 ⏳ OTA `release:ota:plan` / `release:ota:publish`
