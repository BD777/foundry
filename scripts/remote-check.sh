#!/usr/bin/env bash
# Run scripts/check-changed.sh on another of the person's devices (its Foundry
# compute resource) against this worktree's changes, and print its summary.
#
# Usage: scripts/remote-check.sh <device> [check-changed.sh arguments, e.g. --files <path>...]
#   <device>  the device's label (e.g. CanWendeMac-mini) or id (dev_…)
#
# It leases the device's compute resource through the Foundry tools (the
# `foundry` CLI, so it needs FOUNDRY_SESSION_TOKEN and FOUNDRY_SERVER_URL as a
# session has them), keeps a checkout of the GitHub remote in a scratch folder
# there at this worktree's base commit (dependencies installed once, again only
# when the lockfiles change), applies the uncommitted diff and untracked files,
# and runs check-changed.sh there with the arguments given. The device's owner
# must not have turned remote commands off on it (on by default; Resources page).
#
# Environment: FOUNDRY_CLI (default: foundry on PATH, else this repo's built
# packages/worker/dist/foundry-cli.js), REMOTE_CHECK_SCRATCH (default foundry),
# REMOTE_CHECK_REMOTE (default: origin's URL as https).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
device="${1:-}"
[ -n "$device" ] && [[ "$device" != -* ]] || { sed -n '2,16p' "$0"; exit 2; }
shift
check_args=("$@")
scratch="${REMOTE_CHECK_SCRATCH:-foundry}"
piece_bytes=$((512 * 1024))
work="$(mktemp -d)"
lease=""
exec 3>&1

die() { echo "remote-check: $*" >&2; exit 1; }
log() { echo "remote-check: $*" >&2; }

if [ -n "${FOUNDRY_CLI:-}" ]; then
  read -r -a cli <<<"$FOUNDRY_CLI"
elif command -v foundry >/dev/null 2>&1; then
  cli=(foundry)
elif [ -f "$root/packages/worker/dist/foundry-cli.js" ]; then
  cli=(node "$root/packages/worker/dist/foundry-cli.js")
else
  die "no foundry CLI: install the worker, build packages/worker, or set FOUNDRY_CLI"
fi
[ -n "${FOUNDRY_SESSION_TOKEN:-}" ] || die "FOUNDRY_SESSION_TOKEN is not set: compute is leased to Foundry sessions, so run this with a session's token"

# json <expression>: evaluates a JavaScript expression over the JSON on stdin (as v).
json() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const v=JSON.parse(s);const r=eval(process.argv[1]);process.stdout.write(r===undefined||r===null?"":typeof r==="string"?r:JSON.stringify(r))})' "$1"; }

# operate <args JSON file> <op>: one compute operation; prints its result's text.
operate() {
  local answer
  answer="$("${cli[@]}" resource operate "$lease" --op "$2" --args-file "$1")" || return 1
  if [ "$(json 'String(v.results[0].ok)' <<<"$answer")" != true ]; then
    echo "$2 failed: $(json 'v.results[0].errorCode+": "+v.results[0].error' <<<"$answer")" >&2
    return 1
  fi
  json 'v.results[0].text' <<<"$answer"
}

# args <node expression of an object>: writes the arguments of one operation (scratch added) to a file.
args() {
  local file="$work/args.json"
  SCRATCH="$scratch" node -e 'const o=eval("("+process.argv[1]+")");o.scratch??=process.env.SCRATCH;require("node:fs").writeFileSync(process.argv[2],JSON.stringify(o))' "$1" "$file"
  echo "$file"
}

# run_shell <timeout seconds> <shell line>: runs a line in the scratch folder; prints stdout, fails on non-zero.
run_shell() {
  local result code file
  file="$(LINE="$2" args "{command: process.env.LINE, timeoutSec: $1}")"
  result="$(operate "$file" run)" || return 1
  code="$(json 'v.exitCode' <<<"$result")"
  json 'v.stdout' <<<"$result"
  if [ "$code" != 0 ]; then
    json 'v.stderr' <<<"$result" >&2
    return 1
  fi
}

# upload <local file> <format> <dest>: sends a file in pieces.
upload() {
  local size offset=0 name="rc$$"
  size=$(wc -c <"$1" | tr -d ' ')
  while :; do
    FILE="$1" OFFSET=$offset PIECE=$piece_bytes SIZE=$size NAME=$name FORMAT="$2" DEST="$3" SCRATCH="$scratch" node -e '
      const fs = require("node:fs"), e = process.env, offset = +e.OFFSET, size = +e.SIZE;
      const fd = fs.openSync(e.FILE, "r"), piece = Buffer.alloc(Math.min(+e.PIECE, size - offset));
      fs.readSync(fd, piece, 0, piece.length, offset);
      fs.writeFileSync(process.argv[1], JSON.stringify({ scratch: e.SCRATCH, upload: e.NAME, offset,
        data: piece.toString("base64"), done: offset + piece.length >= size, format: e.FORMAT, dest: e.DEST }));' \
      "$work/piece.json"
    operate "$work/piece.json" put_files >/dev/null
    offset=$((offset + piece_bytes))
    [ "$offset" -lt "$size" ] || break
  done
}

# more_output <file on the device> <offset>: prints what it has past offset (to the
# script's stdout); answers how many bytes that was.
more_output() {
  local got
  got="$(operate "$(args "{path: '$1', offset: $2, length: 1048576}")" get_file 2>/dev/null)" || { echo 0; return; }
  json 'Buffer.from(v.data, "base64").toString("utf8")' <<<"$got" >&3
  json 'v.length' <<<"$got"
}

# job <name> <timeout seconds> <shell line>: runs a line in the background on the device
# (stopped if the lease ends), printing its output as it comes; answers its exit status.
job() {
  local out="remote-check/$1.log" status="remote-check/$1.status" offset=0 count exit_code file
  # The line runs in a subshell, so its own exit still records the status.
  file="$(LINE="$3" OUT="$out" STATUS="$status" args '{command: `rm -f "$JOB_OUT" "$JOB_STATUS"; nohup sh -c '"'"'(eval "$JOB_LINE"); echo $? > "$JOB_STATUS"'"'"' > "$JOB_OUT" 2>&1 < /dev/null &`, env: {JOB_LINE: process.env.LINE, JOB_OUT: process.env.OUT, JOB_STATUS: process.env.STATUS}, timeoutSec: 60}')"
  operate "$file" run >/dev/null
  local deadline=$(($(date +%s) + $2))
  while :; do
    count="$(more_output "$out" "$offset")"
    offset=$((offset + count))
    [ "$count" -eq 0 ] || continue
    exit_code="$(run_shell 30 "cat $status 2>/dev/null || true")"
    if [ -n "$exit_code" ]; then
      more_output "$out" "$offset" >/dev/null # written since the last read
      return "$exit_code"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || { log "$1 ran past ${2}s"; return 124; }
    sleep 5
  done
}

cleanup() {
  [ -z "$lease" ] || "${cli[@]}" resource release "$lease" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# ---- what to send -------------------------------------------------------------
cd "$root"
remote="${REMOTE_CHECK_REMOTE:-$(git remote get-url origin)}"
case "$remote" in
  git@*:*) remote="${remote#git@}"; remote="https://${remote/://}" ;;
  ssh://git@*) remote="https://${remote#ssh://git@}" ;;
esac
remote="${remote%.git}.git"
# The base must be on the remote: HEAD when pushed, else where it left origin/main.
if [ -n "$(git branch -r --contains HEAD 2>/dev/null)" ]; then
  base="$(git rev-parse HEAD)"
else
  base="$(git merge-base HEAD origin/main)" || die "HEAD shares no commit with origin/main"
fi
git diff --binary "$base" >"$work/changes.diff"
git ls-files --others --exclude-standard -z >"$work/untracked.list"
tar -czf "$work/untracked.tar.gz" --null -T "$work/untracked.list"
log "base $base; diff $(wc -c <"$work/changes.diff" | tr -d ' ') bytes, $(tr -cd '\0' <"$work/untracked.list" | wc -c | tr -d ' ') untracked files"

# ---- lease ------------------------------------------------------------------
listing="$("${cli[@]}" device list --type compute)"
resource="$(DEVICE="$device" json '(v.find(d=>d.deviceId===process.env.DEVICE||d.deviceLabel.toLowerCase()===process.env.DEVICE.toLowerCase())?.instances??[]).find(i=>i.type==="compute")?.id' <<<"$listing")"
[ -n "$resource" ] || die "no compute resource on $device (foundry device list --type compute; its worker may need an update)"
acquired="$("${cli[@]}" resource acquire --resource "$resource" --reason "remote-check of $(basename "$root")" --wait-ms 600000)" ||
  die "could not lease $device's compute (is it online, and are remote commands on in its Resources page?)"
lease="$(json 'v.lease.id' <<<"$acquired")"
log "leased $device's compute ($lease)"

# ---- checkout at base, with the changes ---------------------------------------
operate "$(args "{url: '$remote', ref: '$base', dir: 'repo'}")" git_sync >/dev/null
run_shell 60 "mkdir -p remote-check" >/dev/null
upload "$work/changes.diff" file remote-check/changes.diff
upload "$work/untracked.tar.gz" tar.gz repo
run_shell 120 'cd repo && if [ -s ../remote-check/changes.diff ]; then git apply --binary --whitespace=nowarn ../remote-check/changes.diff; fi' >/dev/null ||
  die "the diff did not apply at $base"
log "checkout at $base with the changes"

# ---- dependencies (again only when the lockfiles change), then the check ------
deps='cd repo && want="$(cat pnpm-lock.yaml apps/server/go.sum 2>/dev/null | (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-64)" &&
if [ "$(cat .git/remote-check-deps 2>/dev/null)" != "$want" ]; then
  pnpm install --frozen-lockfile && (cd apps/server && go mod download) && echo "$want" > .git/remote-check-deps
fi && pnpm --filter @bd777/foundry-protocol build'
job deps 1800 "$deps" || die "installing dependencies failed (output above)"

# bash 4 or newer: macOS' own is 3.2.
quoted=""
[ ${#check_args[@]} -eq 0 ] || quoted="$(printf '%q ' "${check_args[@]}")"
check_line="cd repo && for b in /opt/homebrew/bin/bash /usr/local/bin/bash bash; do
  if command -v \"\$b\" >/dev/null 2>&1 && [ \"\$(\"\$b\" -c 'echo \${BASH_VERSINFO[0]}')\" -ge 4 ]; then
    \"\$b\" scripts/check-changed.sh $quoted; exit \$?
  fi
done; echo 'no bash 4 or newer on this device (brew install bash)'; exit 2"
set +e
job check 1800 "$check_line"
status=$?
set -e
exit $status
