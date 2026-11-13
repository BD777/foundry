#!/usr/bin/env bash
# Build dev release artifacts for a working tree on another of the person's devices
# (CanWendeMac-mini, then byte-dev, then byte-dev-sg), bring them back here and verify
# their checksums.
#
# Usage: scripts/remote-build.sh [<lease|device>] --out <dir> [--device mac|byte-dev|byte-dev-sg]
#                                [--resource <res_…>] [--tree <dir>] [--base <commit>]
#                                [--server] [--web] [--worker]      (none named: all three)
#   --server  apps/server/cmd/foundry-server for linux/amd64 → <out>/foundry-server
#             (CGO_ENABLED=0: the store is pure Go, modernc.org/sqlite; Go stamps the base
#             commit and vcs.modified as a local build does)
#   --web     vite build with VITE_API_BASE_URL= (same-origin) → <out>/web
#   --worker  scripts/pack-worker-release.mjs → <out>/worker-packages (release.json + tarballs)
#   --fetch-only  only fetch what the device's last build left (after a failed transfer)
#   --tree/--base and <lease|device> as in scripts/remote-check.sh. Type checks are not part
#   of a build: run scripts/remote-check.sh … --web typecheck (or check-changed) for them.
# <out> gets SHA256SUMS (computed on the device, checked here), SOURCE_MANIFEST and
# build-info.txt. deploy-dev.sh uses the manifest to refuse a build that would omit source
# present in the live Server or Web artifact.
#
# Environment: REMOTE_LOG (default /tmp/remote-build-<time>.log), REMOTE_BUILD_TIMEOUT
# (seconds, default 1500), REMOTE_CHECK_SCRATCH (default foundry-remote),
# REMOTE_KEEP_LEASE=1 for concurrent jobs on one lease, REMOTE_LEASE_MODE=exclusive
# to opt out of shared leases, REMOTE_HTTPS_PROXY for a runner-local relay, FOUNDRY_CLI.
set -euo pipefail
export REMOTE_KEEP_JOB=1

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${REMOTE_CHECK_SCRATCH:-foundry-remote}"
rc_name=remote-build
usage() { sed -n '2,22p' "$0"; exit 2; }
target=""
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
  target="$1"
  shift
fi

tree="$root"
base=""
out=""
want_server=0 want_web=0 want_worker=0 fetch_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --device) target="${2:?--device needs mac, byte-dev or byte-dev-sg}"; shift 2 ;;
    --resource) target="${2:?--resource needs a res_… id or lease}"; shift 2 ;;
    --out) out="${2:?--out needs a folder}"; shift 2 ;;
    --tree) tree="${2:?--tree needs a folder}"; shift 2 ;;
    --base) base="${2:?--base needs a commit}"; shift 2 ;;
    --server) want_server=1; shift ;;
    --web) want_web=1; shift ;;
    --worker) want_worker=1; shift ;;
    --fetch-only) fetch_only=1; shift ;;
    *) usage ;;
  esac
done
target="${target:-mac}"
[ -n "$out" ] || usage
[ $((want_server + want_web + want_worker)) -gt 0 ] || want_server=1 want_web=1 want_worker=1
mkdir -p "$out"
out="$(cd "$out" && pwd)"
[ -z "$(ls -A "$out")" ] || { echo "remote-build: $out is not empty" >&2; exit 2; }
log_file="${REMOTE_LOG:-/tmp/remote-build-$(date +%Y%m%dT%H%M%S)-$$.log}"
: >"$log_file"

# shellcheck source=lib/remote-compute.sh
source "$root/scripts/lib/remote-compute.sh"

# Each part builds into the job's build-out with its own log; the parts run side by side.
names=() cmds=()
worker_version=""
if [ $want_worker -eq 1 ]; then
  worker_version="$(FOUNDRY_VERSION_ROOT="$tree" node "$root/scripts/pack-worker-release.mjs" --version-only)" ||
    { echo "remote-build: could not compute the Worker release version from $tree" >&2; exit 2; }
fi
[ $want_server -eq 0 ] || { names+=(server); cmds+=('cd "$RC_REPO/apps/server" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -p "$RC_JOB_CPUS" -o "$OUT/foundry-server" ./cmd/foundry-server'); }
[ $want_web -eq 0 ] || { names+=(web); cmds+=('cd "$RC_REPO/apps/web" && VITE_API_BASE_URL= node_modules/.bin/vite build --outDir "$OUT/web" --emptyOutDir --logLevel warn'); }
[ $want_worker -eq 0 ] || { names+=(worker); cmds+=("cd \"\$RC_REPO\" && WORKER_RELEASE_VERSION=$(printf '%q' "$worker_version") node scripts/pack-worker-release.mjs --out \"\$OUT/worker-packages\""); }
build_line='OUT="$PWD/$RC_JOB/build-out"; rm -rf "$OUT" "$RC_JOB/build-out.tgz" "$RC_JOB"/run/part-*; mkdir -p "$OUT" "$RC_JOB/run"; cp "$RC_JOB/SOURCE_MANIFEST" "$OUT/SOURCE_MANIFEST"
pids=""'
for i in "${!names[@]}"; do
  build_line+="
( s=\$(date +%s); ( ${cmds[$i]} ) > \"\$RC_JOB/run/part-${names[$i]}.log\" 2>&1; c=\$?; echo \"${names[$i]} exit \$c in \$((\$(date +%s)-s))s\" > \"\$RC_JOB/run/part-${names[$i]}.status\"; exit \$c ) &
pids=\"\$pids \$!\""
done
build_line+='
failed=0; for p in $pids; do wait $p || failed=1; done
for f in "$RC_JOB"/run/part-*.status; do cat "$f"; done
for f in "$RC_JOB"/run/part-*.log; do [ -s "$f" ] && { echo "== $f"; tail -30 "$f"; }; done
[ $failed -eq 0 ] || exit 1
(cd "$OUT" && find . -type f ! -name SHA256SUMS | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done > SHA256SUMS)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$RC_JOB/build-out.tgz" -C "$OUT" . 2>/dev/null || tar -czf "$RC_JOB/build-out.tgz" -C "$OUT" .
shasum -a 256 "$RC_JOB/build-out.tgz" | cut -c1-64 > "$RC_JOB/build-out.tgz.sha256"
echo "packed $(wc -c < "$RC_JOB/build-out.tgz" | tr -d " ") bytes"'

started=$(date +%s)
rc_init "$target"
rc_detect_proxy
[ -n "$base" ] || base="$(rc_default_base "$tree")" || die "no base commit for $tree (pass --base)"
base="$(git -C "$root" rev-parse --verify "$base^{commit}")"
if [ $fetch_only -eq 1 ]; then
  rc_job="$(run_shell 30 'find jobs -mindepth 2 -maxdepth 2 -name build-out.tgz 2>/dev/null | LC_ALL=C sort | tail -1 | sed "s#/build-out.tgz$##"')"
  [ -n "$rc_job" ] || die "no previous remote build is left to fetch"
  rc_remote_repo="$rc_job/repo"
  rc_job_created=1
  prepared=$(date +%s) built=$prepared
  : >"$rc_work/changes.diff"
else
  rc_slot_acquire
  rc_sync "$tree" "$base"
  synced=$(date +%s)
  rc_bootstrap "$log_file"
  rc_deps "$log_file"
  prepared=$(date +%s)
  log "synced in $((synced - started))s, dependencies ready in $((prepared - synced))s; building ${names[*]}${worker_version:+ (worker $worker_version)}"

  node - "$tree" "$rc_work/SOURCE_MANIFEST" <<'NODE'
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const tree = path.resolve(process.argv[2]);
const output = process.argv[3];
const files = (args) =>
  execFileSync("git", ["-C", tree, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

const names = new Set([
  ...files(["ls-files", "-z"]),
  ...files(["ls-files", "--others", "--exclude-standard", "-z"]),
]);
const entries = [];
for (const name of names) {
  if (
    name === "node_modules" ||
    name.includes("/node_modules/") ||
    name.startsWith(".git/")
  )
    continue;
  const file = path.join(tree, name);
  if (!existsSync(file)) continue;
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  entries.push(`${digest}  ${name}`);
}
entries.sort();
writeFileSync(output, `${entries.join("\n")}\n`);
NODE
  upload "$rc_work/SOURCE_MANIFEST" file "$rc_job/SOURCE_MANIFEST"

  set +e
  job build "${REMOTE_BUILD_TIMEOUT:-1500}" "$build_line" "$log_file" quiet
  status=$?
  set -e
  built=$(date +%s)
  grep -E ' exit [0-9]+ in ' "$log_file" | sed 's/^/remote-build: /' >&2 || true
  if [ "$status" -ne 0 ]; then
    tail -60 "$log_file" >&2
    die "build failed (exit $status) after $((built - prepared))s; log $log_file"
  fi
fi

want_sum="$(run_shell 30 "cat '$rc_job/build-out.tgz.sha256'" | tr -d '[:space:]')"
download "$rc_job/build-out.tgz" "$rc_work/build-out.tgz" || die "fetching the artifacts failed"
got_sum="$(sha256sum "$rc_work/build-out.tgz" | cut -c1-64)"
[ "$want_sum" = "$got_sum" ] || die "the artifacts arrived damaged (sha256 $got_sum, device $want_sum)"
tar --warning=no-unknown-keyword -xzf "$rc_work/build-out.tgz" -C "$out"
find "$out" -name '._*' -delete # macOS metadata a tar without --no-xattrs adds
if [ -f "$rc_work/SOURCE_MANIFEST" ]; then
  cp "$rc_work/SOURCE_MANIFEST" "$out/SOURCE_MANIFEST"
fi
(cd "$out" && sha256sum --quiet -c SHA256SUMS) || die "a file in $out does not match SHA256SUMS"
fetched=$(date +%s)
if [ -f "$out/foundry-server" ]; then
  go version -m "$out/foundry-server" 2>/dev/null | grep -q 'GOOS=linux' ||
    die "$out/foundry-server is not a linux build"
fi
{
  echo "source tree $tree"
  echo "base $base"
  [ $fetch_only -eq 1 ] && echo "fetched only (the device's last build)" ||
    echo "diff sha256 $(sha256sum "$rc_work/changes.diff" | cut -c1-64)"
  [ ! -f "$out/SOURCE_MANIFEST" ] ||
    echo "source manifest sha256 $(sha256sum "$out/SOURCE_MANIFEST" | cut -c1-64)"
  [ -z "$worker_version" ] || echo "worker version $worker_version"
  echo "built $(date -u +%Y-%m-%dT%H:%M:%SZ) on $target ($rc_lease)"
  grep -E ' exit [0-9]+ in ' "$log_file" || true
} >"$out/build-info.txt"
echo "remote-build: OK — build $((built - prepared))s, transfer $((fetched - built))s ($(wc -c <"$rc_work/build-out.tgz" | tr -d ' ') bytes), $((fetched - started))s total; $out (SHA256SUMS verified); log $log_file"
