#!/usr/bin/env bash
# Exercise alias parsing and offline fallback for both remote entry points. The fixture
# mirrors the live runner order at the time of the fix: Mac mini offline, byte-dev online.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fake="$tmp/foundry"
cat >"$fake" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = device ] && [ "${2:-}" = list ]; then
  cat <<'JSON'
[
  {
    "deviceId": "dev_mac",
    "deviceLabel": "CanWendeMac-mini",
    "online": false,
    "instances": [{"id": "res_mac", "type": "compute", "state": "offline"}]
  },
  {
    "deviceId": "dev_byte",
    "deviceLabel": "byte-dev",
    "online": true,
    "instances": [{"id": "res_byte", "type": "compute", "state": "busy"}]
  },
  {
    "deviceId": "dev_byte_sg",
    "deviceLabel": "byte-dev-sg",
    "online": true,
    "instances": [{"id": "res_byte_sg", "type": "compute", "state": "available"}]
  }
]
JSON
  exit 0
fi
echo "unexpected fake foundry invocation: $*" >&2
exit 99
EOF
chmod +x "$fake"

common=(FOUNDRY_CLI="$fake" FOUNDRY_SESSION_TOKEN=test REMOTE_DRY_RUN=1)
check="$(env "${common[@]}" "$root/scripts/remote-check.sh" --device mac --sh true)"
grep -q '^runner=byte-dev device=dev_byte resource=res_byte preferred=CanWendeMac-mini fallback=yes$' <<<"$check"

build="$(env "${common[@]}" "$root/scripts/remote-build.sh" --device mac --out "$tmp/build" --server)"
grep -q '^runner=byte-dev device=dev_byte resource=res_byte preferred=CanWendeMac-mini fallback=yes$' <<<"$build"
echo "remote-runner-fallback: PASS (Mac mini offline -> byte-dev for check and build)"
