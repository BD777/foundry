#!/bin/sh
# Foundry daemon watchdog — checks if the daemon's heartbeat file is stale.
# If the heartbeat hasn't been updated in 5 minutes, the daemon's event loop
# is likely blocked. Kill it so launchd restarts it.
#
# Installed as a launchd agent (<service label>-watchdog) that runs every 60
# seconds. Arguments: the stack's state root and its daemon's launchd label.

STATE_ROOT="${1:-$HOME/.foundry}"
LABEL="${2:-dev.foundry.worker}"
HB="$STATE_ROOT/daemon-heartbeat"

# An update may intentionally stop the worker before its replacement writes
# a heartbeat. A stale lock never suppresses the watchdog indefinitely.
UPDATE="$STATE_ROOT/logs/self-update.lock"
if [ -f "$UPDATE" ]; then
  UPDATE_AGE=$(( $(date +%s) - $(stat -f %m "$UPDATE") ))
  [ "$UPDATE_AGE" -ge 0 ] && [ "$UPDATE_AGE" -lt 900 ] && exit 0
fi

# No heartbeat file yet — daemon may not have started. Don't kill.
[ -f "$HB" ] || exit 0

# Check file age in seconds
AGE=$(( $(date +%s) - $(stat -f %m "$HB") ))

# 5 minutes = 300 seconds
if [ "$AGE" -gt 300 ]; then
  # A new worker may have replaced the one whose heartbeat we read. Verify
  # the Node owner before terminating it; the app wrapper has a different PID.
  PID=$(/usr/bin/plutil -extract pid raw -o - "$HB" 2>/dev/null) || PID=""
  if [ -n "$PID" ]; then
    case "$PID" in *[!0-9]*|0|1) exit 0 ;; esac
    START=$(/usr/bin/plutil -extract startTime raw -o - "$HB" 2>/dev/null) || exit 0
    CURRENT=$(LC_ALL=C TZ=UTC /bin/ps -ww -o lstart= -p "$PID" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -n "$CURRENT" ] && [ "$CURRENT" = "$START" ] || exit 0
    kill -TERM "$PID" 2>/dev/null || exit 0
    sleep 2
    CURRENT=$(LC_ALL=C TZ=UTC /bin/ps -ww -o lstart= -p "$PID" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ -n "$CURRENT" ] && [ "$CURRENT" = "$START" ]; then
      kill -KILL "$PID" 2>/dev/null
    fi
    echo "$(date): worker heartbeat stale (${AGE}s), stopped pid $PID" >> "$STATE_ROOT/logs/watchdog.log"
    exit 0
  fi
  echo "$(date): daemon heartbeat stale (${AGE}s), killing" >> "$STATE_ROOT/logs/watchdog.log"
  launchctl kill TERM "gui/$(id -u)/$LABEL" 2>/dev/null
fi
