#!/usr/bin/env bash
# Remove a remote-check/remote-build batch's job checkouts, dependencies and outputs.
# The default is session-scoped: other sessions may use the shared runner root at the
# same time. --root removes the whole shared root only when no other job is active.
#
# Usage:
#   scripts/remote-clean.sh <lease|device|res_…> [--root]
#   scripts/remote-clean.sh --device mac|byte-dev|byte-dev-sg [--root]
#   scripts/remote-clean.sh --resource <res_…|lease_…> [--root]
#   scripts/remote-clean.sh --all [--root]
#
# A lease supplied by acquire_resource (FOUNDRY_LEASE_TOKEN) is enough inside a Foundry
# session. --device and --all need FOUNDRY_SESSION_TOKEN, or a paired local `foundry` CLI.
# Environment: REMOTE_CHECK_SCRATCH (default foundry-remote), FOUNDRY_CLI,
# REMOTE_CLEAN_WAIT_MS (default 5000).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="${REMOTE_CHECK_SCRATCH:-foundry-remote}"
rc_name=remote-clean
usage() { sed -n '2,17p' "$0"; exit 2; }
export REMOTE_LEASE_WAIT_MS="${REMOTE_CLEAN_WAIT_MS:-5000}"

all=0
root_cleanup=0
target=""
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
  target="$1"
  shift
fi
while [ $# -gt 0 ]; do
  case "$1" in
    --all) all=1; shift ;;
    --root) root_cleanup=1; shift ;;
    --device) target="${2:?--device needs mac, byte-dev or byte-dev-sg}"; shift 2 ;;
    --resource) target="${2:?--resource needs a res_… or lease_… id}"; shift 2 ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done
[ "$all" -eq 1 ] || [ -n "$target" ] || usage
[ "$all" -eq 0 ] || [ -z "$target" ] || {
  echo "remote-clean: --all cannot be combined with one runner" >&2
  exit 2
}

# shellcheck source=lib/remote-compute.sh
source "$root/scripts/lib/remote-compute.sh"
owner_q="$(printf '%q' "$rc_owner")"

release_lease() {
  [ -z "$rc_lease" ] || cli resource release "$rc_lease" >/dev/null 2>&1 || true
  rc_lease=""
}

list_residuals() {
  local verify_scratch="$1"
  local verify result code file
  verify="$(ARGS_SCRATCH="$verify_scratch" args_command "set -eu
ROOT=\"\${FOUNDRY_STATE_DIR:-\$HOME/.foundry}/compute/$scratch\"
printf \"scratch_root=%s exists=%s\n\" \"\$ROOT\" \"\$([ -e \"\$ROOT\" ] && echo yes || echo no)\"
printf \"foundry_named_entries_begin\n\"
for base in \"\$HOME\" /tmp /var/tmp; do
  [ ! -d \"\$base\" ] || find \"\$base\" -maxdepth 4 \( -iname \"*foundry*\" -o -iname \"fdy-*\" \) -print 2>/dev/null
done | LC_ALL=C sort -u | head -200
printf \"foundry_named_entries_end\n\"" 120)"
  result="$(operate "$verify" run)" || die "could not verify cleanup on $rc_selected_device"
  code="$(json 'v.exitCode' <<<"$result")"
  json 'v.stdout' <<<"$result"
  file="$(ARGS_SCRATCH="$verify_scratch" args '{}')"
  operate "$file" cleanup >/dev/null 2>&1 || true
  [ "$code" = 0 ] || {
    json 'v.stderr' <<<"$result" >&2
    die "could not inspect residual paths on $rc_selected_device"
  }
}

clean_own_jobs() {
  local result code
  log "cleaning this session's jobs ($rc_owner) under $scratch on $rc_selected_device"
  result="$(run_shell 300 "set -eu
OWNER=$owner_q
live=''
for d in jobs/\"\$OWNER\"-*; do
  [ -d \"\$d\" ] || continue
  for f in \"\$d\"/run/*.pid; do
    [ -f \"\$f\" ] || continue
    p=\$(cat \"\$f\" 2>/dev/null || true)
    if [ -n \"\$p\" ] && kill -0 \"\$p\" 2>/dev/null; then live=\"\$live \$f\"; fi
  done
done
[ -z \"\$live\" ] || { echo \"live jobs of this batch:\$live\" >&2; exit 3; }
for slot in .slots/*; do
  [ -d \"\$slot\" ] || continue
  job=\$(cat \"\$slot/job\" 2>/dev/null || true)
  case \"\$job\" in jobs/\"\$OWNER\"-*)
    pid=\$(cat \"\$slot/pid\" 2>/dev/null || true)
    [ -z \"\$pid\" ] || kill \"\$pid\" 2>/dev/null || true
    rm -rf \"\$slot\"
  esac
done
count=0
for d in jobs/\"\$OWNER\"-*; do
  [ -d \"\$d\" ] || continue
  chmod -R u+w \"\$d\" 2>/dev/null || true
  rm -rf \"\$d\"
  count=\$((count + 1))
done
echo \"removed_own_jobs=\$count\"")" ||
    die "could not remove this batch's jobs on $rc_selected_device"
  printf '%s\n' "$result"
  result="$(run_shell 60 "set -eu
OWNER=$owner_q
count=0
for d in jobs/\"\$OWNER\"-*; do [ ! -d \"\$d\" ] || count=\$((count + 1)); done
echo \"own_jobs_remaining=\$count\"
[ \"\$count\" -eq 0 ]")" ||
    die "this batch's job directory is still present on $rc_selected_device"
  printf '%s\n' "$result"
  list_residuals "fdy-own-clean-$$-$RANDOM"
  release_lease
}

clean_root() {
  local file result code verify_scratch="fdy-root-clean-$$-$RANDOM"
  log "cleaning the whole shared root $scratch on $rc_selected_device"
  run_shell 60 'set -eu
active=""
for f in jobs/*/run/*.pid; do
  [ -f "$f" ] || continue
  pid="$(cat "$f" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then active="$active $f"; fi
done
for slot in .slots/*; do
  [ -d "$slot" ] || continue
  pid="$(cat "$slot/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then active="$active $slot"; fi
done
[ -z "$active" ] || { echo "active jobs/slots:$active" >&2; exit 3; }
find .cleanup -maxdepth 0 -mmin +5 -exec rm -rf {} + 2>/dev/null || true
mkdir .cleanup 2>/dev/null || { echo "another cleanup is running" >&2; exit 4; }
active=""
for slot in .slots/*; do
  [ -d "$slot" ] || continue
  pid="$(cat "$slot/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then active="$active $slot"; fi
done
[ -z "$active" ] || { rmdir .cleanup; echo "active job slots:$active" >&2; exit 3; }' >/dev/null ||
    die "whole-root cleanup refused: another remote job is active"
  run_shell 300 "chmod -R u+w . 2>/dev/null || true" >/dev/null ||
    { run_shell 30 "rm -rf .cleanup" >/dev/null 2>&1 || true; die "could not make the scratch root writable on $rc_selected_device"; }
  file="$(args '{}')"
  result="$(operate "$file" cleanup)" ||
    { run_shell 30 "rm -rf .cleanup" >/dev/null 2>&1 || true; die "cleanup failed on $rc_selected_device"; }
  log "cleanup: $(json 'v.removed ?? "nothing to remove"' <<<"$result")"

  local verify
  verify="$(ARGS_SCRATCH="$verify_scratch" args_command "set -eu
ROOT=\"\${FOUNDRY_STATE_DIR:-\$HOME/.foundry}/compute/$scratch\"
[ ! -e \"\$ROOT\" ]" 120)"
  result="$(operate "$verify" run)" || die "could not verify cleanup on $rc_selected_device"
  code="$(json 'v.exitCode' <<<"$result")"
  file="$(ARGS_SCRATCH="$verify_scratch" args '{}')"
  operate "$file" cleanup >/dev/null 2>&1 || true
  [ "$code" = 0 ] || die "scratch root still exists on $rc_selected_device"
  list_residuals "fdy-root-list-$$-$RANDOM"
  log "scratch root absent on $rc_selected_device"
  release_lease
}

clean_one() {
  if [ "$root_cleanup" -eq 1 ]; then clean_root; else clean_own_jobs; fi
}

if [ "$all" -eq 1 ]; then
  [ -n "${FOUNDRY_SESSION_TOKEN:-}" ] ||
    die "--all needs FOUNDRY_SESSION_TOKEN (or clean one acquired lease at a time)"
  listing="$(cli device list --type compute)" || die "could not list compute devices"
  cleaned=0
  for device in CanWendeMac-mini byte-dev byte-dev-sg; do
    record="$(rc_device_record "$listing" "$device" 2>/dev/null)" || continue
    read -r online label _ _ _ <<<"$record"
    if [ "$online" != online ]; then
      log "$label is offline; skipped"
      continue
    fi
    rc_init_exact "$label"
    clean_one
    cleaned=$((cleaned + 1))
  done
  [ "$cleaned" -gt 0 ] || die "no online runner to clean"
else
  rc_init_exact "$target"
  clean_one
fi
