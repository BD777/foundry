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
# usage: scripts/pa-eval-stack.sh DIR SERVER_BINARY PROFILE_ID MODEL EFFORT
set -euo pipefail
T=$1 BIN=$2 PROFILE=$3 MODEL=$4 EFFORT=$5
here=$(cd "$(dirname "$0")" && pwd)
key=${PA_EVAL_SECRET_KEY_PATH:-$HOME/.foundry/server/foundry-secret.key}
[ -e "$T/data/foundry.db" ] && { echo "pa-eval-stack: $T already has a database" >&2; exit 2; }
umask 077
mkdir -p "$T/bin" "$T/data" "$T/state" "$T/logs"
cp "$BIN" "$T/bin/foundry-server"
dead=http://127.0.0.1:9
senv=(PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}"
  HTTP_PROXY=$dead HTTPS_PROXY=$dead ALL_PROXY=$dead http_proxy=$dead https_proxy=$dead all_proxy=$dead
  NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
  FOUNDRY_DB_PATH="$T/data/foundry.db" FOUNDRY_SECRET_KEY_PATH="$key" FOUNDRY_STATE_ROOT="$T/state"
  FOUNDRY_INTEGRATIONS=off FOUNDRY_HOST=127.0.0.1)
port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
env -i "${senv[@]}" PORT="$port" FOUNDRY_WEB_ORIGIN="http://127.0.0.1:$port" \
  "$T/bin/foundry-server" >>"$T/logs/server-init.log" 2>&1 </dev/null &
pid=$!
for _ in $(seq 1 120); do curl -sf -o /dev/null "http://127.0.0.1:$port/healthz" && break; sleep 0.5; done
kill "$pid"; wait "$pid" 2>/dev/null || true
node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))' >"$T/data/eval-user.password"
env -i "${senv[@]}" "$T/bin/foundry-server" users create --username pa1-eval --role admin \
  --display-name "PA1 Eval" --password-stdin <"$T/data/eval-user.password" >/dev/null
node "$here/pa-eval-seed.mjs" "$T/data/foundry.db" pa1-eval "$HOME/.foundry/pa-eval/set" \
  --profile "$PROFILE" --execution-default "api,$PROFILE,claude,$MODEL,$EFFORT" 2>&1 |
  grep -v -i "experimental\|trace-warnings" >"$T/logs/seed.json"
echo "pa-eval-stack: $T ready (seed summary in $T/logs/seed.json)"
