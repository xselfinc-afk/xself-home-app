#!/bin/bash
# releaseIosProduction.sh — one-shot, version-safe iOS production release.
#
# ⚠️ DEPRECATED (2026-06-24) — DO NOT USE FOR NEW RELEASES.
#   This one-shot AUTO-BUMPS the version + BUILDS + SUBMITS in a single command.
#   The supported path is the staged flow (see docs/IOS_RELEASE.md):
#       npm run release:ios:prepare -- --version <x.y.z> --build <n>
#       npm run release:ios:build   -- --confirm-build
#       npm run release:ios:submit  -- --confirm-submit   (staged submit — Phase 5)
#   Kept only as a reference until the staged submit lands; will be retired then.
#
# Refuses to submit any build whose version/buildNumber does not match the
# values in app.json. Also refuses to build if eas.json is not using local
# version sourcing (a remote-source build can silently override app.json).
#
# Manual run:
#   npm run release:ios:submit
#
# Exit codes:
#   0  build + submit succeeded for the exact build it just created
#   1  any precondition or version mismatch — nothing was submitted
#   2  build itself failed (errored / canceled)
#   3  submit step failed
#
# Reads (read-only): app.json, eas.json
# Writes:           tmp/eas-build-create.json, tmp/eas-build-view.json
# Mutates remote:   creates one EAS iOS production build + one submission

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "============================================================" >&2
echo " ⚠️  DEPRECATED one-shot (auto-bump + build + submit)." >&2
echo "     Preferred: staged flow — see docs/IOS_RELEASE.md:" >&2
echo "       npm run release:ios:prepare -- --version <x.y.z> --build <n>" >&2
echo "       npm run release:ios:build   -- --confirm-build" >&2
echo "       npm run release:ios:submit  -- --confirm-submit" >&2
echo "============================================================" >&2

TMP_DIR="$REPO_ROOT/tmp"
mkdir -p "$TMP_DIR"

BUILD_JSON="$TMP_DIR/eas-build-create.json"
VIEW_JSON="$TMP_DIR/eas-build-view.json"

# Resolve EAS binary. Prefer the locally installed one to avoid PATH surprises
# in launchd / cron contexts.
EAS_BIN="${EAS_BIN:-}"
if [ -z "$EAS_BIN" ]; then
  if [ -x "$REPO_ROOT/node_modules/.bin/eas" ]; then EAS_BIN="$REPO_ROOT/node_modules/.bin/eas";
  elif command -v eas >/dev/null 2>&1;          then EAS_BIN="$(command -v eas)";
  else
    echo "FATAL: eas-cli not found. Install with: npm i -g eas-cli"
    exit 1
  fi
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "FATAL: node executable not found. Install Node via nvm or Homebrew."
  exit 1
fi

# JSON helper — uses node so we don't take a hard dependency on jq.
json_get() {
  # $1 = file path, $2 = lodash-style path (e.g. "expo.ios.buildNumber")
  "$NODE_BIN" -e "
    const fs = require('fs');
    try {
      const obj = JSON.parse(fs.readFileSync('$1', 'utf8'));
      const path = '$2'.split('.');
      let cur = obj;
      for (const k of path) { if (cur == null) break; cur = cur[k]; }
      if (cur == null) process.exit(2);
      process.stdout.write(String(cur));
    } catch (e) {
      process.stderr.write('json_get failed: ' + e.message + '\n');
      process.exit(1);
    }
  "
}

banner() {
  echo
  echo "════════════════════════════════════════════════════════════"
  echo " $1"
  echo "════════════════════════════════════════════════════════════"
}

# ── Step 0: Auto-bump release version ────────────────────────────────────────
# Increments expo.version PATCH and expo.ios.buildNumber by 1, then propagates
# the new values into ios/XselfHome.xcodeproj/project.pbxproj via
# syncIosNativeVersion.js. Runs FIRST so every subsequent step (local read,
# pbxproj verify, guard:prod, eas build, post-build verify) sees the new
# version. Without this step, re-running release:ios:submit rebuilds the
# previous version/build, which App Store Connect then rejects as a duplicate.
#
# Escape hatch: SKIP_VERSION_BUMP=1 leaves app.json and pbxproj untouched.
# Use only when a prior run bumped successfully but a later step (EAS build,
# submit) failed and you want to retry without double-bumping.
banner "Step 0/8 — auto-bump release version (app.json + pbxproj)"
if [ "${SKIP_VERSION_BUMP:-0}" = "1" ]; then
  echo "  SKIP_VERSION_BUMP=1 — leaving app.json + pbxproj untouched (retry mode)"
else
  if ! "$NODE_BIN" "$REPO_ROOT/scripts/bumpReleaseVersion.js"; then
    echo
    echo "ERROR: bumpReleaseVersion.js failed. Refusing to build."
    echo "       Re-run with SKIP_VERSION_BUMP=1 only if you have already"
    echo "       manually set the intended version in app.json."
    exit 1
  fi
fi

# ── Step 1: Read local config ─────────────────────────────────────────────────
banner "Step 1/8 — reading local config"
LOCAL_VERSION="$(json_get app.json expo.version || true)"
LOCAL_BUILD="$(json_get app.json expo.ios.buildNumber || true)"
EAS_SOURCE="$(json_get eas.json cli.appVersionSource || true)"

if [ -z "$LOCAL_VERSION" ] || [ -z "$LOCAL_BUILD" ]; then
  echo "ERROR: could not read expo.version / expo.ios.buildNumber from app.json"
  exit 1
fi

echo "  app.json expo.version         : $LOCAL_VERSION"
echo "  app.json expo.ios.buildNumber : $LOCAL_BUILD"
echo "  eas.json cli.appVersionSource : ${EAS_SOURCE:-<unset>}"

# ── Step 2: Refuse remote version sourcing ────────────────────────────────────
if [ "$EAS_SOURCE" != "local" ]; then
  cat <<EOF
ERROR: eas.json cli.appVersionSource must be local. Refusing to build.

Why: with appVersionSource != "local", EAS uses its own server-side version
counter, which can silently overwrite app.json values. The audit step
(version + buildNumber match) would then be meaningless.

Fix: in eas.json set
  "cli": { "appVersionSource": "local" }
and re-run:
  npm run release:ios:submit
EOF
  exit 1
fi

# ── Step 2.5: Sync iOS native version from app.json into pbxproj ─────────────
# Expo prebuild only writes MARKETING_VERSION / CURRENT_PROJECT_VERSION on the
# first prebuild. Subsequent app.json bumps DO NOT propagate, so the .ipa
# metadata can lag behind app.json. We run the sync before guards so the guard
# that checks pbxproj <-> app.json sees the corrected file.
banner "Step 2/8 — npm run sync:ios-version (pbxproj <- app.json)"
if ! npm run sync:ios-version; then
  echo
  echo "ERROR: sync:ios-version failed. Refusing to build."
  exit 1
fi

# Re-read pbxproj values to confirm they now match app.json. The release
# script must not trust the script's exit code alone — the file is what EAS
# will actually compile against.
PBXPROJ="$REPO_ROOT/ios/XselfHome.xcodeproj/project.pbxproj"
if [ ! -f "$PBXPROJ" ]; then
  echo "ERROR: $PBXPROJ not found. Refusing to build."
  exit 1
fi
# Print EVERY MARKETING_VERSION / CURRENT_PROJECT_VERSION value so a reviewer
# can spot a stray block that didn't get rewritten.
echo "  pbxproj MARKETING_VERSION values:"
grep -nE "MARKETING_VERSION = [^;]+;" "$PBXPROJ" | sed 's/^/    /'
echo "  pbxproj CURRENT_PROJECT_VERSION values:"
grep -nE "CURRENT_PROJECT_VERSION = [^;]+;" "$PBXPROJ" | sed 's/^/    /'

# Any value that does NOT match app.json is a hard fail.
BAD_MARKETING="$(grep -oE 'MARKETING_VERSION = [^;]+;' "$PBXPROJ" \
  | sed -E 's/MARKETING_VERSION = (.*);/\1/' | sort -u | grep -v "^$LOCAL_VERSION$" || true)"
BAD_PROJECT="$(grep -oE 'CURRENT_PROJECT_VERSION = [^;]+;' "$PBXPROJ" \
  | sed -E 's/CURRENT_PROJECT_VERSION = (.*);/\1/' | sort -u | grep -v "^$LOCAL_BUILD$" || true)"
if [ -n "$BAD_MARKETING" ] || [ -n "$BAD_PROJECT" ]; then
  cat <<EOF

ERROR: pbxproj contains values that do not match app.json. Refusing to build.

  app.json version     : $LOCAL_VERSION
  app.json buildNumber : $LOCAL_BUILD
  Off-version MARKETING_VERSION     : ${BAD_MARKETING:-<none>}
  Off-version CURRENT_PROJECT_VERSION : ${BAD_PROJECT:-<none>}

Fix: re-run npm run sync:ios-version. If values still differ, the pbxproj
     has a config block whose key name isn't being matched — inspect the
     full pbxproj and extend syncIosNativeVersion.js.

EOF
  exit 1
fi

# Info.plist is the binary that EAS actually packages. If CFBundleShortVersionString
# or CFBundleVersion is hardcoded here, it overrides pbxproj at build time.
PLIST="$REPO_ROOT/ios/XselfHome/Info.plist"
if [ ! -f "$PLIST" ]; then
  echo "ERROR: $PLIST not found. Refusing to build."
  exit 1
fi
PLIST_SHORT="$("$NODE_BIN" -e "
  const fs = require('fs');
  const t = fs.readFileSync('$PLIST', 'utf8');
  const m = t.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
  process.stdout.write(m ? m[1].trim() : '');
")"
PLIST_BUNDLE="$("$NODE_BIN" -e "
  const fs = require('fs');
  const t = fs.readFileSync('$PLIST', 'utf8');
  const m = t.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
  process.stdout.write(m ? m[1].trim() : '');
")"
echo "  Info.plist CFBundleShortVersionString : $PLIST_SHORT"
echo "  Info.plist CFBundleVersion            : $PLIST_BUNDLE"

if [ "$PLIST_SHORT" != '$(MARKETING_VERSION)' ] || [ "$PLIST_BUNDLE" != '$(CURRENT_PROJECT_VERSION)' ]; then
  cat <<EOF

ERROR: Info.plist hardcodes the version/build. Refusing to build.

  CFBundleShortVersionString : $PLIST_SHORT
  CFBundleVersion            : $PLIST_BUNDLE

EAS packages Info.plist verbatim; a literal value here ships regardless of
what pbxproj says. Replace with build-setting variables:

  <key>CFBundleShortVersionString</key>
  <string>\$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>\$(CURRENT_PROJECT_VERSION)</string>

EOF
  exit 1
fi

# ── Step 3: Production guardrails ─────────────────────────────────────────────
banner "Step 3/8 — production guardrails (npm run guard:prod)"
if ! npm run guard:prod; then
  echo
  echo "ERROR: production guardrails failed. Fix the failures above before releasing."
  exit 1
fi

# ── Step 4: Trigger production build ──────────────────────────────────────────
banner "Step 3/8 — eas build --platform ios --profile production"
echo "Starting non-interactive build; this returns when the build job is queued."
echo

set +e
"$EAS_BIN" build --platform ios --profile production --non-interactive --json > "$BUILD_JSON"
BUILD_EXIT=$?
set -e

if [ "$BUILD_EXIT" -ne 0 ] || [ ! -s "$BUILD_JSON" ]; then
  cat <<EOF

ERROR: 'eas build' did not produce a JSON build descriptor.

  exit code        : $BUILD_EXIT
  output file      : $BUILD_JSON
  inspect recent   : eas build:list --platform ios --limit 5
  re-run build     : npm run release:ios:submit

EOF
  exit 1
fi

# ── Step 5: Extract build ID from the JSON payload ───────────────────────────
banner "Step 4/8 — parsing build ID"
BUILD_ID="$(
  "$NODE_BIN" -e "
    const fs = require('fs');
    try {
      const raw = fs.readFileSync('$BUILD_JSON', 'utf8');
      const data = JSON.parse(raw);
      // 'eas build … --json' returns an array of build objects.
      const arr = Array.isArray(data) ? data : [data];
      const ios = arr.find(b => (b.platform || b.platformDisplayName || '').toLowerCase().includes('ios')) || arr[0];
      if (!ios || !ios.id) process.exit(2);
      process.stdout.write(ios.id);
    } catch (e) { process.exit(3); }
  " 2>/dev/null || true
)"

if [ -z "$BUILD_ID" ]; then
  cat <<EOF

ERROR: could not parse build id from $BUILD_JSON.

  inspect raw output : less '$BUILD_JSON'
  list recent builds : eas build:list --platform ios --limit 5

EOF
  exit 1
fi

echo "  build id : $BUILD_ID"

# ── Step 6: Poll until the build finishes ─────────────────────────────────────
banner "Step 5/8 — waiting for build $BUILD_ID to finish"
POLL_INTERVAL="${POLL_INTERVAL:-30}"
# Default 60-minute hard cap — iOS production builds typically take 10–25 min.
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-3600}"
WAITED=0
LAST_STATUS=""

while :; do
  set +e
  "$EAS_BIN" build:view "$BUILD_ID" --json > "$VIEW_JSON"
  VIEW_EXIT=$?
  set -e
  if [ "$VIEW_EXIT" -ne 0 ] || [ ! -s "$VIEW_JSON" ]; then
    echo "  WARN: eas build:view exited $VIEW_EXIT (will retry)"
    sleep "$POLL_INTERVAL"
    WAITED=$((WAITED + POLL_INTERVAL))
    if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then
      echo "ERROR: gave up after ${MAX_WAIT_SECONDS}s waiting on build $BUILD_ID"
      echo "Next:   eas build:view $BUILD_ID"
      exit 2
    fi
    continue
  fi

  STATUS="$(json_get "$VIEW_JSON" status 2>/dev/null || true)"
  if [ "$STATUS" != "$LAST_STATUS" ]; then
    echo "  [$(date -u +%H:%M:%SZ)] status=$STATUS"
    LAST_STATUS="$STATUS"
  fi

  case "$STATUS" in
    FINISHED)
      break
      ;;
    ERRORED|CANCELED)
      LOG_URL="$(json_get "$VIEW_JSON" logsUrl 2>/dev/null || true)"
      cat <<EOF

ERROR: build ended with status=$STATUS

  build id     : $BUILD_ID
  status       : $STATUS
  EAS logs URL : ${LOG_URL:-<not provided in payload>}
  inspect      : eas build:view $BUILD_ID

EOF
      exit 2
      ;;
    *)
      sleep "$POLL_INTERVAL"
      WAITED=$((WAITED + POLL_INTERVAL))
      if [ "$WAITED" -ge "$MAX_WAIT_SECONDS" ]; then
        echo "ERROR: build still $STATUS after ${MAX_WAIT_SECONDS}s — giving up"
        echo "Next:   eas build:view $BUILD_ID"
        exit 2
      fi
      ;;
  esac
done

# ── Step 7: Verify build version matches local app.json ──────────────────────
banner "Step 6/8 — verifying build version matches app.json"
BUILD_VERSION="$(json_get "$VIEW_JSON" appVersion 2>/dev/null || true)"
BUILD_NUMBER="$(json_get "$VIEW_JSON" appBuildVersion 2>/dev/null || true)"

echo "  local  app.json expo.version         : $LOCAL_VERSION"
echo "  local  app.json expo.ios.buildNumber : $LOCAL_BUILD"
echo "  EAS    build.appVersion              : ${BUILD_VERSION:-<unknown>}"
echo "  EAS    build.appBuildVersion         : ${BUILD_NUMBER:-<unknown>}"

if [ -z "$BUILD_VERSION" ] || [ -z "$BUILD_NUMBER" ]; then
  cat <<EOF

ERROR: build payload missing appVersion or appBuildVersion. Refusing to submit.

  build id   : $BUILD_ID
  inspect    : eas build:view $BUILD_ID

EOF
  exit 1
fi

VERSION_MATCH=1
[ "$BUILD_VERSION" = "$LOCAL_VERSION" ] || VERSION_MATCH=0
[ "$BUILD_NUMBER"  = "$LOCAL_BUILD"   ] || VERSION_MATCH=0

if [ "$VERSION_MATCH" -ne 1 ]; then
  cat <<EOF

ERROR: EAS build version does NOT match app.json. Refusing to submit.

  build id          : $BUILD_ID
  local version     : $LOCAL_VERSION (app.json expo.version)
  local buildNumber : $LOCAL_BUILD (app.json expo.ios.buildNumber)
  EAS  version      : $BUILD_VERSION
  EAS  buildNumber  : $BUILD_NUMBER

Likely causes:
  - eas.json switched to remote versioning between the two runs
  - autoIncrement re-enabled in the production profile
  - app.json was edited after 'eas build' was triggered

Diagnostic commands:
  cat eas.json
  jq '.expo.version, .expo.ios.buildNumber' app.json
  eas build:list --platform ios --limit 5

Fix:
  1. Reconcile app.json so version + buildNumber match what you intend to ship.
  2. Confirm eas.json has cli.appVersionSource="local" and production.autoIncrement=false.
  3. Re-run: npm run release:ios:submit

EOF
  exit 1
fi

echo "  ✓ version + buildNumber match — safe to submit."

# ── Step 8: Submit only this build ID ────────────────────────────────────────
banner "Step 7/8 — eas submit --platform ios --id $BUILD_ID"
set +e
"$EAS_BIN" submit --platform ios --id "$BUILD_ID" --non-interactive
SUBMIT_EXIT=$?
set -e

if [ "$SUBMIT_EXIT" -ne 0 ]; then
  cat <<EOF

ERROR: eas submit failed (exit=$SUBMIT_EXIT)

  build id     : $BUILD_ID
  version      : $BUILD_VERSION
  buildNumber  : $BUILD_NUMBER
  retry submit : eas submit --platform ios --id $BUILD_ID

EOF
  exit 3
fi

banner "Step 8/8 — done"
cat <<EOF
  build id     : $BUILD_ID
  version      : $BUILD_VERSION
  buildNumber  : $BUILD_NUMBER
  status       : SUBMITTED
EOF

exit 0
