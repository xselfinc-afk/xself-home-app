#!/bin/bash
# launchd installer for the SHADOW-MODE inventory workflow.
#
# Deliberately mirrors the existing scripts/installLocalInventorySync.sh pattern — same mechanism
# (launchd + shell runner + log file), a DIFFERENT label so it never collides with the existing
# com.xselfhome.giga-inventory-sync job.
#
# This schedule is SHADOW ONLY. It observes inventory (cache-only), advances persisted workflow
# state, and writes recommendations. It NEVER delists, relists, publishes, or calls
# refresh_product_inventory_status.
#
# Usage:
#   bash scripts/installInventoryWorkflowShadow.sh install     # create + load (default 05:30)
#   bash scripts/installInventoryWorkflowShadow.sh status
#   bash scripts/installInventoryWorkflowShadow.sh run-now
#   bash scripts/installInventoryWorkflowShadow.sh disable     # unload, keep the plist
#   bash scripts/installInventoryWorkflowShadow.sh enable      # reload it
#   bash scripts/installInventoryWorkflowShadow.sh uninstall   # unload + delete the plist
#   bash scripts/installInventoryWorkflowShadow.sh logs
#
# Schedule: daily. Default 05:30 local — AFTER the existing 04:00 giga-inventory-sync job so the
# two never overlap and the evidence this job reads is already fresh.
#   HOUR=6 MINUTE=15 bash scripts/installInventoryWorkflowShadow.sh install

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.xselfhome.inventory-workflow-shadow"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_PATH="$HOME/Library/Logs/xself-inventory-workflow-shadow.log"
RUNNER="$REPO_ROOT/scripts/runInventoryWorkflowShadow.sh"
HOUR="${HOUR:-5}"
MINUTE="${MINUTE:-30}"
ACTION="${1:-install}"

# Existing job we must not collide with.
EXISTING_LABEL="com.xselfhome.giga-inventory-sync"

need_runner() {
  [ -f "$RUNNER" ] || { echo "FATAL: runner missing: $RUNNER"; exit 1; }
  chmod +x "$RUNNER"
}

write_plist() {
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

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG_PATH</string>
  <key>StandardErrorPath</key>
  <string>$LOG_PATH</string>

  <key>RunAtLoad</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF
}

case "$ACTION" in
  install)
    need_runner
    # Refuse to stack a second copy of ourselves.
    if launchctl list 2>/dev/null | grep -q "$LABEL"; then
      echo "Already loaded — unloading first so only ONE schedule exists."
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
    fi
    if launchctl list 2>/dev/null | grep -q "$EXISTING_LABEL"; then
      echo "note: existing job $EXISTING_LABEL is present (04:00). This job runs at $HOUR:$MINUTE — no overlap."
    fi
    write_plist
    launchctl load "$PLIST_PATH"
    echo "✓ installed + loaded: $LABEL"
    echo "  schedule : daily $(printf '%02d:%02d' "$HOUR" "$MINUTE") local"
    echo "  runner   : $RUNNER"
    echo "  log      : $LOG_PATH"
    echo "  mode     : SHADOW ONLY (no delist / relist / publish)"
    ;;
  status)
    echo "label   : $LABEL"
    echo "plist   : $PLIST_PATH $( [ -f "$PLIST_PATH" ] && echo '(present)' || echo '(absent)')"
    if launchctl list 2>/dev/null | grep -q "$LABEL"; then
      echo "loaded  : YES"
      launchctl list | grep "$LABEL" | awk '{print "  pid="$1"  last_exit="$2"  label="$3}'
    else
      echo "loaded  : no"
    fi
    [ -f "$PLIST_PATH" ] && echo "schedule: $(plutil -extract StartCalendarInterval json -o - "$PLIST_PATH" 2>/dev/null || echo 'n/a')"
    echo "log     : $LOG_PATH $( [ -f "$LOG_PATH" ] && echo "($(wc -l < "$LOG_PATH" | tr -d ' ') lines)" || echo '(none yet)')"
    ;;
  run-now)
    need_runner
    echo "running shadow workflow now (foreground)…"
    bash "$RUNNER"
    ;;
  disable)
    launchctl unload "$PLIST_PATH" 2>/dev/null && echo "✓ disabled (unloaded). Plist kept at $PLIST_PATH" || echo "not loaded."
    ;;
  enable)
    [ -f "$PLIST_PATH" ] || { echo "FATAL: no plist — run install first."; exit 1; }
    launchctl load "$PLIST_PATH" && echo "✓ re-enabled."
    ;;
  uninstall)
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✓ uninstalled (plist removed). Logs and reports kept."
    ;;
  logs)
    [ -f "$LOG_PATH" ] && tail -60 "$LOG_PATH" || echo "no log yet: $LOG_PATH"
    ;;
  *)
    echo "usage: $0 {install|status|run-now|disable|enable|uninstall|logs}"; exit 1;;
esac
