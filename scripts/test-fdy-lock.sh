#!/usr/bin/env bash
# Exercise FIFO waiters, holder visibility and stale-holder reporting without touching
# the live heavy/deploy locks.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lock="$root/scripts/fdy-lock"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export FOUNDRY_HEAVY_LOCK="$tmp/heavy.lock"
export FOUNDRY_LOCK_LOG="$tmp/lock-log.jsonl"
export FOUNDRY_LOCK_POLL=0.1
export ORDER="$tmp/order"

FOUNDRY_SESSION_ID=holder "$lock" heavy -- sh -c 'sleep 1; echo holder >> "$ORDER"' &
holder=$!
for _ in $(seq 1 100); do
  [ -s "$FOUNDRY_HEAVY_LOCK.holder" ] && break
  sleep 0.05
done
[ -s "$FOUNDRY_HEAVY_LOCK.holder" ] || {
  echo "holder sidecar was not written" >&2
  exit 1
}

FOUNDRY_SESSION_ID=waiter-1 "$lock" heavy -- sh -c 'echo waiter-1 >> "$ORDER"' \
  2>"$tmp/waiter-1.err" &
wait1=$!
for _ in $(seq 1 100); do
  grep -q ' waiter-1$' "$FOUNDRY_HEAVY_LOCK.queue" 2>/dev/null && break
  sleep 0.05
done
FOUNDRY_SESSION_ID=waiter-2 "$lock" heavy -- sh -c 'echo waiter-2 >> "$ORDER"' \
  2>"$tmp/waiter-2.err" &
wait2=$!

wait "$holder"
wait "$wait1"
wait "$wait2"
[ "$(cat "$ORDER")" = $'holder\nwaiter-1\nwaiter-2' ] || {
  echo "queue was not FIFO: $(tr '\n' ' ' <"$ORDER")" >&2
  exit 1
}
grep -q 'position 2' "$tmp/waiter-1.err"
grep -q 'position 3' "$tmp/waiter-2.err"
node - "$FOUNDRY_LOCK_LOG" <<'NODE'
const fs = require("node:fs");
const events = fs
  .readFileSync(process.argv[2], "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
if (events.filter((event) => event.event === "finished").length !== 3)
  throw new Error(`expected 3 finished events, got ${JSON.stringify(events)}`);
NODE

dead="$(sh -c 'echo $$')"
printf '{"pid":%s,"sessionId":"stale","command":"gone","startedAt":"2020-01-01T00:00:00Z"}\n' \
  "$dead" >"$FOUNDRY_HEAVY_LOCK.holder"
status="$("$lock" status heavy)"
grep -q 'session=stale .*STALE' <<<"$status"
rm -f "$FOUNDRY_HEAVY_LOCK.holder"
flock "$FOUNDRY_HEAVY_LOCK" -c 'sleep 1' &
external=$!
for _ in $(seq 1 100); do
  status_out="$("$lock" status heavy)"
  grep -q 'holder external pid=' <<<"$status_out" && break
  sleep 0.05
done
status_out="$("$lock" status heavy)"
grep -q 'holder external pid=' <<<"$status_out"
wait "$external"
echo "fdy-lock: PASS (FIFO waiters, holder sidecar, stale detection, shared log)"
