#!/usr/bin/env bash
# Run checks for a working tree on another of the person's devices (its Foundry compute,
# with fallback CanWendeMac-mini → byte-dev → byte-dev-sg) and print a short result; the
# full output goes to a log.
#
# Usage: scripts/remote-check.sh [<lease|device>] [--device mac|byte-dev|byte-dev-sg]
#                               [--resource <res_…>] [--tree <dir>] [--base <commit>] [check]
#   check (one of):
#     --files <path>… | --list | --since <t>   scripts/check-changed.sh with these arguments (default)
#     --go <go test arguments…>                e.g. --go ./internal/httpapi -run 'TestFoo|TestBar'
#     --web typecheck | --web test <file>…     apps/web tsc --noEmit, or these test files
#     --worker test <file>… | --worker build   Worker tests (builds protocol + Worker first), or tsc
#     --sh '<shell line>'                      any line, run in the checkout's root
#   --tree <dir>    the tree to check (default: this script's checkout). A worktree or a
#                   plain copy: everything differing from <base> is sent, untracked included.
#   --base <commit> a commit on GitHub (default: the tree's HEAD when pushed, else its
#                   merge-base with origin/main; origin/main for a plain folder).
#   <lease>  acquire_resource {resourceId, forCommands: true, holdFor: 3600} answers leaseId and
#            commandToken: FOUNDRY_LEASE_TOKEN=<commandToken> scripts/remote-check.sh <leaseId> …
#   <device> a label or dev_… id; the script leases it itself (needs FOUNDRY_SESSION_TOKEN).
#            A preferred alias falls forward when it is offline. An explicit res_… id or
#            lease never falls back.
# The lease is released when the script ends unless REMOTE_KEEP_LEASE=1. Each invocation
# uses its own job checkout under the removable scratch root "foundry-remote"; shared
# toolchains and caches make concurrent jobs fast. Run scripts/remote-clean.sh at the end
# of a work batch.
#
# Environment: REMOTE_LOG (default /tmp/remote-check-<time>.log), REMOTE_CHECK_TIMEOUT
# (seconds, default 1800), REMOTE_CHECK_SCRATCH (default foundry-remote),
# REMOTE_KEEP_LEASE=1 for concurrent jobs on one lease, REMOTE_LEASE_MODE=exclusive
# to opt out of shared leases, REMOTE_HTTPS_PROXY for a runner-local relay, FOUNDRY_CLI.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${REMOTE_CHECK_SCRATCH:-foundry-remote}"
rc_name=remote-check
usage() { sed -n '2,25p' "$0"; exit 2; }
target=""
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
  target="$1"
  shift
fi

tree="$root"
base=""
mode=check
rest=()
while [ $# -gt 0 ]; do
  case "$1" in
    --device) target="${2:?--device needs mac, byte-dev or byte-dev-sg}"; shift 2 ;;
    --resource) target="${2:?--resource needs a res_… id or lease}"; shift 2 ;;
    --tree) tree="${2:?--tree needs a folder}"; shift 2 ;;
    --base) base="${2:?--base needs a commit}"; shift 2 ;;
    --go) mode=go; shift; rest=("$@"); break ;;
    --web) mode="web-${2:?--web needs typecheck or test}"; shift 2; rest=("$@"); break ;;
    --worker) mode="worker-${2:?--worker needs test or build}"; shift 2; rest=("$@"); break ;;
    --sh) mode=sh; rest=("${2:?--sh needs a line}"); shift 2 ;;
    -h | --help) usage ;;
    *) rest+=("$1"); shift ;;
  esac
done
target="${target:-mac}"
log_file="${REMOTE_LOG:-/tmp/remote-check-$(date +%Y%m%dT%H%M%S)-$$.log}"
: >"$log_file"

# shellcheck source=lib/remote-compute.sh
source "$root/scripts/lib/remote-compute.sh"

quoted=""
[ ${#rest[@]} -eq 0 ] || quoted="$(printf '%q ' "${rest[@]}")"
worker_build='(cd "$RC_REPO/packages/worker" && rm -rf dist && ../../node_modules/.bin/tsc -p tsconfig.json)'
case "$mode" in
  check) line="cd \"\$RC_REPO\" && for b in /opt/homebrew/bin/bash /usr/local/bin/bash; do
  if [ -x \"\$b\" ]; then \"\$b\" scripts/check-changed.sh $quoted; exit \$?; fi
done; bash scripts/check-changed.sh $quoted" ;;
  go) line="$worker_build && cd \"\$RC_REPO/apps/server\" && go test -p \"\$RC_JOB_CPUS\" $quoted" ;;
  web-typecheck) line="cd \"\$RC_REPO/apps/web\" && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit" ;;
  web-test) [ -n "$quoted" ] || die "--web test needs test files"
    line="cd \"\$RC_REPO/apps/web\" && node --import ./test/register-bundler-resolve.mjs --test-timeout=120000 --test $quoted" ;;
  worker-test) [ -n "$quoted" ] || die "--worker test needs test files"
    line="$worker_build && cd \"\$RC_REPO/packages/worker\" && node scripts/run-worker-tests.mjs -- $quoted" ;;
  worker-build) line="$worker_build" ;;
  sh) line="cd \"\$RC_REPO\" && ${rest[0]}" ;;
  *) die "unknown check $mode" ;;
esac

started=$(date +%s)
rc_init "$target"
rc_detect_proxy
[ -n "$base" ] || base="$(rc_default_base "$tree")" || die "no base commit for $tree (pass --base)"
base="$(git -C "$root" rev-parse --verify "$base^{commit}")"
rc_slot_acquire
rc_sync "$tree" "$base"
synced=$(date +%s)
rc_bootstrap "$log_file"
rc_deps "$log_file"
prepared=$(date +%s)
log "synced in $((synced - started))s, toolchain and dependencies ready in $((prepared - synced))s; running $mode"

set +e
job check "${REMOTE_CHECK_TIMEOUT:-1800}" "$line" "$log_file" quiet
status=$?
set -e
ended=$(date +%s)

# A short answer: failures first, then the end of the output.
if [ "$status" -ne 0 ]; then
  grep -E -- '^(--- FAIL|FAIL|not ok|panic:)|error TS[0-9]+|✗|✖' "$log_file" | head -30 >&2 || true
  echo "----" >&2
fi
tail -n "${REMOTE_TAIL:-25}" "$log_file" >&2
result=PASS
[ "$status" -eq 0 ] || result="FAIL (exit $status)"
echo "remote-check: $result — $mode in $((ended - prepared))s on the device, $((ended - started))s total; log $log_file"
exit "$status"
