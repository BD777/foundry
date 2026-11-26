#!/usr/bin/env bash
# A full runner must yield the lease before its current holders can release.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
FOUNDRY_CLI=true
source "$root/scripts/lib/remote-compute.sh"
cd "$rc_work"
mkdir -p jobs .cleanup
for slot in {1..16}; do
  mkdir -p ".slots/$slot"
  echo "$$" > ".slots/$slot/pid"
done

# Stand in for serialized remote calls. Bound each one so the old remote
# polling loop fails promptly. Skip the long-lived slot sentinel in the test.
mkdir bin
printf '#!/bin/sh\nexit 0\n' > bin/nohup
chmod +x bin/nohup
export PATH="$PWD/bin:$PATH"
run_shell() { timeout 4 sh -c "$2"; }

# Simulate other lease users making progress only between remote calls.
sleep() {
  case "$1" in
    1) rmdir .cleanup ;;
    2) rm .slots/1/pid && rmdir .slots/1 ;;
    *) return 1 ;;
  esac
}
rc_slot_acquire
[[ "$rc_slot" == 1 && "$(cat .slots/1/job)" == "$rc_job" ]]
