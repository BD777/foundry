#!/bin/sh
# Foundry daemon watchdog — checks if the daemon's heartbeat file is stale.
# If the heartbeat hasn't been updated in 5 minutes, the daemon's event loop
# is likely blocked. Kill it so launchd restarts it.
#
# Installed as a launchd agent (dev.foundry.worker-watchdog) that runs
# every 60 seconds.

HB="$HOME/.foundry/daemon-heartbeat"

# No heartbeat file yet — daemon may not have started. Don't kill.
[ -f "$HB" ] || exit 0

# Check file age in seconds
AGE=$(( $(date +%s) - $(stat -f %m "$HB") ))

# 5 minutes = 300 seconds
if [ "$AGE" -gt 300 ]; then
  echo "$(date): daemon heartbeat stale (${AGE}s), killing" >> "$HOME/.foundry/logs/watchdog.log"
  launchctl kill TERM "gui/$(id -u)/dev.foundry.worker" 2>/dev/null
fi
