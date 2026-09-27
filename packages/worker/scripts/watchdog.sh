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

# No heartbeat file yet — daemon may not have started. Don't kill.
[ -f "$HB" ] || exit 0

# Check file age in seconds
AGE=$(( $(date +%s) - $(stat -f %m "$HB") ))

# 5 minutes = 300 seconds
if [ "$AGE" -gt 300 ]; then
  echo "$(date): daemon heartbeat stale (${AGE}s), killing" >> "$STATE_ROOT/logs/watchdog.log"
  launchctl kill TERM "gui/$(id -u)/$LABEL" 2>/dev/null
fi
