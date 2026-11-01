#!/usr/bin/env bash
# Run only the checks that apply to changed files, using local binaries, then print one
# summary table. Agents run this once at the end of a change instead of many separate
# check invocations.
#
# Usage: scripts/check-changed.sh [--since <time>] [--files <path>...] [--base <ref>] [--list]
#   --since <time>  only changed/untracked files modified after <time> (ISO 8601 or epoch).
#                   Agents sharing a checkout record `START=$(date -Iseconds)` when they begin
#                   and pass `--since "$START"`, so they check their own files, not everyone's.
#   --files <p>...  only these paths (until the next --option)
#   --base <ref>    diff the working tree against <ref> instead of HEAD
#   --list          print the plan without running it
# Default scope is the whole diff against HEAD (release check).
# Heavy steps (tsc, builds, web/worker tests, go test) queue on a VM-wide flock so
# concurrent callers do not thrash the CPUs; light steps (prettier, gofmt, audits) don't.
set -uo pipefail
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "check-changed.sh needs bash 4 or newer (macOS: brew install bash), not $BASH_VERSION" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caller_pwd="$PWD"
lock_file="/tmp/foundry-check-changed.lock"

# root_relative <path>: a path given from the caller's folder, relative to the root
# (GNU realpath; elsewhere, as on macOS, node).
root_relative() {
  if realpath -m / >/dev/null 2>&1; then
    (cd "$caller_pwd" && realpath -m --relative-to="$root" -- "$1")
  else
    node -e 'const p = require("node:path"); console.log(p.relative(process.argv[1], p.resolve(process.argv[2], process.argv[3])))' \
      "$root" "$caller_pwd" "$1"
  fi
}
# now: seconds, with fractions where date has them (not BSD date).
now() { local t; t="$(date +%s.%N)"; case "$t" in *N) date +%s ;; *) echo "$t" ;; esac; }
# Linux caps go test's memory and serializes heavy steps; elsewhere they just run.
has_flock=0
command -v flock >/dev/null 2>&1 && has_flock=1

base="HEAD"
list_only=0
since=""
explicit_files=()
files_given=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2:?--base needs a ref}"; shift 2 ;;
    --since) since="${2:?--since needs a time}"; shift 2 ;;
    --files)
      files_given=1; shift
      while [ $# -gt 0 ] && [[ "$1" != --* ]]; do
        explicit_files+=("$(root_relative "$1")"); shift
      done ;;
    --list) list_only=1; shift ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
cd "$root"

if [ $files_given -eq 1 ]; then
  scope="given files"
  mapfile -t changed < <(printf '%s\n' "${explicit_files[@]}" | grep . | sort -u)
else
  scope="changed files against $base"
  mapfile -t changed < <(
    { git diff --name-only "$base" --; git ls-files --others --exclude-standard; } | sort -u
  )
fi
if [ -n "$since" ]; then
  if [[ "$since" =~ ^[0-9]+$ ]]; then since_epoch="$since"; else
    since_epoch="$(date -d "$since" +%s)" || { echo "bad --since time: $since" >&2; exit 2; }
  fi
  recent=()
  for f in "${changed[@]}"; do
    [ -f "$f" ] && [ "$(stat -c %Y -- "$f")" -gt "$since_epoch" ] && recent+=("$f")
  done
  changed=("${recent[@]}")
  scope="$scope modified since $since"
fi
existing=()
for f in "${changed[@]}"; do [ -f "$f" ] && existing+=("$f"); done
mapfile -t untracked < <(git ls-files --others --exclude-standard)

if [ ${#changed[@]} -eq 0 ]; then
  echo "No $scope."
  exit 0
fi

has() { printf '%s\n' "${changed[@]}" | grep -qE "$1"; }
matching() { printf '%s\n' "${existing[@]}" | grep -E "$1" || true; }
is_untracked() { printf '%s\n' "${untracked[@]}" | grep -qxF "$1"; }
# True when the file is new or its diff adds/removes an import line.
imports_changed() {
  local file="$1" pattern="$2"
  is_untracked "$file" && return 0
  git diff "$base" -- "$file" | grep -qE "$pattern"
}

bin() { # bin <package dir> <name>: package-local binary, else the root one
  if [ -x "$1/node_modules/.bin/$2" ]; then echo "$root/$1/node_modules/.bin/$2"; else echo "$root/node_modules/.bin/$2"; fi
}

# ---- plan -------------------------------------------------------------------
names=() targets=() commands=() heavy=()
# add <name> <target> <command> [heavy]: heavy steps take the shared CPU lock.
add() { names+=("$1"); targets+=("$2"); commands+=("$3"); heavy+=("${4:-0}"); }
q() { printf '%q ' "$@"; }

prettier_files=()
for f in "${existing[@]}"; do
  case "$f" in *.go) ;; *) prettier_files+=("$f") ;; esac
done
if [ ${#prettier_files[@]} -gt 0 ]; then
  add prettier "${#prettier_files[@]} files" \
    "$(q "$root/node_modules/.bin/prettier" --check --ignore-unknown --log-level warn "${prettier_files[@]}")"
fi

mapfile -t go_files < <(matching '^apps/server/.*\.go$')
if [ ${#go_files[@]} -gt 0 ]; then
  add gofmt "${#go_files[@]} files" \
    "out=\$(gofmt -l $(q "${go_files[@]}")); if [ -n \"\$out\" ]; then echo \"gofmt needed:\"; echo \"\$out\"; exit 1; fi"
fi

protocol_changed=0
has '^packages/protocol/(src|tsconfig)' && protocol_changed=1
if [ $protocol_changed -eq 1 ]; then
  add "protocol build" packages/protocol "cd packages/protocol && $(q "$(bin packages/protocol tsc)") -p tsconfig.json" heavy
fi
if has '^packages/protocol/' && [ -d packages/protocol/test ]; then
  add "protocol tests" "packages/protocol/test" "cd packages/protocol && node --test test/*.test.mjs"
fi

web_src_changed=0
has '^apps/web/src/' && web_src_changed=1
if [ $web_src_changed -eq 1 ] || [ $protocol_changed -eq 1 ] || has '^apps/web/tsconfig'; then
  add "tsc web" apps/web "cd apps/web && $(q "$(bin apps/web tsc)") -p tsconfig.json --noEmit" heavy
fi

# Web tests: changed test files + tests that mention a changed src module by path
# (relative to src, no extension), feature directory, or basename as an import specifier.
web_tests=()
mapfile -t web_tests < <(matching '^apps/web/test/.*\.test\.mjs$')
mapfile -t web_src < <(matching '^apps/web/src/.*\.(ts|tsx)$')
if [ ${#web_src[@]} -gt 0 ]; then
  patterns=()
  for f in "${web_src[@]}"; do
    rel="${f#apps/web/src/}"; rel="${rel%.*}"
    patterns+=("$rel")
    if [[ "$rel" =~ ^features/([^/]+)/ ]]; then patterns+=("features/${BASH_REMATCH[1]}/"); fi
    stem="$(basename "$rel")"
    if [ "$stem" != index ]; then patterns+=("/$stem.ts" "/$stem.js" "/$stem\"" "/$stem'"); fi
  done
  mapfile -t related < <(grep -lF "$(printf '%s\n' "${patterns[@]}" | sort -u)" apps/web/test/*.test.mjs 2>/dev/null)
  web_tests+=("${related[@]}")
fi
mapfile -t web_tests < <(printf '%s\n' "${web_tests[@]}" | grep . | sort -u)
if [ ${#web_tests[@]} -gt 0 ]; then
  rel_tests=("${web_tests[@]#apps/web/}")
  add "web tests" "${#web_tests[@]} files" \
    "cd apps/web && node --import ./test/register-bundler-resolve.mjs --test $(q "${rel_tests[@]}")" heavy
fi

# Worker: tests import ../dist, so a src change means build (which also typechecks).
worker_src_changed=0
has '^packages/worker/(src/|tsconfig)' && worker_src_changed=1
worker_tests=()
mapfile -t worker_tests < <(matching '^packages/worker/test/.*\.test\.mjs$')
mapfile -t worker_src < <(matching '^packages/worker/src/.*\.ts$')
if [ ${#worker_src[@]} -gt 0 ]; then
  patterns=()
  for f in "${worker_src[@]}"; do
    rel="${f#packages/worker/src/}"; rel="${rel%.ts}"
    patterns+=("dist/$rel.js")
    case "$rel" in */*) patterns+=("dist/${rel%/*}/") ;; esac
  done
  mapfile -t related < <(grep -lF "$(printf '%s\n' "${patterns[@]}" | sort -u)" packages/worker/test/*.test.mjs 2>/dev/null)
  worker_tests+=("${related[@]}")
fi
mapfile -t worker_tests < <(printf '%s\n' "${worker_tests[@]}" | grep . | sort -u)
if [ $worker_src_changed -eq 1 ] && [ ${#worker_tests[@]} -gt 0 ]; then
  add "worker build" packages/worker "cd packages/worker && $(q "$(bin packages/worker tsc)") -p tsconfig.json" heavy
elif [ $worker_src_changed -eq 1 ] || [ $protocol_changed -eq 1 ]; then
  add "tsc worker" packages/worker "cd packages/worker && $(q "$(bin packages/worker tsc)") -p tsconfig.json --noEmit" heavy
fi
if [ ${#worker_tests[@]} -gt 0 ]; then
  rel_tests=("${worker_tests[@]#packages/worker/}")
  add "worker tests" "${#worker_tests[@]} files" \
    "cd packages/worker && node scripts/run-worker-tests.mjs -- $(q "${rel_tests[@]}")" heavy
fi

# Go: per package, run only the Test funcs of _test.go files that share a basename prefix
# with a touched file (feishu.go -> feishu_test.go, feishu_gateway_test.go) plus tests in
# touched _test.go files. Small packages (<= 10 test files) and shared-file changes run
# the whole package; a touched package with no matching tests is compiled only.
go_test_cmd="cd apps/server && go test -timeout 20m"
if command -v systemd-run >/dev/null 2>&1; then
  go_test_cmd="cd apps/server && systemd-run --user --scope -q -p MemoryMax=2500M go test -timeout 20m"
fi
go_full=() go_plan=()
mapfile -t go_dirs < <(printf '%s\n' "${go_files[@]}" | grep . | xargs -r -n1 dirname | sort -u)
for dir in "${go_dirs[@]}"; do
  pkg="./${dir#apps/server/}"
  short="${pkg#./internal/}"
  test_files=("$dir"/*_test.go)
  [ -e "${test_files[0]}" ] || test_files=()
  mapfile -t touched < <(printf '%s\n' "${go_files[@]}" | grep -E "^$dir/[^/]+\.go\$")
  shared=""
  for f in "${touched[@]}"; do
    case "$(basename "$f")" in store.go | server.go | routes.go | models.go) shared="$(basename "$f")" ;; esac
  done
  if [ ${#test_files[@]} -le 10 ] || [ -n "$shared" ]; then
    go_full+=("$pkg")
    go_plan+=("$short: whole package (${shared:+shared file $shared, }${#test_files[@]} test files)")
    continue
  fi
  chosen=()
  for t in "${test_files[@]}"; do
    tstem="$(basename "$t" _test.go)"
    for f in "${touched[@]}"; do
      stem="$(basename "$f" .go)"; stem="${stem%_test}"
      if [ "$tstem" = "$stem" ] || [[ "$tstem" == "${stem}_"* ]] || [[ "$stem" == "${tstem}_"* ]]; then
        chosen+=("$t"); break
      fi
    done
  done
  mapfile -t funcs < <(cat /dev/null "${chosen[@]}" | grep -oE '^func Test[A-Za-z0-9_]+\(' | sed -E 's/^func (Test[A-Za-z0-9_]+)\(/\1/' | grep -vx TestMain | sort -u)
  if [ ${#funcs[@]} -eq 0 ]; then
    go_plan+=("$short: compile only (no tests match $(printf '%s ' "${touched[@]##*/}"))")
    add "go test" "$short (compile)" "$go_test_cmd -run '^\$' $(q "$pkg")" heavy
  else
    regex="^($(IFS='|'; echo "${funcs[*]}"))\$"
    go_plan+=("$short: ${#funcs[@]} tests from $(printf '%s ' "${chosen[@]##*/}")")
    add "go test" "$short (${#funcs[@]} tests)" "$go_test_cmd -run $(q "$regex") $(q "$pkg")" heavy
  fi
done
if [ ${#go_full[@]} -gt 0 ]; then
  add "go test" "${go_full[*]#./internal/}" "$go_test_cmd $(q "${go_full[@]}")" heavy
fi

if [ $web_src_changed -eq 1 ]; then
  # Expand `pnpm audit:ui` into its node scripts: one process each, no pnpm startup.
  ui_audits="$(cd apps/web && node -e '
    const s = require("./package.json").scripts;
    console.log(s["audit:ui"].split("&&").map((p) => s[p.trim().replace(/^pnpm /, "")]).join("\n"));')"
  ui_cmd="cd apps/web && rc=0"
  while IFS= read -r audit; do ui_cmd+="; $audit || rc=1"; done <<<"$ui_audits"
  add "audit:ui" "$(wc -l <<<"$ui_audits") audits" "$ui_cmd; exit \$rc"
fi

if has '^packages/protocol/src/' || has '^apps/server/internal/(store|httpapi)/'; then
  add "audit:contract" scripts "node scripts/audit-contract.mjs"
fi

if has '^packages/protocol/src/evidence' || has '^scripts/generate-evidence-models\.mjs$' ||
  has '^apps/server/internal/store/evidence(-schema\.json|_models_generated\.go)$' || has '^docs/evidence-and-verify-v1-fields\.md$'; then
  add "audit:evidence-models" scripts "node scripts/generate-evidence-models.mjs --check"
fi

boundary=0
for f in $(matching '^apps/server/internal/.*\.go$' | grep -v '_test\.go$'); do
  imports_changed "$f" '^[+-][[:space:]]*(import[[:space:](]|([A-Za-z_.]+[[:space:]]+)?"[^"]+"[[:space:]]*$)' && boundary=1
done
for f in $(matching '^packages/worker/src/.*\.ts$'); do
  imports_changed "$f" '^[+-](import[[:space:]]|.*[[:space:]]from[[:space:]]+"|.*import\(")' && boundary=1
done
for f in "${changed[@]}"; do # deleted modules
  [[ "$f" =~ ^(apps/server/internal/.*\.go|packages/worker/src/.*\.ts)$ ]] && [ ! -f "$f" ] && boundary=1
done
if [ $boundary -eq 1 ]; then
  add "audit:modules" scripts "node scripts/audit-module-boundaries.mjs"
fi

# ---- run --------------------------------------------------------------------
if [ ${#names[@]} -eq 0 ]; then
  echo "${#changed[@]} $scope; no checks apply."
  exit 0
fi

echo "${#changed[@]} $scope. Plan:"
for i in "${!names[@]}"; do
  printf '  %-15s %s%s\n' "${names[$i]}" "${targets[$i]}" "$([ "${heavy[$i]}" = heavy ] && echo '  [locked]')"
done
for line in "${go_plan[@]}"; do echo "  go: $line"; done
if [ $list_only -eq 1 ]; then
  echo
  for i in "${!names[@]}"; do printf '# %s\n%s\n' "${names[$i]}" "${commands[$i]}"; done
  exit 0
fi

logdir="$(mktemp -d)"
trap 'rm -rf "$logdir"' EXIT
exec 9>>"$lock_file"
run_start=$(now)
results=() seconds=() waits=()
failed=0
for i in "${!names[@]}"; do
  wait_s=0
  if [ "${heavy[$i]}" = heavy ] && [ $has_flock -eq 1 ] && ! flock -n 9; then
    echo "waiting for another check run (${names[$i]}; lock $lock_file)..."
    wait_start=$(now)
    flock 9
    wait_s="$(echo "$(now) - $wait_start" | bc)"
  fi
  start=$(now)
  if (cd "$root" && eval "${commands[$i]}") >"$logdir/$i.log" 2>&1 9>&-; then
    results+=(PASS)
  else
    results+=(FAIL)
    failed=1
    echo
    echo "==== ${names[$i]} FAILED (last 80 lines) ===="
    tail -n 80 "$logdir/$i.log"
  fi
  seconds+=("$(echo "$(now) - $start" | bc)")
  waits+=("$wait_s")
  [ $has_flock -eq 0 ] || flock -u 9
done

echo
printf '%-15s %-40s %-6s %8s %8s\n' CHECK TARGET RESULT SECONDS WAITED
total_wait=0
for i in "${!names[@]}"; do
  target="${targets[$i]}"
  [ ${#target} -gt 40 ] && target="${target:0:37}..."
  printf '%-15s %-40s %-6s %8.1f %8.1f\n' "${names[$i]}" "$target" "${results[$i]}" "${seconds[$i]}" "${waits[$i]}"
  total_wait="$(echo "$total_wait + ${waits[$i]}" | bc)"
done
wall="$(echo "$(now) - $run_start" | bc)"
printf '%-15s %-40s %-6s %8.1f %8.1f\n' "total (wall)" "" "$([ $failed -eq 0 ] && echo PASS || echo FAIL)" "$wall" "$total_wait"
exit $failed
