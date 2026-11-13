#!/usr/bin/env bash
# Regression: deploy-dev re-execs itself under fdy-lock; the inner process must still
# have --prebuilt/--label/parts. DEPLOY_DRY_RUN stops at the lock boundary.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/build"
printf 'not-a-real-server\n' >"$tmp/build/foundry-server"
(cd "$tmp/build" && sha256sum foundry-server >SHA256SUMS)

output="$(
  FOUNDRY_DEPLOY_LOCK="$tmp/deploy.lock" \
    FOUNDRY_LOCK_LOG="$tmp/lock-log.jsonl" \
    DEPLOY_DRY_RUN=1 \
    "$root/scripts/deploy-dev.sh" --prebuilt "$tmp/build" --label args-test --server 2>&1
)"
grep -q "dry run after deploy lock: server from $tmp/build (label args-test)" <<<"$output"
grep -q '"event":"finished".*"lock":".*/deploy.lock"' "$tmp/lock-log.jsonl"
echo "deploy-lock-args: PASS (original argv survives the lock re-exec)"
