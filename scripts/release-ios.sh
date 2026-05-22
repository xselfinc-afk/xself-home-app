#!/bin/bash
# scripts/release-ios.sh — Fully automated iOS App Store release for Xself Home.
#
# What it does (in order):
#   0. Preflight: required tools, EAS login, clean git tree.
#   1. Read current expo.version + expo.ios.buildNumber from app.json.
#   2. Validate eas.json (appVersionSource == "local").
#   3. Validate required EXPO_PUBLIC_* env vars in .env.
#   4. Type-check (npx tsc --noEmit --skipLibCheck).
#   5. Bump patch version (1.0.3 → 1.0.4) and build number (24 → 25).
#      Synchronize app.json and ios/XselfHome/Info.plist via PlistBuddy.
#   6. eas build --platform ios --profile production.
#   7. eas submit --platform ios --latest.
#   8. Print old/new versions + build URL + submit URL.
#
# Flags:
#   --dry-run        Preview the bump and validations; skip EAS build + submit.
#   --skip-submit    Build only; don't auto-submit to App Store Connect.
#   --allow-dirty    Don't abort on uncommitted changes.
#
# Future releases:   ./scripts/release-ios.sh

set -e
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── tiny color helpers ───────────────────────────────────────────────────────
g()   { printf "\033[32m%s\033[0m\n" "$*"; }
y()   { printf "\033[33m%s\033[0m\n" "$*"; }
r()   { printf "\033[31m%s\033[0m\n" "$*"; }
hdr() { printf "\n\033[1m═══ %s ═══\033[0m\n" "$*"; }
fatal() { r "✗ $*"; exit 1; }

# ── flags ────────────────────────────────────────────────────────────────────
DRY_RUN=0
ALLOW_DIRTY=0
SKIP_SUBMIT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --skip-submit) SKIP_SUBMIT=1 ;;
    -h|--help)
      sed -n '2,/^# Flags:/p' "$0" | sed 's/^# \{0,1\}//'
      sed -n '/^# Flags:/,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fatal "Unknown flag: $arg (use --help)" ;;
  esac
done

# ── 0. Preflight ─────────────────────────────────────────────────────────────
hdr "0. Preflight"

for cmd in node npx eas /usr/libexec/PlistBuddy git; do
  command -v "$cmd" >/dev/null 2>&1 || fatal "missing tool: $cmd"
done
g "✓ tools: node, npx, eas, PlistBuddy, git"

if ! eas whoami >/dev/null 2>&1; then
  fatal "Not logged into EAS. Run: eas login"
fi
g "✓ EAS authenticated as $(eas whoami 2>&1 | tail -1)"

if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  y "git working tree has uncommitted changes:"
  git status --short | sed 's/^/    /' | head -10
  fatal "Commit or stash first, or pass --allow-dirty"
fi
g "✓ git working tree clean (or --allow-dirty)"

# ── 1. Read current versions ─────────────────────────────────────────────────
hdr "1. Reading current versions"

APP_JSON="$REPO_ROOT/app.json"
INFO_PLIST="$REPO_ROOT/ios/XselfHome/Info.plist"
EAS_JSON="$REPO_ROOT/eas.json"

[ -f "$APP_JSON"   ] || fatal "app.json not found"
[ -f "$INFO_PLIST" ] || fatal "Info.plist not found at $INFO_PLIST"
[ -f "$EAS_JSON"   ] || fatal "eas.json not found"

OLD_VERSION=$(node -e "console.log(require('./app.json').expo.version)")
OLD_BUILD=$(node -e "console.log(require('./app.json').expo.ios.buildNumber)")
PLIST_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST")
PLIST_BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST")
g "  app.json  : version=$OLD_VERSION buildNumber=$OLD_BUILD"
g "  Info.plist: version=$PLIST_VERSION buildNumber=$PLIST_BUILD"

# If app.json and Info.plist disagree, take the max as the source of truth
# so we always bump from the higher of the two — never accidentally regress.
if [ "$OLD_VERSION" != "$PLIST_VERSION" ] || [ "$OLD_BUILD" != "$PLIST_BUILD" ]; then
  y "  ⚠ app.json and Info.plist disagree; will sync to the higher value before bumping"
  OLD_BUILD=$(( OLD_BUILD > PLIST_BUILD ? OLD_BUILD : PLIST_BUILD ))
fi

# ── 2. Validate eas.json ─────────────────────────────────────────────────────
hdr "2. Validating eas.json"

EAS_SRC=$(node -e "console.log((require('./eas.json').cli || {}).appVersionSource || '')")
if [ "$EAS_SRC" != "local" ]; then
  fatal "eas.json cli.appVersionSource must be \"local\" (currently: \"$EAS_SRC\"). Run: edit eas.json and set \"cli\": { \"appVersionSource\": \"local\" }"
fi
g "✓ cli.appVersionSource = local"

AUTO_INC=$(node -e "console.log(((require('./eas.json').build || {}).production || {}).autoIncrement === true ? 'true' : 'false')")
if [ "$AUTO_INC" = "true" ]; then
  fatal "eas.json build.production.autoIncrement is true — this would double-bump the build number this script just set.
       Open eas.json and remove or set: \"production\": { \"autoIncrement\": false }
       This script owns version + build number; you don't need autoIncrement."
fi
g "✓ build.production.autoIncrement is off (script owns the bump)"

# ── 3. Validate production env vars ──────────────────────────────────────────
hdr "3. Validating production env"

REQUIRED_VARS=(
  EXPO_PUBLIC_SUPABASE_URL
  EXPO_PUBLIC_SUPABASE_ANON_KEY
  EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
  EXPO_PUBLIC_APPLE_MERCHANT_ID
)
ENV_OK=1
for v in "${REQUIRED_VARS[@]}"; do
  if ! grep -E "^${v}=" .env >/dev/null 2>&1; then
    r "  ✗ $v missing from .env"
    ENV_OK=0
  fi
done
[ "$ENV_OK" -eq 1 ] || fatal "Missing required production env vars in .env"
g "✓ all required EXPO_PUBLIC_* env vars present in .env"

# Warn (don't fail) on Stripe test mode for a production release.
if grep -E '^EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test' .env >/dev/null 2>&1; then
  y "  ⚠ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY is a TEST key (pk_test_…). Production typically wants pk_live_…"
fi

# ── 4. TypeScript check ──────────────────────────────────────────────────────
hdr "4. Type-checking"
npx tsc --noEmit --skipLibCheck >/dev/null 2>&1 \
  || { npx tsc --noEmit --skipLibCheck; fatal "TypeScript errors — fix before releasing"; }
g "✓ TypeScript: no errors"

# ── 5. Compute + apply bumps ─────────────────────────────────────────────────
hdr "5. Bumping versions"

NEW_VERSION=$(node -e "
  const v = '$OLD_VERSION'.split('.');
  if (v.length !== 3) { console.error('Unexpected version shape: $OLD_VERSION'); process.exit(1); }
  const n = Number(v[2]);
  if (!Number.isFinite(n)) { console.error('Patch is not numeric: ' + v[2]); process.exit(1); }
  v[2] = String(n + 1);
  console.log(v.join('.'));
")
NEW_BUILD=$(( OLD_BUILD + 1 ))

g "  version : $OLD_VERSION  →  $NEW_VERSION   (patch +1)"
g "  build   : $OLD_BUILD  →  $NEW_BUILD   (build +1)"

if [ "$DRY_RUN" -eq 1 ]; then
  y "  --dry-run — not writing files, not running EAS"
  exit 0
fi

# 5a. write app.json (preserve key order via in-place JSON serialize)
node -e "
  const fs = require('fs');
  const p = require('./app.json');
  p.expo.version = '$NEW_VERSION';
  if (!p.expo.ios) p.expo.ios = {};
  p.expo.ios.buildNumber = '$NEW_BUILD';
  fs.writeFileSync('./app.json', JSON.stringify(p, null, 2) + '\n');
" || fatal "Failed to update app.json"

# 5b. write Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEW_VERSION" "$INFO_PLIST" \
  || fatal "PlistBuddy: failed to set CFBundleShortVersionString"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEW_BUILD" "$INFO_PLIST" \
  || fatal "PlistBuddy: failed to set CFBundleVersion"

# 5c. verify sync (catches any silent failure)
A_V=$(node -e "console.log(require('./app.json').expo.version)")
A_B=$(node -e "console.log(require('./app.json').expo.ios.buildNumber)")
P_V=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST")
P_B=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST")
if [ "$A_V" != "$NEW_VERSION" ] || [ "$A_B" != "$NEW_BUILD" ] \
   || [ "$P_V" != "$NEW_VERSION" ] || [ "$P_B" != "$NEW_BUILD" ]; then
  fatal "Version sync mismatch — app.json($A_V/$A_B) Info.plist($P_V/$P_B)"
fi
g "✓ app.json + Info.plist both at $NEW_VERSION ($NEW_BUILD)"

# ── 6. EAS build ─────────────────────────────────────────────────────────────
hdr "6. EAS build (production iOS)"
y "  Typical run time: 10–20 minutes. Press Ctrl-C only if truly stuck."

BUILD_LOG="$(mktemp -t eas-build.XXXXXX).log"
if eas build --platform ios --profile production --non-interactive 2>&1 | tee "$BUILD_LOG"; then
  BUILD_URL=$(grep -oE 'https://expo\.dev/[a-zA-Z0-9/_.-]*builds/[a-f0-9-]+' "$BUILD_LOG" | tail -1)
  g "✓ Build complete"
  [ -n "$BUILD_URL" ] && g "  Build URL: $BUILD_URL"
else
  fatal "EAS build failed — full log: $BUILD_LOG"
fi

# ── 7. EAS submit ────────────────────────────────────────────────────────────
SUBMIT_URL=""
if [ "$SKIP_SUBMIT" -eq 1 ]; then
  y "  --skip-submit set — skipping eas submit"
else
  hdr "7. EAS submit (App Store Connect)"
  SUBMIT_LOG="$(mktemp -t eas-submit.XXXXXX).log"
  if eas submit --platform ios --latest --non-interactive 2>&1 | tee "$SUBMIT_LOG"; then
    SUBMIT_URL=$(grep -oE 'https://expo\.dev/[a-zA-Z0-9/_.-]*submissions/[a-f0-9-]+' "$SUBMIT_LOG" | tail -1)
    g "✓ Submit complete"
    [ -n "$SUBMIT_URL" ] && g "  Submit URL: $SUBMIT_URL"
  else
    fatal "EAS submit failed — full log: $SUBMIT_LOG"
  fi
fi

# ── 8. Final summary ─────────────────────────────────────────────────────────
hdr "Release complete"
cat <<EOF

  Old version : $OLD_VERSION  (build $OLD_BUILD)
  New version : $NEW_VERSION  (build $NEW_BUILD)

  Build URL   : ${BUILD_URL:-(not parsed — check terminal output above)}
  Submit URL  : ${SUBMIT_URL:-(skipped or not parsed)}

  Next:
    1. Wait ~10–30 min for App Store Connect to process the build.
    2. Open https://appstoreconnect.apple.com → My Apps → Xself Home →
       TestFlight, then submit for review when you're happy.
    3. Commit the bump:
         git add app.json ios/XselfHome/Info.plist
         git commit -m "Bump iOS to $NEW_VERSION ($NEW_BUILD)"

EOF
