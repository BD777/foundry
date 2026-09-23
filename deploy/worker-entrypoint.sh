#!/bin/sh
# foundry-worker container entrypoint.
# Required environment:
#   FOUNDRY_SERVER_URL  e.g. http://foundry-server:31982
#   FOUNDRY_WORKSPACE   e.g. /workspace/default
# First start only:
#   FOUNDRY_PAIRING_TOKEN  one-time token from Devices → Add device (or
#                          `foundry-server devices pairing-token`); the device
#                          credential is then kept in the worker home volume.
set -eu

: "${FOUNDRY_SERVER_URL:?FOUNDRY_SERVER_URL is required}"
: "${FOUNDRY_WORKSPACE:?FOUNDRY_WORKSPACE is required}"

WORKER_JS="/opt/worker/dist/cli.js"

# `init` is idempotent: it preserves an existing .foundry/workspace.json and
# only creates missing directories/files.
node "$WORKER_JS" init "$FOUNDRY_WORKSPACE"

# `pair` redeems FOUNDRY_PAIRING_TOKEN only while this worker is unpaired and
# otherwise keeps the saved credential, so restarts never reuse the token.
node "$WORKER_JS" pair \
  --server "$FOUNDRY_SERVER_URL" \
  --workspace "$FOUNDRY_WORKSPACE"

# `daemon` (alias of `connect`) runs in the foreground and reconnects to the
# server's WebSocket indefinitely, so Docker's restart policy is the supervisor.
exec node "$WORKER_JS" daemon \
  --server "$FOUNDRY_SERVER_URL" \
  --workspace "$FOUNDRY_WORKSPACE"
