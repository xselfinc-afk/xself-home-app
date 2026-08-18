#!/bin/bash
# Install / uninstall the daily review-coverage reconciliation LaunchAgent.
#
# The plist is generated here rather than committed as a file because it must carry an absolute
# path to this checkout, which differs per machine. Nothing secret is written: the wrapper sources
# .env.local at run time, so SUPABASE_SERVICE_ROLE_KEY never lands in ~/Library/LaunchAgents.
#
#   npm run reviews:schedule:install     # install or update, then verify
#   npm run reviews:schedule:uninstall
set -euo pipefail

LABEL="com.xself.review-coverage.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

uninstall() {
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "[reviewSchedule] uninstalled $LABEL"
}

install() {
  [ -f "$REPO/.env.local" ] || { echo "[reviewSchedule] .env.local missing — the job would have no credentials"; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$REPO/scripts/runReviewCoverageReconcile.sh</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$REPO</string>
	<key>StandardOutPath</key>
	<string>$HOME/Library/Logs/$LABEL.out.log</string>
	<key>StandardErrorPath</key>
	<string>$HOME/Library/Logs/$LABEL.err.log</string>
	<key>RunAtLoad</key>
	<false/>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>9</integer>
		<key>Minute</key>
		<integer>30</integer>
	</dict>
</dict>
</plist>
PL
  # Reload so re-running picks up a moved checkout instead of silently keeping the old path.
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  launchctl list | grep -q "$LABEL" || { echo "[reviewSchedule] load failed"; exit 1; }
  echo "[reviewSchedule] installed $LABEL — daily 09:30, repo=$REPO"
}

case "${1:-install}" in
  install)   install ;;
  uninstall) uninstall ;;
  *) echo "usage: $0 [install|uninstall]"; exit 2 ;;
esac
