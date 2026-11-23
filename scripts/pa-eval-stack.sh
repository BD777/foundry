#!/bin/bash
# Prepares a fresh hermetic stack directory for scripts/pa-eval-run.mjs
# --stack-dir (was ~/pa1-scripts/fresh.sh): a copy of a prebuilt server
# binary, a fresh database the binary migrates on a throwaway start, the
# synthetic user pa1-eval (random password in DIR/data/eval-user.password,
# mode 0600, never printed) and the fixture from scripts/pa-eval-seed.mjs.
# The server only ever sees a dead proxy, FOUNDRY_INTEGRATIONS=off and the
# server key referenced read-only where it lives (never copied).
# One stack per run: the Worker keeps the server URL it paired with, and
# every run picks a new port.
#
# usage: scripts/pa-eval-stack.sh DIR SERVER_BINARY PROFILE_ID MODEL EFFORT [KIND]
# The eval set is PA_EVAL_SET (default ~/.foundry/pa-eval/set). DIR must not
# be under the person's home: the eval's Workers see the run folder at its
# real path.
# KIND is the execution default's provider kind (api, the default, for a
# seeded server profile; environment for a device's connector profile such
# as limen_default, which needs no server row and is not seeded).
set -euo pipefail
T=$1 BIN=$2 PROFILE=$3 MODEL=$4 EFFORT=$5 KIND=${6:-api}
here=$(cd "$(dirname "$0")" && pwd)
# A seeded server profile's secret is wrapped with the dev server's key, so
# KIND api uses that key read-only; otherwise the stack has a key of its own.
if [ "${6:-api}" = api ]; then key=${PA_EVAL_SECRET_KEY_PATH:-$HOME/.foundry/server/foundry-secret.key}
else key=${PA_EVAL_SECRET_KEY_PATH:-$1/data/foundry-secret.key}; fi
[ -e "$T/data/foundry.db" ] && { echo "pa-eval-stack: $T already has a database" >&2; exit 2; }
case "$(cd "$(dirname "$T")" && pwd)/" in "$HOME"/*) echo "pa-eval-stack: $T is under $HOME; use a folder outside it" >&2; exit 2 ;; esac
umask 077
mkdir -p "$T/bin" "$T/data" "$T/state" "$T/logs"
cp "$BIN" "$T/bin/foundry-server"
dead=http://127.0.0.1:9
senv=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}"
  HTTP_PROXY=$dead HTTPS_PROXY=$dead ALL_PROXY=$dead http_proxy=$dead https_proxy=$dead all_proxy=$dead
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
  FOUNDRY_DB_PATH="$T/data/foundry.db" FOUNDRY_SECRET_KEY_PATH="$key" FOUNDRY_STATE_ROOT="$T/state"
  FOUNDRY_INTEGRATIONS=off FOUNDRY_HOST=127.0.0.1)
[ -e "$key" ] || env -i "${senv[@]}" "$T/bin/foundry-server" keys generate >/dev/null
port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
env -i "${senv[@]}" PORT="$port" FOUNDRY_WEB_ORIGIN="http://127.0.0.1:$port" \
  "$T/bin/foundry-server" >>"$T/logs/server-init.log" 2>&1 </dev/null &
pid=$!
for _ in $(seq 1 120); do curl -sf -o /dev/null "http://127.0.0.1:$port/healthz" && break; sleep 0.5; done
kill "$pid"; wait "$pid" 2>/dev/null || true
node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))' >"$T/data/eval-user.password"
env -i "${senv[@]}" "$T/bin/foundry-server" users create --username pa1-eval --role admin \
  --display-name "PA1 Eval" --password-stdin <"$T/data/eval-user.password" >/dev/null
seed_profile=(--profile "$PROFILE")
[ "$KIND" = api ] || seed_profile=()
node "$here/pa-eval-seed.mjs" "$T/data/foundry.db" pa1-eval "${PA_EVAL_SET:-$HOME/.foundry/pa-eval/set}" \
  "${seed_profile[@]}" --execution-default "$KIND,$PROFILE,claude,$MODEL,$EFFORT" 2>&1 |
  grep -v -i "experimental\|trace-warnings" >"$T/logs/seed.json"
echo "pa-eval-stack: $T ready (seed summary in $T/logs/seed.json)"
