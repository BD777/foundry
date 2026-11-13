# Shared by scripts/remote-check.sh, scripts/remote-build.sh and scripts/remote-clean.sh:
# drive a compute lease on another device through the `foundry` CLI, mirror a working
# tree there, run jobs. Source it after setting `root` (this repo) and `scratch` (the
# device's one removable scratch root).
#
# Caller contract: rc_init <lease|device|resource> first; the EXIT trap releases the
# lease and removes the local temporary folder however the script ends.

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
rc_piece_bytes=$((512 * 1024))
rc_cli_timeout=${REMOTE_CLI_TIMEOUT:-2100}
rc_work="$(mktemp -d)"
rc_lease=""
rc_owner="$(printf '%s' "${FOUNDRY_SESSION_ID:-local}" | tr -c 'A-Za-z0-9_.-' '_')"
rc_job_id="${rc_owner}-$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM}"
rc_job="jobs/$rc_job_id"
rc_remote_repo="$rc_job/repo"
rc_slot=""
rc_job_cpus=""
rc_job_created=0
rc_keep_job="${REMOTE_KEEP_JOB:-0}"
rc_https_proxy="${REMOTE_HTTPS_PROXY:-}"
rc_name="${rc_name:-remote}"

die() { echo "$rc_name: $*" >&2; exit 1; }
log() { echo "$rc_name: $*" >&2; }

if [ -n "${FOUNDRY_CLI:-}" ]; then
  read -r -a rc_cli <<<"$FOUNDRY_CLI"
elif command -v foundry >/dev/null 2>&1; then
  rc_cli=(foundry)
elif [ -f "$root/packages/worker/dist/foundry-cli.js" ]; then
  rc_cli=(node "$root/packages/worker/dist/foundry-cli.js")
elif [ -f "$HOME/workspace/foundry/packages/worker/dist/foundry-cli.js" ]; then
  rc_cli=(node "$HOME/workspace/foundry/packages/worker/dist/foundry-cli.js")
else
  die "no foundry CLI: install the worker, build packages/worker, or set FOUNDRY_CLI"
fi
# Every CLI call is bounded: a call that never answers must not hold the lease forever.
cli() { timeout "$rc_cli_timeout" "${rc_cli[@]}" "$@"; }

# json <expression>: evaluates a JavaScript expression over the first JSON value on
# stdin (as v), ignoring notices the CLI prints after it.
json() { node -e '
  let s="";
  process.stdin.on("data",c=>s+=c).on("end",()=>{
    const start=s.search(/[\[{]/);
    let depth=0, quoted=false, escaped=false, end=-1;
    for(let i=start;i>=0&&i<s.length;i++){
      const ch=s[i];
      if(quoted){
        if(escaped) escaped=false;
        else if(ch==="\\") escaped=true;
        else if(ch==="\"") quoted=false;
        continue;
      }
      if(ch==="\"") quoted=true;
      else if(ch==="{"||ch==="[") depth++;
      else if((ch==="}"||ch==="]")&&--depth===0){end=i+1;break}
    }
    if(start<0||end<0) throw new Error("no JSON value in CLI output");
    const v=JSON.parse(s.slice(start,end));
    const r=eval(process.argv[1]);
    process.stdout.write(r===undefined||r===null?"":typeof r==="string"?r:JSON.stringify(r))
  })' "$1"; }

# operate <args JSON file> <op>: one compute operation; prints its result's text.
operate() {
  local answer
  answer="$(cli resource operate "$rc_lease" --op "$2" --args-file "$1")" || {
    echo "$2: the foundry CLI failed or timed out" >&2
    return 1
  }
  if [ "$(json 'String(v.results[0].ok)' <<<"$answer")" != true ]; then
    echo "$2 failed: $(json 'v.results[0].errorCode+": "+v.results[0].error' <<<"$answer")" >&2
    return 1
  fi
  json 'v.results[0].text' <<<"$answer"
}

# args <node expression of an object>: writes one operation's arguments (scratch added) to a file.
args() {
  local file="$rc_work/args.json"
  SCRATCH="${ARGS_SCRATCH:-$scratch}" node -e 'const o=eval("("+process.argv[1]+")");o.scratch??=process.env.SCRATCH;require("node:fs").writeFileSync(process.argv[2],JSON.stringify(o))' "$1" "$file"
  echo "$file"
}

# args_command <shell line> <timeout seconds>: JSON-encodes a command without putting
# its shell text through a JavaScript template literal.
args_command() {
  local file="$rc_work/command.json"
  SCRATCH="${ARGS_SCRATCH:-$scratch}" COMMAND="$1" TIMEOUT="$2" node -e '
    require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
      scratch: process.env.SCRATCH,
      command: process.env.COMMAND,
      timeoutSec: Number(process.env.TIMEOUT),
    }));
  ' "$file"
  echo "$file"
}

# run_shell <timeout seconds> <shell line>: runs a line in the scratch folder; prints stdout, fails on non-zero.
run_shell() {
  local result code file
  file="$(args_command "$2" "$1")"
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
    FILE="$1" OFFSET=$offset PIECE=$rc_piece_bytes SIZE=$size NAME=$name FORMAT="$2" DEST="$3" SCRATCH="$scratch" node -e '
      const fs = require("node:fs"), e = process.env, offset = +e.OFFSET, size = +e.SIZE;
      const fd = fs.openSync(e.FILE, "r"), piece = Buffer.alloc(Math.min(+e.PIECE, size - offset));
      fs.readSync(fd, piece, 0, piece.length, offset);
      fs.writeFileSync(process.argv[1], JSON.stringify({ scratch: e.SCRATCH, upload: e.NAME, offset,
        data: piece.toString("base64"), done: offset + piece.length >= size, format: e.FORMAT, dest: e.DEST }));' \
      "$rc_work/piece.json"
    operate "$rc_work/piece.json" put_files >/dev/null
    offset=$((offset + rc_piece_bytes))
    [ "$offset" -lt "$size" ] || break
  done
}

# get_piece <file on the device> <offset> <local file>: appends the next piece of the
# device's file to the local file; prints "<bytes> <more: true|false>". A server that
# cuts tool results to a model's text budget (before command tokens got whole
# results) cannot answer a large piece: then pieces shrink to what fits.
rc_get_bytes=$((4 * 1024 * 1024))
get_piece() {
  local answer
  [ ! -f "$rc_work/get.small" ] || rc_get_bytes=6000
  while :; do
    printf '{"scratch":"%s","path":"%s","offset":%s,"length":%s}' "$scratch" "$1" "$2" "$rc_get_bytes" >"$rc_work/get.json"
    answer="$(cli resource operate "$rc_lease" --op get_file --args-file "$rc_work/get.json")" || return 1
    if node -e 'const s=require("node:fs").readFileSync(0,"utf8");const v=JSON.parse(s.slice(s.indexOf("{"),s.lastIndexOf("}")+1));const r=v.results[0];if(!r.ok){console.error("get_file failed: "+r.errorCode+": "+r.error);process.exit(3)}const t=JSON.parse(r.text);require("node:fs").appendFileSync(process.argv[1],Buffer.from(t.data,"base64"));console.log(t.length+" "+Boolean(t.truncated))' "$3" <<<"$answer" 2>"$rc_work/get.err"; then
      return 0
    elif [ $? -eq 3 ] || [ "$rc_get_bytes" -le 6000 ]; then
      cat "$rc_work/get.err" >&2
      return 1
    fi
    rc_get_bytes=6000
    : >"$rc_work/get.small"
    log "the server cuts tool results; reading in ${rc_get_bytes}-byte pieces (slow; deploy a server with whole command-token results)"
  done
}

# download <file on the device> <local file>: fetches a whole file, pieces in parallel.
download() {
  node "$root/scripts/lib/remote-fetch.mjs" "$rc_lease" "$scratch" "$1" "$2"
}

# more_output <file on the device> <offset> <local log>: appends what the device's file
# has past offset to the local log; answers how many bytes that was.
more_output() {
  local piece
  piece="$(get_piece "$1" "$2" "$3" 2>/dev/null)" || { echo 0; return; }
  echo "${piece%% *}"
}

# The device user's login PATH (compute runs commands with a minimal PATH; pnpm and go
# often live only there). The scratch-local toolchain, when present, wins. Foundry's own
# session and lease variables are dropped: the Worker's tests read FOUNDRY_* and must see
# a plain shell, not the compute job's.
rc_setup='if command -v bash >/dev/null 2>&1; then p=$(bash -lc '"'"'printf %s "$PATH"'"'"' </dev/null 2>/dev/null); [ -n "$p" ] && PATH=$p && export PATH; fi
[ ! -f .toolchain/env.sh ] || . .toolchain/env.sh
for v in $(env | sed -n "s/^\(FOUNDRY_[A-Z0-9_]*\)=.*/\1/p"); do unset "$v"; done
export CI=1
[ -z "${RC_JOB_CPUS:-}" ] || export GOMAXPROCS="$RC_JOB_CPUS"
if [ -n "${RC_HTTPS_PROXY:-}" ]; then
  export HTTPS_PROXY="$RC_HTTPS_PROXY" HTTP_PROXY="$RC_HTTPS_PROXY"
  export https_proxy="$RC_HTTPS_PROXY" http_proxy="$RC_HTTPS_PROXY"
fi
export FOUNDRY_LOCK_DISABLE=1'

# job <name> <timeout seconds> <shell line> <local log> [quiet]: runs a line in the
# background on the device (stopped if the lease ends); appends its output to the local
# log, echoing new output to stderr unless quiet; answers its exit status (124 past the
# timeout, 125 when the device stopped it).
job() {
  local out="$rc_job/run/$1.log" status="$rc_job/run/$1.status" pidfile="$rc_job/run/$1.pid" offset=0 count exit_code file alive before
  file="$(RC_REPO="$rc_remote_repo" RC_JOB="$rc_job" RC_JOB_CPUS="$rc_job_cpus" RC_HTTPS_PROXY="$rc_https_proxy" LINE="$3" OUT="$out" STATUS="$status" PIDFILE="$pidfile" SETUP="$rc_setup" args '{command: `mkdir -p "$(dirname "$JOB_OUT")"; rm -f "$JOB_OUT" "$JOB_STATUS" "$JOB_PID"; nohup sh -c '"'"'(eval "$JOB_SETUP"; eval "$JOB_LINE"); echo $? > "$JOB_STATUS"'"'"' > "$JOB_OUT" 2>&1 < /dev/null & echo $! > "$JOB_PID"`, env: {JOB_SETUP: process.env.SETUP, JOB_LINE: process.env.LINE, JOB_OUT: process.env.OUT, JOB_STATUS: process.env.STATUS, JOB_PID: process.env.PIDFILE, RC_REPO: process.env.RC_REPO, RC_JOB: process.env.RC_JOB, RC_JOB_CPUS: process.env.RC_JOB_CPUS, RC_HTTPS_PROXY: process.env.RC_HTTPS_PROXY}, timeoutSec: 60}')"
  operate "$file" run >/dev/null || return 125
  local deadline=$(($(date +%s) + $2))
  while :; do
    before=$(wc -c <"$4" | tr -d ' ')
    count="$(more_output "$out" "$offset" "$4")"
    offset=$((offset + count))
    [ "${5:-}" = quiet ] || [ "$count" -eq 0 ] || tail -c +"$((before + 1))" "$4" >&2
    [ "$count" -eq 0 ] || continue
    exit_code="$(run_shell 30 "cat $status 2>/dev/null || true" 2>/dev/null)" || exit_code=""
    if [ -n "$exit_code" ]; then
      before=$(wc -c <"$4" | tr -d ' ')
      more_output "$out" "$offset" "$4" >/dev/null
      [ "${5:-}" = quiet ] || tail -c +"$((before + 1))" "$4" >&2
      return "$exit_code"
    fi
    alive="$(run_shell 30 "kill -0 \$(cat $pidfile 2>/dev/null) 2>/dev/null && echo yes || echo no" 2>/dev/null || echo unknown)"
    if [ "$alive" = no ] && [ -z "$(run_shell 30 "cat $status 2>/dev/null || true" 2>/dev/null)" ]; then
      more_output "$out" "$offset" "$4" >/dev/null
      log "$1 was stopped on the device before it finished (its worker restarted, or the lease ended or was handed to a waiting session)"
      return 125
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      run_shell 30 "kill -TERM -\$(cat $pidfile) 2>/dev/null || kill -TERM \$(cat $pidfile) 2>/dev/null; true" >/dev/null 2>&1 || true
      log "$1 ran past ${2}s and was stopped"
      return 124
    fi
    sleep 3
  done
}

# rc_bootstrap <local log>: install only missing or too-old Node/Go/pnpm into the
# scratch root and point every cache there too. Nothing is installed system-wide.
rc_bootstrap() {
  local log_file="$1" status
  local line='set -eu
ROOT="$PWD"
TOOLCHAIN="$ROOT/.toolchain"
CACHE="$ROOT/.cache"
mkdir -p "$TOOLCHAIN" "$CACHE/go-build" "$CACHE/go-mod" "$CACHE/gopath" \
  "$CACHE/npm" "$CACHE/pnpm-store" "$CACHE/corepack" "$CACHE/config" "$CACHE/data" "$CACHE/state"
BOOTSTRAP_LOCK="$TOOLCHAIN/.bootstrap-lock"
tries=0
while ! mkdir "$BOOTSTRAP_LOCK" 2>/dev/null; do
  find "$BOOTSTRAP_LOCK" -maxdepth 0 -mmin +30 -exec rm -rf {} + 2>/dev/null || true
  tries=$((tries + 1))
  [ "$tries" -lt 900 ] || { echo "toolchain bootstrap lock is stuck" >&2; exit 1; }
  sleep 2
done
trap "rm -rf \"$BOOTSTRAP_LOCK\"" EXIT
export PNPM_HOME="$TOOLCHAIN/pnpm"
export npm_config_store_dir="$CACHE/pnpm-store"
export npm_config_cache="$CACHE/npm"
export COREPACK_HOME="$CACHE/corepack"
export XDG_CACHE_HOME="$CACHE"
export XDG_CONFIG_HOME="$CACHE/config"
export XDG_DATA_HOME="$CACHE/data"
export XDG_STATE_HOME="$CACHE/state"
export GOCACHE="$CACHE/go-build"
export GOMODCACHE="$CACHE/go-mod"
export GOPATH="$CACHE/gopath"
export GOTOOLCHAIN=local
export GOTELEMETRY=off

version_ge() {
  node -e '"'"'
    const parse = (s) => String(s).replace(/^go/, "").split(".").map(Number);
    const [want, got] = process.argv.slice(1).map(parse);
    for (let i = 0; i < Math.max(want.length, got.length); i++) {
      const a = want[i] || 0, b = got[i] || 0;
      if (b > a) process.exit(0);
      if (b < a) process.exit(1);
    }
    process.exit(0);
  '"'"' "$1" "$2"
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    command -v npm >/dev/null 2>&1 &&
    version_ge 22 "$(node -p "process.versions.node")"
}

go_need="$(sed -n "s/^go //p" "$RC_REPO/apps/server/go.mod" 2>/dev/null | head -1)"
[ -n "$go_need" ] || go_need=1.24.0
go_ok() {
  command -v go >/dev/null 2>&1 &&
    version_ge "$go_need" "$(go env GOVERSION 2>/dev/null || go version | sed -E "s/^go version go([^ ]+).*/\1/")"
}

pnpm_need="$(sed -n "s/.*\"packageManager\": \"pnpm@\([^\"]*\)\".*/\1/p" "$RC_REPO/package.json" 2>/dev/null | head -1)"
[ -n "$pnpm_need" ] || pnpm_need=11.7.0
pnpm_ok() {
  command -v pnpm >/dev/null 2>&1 &&
    version_ge "$pnpm_need" "$(pnpm --version 2>/dev/null)"
}

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    echo "neither curl nor wget is available for scratch toolchain bootstrap" >&2
    exit 1
  fi
}

if ! node_ok; then
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) node_arch=darwin-arm64 ;;
    Darwin:x86_64) node_arch=darwin-x64 ;;
    Linux:x86_64) node_arch=linux-x64 ;;
    Linux:aarch64|Linux:arm64) node_arch=linux-arm64 ;;
    *) echo "unsupported Node bootstrap platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  node_version="${REMOTE_NODE_VERSION:-22.20.0}"
  echo "bootstrapping Node $node_version in $TOOLCHAIN"
  rm -rf "$TOOLCHAIN/node" "$TOOLCHAIN/node-v$node_version-$node_arch"
  fetch "https://nodejs.org/dist/v$node_version/node-v$node_version-$node_arch.tar.gz" |
    tar -xzf - -C "$TOOLCHAIN"
  mv "$TOOLCHAIN/node-v$node_version-$node_arch" "$TOOLCHAIN/node"
fi
[ ! -x "$TOOLCHAIN/node/bin/node" ] || PATH="$TOOLCHAIN/node/bin:$PATH"

if ! go_ok; then
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) go_arch=darwin-arm64 ;;
    Darwin:x86_64) go_arch=darwin-amd64 ;;
    Linux:x86_64) go_arch=linux-amd64 ;;
    Linux:aarch64|Linux:arm64) go_arch=linux-arm64 ;;
    *) echo "unsupported Go bootstrap platform: $(uname -s) $(uname -m)" >&2; exit 1 ;;
  esac
  echo "bootstrapping Go $go_need in $TOOLCHAIN"
  rm -rf "$TOOLCHAIN/go"
  fetch "https://go.dev/dl/go$go_need.$go_arch.tar.gz" | tar -xzf - -C "$TOOLCHAIN"
fi
[ ! -x "$TOOLCHAIN/go/bin/go" ] || PATH="$TOOLCHAIN/go/bin:$PATH"

if ! pnpm_ok; then
  echo "bootstrapping pnpm $pnpm_need in $TOOLCHAIN"
  rm -rf "$TOOLCHAIN/pnpm"
  npm install --global --prefix "$TOOLCHAIN/pnpm" "pnpm@$pnpm_need"
fi
[ ! -x "$TOOLCHAIN/pnpm/bin/pnpm" ] || PATH="$TOOLCHAIN/pnpm/bin:$PATH"
export PATH

cat >"$TOOLCHAIN/env.sh" <<EOF
export PATH="$TOOLCHAIN/node/bin:$TOOLCHAIN/go/bin:$TOOLCHAIN/pnpm/bin:\$PATH"
export PNPM_HOME="$TOOLCHAIN/pnpm"
export npm_config_store_dir="$CACHE/pnpm-store"
export npm_config_cache="$CACHE/npm"
export COREPACK_HOME="$CACHE/corepack"
export XDG_CACHE_HOME="$CACHE"
export XDG_CONFIG_HOME="$CACHE/config"
export XDG_DATA_HOME="$CACHE/data"
export XDG_STATE_HOME="$CACHE/state"
export GOCACHE="$CACHE/go-build"
export GOMODCACHE="$CACHE/go-mod"
export GOPATH="$CACHE/gopath"
export GOTOOLCHAIN=local
export GOTELEMETRY=off
EOF
node -p "process.versions.node"
go env GOVERSION
pnpm --version'
  set +e
  job bootstrap 1800 "$line" "$log_file" quiet
  status=$?
  set -e
  [ "$status" -eq 0 ] || {
    tail -50 "$log_file" >&2
    die "scratch toolchain bootstrap failed (log: $log_file)"
  }
  log "toolchain ready: $(tail -3 "$log_file" | tr '\n' ' ')"
}

# rc_slot_acquire: take one of the runner's CPU/memory-sized job slots. This is a
# counting semaphore, not a device lock: byte-dev gets 16, byte-dev-sg 3 and a
# 10-CPU/16-GiB Mac mini 4 from the same formula.
rc_slot_acquire() {
  local line='set -eu
mkdir -p .slots
cpus="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
if [ -r /proc/meminfo ]; then
  mem_gib="$(awk '"'"'/MemTotal/{print int($2/1048576)}'"'"' /proc/meminfo)"
elif command -v sysctl >/dev/null 2>&1; then
  mem_gib="$(( $(sysctl -n hw.memsize) / 1073741824 ))"
else
  mem_gib=8
fi
cpu_slots=$(( cpus / 2 ))
mem_slots=$(( mem_gib / 4 ))
slots=$cpu_slots
[ "$mem_slots" -lt "$slots" ] && slots=$mem_slots
[ "$slots" -ge 1 ] || slots=1
[ "$slots" -le 16 ] || slots=16
tries=0
while :; do
  if [ -e .cleanup ] && find .cleanup -maxdepth 0 -mmin +5 | grep -q .; then
    rm -rf .cleanup
  fi
  if [ -e .cleanup ]; then
    tries=$((tries + 1))
    [ "$tries" -lt 450 ] || { echo "remote scratch cleanup is stuck" >&2; exit 1; }
    sleep 1
    continue
  fi
  for existing in .slots/*; do
    [ -d "$existing" ] || continue
    owner_pid="$(cat "$existing/pid" 2>/dev/null || true)"
    if [ -n "$owner_pid" ] && ! kill -0 "$owner_pid" 2>/dev/null; then
      rm -rf "$existing"
    elif [ -z "$owner_pid" ] && find "$existing" -maxdepth 0 -mmin +1 | grep -q .; then
      rm -rf "$existing"
    fi
  done
  for slot in $(seq 1 "$slots"); do
    if mkdir ".slots/$slot" 2>/dev/null; then
      nohup sh -c "sleep 2100" >/dev/null 2>&1 &
      echo "$!" > ".slots/$slot/pid"
      echo __RC_JOB__ > ".slots/$slot/job"
      echo "slot=$slot slots=$slots cpus=$cpus memGiB=$mem_gib"
      exit 0
    fi
  done
  tries=$((tries + 1))
  [ "$tries" -lt 450 ] || { echo "all $slots remote job slots stayed busy" >&2; exit 1; }
  [ "$tries" -ne 1 ] || echo "waiting for one of $slots remote job slots" >&2
  sleep 2
done'
  line="${line//__RC_JOB__/$(printf '%q' "$rc_job")}"
  local result
  result="$(run_shell 1000 "$line")" || die "could not acquire a remote job slot"
  rc_slot="$(sed -n 's/.*slot=\([0-9][0-9]*\).*/\1/p' <<<"$result" | tail -1)"
  [ -n "$rc_slot" ] || die "remote job slot answer was unreadable: $result"
  local slots cpus
  slots="$(sed -n 's/.*slots=\([0-9][0-9]*\).*/\1/p' <<<"$result" | tail -1)"
  cpus="$(sed -n 's/.*cpus=\([0-9][0-9]*\).*/\1/p' <<<"$result" | tail -1)"
  rc_job_cpus=$(( (${cpus:-1} + ${slots:-1} - 1) / ${slots:-1} ))
  [ "$rc_job_cpus" -ge 1 ] || rc_job_cpus=1
  log "remote job slot $rc_slot: ${result#*slot=}"
}

rc_cleanup() {
  if [ -n "$rc_slot" ] && [ -n "$rc_lease" ]; then
    run_shell 30 "kill \$(cat '.slots/$rc_slot/pid' 2>/dev/null) 2>/dev/null || true; rm -rf '.slots/$rc_slot'" >/dev/null 2>&1 || true
  fi
  if [ "${rc_job_created:-0}" = 1 ] && [ "${rc_keep_job:-0}" != 1 ] && [ -n "$rc_lease" ]; then
    local file
    file="$(args "{path: '$rc_job'}")"
    operate "$file" cleanup >/dev/null 2>&1 || true
  fi
  if [ -n "$rc_lease" ]; then
    if [ "${REMOTE_KEEP_LEASE:-0}" = 1 ]; then
      log "kept $rc_lease for the rest of this concurrent batch"
    else
      cli resource release "$rc_lease" >/dev/null 2>&1 &&
        log "released $rc_lease" ||
        log "could not release $rc_lease (it ends at its hold deadline; release_resource it)"
    fi
  fi
  rm -rf "$rc_work"
}
trap rc_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

rc_canonical_device() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    mac | mac-mini | canwendemac-mini) echo CanWendeMac-mini ;;
    byte-dev) echo byte-dev ;;
    byte-dev-sg) echo byte-dev-sg ;;
    *) echo "$1" ;;
  esac
}

# rc_device_record <listing> <device label or id>: prints "<online|offline> <label> <deviceId> <resourceId> <state>".
rc_device_record() {
  DEVICE="$2" json '
    const devices = Array.isArray(v) ? v : (v.devices ?? []);
    const wanted = process.env.DEVICE.toLowerCase();
    const d = devices.find((item) =>
      String(item.deviceId).toLowerCase() === wanted ||
      String(item.deviceLabel).toLowerCase() === wanted);
    if (!d) process.exit(2);
    const r = (d.instances ?? []).find((item) => item.type === "compute");
    if (!r) process.exit(3);
    const online = d.online !== false && r.state !== "offline";
    console.log(`${online ? "online" : "offline"} ${d.deviceLabel} ${d.deviceId} ${r.id} ${r.state ?? "unknown"}`);
  ' <<<"$1"
}

rc_acquire_resource() {
  local resource="$1" label="$2" acquired wait_ms hold_s
  local -a args
  wait_ms="${REMOTE_LEASE_WAIT_MS:-600000}"
  hold_s="${REMOTE_LEASE_HOLD_SECONDS:-3600}"
  local mode="${REMOTE_LEASE_MODE-shared}"
  args=(resource acquire --resource "$resource" \
    --reason "$rc_name of $(basename "$root")" --wait-ms "$wait_ms" --hold-for "$hold_s")
  [ -z "$mode" ] || args+=(--mode "$mode")
  acquired="$(rc_cli_timeout=660 cli "${args[@]}")" ||
    die "could not lease $label's compute (offline, busy with no slot, or remote commands off)"
  rc_lease="$(json 'v.lease?.id' <<<"$acquired")"
  [ -n "$rc_lease" ] || die "$label's compute is still waiting after ${wait_ms}ms: $(json 'v.message ?? v.status ?? JSON.stringify(v)' <<<"$acquired")"
  rc_selected_device="$label"
  log "leased $label's compute ($rc_lease)"
}

# rc_detect_proxy: an explicit REMOTE_HTTPS_PROXY wins. Otherwise, use byte-dev's local
# relay only when it actually reaches the proxy.golang.org endpoint.
rc_detect_proxy() {
  [ -z "$rc_https_proxy" ] || {
    log "using configured HTTPS proxy $rc_https_proxy"
    return
  }
  local answer
  answer="$(run_shell 12 "if command -v curl >/dev/null 2>&1 && curl -fsSI --max-time 5 --proxy http://127.0.0.1:12263 https://proxy.golang.org/ >/dev/null 2>&1; then echo yes; else echo no; fi")" ||
    answer=no
  if [ "$answer" = yes ]; then
    rc_https_proxy="http://127.0.0.1:12263"
    log "using detected runner HTTPS proxy $rc_https_proxy"
  fi
}

# rc_init_exact <lease|device|resource>: never substitutes another runner.
rc_init_exact() {
  local target="$1" listing record online label resource
  if [[ "$target" == lease_* ]]; then
    [ -n "${FOUNDRY_LEASE_TOKEN:-}${FOUNDRY_SESSION_TOKEN:-}" ] ||
      die "FOUNDRY_LEASE_TOKEN is not set: pass the commandToken acquire_resource answered with forCommands for $target"
    rc_lease="$target"
    cli resource status --lease "$rc_lease" >/dev/null ||
      die "cannot use lease $rc_lease with this token (ended, or not a lease the session handed over?)"
    rc_selected_device="$rc_lease"
    log "using lease $rc_lease"
    return
  fi
  [ -n "${FOUNDRY_SESSION_TOKEN:-}" ] ||
    die "no FOUNDRY_SESSION_TOKEN (Claude Code and Codex commands never have one): acquire_resource {resourceId, forCommands: true, holdFor: 3600}, then FOUNDRY_LEASE_TOKEN=<commandToken> $0 <leaseId> …"
  if [[ "$target" == res_* ]]; then
    rc_acquire_resource "$target" "$target"
    return
  fi
  listing="$(cli device list --type compute)" || die "could not list compute devices"
  record="$(rc_device_record "$listing" "$target")" ||
    die "no compute resource for $target (try --device mac|byte-dev|byte-dev-sg)"
  read -r online label _ resource _ <<<"$record"
  [ "$online" = online ] || die "$label is offline"
  rc_acquire_resource "$resource" "$label"
}

# rc_init <lease|device|resource>: a device alias falls back in runner order when its
# preferred compute is offline. An explicit resource id and lease never fall back.
rc_init() {
  local target="$1" preferred listing record online label resource candidate
  local -a order candidates
  if [[ "$target" == lease_* || "$target" == res_* || "$target" == dev_* ]]; then
    rc_init_exact "$target"
    return
  fi
  [ -n "${FOUNDRY_SESSION_TOKEN:-}" ] ||
    die "runner fallback needs a device-list credential; pass a compute lease from acquire_resource as <leaseId> with FOUNDRY_LEASE_TOKEN"
  preferred="$(rc_canonical_device "$target")"
  order=(CanWendeMac-mini byte-dev byte-dev-sg)
  candidates=()
  for candidate in "$preferred" "${order[@]}"; do
    case " ${candidates[*]-} " in *" $candidate "*) ;; *) candidates+=("$candidate") ;; esac
  done
  listing="$(cli device list --type compute)" || die "could not list compute devices"
  for candidate in "${candidates[@]}"; do
    record="$(rc_device_record "$listing" "$candidate" 2>/dev/null)" || continue
    read -r online label _ resource _ <<<"$record"
    [ "$online" = online ] || continue
    if [ "$label" != "$preferred" ]; then
      log "$preferred is offline; falling back to $label"
    fi
    if [ "${REMOTE_DRY_RUN:-0}" = 1 ]; then
      printf 'runner=%s device=%s resource=%s preferred=%s fallback=%s\n' \
        "$label" "$(awk '{print $3}' <<<"$record")" "$resource" "$preferred" \
        "$([ "$label" = "$preferred" ] && echo no || echo yes)"
      exit 0
    fi
    rc_acquire_resource "$resource" "$label"
    return
  done
  die "no online compute runner in order: ${candidates[*]}"
}

# rc_remote_url: origin as https (the device clones from GitHub, not from this host).
rc_remote_url() {
  local remote="${REMOTE_CHECK_REMOTE:-$(git -C "$root" remote get-url origin)}"
  case "$remote" in
    git@*:*) remote="${remote#git@}"; remote="https://${remote/://}" ;;
    ssh://git@*) remote="https://${remote#ssh://git@}" ;;
  esac
  echo "${remote%.git}.git"
}

# rc_snapshot <tree> <base>: writes $rc_work/changes.diff, the whole difference between
# commit <base> and the files in <tree> (tracked, staged, unstaged and untracked alike;
# .gitignore applies; node_modules links never count). <tree> may be a worktree of this
# repo or any plain folder holding a copy of it. Git writes only to temporary files: a
# private index, and an object folder that borrows this repo's objects.
rc_snapshot() {
  local tree base gitdir objects
  tree="$(cd "$1" && pwd)"
  base="$2"
  gitdir="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)"
  objects="$gitdir/objects"
  mkdir -p "$rc_work/objects"
  (
    export GIT_DIR="$gitdir" GIT_WORK_TREE="$tree" GIT_INDEX_FILE="$rc_work/index"
    export GIT_OBJECT_DIRECTORY="$rc_work/objects" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"
    cd "$tree"
    git read-tree "$base"
    git add -A -- . ':(exclude,glob)**/node_modules' ':(exclude,glob)**/node_modules/**'
    git diff --cached --binary --no-renames "$base" >"$rc_work/changes.diff"
    git diff --cached --stat "$base" | tail -1 >&2
  )
}

# rc_sync <tree> <base>: the device's persistent checkout (scratch/repo) at <base> with the
# tree's changes applied. Ignored files there (node_modules, Go caches live outside) stay.
rc_sync() {
  local archive="$rc_work/source-$2.tar.gz" remote_archive="cache/sources/$2.tar.gz"
  local upload_name="cache/sources/.$2.$$.tar.gz" result code changes="$rc_job/changes.diff.gz"
  rc_job_created=1
  rc_snapshot "$1" "$2"
  log "base $2; diff $(wc -c <"$rc_work/changes.diff" | tr -d ' ') bytes"
  git -C "$root" archive --format=tar.gz -1 "$2" >"$archive" ||
    die "could not archive base $2"
  if [ "$(run_shell 30 "test -f '$remote_archive' && echo yes || echo no")" != yes ]; then
    log "uploading base archive $(wc -c <"$archive" | tr -d ' ') bytes to the shared runner cache"
    run_shell 30 'mkdir -p cache/sources' >/dev/null
    upload "$archive" file "$upload_name"
    run_shell 30 "if [ -f '$remote_archive' ]; then rm -f '$upload_name'; else mv '$upload_name' '$remote_archive'; fi" >/dev/null ||
      die "could not install the shared base archive"
  fi
  run_shell 60 "mkdir -p '$rc_job/run'" >/dev/null
  result="$(run_shell 300 "mkdir -p '$rc_remote_repo' && tar -xzf '$remote_archive' -C '$rc_remote_repo'")" ||
    die "could not extract base $2 into $rc_remote_repo"
  if [ -s "$rc_work/changes.diff" ]; then
    gzip -c "$rc_work/changes.diff" >"$rc_work/changes.diff.gz"
    upload "$rc_work/changes.diff.gz" file "$changes"
    run_shell 120 "cd '$rc_remote_repo' && gunzip -c '../changes.diff.gz' | git apply --binary --whitespace=nowarn" >/dev/null ||
      die "the diff did not apply at $2"
  fi
  log "job checkout at $2 from shared archive: $rc_remote_repo"
}

# rc_deps <local log>: dependencies (again only when the lockfiles change), then the
# protocol build every package reads.
rc_deps() {
  local line='cd "$RC_REPO" && want="$(cat pnpm-lock.yaml apps/server/go.sum 2>/dev/null | (shasum -a 256 2>/dev/null || sha256sum) | cut -c1-64)" &&
deps_stamp="../deps.sha256"
if [ "$(cat "$deps_stamp" 2>/dev/null)" != "$want" ]; then
  pnpm install --frozen-lockfile && (cd apps/server && go mod download) && echo "$want" > "$deps_stamp"
fi && pnpm --filter @bd777/foundry-protocol build'
  job deps 1800 "$line" "$1" quiet || { tail -40 "$1" >&2; die "installing dependencies failed (log: $1)"; }
}

# rc_default_base <tree>: a commit the device can fetch for the tree: its HEAD when that
# is on a remote branch, else where it left origin/main; origin/main for a plain folder.
rc_default_base() {
  if git -C "$1" rev-parse --git-dir >/dev/null 2>&1 &&
    [ "$(git -C "$1" rev-parse --show-toplevel)" = "$(cd "$1" && pwd -P)" ]; then
    if [ -n "$(git -C "$1" branch -r --contains HEAD 2>/dev/null)" ]; then
      git -C "$1" rev-parse HEAD
    else
      git -C "$1" merge-base HEAD origin/main
    fi
  else
    git -C "$root" rev-parse origin/main
  fi
}
