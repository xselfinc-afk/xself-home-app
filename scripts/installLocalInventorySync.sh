#!/bin/bash
# Local-mode installer for the GIGA inventory sync (macOS launchd).
#
# Moves the inventory sync off the GitHub Actions cloud runner and onto this
# Mac, where requests originate from a residential IP and the saved
# Playwright session is reused — significantly lower anti-bot risk than the
# datacenter-IP cloud runner.
#
# The GitHub Actions workflow (.github/workflows/sync-inventory.yml) is
# intentionally NOT removed by this installer — it stays in place as a
# fallback. Uninstall it manually later if you want local to be the only path.
#
# Usage:
#   bash scripts/installLocalInventorySync.sh install     # default
#   bash scripts/installLocalInventorySync.sh uninstall
#   bash scripts/installLocalInventorySync.sh status
#   bash scripts/installLocalInventorySync.sh run-now
#
# Or via npm:
#   npm run inventory:install-local
#   npm run inventory:uninstall-local
#   npm run inventory:status-local
#   npm run inventory:run-now-local
#
# Schedule: daily at HOUR:MINUTE local time. Defaults 04:00 (off-peak to
# avoid bot-detection windows). Override per-install:
#   HOUR=8 MINUTE=30 npm run inventory:install-local
#
# Logs:    ~/Library/Logs/xself-giga-inventory-sync.log
# Runner:  scripts/runGigaInventorySync.sh
# Session: scripts/.giga-session.json  (refresh: npm run giga:refresh-session)

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.xselfhome.giga-inventory-sync"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_PATH="$HOME/Library/Logs/xself-giga-inventory-sync.log"
RUNNER="$REPO_ROOT/scripts/runGigaInventorySync.sh"
SESSION="$REPO_ROOT/scripts/.giga-session.json"

HOUR="${HOUR:-4}"
MINUTE="${MINUTE:-0}"

cmd_install() {
  if [ ! -f "$RUNNER" ]; then
    echo "FATAL: runner missing at $RUNNER" >&2; exit 1
  fi
  chmod +x "$RUNNER" 2>/dev/null || true

  if [ ! -f "$SESSION" ]; then
    echo "WARNING: $SESSION not found."
    echo "         The job will fail with 'Session expired' until you run:"
    echo "             npm run giga:refresh-session"
  fi

  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$HOME/Library/Logs"
  touch "$LOG_PATH"

  # If the agent is already loaded (possibly with stale paths), unload first.
  launchctl unload "$PLIST_PATH" 2>/dev/null || true

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$REPO_ROOT</string>

  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>

  <!-- Daily at $HOUR:$(printf '%02d' "$MINUTE") local time. If the Mac is asleep
       at that wall time, launchd fires the job on wake. -->
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>ThrottleInterval</key>
  <integer>60</integer>
</dict>
</plist>
EOF

  launchctl load -w "$PLIST_PATH"

  echo ""
  echo "Installed local daily inventory sync."
  printf "  Label:    %s\n" "$LABEL"
  printf "  Plist:    %s\n" "$PLIST_PATH"
  printf "  Runner:   %s\n" "$RUNNER"
  printf "  Schedule: daily at %02d:%02d local time\n" "$HOUR" "$MINUTE"
  printf "  Logs:     %s\n" "$LOG_PATH"
  echo ""
  echo "Manual trigger:  launchctl start $LABEL"
  echo "                 (or: npm run inventory:run-now-local)"
  echo "Tail logs:       tail -f $LOG_PATH"
  echo "Status:          npm run inventory:status-local"
  echo "Uninstall:       npm run inventory:uninstall-local"
  echo ""
  echo "Note: GitHub Actions workflow is left in place as a fallback."
}

cmd_uninstall() {
  if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Uninstalled: $PLIST_PATH"
  else
    echo "Nothing to uninstall (no plist at $PLIST_PATH)."
  fi
  echo "(GitHub Actions workflow .github/workflows/sync-inventory.yml is untouched.)"
}

cmd_status() {
  printf "Label:     %s\n" "$LABEL"
  printf "Plist:     %s\n" "$PLIST_PATH"
  if [ -f "$PLIST_PATH" ]; then
    echo  "Installed: yes"
  else
    echo  "Installed: no"
  fi
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    echo  "Loaded:    yes"
    launchctl list 2>/dev/null | grep "$LABEL" | sed 's/^/  /'
  else
    echo  "Loaded:    no"
  fi
  printf "Session:   %s\n" "$SESSION"
  if [ -f "$SESSION" ]; then
    SESS_MTIME="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M' "$SESSION" 2>/dev/null || echo unknown)"
    printf "  last refreshed: %s\n" "$SESS_MTIME"
  else
    echo  "  MISSING — run 'npm run giga:refresh-session'"
  fi
  printf "Log:       %s\n" "$LOG_PATH"
  if [ -f "$LOG_PATH" ] && [ -s "$LOG_PATH" ]; then
    echo  "Last 10 lines:"
    tail -n 10 "$LOG_PATH" | sed 's/^/  /'
  fi
}

cmd_run_now() {
  if [ ! -f "$PLIST_PATH" ]; then
    echo "Not installed. Run: npm run inventory:install-local" >&2
    exit 1
  fi
  launchctl start "$LABEL"
  echo "Triggered $LABEL."
  echo "Tail logs:  tail -f $LOG_PATH"
}

case "${1:-install}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  run-now)   cmd_run_now ;;
  *) echo "Usage: $0 {install|uninstall|status|run-now}" >&2; exit 1 ;;
esac
