#!/usr/bin/env bash
# Deploy prebuilt artifacts (scripts/remote-build.sh output) to the dev server on this
# host; nothing is built here. Takes /tmp/fdy-deploy.lock through scripts/fdy-lock:
# do not wrap it in flock.
#
# Usage: scripts/deploy-dev.sh --prebuilt <dir> --label <item> [--server] [--web] [--worker]
#                                [--replaces <current-live-id>]...
#   (none named: every part <dir> holds)
#   --server  <dir>/foundry-server: keeps foundry-server.pre-<item>, swaps the binary
#             atomically, SIGHUP handoff (port stays open), waits for "took over" and a new
#             /healthz startedAt; a kept or failed handoff puts the previous binary back.
#   --web     <dir>/web through scripts/deploy-web-dev.sh (release dir releases/<item>).
#   --worker  <dir>/worker-packages: keeps release.json.pre-<item>, adds the tarballs (old
#             ones stay for rollback), swaps release.json, checks /api/worker/release.
#             Devices then update through update_worker / foundry-worker update.
#   --replaces  Explicitly acknowledge replacing the current live Web build id or Server
#               binary SHA when the new source manifest does not contain the live one;
#               repeat it when a combined Server+Web deploy replaces both.
#   --build     Refused. Build with scripts/remote-build.sh first, then pass --prebuilt.
# <dir>/SHA256SUMS is checked first. Before --worker, compare the live package with the
# tree you built (another session's release must not be reverted).
#
# Environment: FOUNDRY_SERVER_RELEASE (default ~/.foundry/server/releases/dev023-candidate),
# FOUNDRY_WORKER_PACKAGES (default ~/.foundry/server/worker-packages), DEPLOY_LOCK_WAIT
# (seconds, default 1800), FOUNDRY_WEB_ROOT / FOUNDRY_WEB_ORIGIN as deploy-web-dev.sh;
# FOUNDRY_PM2_APP (default foundry-server), FOUNDRY_HEALTHZ_URL, FOUNDRY_DEPLOY_LOCK and
# FOUNDRY_RELEASES (Web rollback folders, default ~/.foundry/server/releases) to
# rehearse on a scratch pm2 app.
set -euo pipefail

original_args=("$@")
die() { echo "deploy-dev: $*" >&2; exit 1; }
log() { echo "deploy-dev: $*" >&2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="" label="" replaces=""
want_server=0 want_web=0 want_worker=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prebuilt) dir="${2:?--prebuilt needs a folder}"; shift 2 ;;
    --label) label="${2:?--label needs a name}"; shift 2 ;;
    --replaces) replaces="${replaces:+$replaces,}${2:?--replaces needs the current live build id}"; shift 2 ;;
    --server) want_server=1; shift ;;
    --web) want_web=1; shift ;;
    --worker) want_worker=1; shift ;;
    --build | --build-only)
      die "builds are not allowed in deploy-dev or its deploy lock; run scripts/remote-build.sh, then pass --prebuilt" ;;
    *) sed -n '2,24p' "$0"; exit 2 ;;
  esac
done
[ -n "$dir" ] && [ -n "$label" ] || { sed -n '2,24p' "$0"; exit 2; }
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || die "label must be letters, digits, . _ -"
dir="$(cd "$dir" && pwd)"
if [ $((want_server + want_web + want_worker)) -eq 0 ]; then
  [ ! -f "$dir/foundry-server" ] || want_server=1
  [ ! -d "$dir/web" ] || want_web=1
  [ ! -d "$dir/worker-packages" ] || want_worker=1
fi
[ $((want_server + want_web + want_worker)) -gt 0 ] || die "$dir holds no foundry-server, web or worker-packages"
[ -f "$dir/SHA256SUMS" ] || die "$dir has no SHA256SUMS (not a remote-build output?)"
(cd "$dir" && sha256sum --quiet -c SHA256SUMS) || die "$dir does not match its SHA256SUMS"

release="${FOUNDRY_SERVER_RELEASE:-$HOME/.foundry/server/releases/dev023-candidate}"
packages="${FOUNDRY_WORKER_PACKAGES:-$HOME/.foundry/server/worker-packages}"
pm2_app="${FOUNDRY_PM2_APP:-foundry-server}"
pm2_log="$HOME/.pm2/logs/$pm2_app-error.log"
healthz="${FOUNDRY_HEALTHZ_URL:-http://127.0.0.1:31982/healthz}"

lock="${FOUNDRY_DEPLOY_LOCK:-/tmp/fdy-deploy.lock}"
if [ "${_FDY_DEPLOY_LOCKED:-0}" != 1 ]; then
  exec env FOUNDRY_DEPLOY_LOCK="$lock" _FDY_DEPLOY_LOCKED=1 \
    "$root/scripts/fdy-lock" deploy --wait "${DEPLOY_LOCK_WAIT:-1800}" -- "$0" "${original_args[@]}"
fi
log "deploy lock held; prebuilt artifacts only (no build)"
if [ "${DEPLOY_DRY_RUN:-0}" = 1 ]; then
  parts=()
  [ $want_server -eq 0 ] || parts+=(server)
  [ $want_web -eq 0 ] || parts+=(web)
  [ $want_worker -eq 0 ] || parts+=(worker)
  log "dry run after deploy lock: ${parts[*]} from $dir (label $label)"
  exit 0
fi

started_at() { curl -fsS --max-time 5 "$healthz" | sed -n 's/.*"startedAt":"\([^"]*\)".*/\1/p'; }
replaces_current() { case ",$replaces," in *",$1,"*) return 0 ;; esac; return 1; }

current_web_build() {
  local file="${FOUNDRY_WEB_ROOT:-/var/www/foundryapp-dev}/version.json"
  sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$file" 2>/dev/null
}

check_source_manifest() {
  local kind="$1" live="$2" recorded="$3" candidate="$dir/SOURCE_MANIFEST" expected actual
  [ -n "$live" ] || die "$kind: cannot identify the live build"
  if [ ! -f "$candidate" ]; then
    if replaces_current "$live"; then
      log "$kind: explicit replacement of live source $live (artifact has no source manifest)"
      return
    fi
    die "$kind: the prebuilt artifact has no SOURCE_MANIFEST; pass --replaces $live only after verifying the replacement"
  fi
  expected="$(sed -n 's/^source manifest sha256 //p' "$dir/build-info.txt" 2>/dev/null)"
  if [ -z "$expected" ]; then
    if replaces_current "$live"; then
      log "$kind: explicit replacement of live source $live (build-info has no source manifest hash)"
      return
    fi
    die "$kind: build-info.txt has no source manifest hash; pass --replaces $live only after verifying the replacement"
  fi
  actual="$(sha256sum "$candidate" | cut -d' ' -f1)"
  [ "$actual" = "$expected" ] || die "$kind: SOURCE_MANIFEST does not match build-info.txt"

  if [ -f "$recorded" ] && node - "$recorded" "$candidate" <<'NODE'
const { readFileSync } = require("node:fs");
const parse = (file) =>
  new Map(
    readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(66), line.slice(0, 64)]),
  );
const live = parse(process.argv[2]);
const next = parse(process.argv[3]);
const missing = [...live].filter(([path, hash]) => next.get(path) !== hash);
if (missing.length) {
  for (const [path] of missing.slice(0, 12))
    console.error(`missing live source: ${path}`);
  process.exit(1);
}
NODE
  then
    return
  fi

  if replaces_current "$live"; then
    log "$kind: explicit replacement of live source $live"
    return
  fi
  if [ -f "$recorded" ]; then
    die "$kind: the new source does not contain the live source $live; pass --replaces $live only after verifying the replacement"
  fi
  die "$kind: no source manifest is recorded for live build $live; pass --replaces $live only after verifying the replacement"
}

record_source_manifest() {
  local recorded="$1"
  if [ ! -f "$dir/SOURCE_MANIFEST" ]; then
    log "no SOURCE_MANIFEST to record; the next deploy will still require --replaces"
    return
  fi
  mkdir -p "$(dirname "$recorded")"
  install -m 644 "$dir/SOURCE_MANIFEST" "$recorded"
}

deploy_server() {
  local new="$dir/foundry-server" backup="$release/foundry-server.pre-$label" before lines i live
  go version -m "$new" 2>/dev/null | grep -q 'GOOS=linux' || die "$new is not a linux build"
  [ ! -e "$backup" ] || die "$backup exists; pick another --label"
  live="$(sha256sum "$release/foundry-server" | cut -d' ' -f1)"
  check_source_manifest server "$live" "$release/foundry-server.source-manifest"
  before="$(started_at)" || die "the running server does not answer /healthz"
  cp -p "$release/foundry-server" "$backup"
  cp "$new" "$release/.foundry-server.new" && chmod 755 "$release/.foundry-server.new"
  mv -f "$release/.foundry-server.new" "$release/foundry-server"
  lines=$(wc -l <"$pm2_log")
  env -i HOME="$HOME" PATH="$PATH" pm2 sendSignal SIGHUP "$pm2_app" >/dev/null
  for i in $(seq 1 75); do
    sleep 2
    if tail -n +"$((lines + 1))" "$pm2_log" | grep -q 'restart handoff: new server pid .* took over'; then
      break
    fi
    if tail -n +"$((lines + 1))" "$pm2_log" | grep -q 'restart handoff: kept server pid'; then
      tail -n +"$((lines + 1))" "$pm2_log" | grep 'restart handoff' >&2
      mv -f "$backup" "$release/foundry-server"
      die "the new server did not take over; previous binary restored (the old process kept serving)"
    fi
  done
  tail -n +"$((lines + 1))" "$pm2_log" | grep 'restart handoff' | tail -2 >&2 || true
  local after=""
  for i in $(seq 1 15); do
    after="$(started_at || true)"
    [ -z "$after" ] || [ "$after" = "$before" ] || break
    sleep 2
  done
  [ -n "$after" ] && [ "$after" != "$before" ] ||
    die "healthz still reports startedAt $before; check $pm2_log (rollback: mv $backup $release/foundry-server && pm2 sendSignal SIGHUP $pm2_app)"
  record_source_manifest "$release/foundry-server.source-manifest"
  log "server: $(sha256sum "$release/foundry-server" | cut -c1-12) running since $after (was $before); rollback copy $backup"
}

deploy_web() {
  local live releases
  live="$(current_web_build)"
  releases="${FOUNDRY_RELEASES:-$HOME/.foundry/server/releases}"
  check_source_manifest web "$live" "$releases/source-manifests/web-$live.txt"
  "$root/scripts/deploy-web-dev.sh" "$dir/web" "$releases/$label"
  record_source_manifest "$releases/source-manifests/web-$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$dir/web/version.json").txt"
}

deploy_worker() {
  local src="$dir/worker-packages" version old served
  [ -f "$src/release.json" ] || die "$src has no release.json"
  version="$(node -p 'require(process.argv[1]).version' "$src/release.json")"
  old="$(node -p 'require(process.argv[1]).version' "$packages/release.json")"
  [ ! -e "$packages/release.json.pre-$label" ] || die "$packages/release.json.pre-$label exists; pick another --label"
  cp -p "$packages/release.json" "$packages/release.json.pre-$label"
  cp -n "$src"/*.tgz "$packages/"
  cp "$src/release.json" "$packages/.release.json.new" && mv -f "$packages/.release.json.new" "$packages/release.json"
  served="$(curl -fsS --max-time 10 "${FOUNDRY_WEB_ORIGIN:-https://dev.foundryapp.app}/api/worker/release")" || served=""
  case "$served" in
    *"\"$version\""*) ;;
    *) cp -p "$packages/release.json.pre-$label" "$packages/release.json"
       die "the server does not serve $version; release.json restored to $old" ;;
  esac
  log "worker: serving $version (was $old); rollback: cp $packages/release.json.pre-$label $packages/release.json"
}

[ $want_server -eq 0 ] || deploy_server
[ $want_web -eq 0 ] || deploy_web
[ $want_worker -eq 0 ] || deploy_worker
log "done"
