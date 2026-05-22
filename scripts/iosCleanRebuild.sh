#!/bin/bash
# scripts/iosCleanRebuild.sh
#
# Recovery for Hermes / Pods ABI mismatches on iOS, including the canonical
# "[runtime not ready]: ReferenceError: Property 'MessageQueue' doesn't exist"
# crash that appears after a pod install changes CLANG_CXX_LANGUAGE_STANDARD
# or React Native / Hermes version, while DerivedData still holds the old ABI.
#
# This script is intentionally cautious:
#   • Only deletes DerivedData directories whose name starts with "XselfHome-".
#   • Does NOT touch any source / config / git state.
#   • Reinstalls Pods (which will re-emit a fresh Podfile.lock).
#   • Prints the remaining manual steps — it does NOT build or install the app
#     for you, so you can review before installing on your device.
#
# Usage:
#   npm run ios:clean-rebuild

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "═══════════════════════════════════════════════════════════════════"
echo " iOS clean rebuild — recovery for Hermes/Pods ABI mismatches"
echo "═══════════════════════════════════════════════════════════════════"
echo " What this script does:"
echo "   1. Removes Xcode DerivedData for XselfHome only"
echo "   2. Wipes ios/Pods + ios/Podfile.lock"
echo "   3. Reinstalls Pods (cd ios && pod install)"
echo "   4. Prints the next manual steps (Metro cache + device build)"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# 1. Remove only XselfHome-* derived data
DERIVED="$HOME/Library/Developer/Xcode/DerivedData"
if [ -d "$DERIVED" ]; then
  COUNT=$(find "$DERIVED" -maxdepth 1 -type d -name "XselfHome-*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COUNT" -gt 0 ]; then
    find "$DERIVED" -maxdepth 1 -type d -name "XselfHome-*" -exec rm -rf {} + 2>/dev/null || true
    echo "  ✓ Removed $COUNT DerivedData director(y/ies) for XselfHome"
  else
    echo "  ✓ No XselfHome DerivedData to clean"
  fi
else
  echo "  ✓ No Xcode DerivedData root to clean"
fi

# 2. Wipe Pods + lockfile
echo "  ✓ Wiping ios/Pods + ios/Podfile.lock"
rm -rf ios/Pods ios/Podfile.lock

# 3. Reinstall
echo "  ✓ Running pod install (this can take 30–60 seconds)..."
(cd ios && pod install) || { echo "✗ pod install failed — see output above" >&2; exit 1; }

echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo " Next steps (run manually — the script does NOT do these for you)"
echo "═══════════════════════════════════════════════════════════════════"
echo "  npx expo start --clear        # clears Metro cache"
echo "  npx expo run:ios --device     # builds + installs on the connected iPhone"
echo ""
echo "If the runtime-not-ready / MessageQueue error returns, also force-quit"
echo "the app on the device and re-launch. If it STILL persists, run:"
echo "  rm -rf node_modules && npm install"
echo "  npm run ios:clean-rebuild"
echo "═══════════════════════════════════════════════════════════════════"
