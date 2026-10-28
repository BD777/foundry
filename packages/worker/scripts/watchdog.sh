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

# The session runner (execution host) writes its own heartbeat every few
# seconds. Stale for 5 minutes with its recorded process still alive, its
# event loop is gone (2026-10-28: wedged in its exit path, SIGTERM ignored):
# remove its job, then end exactly that process. The daemon starts a new one.
HOST_HB="$STATE_ROOT/execution-host/heartbeat.json"
if [ -f "$HOST_HB" ]; then
  HOST_AGE=$(( $(date +%s) - $(stat -f %m "$HOST_HB") ))
  if [ "$HOST_AGE" -gt 300 ]; then
    HPID=$(/usr/bin/plutil -extract pid raw -o - "$HOST_HB" 2>/dev/null) || HPID=""
    HSTART=$(/usr/bin/plutil -extract startTime raw -o - "$HOST_HB" 2>/dev/null) || HSTART=""
    HLABEL=$(/usr/bin/plutil -extract label raw -o - "$HOST_HB" 2>/dev/null) || HLABEL=""
    case "$HPID" in ''|*[!0-9]*|0|1) HPID="" ;; esac
    case "$HLABEL" in app.foundry.execution.*) ;; *) HLABEL="" ;; esac
    if [ -n "$HPID" ] && [ -n "$HSTART" ]; then
      CURRENT=$(LC_ALL=C TZ=UTC /bin/ps -ww -o lstart= -p "$HPID" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      if [ -n "$CURRENT" ] && [ "$CURRENT" = "$HSTART" ]; then
        [ -n "$HLABEL" ] && launchctl bootout "gui/$(id -u)/$HLABEL" 2>/dev/null
        kill -TERM "$HPID" 2>/dev/null
        sleep 5
        CURRENT=$(LC_ALL=C TZ=UTC /bin/ps -ww -o lstart= -p "$HPID" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        [ -n "$CURRENT" ] && [ "$CURRENT" = "$HSTART" ] && kill -KILL "$HPID" 2>/dev/null
        echo "$(date): execution host heartbeat stale (${HOST_AGE}s), stopped pid $HPID" >> "$STATE_ROOT/logs/watchdog.log"
      fi
    fi
  fi
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
