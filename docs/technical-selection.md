# Foundry Technical Architecture

This page records the architecture and technology choices Foundry is built on.
What is and is not implemented today is tracked in
[current status](current-status.md); the target shape is described in the
[Workspace and Sandbox overview](workspace-sandbox-overview.md).

## 1. Architecture

Foundry is a **local-first workspace with a thin web control plane**. The
execution boundary is the user's paired device, not the web server.

```text
React Web UI  (apps/web)
  -> HTTP + SSE
Go Foundry Server  (apps/server)
  <- outbound WebSocket (HTTP polling fallback)
Local Foundry Worker Daemon  (packages/worker)
  -> local filesystem workspace
  -> local credentials and native CLI logins
  -> Claude Agent SDK / Codex SDK (CLI fallback)
```

- The browser provides the product surface.
- The server coordinates accounts, devices, workspace membership, sessions,
  messages, the Feishu bot and state projection.
- The worker daemon owns execution, filesystem access, provider SDK calls,
  credentials, Issue environments and evidence collection.
- `packages/protocol` is the shared TypeScript contract for web and worker.

## 2. Hard Boundary: Server Must Not Run User Workers

The Foundry server must not take user Claude/Codex credentials and run agent
runtimes on the user's behalf.

Reasons:

- User environments vary widely.
- Codebases, dependencies, simulators, dev servers, and local credentials are machine-specific.
- Provider authorization should remain in the user's local trust boundary.
- The workspace itself is local-first and filesystem-backed.

The server may know:

- a workspace exists and which device hosts it,
- which agent profiles and providers are available on that device,
- whether a provider login is present,
- read-only file content explicitly requested through the daemon,
- session, Issue and run status, event summaries, and evidence metadata.

The server must not know:

- device-local provider secrets, environment variables or custom commands,
- raw local credential files or official OAuth credentials,
- full local filesystem content by default,
- enough information to run Claude/Codex remotely as the user.

One explicit exception: a server-owned profile for a remote API endpoint may
submit an `apiKey` write-only; the server seals it in its encrypted secret
store and never returns it. See [security](security.md#secret-store).

## 3. Components

### 3.1 Web UI

Stack:

- React 19, Vite, TypeScript
- Tailwind CSS with Foundry-owned design tokens
- Radix primitives under a small shadcn-style local component layer
  (`apps/web/src/components/ui`)
- Streamdown for Markdown rendering

Routing is a small app-owned browser router (`apps/web/src/app/navigation.ts`);
server state arrives through one projection endpoint plus SSE
(`apps/web/src/app/use-foundry-live-data.ts`). No client router or query
library is used. Radix owns accessibility and interaction semantics; the design
tokens own the visual system. Feature and component boundaries are described in
[Web architecture](../apps/web/src/ARCHITECTURE.md).

Why React:

- Strong ecosystem for dashboards, event streams, diff/review surfaces, logs, and complex async state.
- Good fit for future desktop/mobile wrapper paths.
- Familiar integration with Vite and TypeScript.

### 3.2 Go Server

Stack:

- Go (`net/http`), started with `go run ./cmd/foundry-server`
- SSE for web updates; `gorilla/websocket` for the daemon connection
- SQLite (`modernc.org/sqlite`, pure Go) behind the `store.Store` interface
- the Feishu Open Platform SDK for the long-connection bot

Why Go:

- Excellent long-connection and concurrency support.
- Good fit for device heartbeat, job dispatch, event fanout, and state projection.
- Easy to package as a single small server.

The server owns:

- accounts, sessions, invites and workspace roles,
- device pairing and per-device credentials,
- workspace registry projection and the daemon connection registry,
- job/control message relay and agent session projection,
- read-only local file request relay,
- event fanout to web clients,
- the sealed secret store for remote-endpoint profiles,
- the promoted skill catalog,
- the HTTP MCP endpoint for session orchestration,
- the per-workspace Feishu bot.

The server does not own:

- device-local provider secrets,
- workspace file execution,
- Claude/Codex SDK execution,
- local preview or simulator processes,
- local worktree mutation.

### 3.3 Local Foundry Worker Daemon

Stack:

- TypeScript on Node.js (`engines: >=20`; CI runs Node 22)
- `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk`
- binaries `foundry-worker` (daemon and workspace CLI) and `foundry`
  (agent-facing session orchestration CLI / stdio MCP)

Main commands (`packages/worker/src/cli-contract.ts` is the authority):

```bash
foundry-worker setup --server <url> --workspace <path>   # init + pair + install service
foundry-worker init <path>
foundry-worker connect [--polling]
foundry-worker install-service | status | logs | uninstall-service
foundry-worker doctor
foundry-worker providers
```

The daemon owns:

- the local workspace registry and `.foundry/` initialization,
- local filesystem access,
- provider credentials, native logins and profile configuration,
- Claude/Codex sessions (SDK first, CLI fallback when the SDK is unavailable),
- Issue environments, worktrees and the execution sandbox
  (macOS `sandbox-exec`, Linux bubblewrap),
- evidence collection, verification and Accept integration,
- local preview processes,
- event streaming back to the server.

The daemon initiates the connection to the server through an outbound
WebSocket (`/api/daemon/ws`), so no inbound access to the user's machine is
required. HTTP polling (`--polling`) remains for debugging and compatibility.

## 4. Workspace Model

A workspace is an existing local directory registered on a paired device. It
can be registered from the CLI (`foundry-worker init` / `setup`) or by the
device owner from the web app, which only accepts an existing absolute folder
on that device. Registration never deletes files; removing a workspace only
unregisters it.

`foundry-worker init` creates the workspace scaffold (`AGENTS.md`,
`CONTEXT.md`, `artifacts/`, `accepted/`, `.foundry/`). The full local layout
and the external execution store are described in
[storage strategy](storage-strategy.md).

The server cannot instruct the daemon to operate on arbitrary local paths:
device operations are limited to the device owner, and file access is confined
to registered workspaces.

## 5. Provider Runtimes

Foundry supports exactly two provider runtimes, both run by the local daemon:

- **Claude** through the Claude Agent SDK
  ([docs](https://code.claude.com/docs/en/agent-sdk/overview)), falling back
  to the local `claude` CLI.
- **Codex** through the Codex SDK
  ([docs](https://developers.openai.com/codex/sdk)), falling back to
  `codex exec`.

Credentials come from the native CLI login (official accounts), from
device-local profiles in `~/.foundry/agent-profiles.local.json` (endpoint, key,
environment, custom command), or from a server profile whose sealed key is
delivered to the daemon for the run. Model catalogs come from the native
runtime (Claude Agent SDK `supportedModels()`, Codex `model/list`); compatible
endpoints may additionally be queried at `/models` for metadata only. Every
inference request goes through the native SDK or CLI; Foundry never calls
provider inference endpoints directly.

Foundry's product model does not expose Claude/Codex internals directly.
The worker normalizes provider session IDs, streaming output, tool calls,
subagents, final responses, errors and cancellation into Foundry events and
transcripts (`packages/worker/src/sdk-messages.ts`,
`packages/worker/src/transcript-adapters/`).

## 6. Local Credential Strategy

Device-local secrets stay on the device:

- official OAuth credentials never leave the native CLI (for example the macOS
  keychain for Claude Code);
- device profile keys, environment variables and commands live in owner-only
  files under the state root;
- a profile's `env` and `command` are always rejected at the control-plane API.

Server profiles for remote endpoints are the one server-side exception (see
§2). Workspace-level isolation comes from per-workspace profile selection and
the Issue execution sandbox, which denies executors access to the state roots.

## 7. Foundry Development Preview vs Workspace Preview

Do not mix these two concepts.

- **Foundry product development preview**: the normal Vite dev server
  (`pnpm dev:web`) used while building Foundry itself. It is not a
  Foundry-managed workspace asset.
- **Workspace preview**: a workspace-configured command
  (`.foundry/preview.json`) that the daemon starts inside an Issue's candidate
  write boundary on a local port, so a human can inspect the candidate. It
  shares the execution slot and is stopped before Accept or request-changes.

## 8. Repository Shape

```text
foundry/
  apps/
    web/          React app
    server/       Go server
  packages/
    worker/       local daemon, foundry-worker and foundry CLIs
    protocol/     shared TypeScript contract
  deploy/         Docker image and compose file
  scripts/        dev stacks, audits, code generation
  examples/       sample workspace
  docs/
```

Go cannot import TypeScript types. The Evidence/Verify contract
(`packages/protocol/src/evidence.ts`) is the source for generated Go models
(`apps/server/internal/store/evidence_models_generated.go`) and JSON Schema via
`scripts/generate-evidence-models.mjs`; the remaining projection types are
hand-written Go structs kept in step with the protocol package.

## 9. Open Questions

- PostgreSQL for hosted deployments: the `Store` interface keeps it possible,
  but no implementation exists.
- How much historical run event data should be mirrored to the server.
- How permission requests and generalized retries should be represented
  uniformly across Claude and Codex.
- Which resource leases beyond worktrees and preview ports are required (see
  [tool use and resources](tool-use-and-resources.md)).
