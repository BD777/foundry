#!/usr/bin/env bash
# Scratch Foundry stacks: throwaway servers on copies of a live database, for
# browser checks and real-model runs that must not touch the live stack.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/scratch-stack.sh <command> ...

  up <name> [--keep-db] [--egress]   build if sources changed, copy the DB, start
  down <name>                        stop what <name> started, delete its dir
  list                               instances, their state and URLs
  shot <name> <path|url> <out.png> [--dark] [--width N] [--height N] [--wait ms] [--full]
                                     signed-in screenshot of a page
  worker <name> pair                 pair a worker (real HOME, own state root)
  worker <name> start | stop         run it in the background / stop it
  worker <name> <worker args...>     any foundry-worker command, same isolation

Each instance lives in ${TMPDIR:-/tmp}/foundry-scratch/<name>: an online copy
(SQLite backup API, source opened read-only) of the live DB and its secret
key, a free port picked at `up`, its own admin login (printed), logs, and
the worker's FOUNDRY_STATE_ROOT. Nothing is stripped from the copy: the
server runs with FOUNDRY_INTEGRATIONS=off, so it opens no Feishu bot
connection, never refreshes, revokes or keeps alive Connectors tokens and
runs no skill repository checks. Its other egress goes to a dead proxy
unless --egress (needed only for something you ask for explicitly, e.g.
"Check now" on a skill repository). A worker paired to an instance runs
with the real HOME, so model logins work; never click "Update worker" for
it (the updater acts on the real HOME).

Builds (server binary, web dist) are shared by every instance of a checkout
and rebuilt only when a source file is newer; SCRATCH_REBUILD=1 forces it.
Builds take a lock and run one at a time under a MemoryMax=2500M scope; each
server runs under its own MemoryMax (SCRATCH_SERVER_MEM, default 1G).

Concurrency on a 2 vCPU / 7.5 GB VM: 2-3 instances side by side are fine (an
idle server holds ~35 MB; `up` with current builds takes ~2 s). A rebuild
(~20 s with a warm Go cache, minutes cold) saturates both CPUs: start
instances one after another, never during `pnpm verify` or Docker builds,
and check `free -m` first.

Environment:
  SCRATCH_SRC         checkout to build (default: this script's checkout)
  SCRATCH_SOURCE_DB   DB to copy (default ~/.foundry/server/foundry.db; its
                      foundry-secret.key is copied too)
  SCRATCH_ROOT        instances' parent (default ${TMPDIR:-/tmp}/foundry-scratch)
  SCRATCH_SERVER_MEM  server memory cap (default 1G)
  SCRATCH_CHROME, SCRATCH_PLAYWRIGHT_CORE   browser / playwright-core for shot
                      (default: discovered, see scripts/scratch-stack/shot.mjs)
EOF
}

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SRC=$(cd "${SCRATCH_SRC:-$REPO}" && pwd)
ROOT=${SCRATCH_ROOT:-${TMPDIR:-/tmp}/foundry-scratch}
SOURCE_DB=${SCRATCH_SOURCE_DB:-$HOME/.foundry/server/foundry.db}
SOURCE_KEY=$(dirname "$SOURCE_DB")/foundry-secret.key
SERVER_MEM=${SCRATCH_SERVER_MEM:-1G}
BUILD=$ROOT/.build/$(printf %s "$SRC" | sha1sum | cut -c1-10)
ADMIN=scratch-admin

# A Foundry session exports FOUNDRY_* pointing at its own (live) stack; none
# of that may reach a scratch server or worker.
for v in $(env | grep -oE '^(FOUNDRY_[A-Z_]+|CLAUDE_CODE_USE_FOUNDRY)=' | tr -d =); do unset "$v"; done

die() { echo "scratch-stack: $*" >&2; exit 1; }
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.1fs", b - a }'; }

cap() { # memory-capped, low-priority run
  if command -v systemd-run >/dev/null; then
    systemd-run --user --scope -q -p MemoryMax=2500M -p MemorySwapMax=1G nice "$@"
  else
    nice "$@"
  fi
}

instance() { # name -> sets NAME and DIR
  [[ ${1:-} =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "instance name must match [a-z0-9][a-z0-9-]*, got '${1:-}'"
  NAME=$1
  DIR=$ROOT/$1
}

load() { # instance.env of DIR
  [ -f "$DIR/instance.env" ] || die "no instance '$NAME' (scripts/scratch-stack.sh list)"
  # shellcheck disable=SC1091
  . "$DIR/instance.env"
}

# The environment every server-binary run of this instance gets (in SENV).
# Each run of foundry-server opens and migrates FOUNDRY_DB_PATH (default: the
# live DB), so the binary is only ever invoked here as `env "${SENV[@]}" …`.
server_env() {
  local db=$DIR/data/foundry.db
  [ "$(realpath -m "$db")" != "$(realpath -m "$SOURCE_DB")" ] || die "refusing to run against the source DB"
  local proxy=()
  if [ "${EGRESS:-0}" != 1 ]; then
    local dead=http://127.0.0.1:9
    proxy=(HTTP_PROXY=$dead HTTPS_PROXY=$dead ALL_PROXY=$dead http_proxy=$dead https_proxy=$dead all_proxy=$dead
      NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost)
  fi
  SENV=("${proxy[@]}"
    FOUNDRY_DB_PATH="$db" FOUNDRY_SECRET_KEY_PATH="$DIR/data/foundry-secret.key"
    FOUNDRY_STATE_ROOT="$DIR/state" FOUNDRY_INTEGRATIONS=off
    FOUNDRY_HOST=127.0.0.1 PORT="$PORT" FOUNDRY_WEB_ORIGIN="$URL" FOUNDRY_WEB_DIST="$DIR/web")
}

# A PID belongs to this instance only while its command line names what the
# instance started (and, for the worker, its environment names its state).
ours() { # pid cmdline-substring [environ-entry]
  local pid=$1
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -qF -- "$2" || return 1
  [ -z "${3:-}" ] || tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null | grep -qxF -- "$3"
}
server_pid() { local p; p=$(cat "$DIR/server.pid" 2>/dev/null) && ours "$p" "$DIR/bin/foundry-server" && echo "$p"; }
worker_pid() { local p; p=$(cat "$DIR/worker.pid" 2>/dev/null) && ours "$p" "packages/worker/dist/cli.js" "FOUNDRY_STATE_ROOT=$DIR/state" && echo "$p"; }

stop_pid() { # pid label
  kill "$1" 2>/dev/null || return 0
  for _ in $(seq 1 40); do kill -0 "$1" 2>/dev/null || break; sleep 0.25; done
  kill -0 "$1" 2>/dev/null && kill -9 "$1"
  echo "stopped $2 $1"
}

stop_all() {
  local pid
  if pid=$(worker_pid); then stop_pid "$pid" worker; fi
  if pid=$(server_pid); then stop_pid "$pid" server; fi
  rm -f "$DIR/server.pid" "$DIR/worker.pid"
}

# --- builds -----------------------------------------------------------------

changed() { # output inputs... : missing, forced, or any input newer
  local out=$1; shift
  [ "${SCRATCH_REBUILD:-0}" = 1 ] || [ ! -e "$out" ] ||
    [ -n "$(find "$@" -type f -newer "$out" ! -name '*_test.go' ! -path '*/node_modules/*' -print -quit 2>/dev/null)" ]
}

build() {
  mkdir -p "$BUILD"
  exec 9>"$BUILD/.lock"
  flock 9
  local server=$SRC/apps/server proto=$SRC/packages/protocol web=$SRC/apps/web
  if changed "$BUILD/foundry-server" "$server"; then
    echo "building server..."
    (cd "$server" && GOFLAGS=-p=1 cap go build -o "$BUILD/foundry-server.new" ./cmd/foundry-server)
    mv -f "$BUILD/foundry-server.new" "$BUILD/foundry-server"
  fi
  if changed "$proto/dist/index.js" "$proto/src" "$proto/package.json" "$proto/tsconfig.json"; then
    echo "building protocol..."
    (cd "$proto" && cap npx tsc -p tsconfig.json) >"$BUILD/protocol-build.log" 2>&1 ||
      { tail -20 "$BUILD/protocol-build.log"; die "protocol build failed"; }
  fi
  if changed "$BUILD/web/index.html" "$web/src" "$web/public" "$web/index.html" "$web/vite.config.ts" "$web/package.json" "$proto/dist"; then
    echo "building web..."
    rm -rf "$BUILD/web.new"
    (cd "$web" && VITE_API_BASE_URL='' cap npx vite build --outDir "$BUILD/web.new" --emptyOutDir) >"$BUILD/web-build.log" 2>&1 ||
      { tail -20 "$BUILD/web-build.log"; die "web build failed"; }
    rm -rf "$BUILD/web.old"
    [ ! -d "$BUILD/web" ] || mv "$BUILD/web" "$BUILD/web.old"
    mv "$BUILD/web.new" "$BUILD/web"
    rm -rf "$BUILD/web.old"
  fi
  flock -u 9
}

# --- commands ---------------------------------------------------------------

free_port() {
  python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}
port_free() { ! ss -Hltn "sport = :$1" | grep -q .; }

cmd_up() {
  instance "${1:-}"; shift
  local keep=0 egress=0
  for arg in "$@"; do
    case $arg in
      --keep-db) keep=1 ;;
      --egress) egress=1 ;;
      *) die "unknown option $arg" ;;
    esac
  done
  local t0 t; t0=$(now)
  [ -f "$SOURCE_DB" ] || die "no source DB at $SOURCE_DB"
  if [ -f "$DIR/instance.env" ]; then stop_all; fi
  mkdir -p "$DIR/data" "$DIR/logs" "$DIR/state" "$DIR/bin"
  chmod 700 "$DIR"

  t=$(now); build; local build_time; build_time=$(since "$t")

  # Hard links: a later rebuild replaces the shared files, never these.
  ln -f "$BUILD/foundry-server" "$DIR/bin/foundry-server" 2>/dev/null || cp -f "$BUILD/foundry-server" "$DIR/bin/foundry-server"
  rm -rf "$DIR/web"
  cp -al "$BUILD/web" "$DIR/web" 2>/dev/null || cp -r "$BUILD/web" "$DIR/web"

  t=$(now)
  if [ "$keep" = 1 ] && [ -f "$DIR/data/foundry.db" ]; then
    echo "keeping the DB copy"
  else
    rm -f "$DIR"/data/foundry.db*
    python3 -I -c 'import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst); dst.close(); src.close()' "$SOURCE_DB" "$DIR/data/foundry.db"
    [ ! -f "$SOURCE_KEY" ] || install -m 600 "$SOURCE_KEY" "$DIR/data/foundry-secret.key"
  fi
  local copy_time; copy_time=$(since "$t")

  local pass=""
  if [ -f "$DIR/instance.env" ]; then
    pass=$( (. "$DIR/instance.env"; echo "${PASS:-}") )
    PORT=$( (. "$DIR/instance.env"; echo "${PORT:-}") )
  fi
  [ -n "$pass" ] || pass=$(python3 -I -c 'import secrets; print(secrets.token_urlsafe(12))')
  if [ -z "${PORT:-}" ] || ! port_free "$PORT"; then PORT=$(free_port); fi
  URL=http://127.0.0.1:$PORT
  EGRESS=$egress
  umask 077
  cat >"$DIR/instance.env" <<EOF
PORT=$PORT
URL=$URL
ADMIN=$ADMIN
PASS=$pass
EGRESS=$EGRESS
SRC=$SRC
SOURCE_DB=$SOURCE_DB
EOF

  server_env
  # Creating the login also migrates the copy.
  if ! printf %s "$pass" | env "${SENV[@]}" "$DIR/bin/foundry-server" users create --username "$ADMIN" --role admin --password-stdin >/dev/null 2>"$DIR/logs/users.log"; then
    printf %s "$pass" | env "${SENV[@]}" "$DIR/bin/foundry-server" users reset-password --username "$ADMIN" --password-stdin >/dev/null 2>>"$DIR/logs/users.log" ||
      { cat "$DIR/logs/users.log" >&2; die "could not create the admin login"; }
  fi

  local run=("$DIR/bin/foundry-server")
  if command -v systemd-run >/dev/null; then
    run=(systemd-run --user --scope -q --unit "foundry-scratch-$NAME-$(date +%s)" -p MemoryMax="$SERVER_MEM" -p MemorySwapMax=512M "${run[@]}")
  fi
  # env, nohup and systemd-run --scope all exec, so $! is the server itself.
  env "${SENV[@]}" nohup "${run[@]}" >>"$DIR/logs/server.log" 2>&1 </dev/null &
  echo $! >"$DIR/server.pid"
  local ok=0
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$URL/healthz"; then ok=1; break; fi
    if ! kill -0 "$(cat "$DIR/server.pid")" 2>/dev/null; then break; fi
    sleep 0.25
  done
  [ "$ok" = 1 ] || { tail -20 "$DIR/logs/server.log" >&2; die "server did not start"; }
  server_pid >/dev/null || die "server pid $(cat "$DIR/server.pid") is not $DIR/bin/foundry-server"
  echo "$NAME up in $(since "$t0") (build $build_time, DB copy $copy_time)"
  echo "  url    $URL"
  echo "  login  $ADMIN / $pass"
  echo "  egress $([ "$EGRESS" = 1 ] && echo on || echo 'dead proxy')   integrations off"
  echo "  shot   scripts/scratch-stack.sh shot $NAME /connectors/feishu /tmp/$NAME.png"
  echo "  down   scripts/scratch-stack.sh down $NAME"
}

cmd_down() {
  instance "${1:-}"
  [ -d "$DIR" ] || die "no instance '$NAME'"
  stop_all
  rm -rf "$DIR"
  echo "$NAME removed"
}

cmd_list() {
  [ -d "$ROOT" ] || { echo "no instances"; return; }
  local found=0
  for d in "$ROOT"/*/; do
    [ -f "$d/instance.env" ] || continue
    found=1
    DIR=${d%/}; NAME=$(basename "$DIR")
    local state=down pid worker=-
    # shellcheck disable=SC1091
    (. "$DIR/instance.env"
      if pid=$(server_pid); then state="up pid $pid"; fi
      if pid=$(worker_pid); then worker="pid $pid"; fi
      printf '%-12s %-16s %-26s egress=%s worker=%s src=%s\n' "$NAME" "$state" "$URL" "$EGRESS" "$worker" "$SRC")
  done
  [ "$found" = 1 ] || echo "no instances"
}

cmd_shot() {
  instance "${1:-}"; shift
  load
  [ $# -ge 2 ] || die "usage: shot <name> <path|url> <out.png> [--dark] [--width N]"
  local target=$1; shift
  case $target in http*://*) ;; *) target=$URL/${target#/} ;; esac
  SCRATCH_USER=$ADMIN SCRATCH_PASS=$PASS node "$REPO/scripts/scratch-stack/shot.mjs" "$target" "$@"
}

cmd_worker() {
  instance "${1:-}"; shift
  load
  local cli=$SRC/packages/worker/dist/cli.js
  [ -f "$cli" ] || die "no worker build at $cli (pnpm --filter @bd777/foundry-worker build)"
  local wenv=(FOUNDRY_STATE_ROOT="$DIR/state" FOUNDRY_STACK="scratch-$NAME")
  case ${1:-} in
    pair)
      local jar token
      jar=$(mktemp)
      curl -sf -c "$jar" -H "Origin: $URL" -H 'Content-Type: application/json' \
        -d "{\"username\":\"$ADMIN\",\"password\":\"$PASS\"}" "$URL/api/auth/login" >/dev/null || die "login failed"
      token=$(curl -sf -b "$jar" -H "Origin: $URL" -H "Idempotency-Key: $(date +%s%N)" -X POST \
        "$URL/api/devices/pairing-tokens" | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["token"])') || die "no pairing token"
      rm -f "$jar"
      env "${wenv[@]}" node "$cli" setup --server "$URL" --token "$token" --no-service
      ;;
    start)
      if worker_pid >/dev/null; then echo "worker already running"; return; fi
      env "${wenv[@]}" nohup node "$cli" connect >>"$DIR/logs/worker.log" 2>&1 </dev/null &
      echo $! >"$DIR/worker.pid"
      sleep 1
      worker_pid >/dev/null || { tail -20 "$DIR/logs/worker.log" >&2; die "worker did not start"; }
      echo "worker pid $(cat "$DIR/worker.pid"), log $DIR/logs/worker.log"
      ;;
    stop)
      local pid
      if pid=$(worker_pid); then stop_pid "$pid" worker; fi
      rm -f "$DIR/worker.pid"
      ;;
    "") die "usage: worker <name> pair|start|stop|<worker args>" ;;
    *) exec env "${wenv[@]}" node "$cli" "$@" ;;
  esac
}

case ${1:-} in
  up | down | list | shot | worker) command=$1; shift; "cmd_$command" "$@" ;;
  -h | --help | help | "") usage ;;
  *) usage >&2; exit 2 ;;
esac
