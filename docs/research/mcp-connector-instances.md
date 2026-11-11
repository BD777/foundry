# MCP management for server-held connector instances

## Decision

Add one Foundry MCP tool, `connector_instances`, whose `action` selects
`list`, `probe`, `create`, `update`, `check`, `revoke`, `bind_workspace`, or
`unbind_workspace`. It operates on the same server-held extension instances
as the existing person-only management API, but does not make those REST
routes reachable by session tokens.

The public tool schema accepts only secret references:

```json
{
  "secretFiles": {
    "readToken": { "path": "/home/alice/acme/.env", "key": "ACME_TOKEN" }
  }
}
```

`path` may be absolute, start with `~`, or be relative to the calling
session's workspace. `key` is optional; without it the trimmed file is the
secret. With it, the Worker reads a dotenv assignment. The public arguments
never contain the secret value.

## Worker interception

Both native HTTP MCP clients use `startServerMcpForwarder`: Claude receives
the loopback URL and Codex resolves the server URL through `serverMcpURL`.
The forwarder therefore buffers MCP JSON-RPC requests for `tools/call` named
`connector_instances` before forwarding.

For that call only, the Worker:

1. Finds the session by the bearer token and requires an active session whose
   device is this Worker and whose session kind permits connector file reads.
2. Resolves `secretFiles`; relative paths use that session's workspace.
3. Applies the device-file path rules, including denied credential stores,
   regular-file checks, realpath checks, and a bounded read.
4. Reads either the whole file or one dotenv key. Errors name the path or key
   but never include file content.
5. Deletes `secretFiles`, places resolved values in an internal
   `secretValues` argument object, and adds
   `X-Foundry-MCP-Secret-Proxy: connector-instances-v1`.
6. Recalculates `Content-Length` and forwards the request.

A missing file, missing variable, malformed dotenv input, or unavailable
session is answered locally as an MCP tool error without reaching the Server.
Secret values are registered with the Worker's redactor, are never logged,
and are not retained on disk.

## Server boundary

The Server accepts `secretValues` only on `connector_instances` calls carrying
the proxy marker. Unresolved `secretFiles` are rejected with a clear message.
Secret-typed descriptor fields are removed from ordinary `fields` before the
service call; only the proxy-provided `secretValues` can supply them. Thus
the tool's model-facing argument shape cannot carry plaintext secrets.

The Server resolves the authenticated session and allows the tool only when:

- the actor is an agent session, not a person or device credential;
- the session has a person creator and that person owns the device;
- the session is not an Issue execution, clarification, verifier, or utility
  session;
- the requested workspace is managed by that person for binding operations.

For the person's assistant, `permission.Resolve` applies the current package:
listing requires ordinary connector access, reads filter instances denied by
the package, and every mutation or binding requires write access. Other
sessions retain the existing person-owned account rules.

## Results and audit

`list` returns only the fields shown in the Web instance list: ids, label,
network/status, access, version, route count, base URL, availability, and
timestamps. It never returns secret values, sealed blobs, or secret metadata
beyond field ids already needed by the form.

Every MCP action writes a session audit event containing only the action,
connector kind, instance id when present, and success/failure. The existing
account audit events remain in place. All returned/error text is checked
against the resolved values and redacted before it can reach the tool result.

## Verification

- Go: non-owner and Issue session refusal; create and probe through MCP;
  assistant read/write package enforcement; concise list shape; no secret in
  responses or audit.
- Worker: dotenv and whole-file lookup; missing file/key errors; proxy body
  replacement; no secret in logs or returned errors.
- Foundry skill copies remain byte-identical and keep the existing revision.
