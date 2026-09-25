# Foundry Development

## Change history and documentation

Use `git log` and `git show` to trace delivered changes. Commit messages should explain
the problem, resulting behavior and relevant validation, including any unverified limits.
Keep durable decisions in the owning design document, future work in the README Roadmap,
and reproducible acceptance checks in the [regression cases](../cases/README.md). Do not
duplicate commit history in a separate chronological development log.

## Component themes

Shared UI primitives own foreground, background and border semantics. Light/dark
values live in the root token definitions in `00-foundation.css`; feature styles
consume tokens and must not add page-specific dark selectors, literal colors or
color `!important` overrides. Status components use paired success/warning/error/info
tokens. Fixed provider identities and media/terminal surfaces use their own paired
tokens. Radix supplies interaction behavior; it does not supply a theme automatically.
Tailwind's semantic colors also map to Foundry tokens so Streamdown controls and
portals inherit the same theme.

Use `test/theme-gallery.html` with the web dev server to inspect shared panels,
checklists, badges, alerts, menus, Markdown, composer and repository inventory in
both themes. `node --test test/theme-contract.test.mjs` (from `apps/web`) prevents
raw feature colors and checks semantic text/surface contrast at 4.5:1. The layout
contract audit (`scripts/audit-v3-layout-contract.mjs`) also expects semantic
color references.

## Install

Normal local install:

```bash
pnpm install
```

If the workspace is on an SMB or network-mounted volume, keep pnpm's virtual store on a local disk:

```bash
pnpm install --virtual-store-dir="$HOME/.cache/foundry-pnpm-virtual-store"
```

This avoids writing large package trees, such as icon libraries, into the network volume.

## Run

Web app:

```bash
pnpm dev:web
```

Go server:

```bash
pnpm dev:server
```

The server defaults to SQLite at `apps/server/.data/foundry.db` when run through `pnpm dev:server`.
Web HMR does not update a compiled Server or a running Worker. When changing the
Issue event protocol, rebuild and reload both affected processes, preserve their
configured database and environment, and check for active executions first. An old
Server can keep accepting and storing Worker events without publishing the new
Issue SSE types, leaving the new UI dependent on its slow repair poll.
Server startup does not seed demo data by default. Use `FOUNDRY_DEMO_SEED=1` when you explicitly want the demo fixture dataset:

```bash
FOUNDRY_DEMO_SEED=1 pnpm dev:server
```

Use a custom database path when needed:

```bash
FOUNDRY_DB_PATH=/tmp/foundry.db pnpm dev:server
```

Use `PORT` to run another server instance for local end-to-end tests:

```bash
PORT=31992 FOUNDRY_DB_PATH=/tmp/foundry-e2e.db pnpm dev:server
```

### Parallel stacks

When two lines of work run concurrently, give each its own worktree, server,
worker and web (their Issues, evidence and acceptance state would otherwise
collide). `node scripts/dev-stack.mjs` creates, diagnoses, repairs, smokes and
tears down such stacks (`pnpm stack <command>`). Ports derive from a base
(server = base + 982, web = base + 983); the default stack stays on 31982/31983.
See [Parallel dev stacks](dev-stacks.md) for the full command set, state-root
isolation and the pre-restart backup tool.

### Server Security

The server and web development processes bind to loopback by default. Keep that default for normal local development.

Every browser API call requires a Foundry account, including on loopback. On first start with no accounts the server logs a one-time setup code; open the web app and create the owner with it.

Workers authenticate with their own device credential, obtained once from a pairing token (see the worker section below). Remote deployments must terminate TLS before the Go server. To develop behind a public TLS reverse proxy, keep both processes on loopback and route `/api/` to the server and everything else to Vite on the same host:

```bash
FOUNDRY_WEB_ORIGIN=https://dev.foundry.example pnpm dev:server

# Same-origin API calls; HMR goes through the proxy on :443.
VITE_API_BASE_URL= FOUNDRY_WEB_PUBLIC_HOST=dev.foundry.example pnpm dev:web
```

Accounts can also be managed from the shell:

```bash
cd apps/server
go run ./cmd/foundry-server users create --username alice --role admin   # prints a generated password
go run ./cmd/foundry-server users reset-password --username alice
go run ./cmd/foundry-server users list
```

The commands use the same `FOUNDRY_DB_PATH` as the server. Owners invite members from **Manage → Members**.

The demo reset endpoint is disabled by default. Enable it only for an isolated development database:

```bash
FOUNDRY_ENABLE_DEV_RESET=1 pnpm dev:server
```

See [Security](security.md) before changing bind, origin, authentication, attachment, or local-file behavior.

Worker CLI:

```bash
pnpm --filter @foundry/worker foundry-worker -- --help
pnpm --filter @foundry/worker foundry-worker -- --commands
pnpm --filter @foundry/worker foundry-worker -- setup --schema
pnpm --filter @foundry/worker foundry-worker -- setup --man
pnpm --filter @foundry/worker pack --dry-run
```

The repo-local `foundry-worker` script auto-builds the worker CLI when `dist/` is missing or stale.
CLI help and discovery commands return before filesystem, network, or service side effects.

Initialize, pair, register, and install the local daemon. Start the server at `http://127.0.0.1:31982` first, then create a one-time pairing token in the web app (**Devices → Add device**) or on the server host (`go run ./cmd/foundry-server devices pairing-token --username <you>` in `apps/server`). The token expires quickly and works once; the worker exchanges it for its own device credential, stored owner-only in `~/.foundry/daemon-config.json`:

```bash
pnpm --filter @foundry/worker foundry-worker -- setup --server http://127.0.0.1:31982 --workspace /tmp/foundry-workspace --token <pairing-token>
```

Re-running `setup` or `pair` without `--token` keeps the saved credential. One machine is one device per account (identified by a hash of the OS machine id); pairing it again rotates the credential of the same device. Only one daemon runs per state root.

Use `--no-start` to write the login service without starting it, or `--no-service` for a foreground-only smoke test.

`connect` defaults to the WebSocket daemon protocol at `/api/daemon/ws`. Use `--polling` to force the older HTTP polling loop:

```bash
pnpm --filter @foundry/worker foundry-worker -- connect --server http://127.0.0.1:31982 --workspace /tmp/foundry-workspace --polling --once
```

Pair and install a login service:

```bash
pnpm --filter @foundry/worker foundry-worker -- init /tmp/foundry-workspace
pnpm --filter @foundry/worker foundry-worker -- pair --server http://127.0.0.1:31982 --workspace /tmp/foundry-workspace --token <pairing-token>
pnpm --filter @foundry/worker foundry-worker -- install-service
pnpm --filter @foundry/worker foundry-worker -- status
pnpm --filter @foundry/worker foundry-worker -- logs --lines 120
pnpm --filter @foundry/worker foundry-worker -- uninstall-service
```

`install-service` writes a user-level launch-on-login service:

- macOS: `~/Library/LaunchAgents/dev.foundry.worker.plist`
- Linux: `~/.config/systemd/user/foundry-worker.service`

A `mock` runtime remains as the deterministic test baseline; `claude` and `codex` run through agent profiles. A profile is a concrete account, endpoint, command, and env bundle on one device; the runtime is only `claude` or `codex`. Provider credentials and unrestricted session metadata stay on the machine running `foundry-worker`.
The daemon reports redacted device profiles, workspace-specific agents, root file metadata, and read-only file content over the WebSocket control channel so the server never reads the user's filesystem directly.

Sessions run through the native SDK (Claude Agent SDK, Codex SDK) and fall back to the local CLI automatically when the SDK cannot be loaded or fails to start. `foundry-worker providers` reports a runtime as runnable when either its SDK or its CLI is present; `FOUNDRY_CLAUDE_BIN` and `FOUNDRY_CODEX_BIN` point at a CLI outside the usual locations.

Settings diagnostics stay read-only. Chat sessions are intentionally a thin GUI over the selected local agent profile: they run on the paired machine, can use workspace-write access, and leave any edits in the local workspace. The selected local profile and runtime permissions remain the execution boundary.

Device-scoped profiles are stored in `~/.foundry/agent-profiles.local.json`. The web app writes this file through the connected local daemon; the server stores only redacted projection fields such as label, runtime, status, and base URL.
The control plane rejects `env` and `command` in every profile payload; a remote-endpoint server profile may submit an `apiKey` write-only, which the server seals in its secret store and never returns. Private worker JSON is written atomically with file mode `0600` and owner-only parent directories.

Saving profiles and refreshing the device page run no provider checks. The
worker does not run `claude -p` or any chat/completions-style request during
those flows; real provider failures surface when a user explicitly starts a
chat/session.

An explicit account inspection is available on the device page
(`POST /api/devices/{deviceId}/accounts/{runtime}/inspect`, on demand only).
It runs native read-only commands through the daemon:
`claude auth status --json` for Claude, and Codex's app-server `account/read`
plus `account/rateLimits/read` for Codex. The result is one of
`verified` (Codex only, when its native usage read succeeds),
`local_login`, `not_signed_in`, or `unavailable`. Claude has no native
quota/validity read, so its strongest result is `local_login`; a cached or
local login is never displayed as online-valid. The reported configuration
source (for example a daemon `$HOME` that differs from the desktop login) is
shown, and inspecting another source never changes the execution account.
See [security](security.md) for the identity boundary.

Agent profiles can store runtime-specific defaults. Claude profiles use Claude Code's own `--effort` and `--permission-mode` values. Codex profiles use Codex's `model_reasoning_effort`, `sandbox_mode`, and `approval_policy` values. The chat composer can override these per send.

Model catalogs are fetched only through explicit, non-generating reads, never
automatically on save: official Claude accounts use the Agent SDK's
`supportedModels()` (no prompt, no tools); official Codex accounts use the
native app-server `model/list` with a bundled-catalog fallback, and a custom
gateway catalog file is never shown as official; compatible endpoints are
queried at `/models` (or `/v1/models`) by the daemon — the one sanctioned
provider HTTP exception, because no native CLI can enumerate a compatible
endpoint.

For custom command profiles, the worker sends the prompt on stdin and sets `FOUNDRY_WORKSPACE`, `FOUNDRY_RESULT_FILE`, `FOUNDRY_SESSION_ID`, and `FOUNDRY_SESSION_SOURCE`. If the command writes markdown to `$FOUNDRY_RESULT_FILE`, that file becomes the response; otherwise stdout is used.

Issues run in persistent candidate worktrees under `~/.foundry/workspaces/<workspace-id>/environments/<issue-id>/workspace/` by default. Foundry initializes non-Git roots and prepares registered child repositories on demand. Source files remain read-only to the executor; Workspace Accept validates the reviewed revision and integrates changes through the connected worker. There is no fallback to executing these Issues directly in the source directory. Candidate execution and deterministic collectors run under macOS sandbox-exec or Linux bubblewrap; independent-agent verification and the Accept/integration step run on macOS and Linux (controlled HTTP targets are macOS only, and the Linux sandbox cannot block the control plane); other platforms are refused. See [Issue execution](issue-workspace-execution.md) for storage overrides, recovery and legacy compatibility.

Preview is opt-in per workspace. Copy `.foundry/preview.example.json` to `.foundry/preview.json` and set a command that starts a local server using `$FOUNDRY_PREVIEW_PORT`. Review can start and stop the preview in the candidate environment, with logs in its scratch directory. A running preview holds a shared execution slot; Accept and Request changes stop it before proceeding.

Check provider readiness for a workspace:

```bash
pnpm --filter @foundry/worker foundry-worker providers --workspace /tmp/foundry-workspace
```

## Verify

Run the same two gates used in CI:

```bash
pnpm format
pnpm verify
```

`pnpm verify` runs:

- TypeScript typechecks and production builds;
- JavaScript and TypeScript package tests;
- Go tests and `go vet`;
- strict HTTP and WebSocket protocol checks;
- web component, layout, native-control, button, CSS, and app-boundary audits;
- regression case catalogue validation.

GitHub Actions runs `pnpm format` and `pnpm verify` on every push and pull request using Node.js 22, pnpm 11.7.0, and the Go version declared by `apps/server/go.mod`.

The worker suite runs under an OS write allowlist so a wrong test cannot touch your real `~/.foundry` or native credential homes: macOS uses `sandbox-exec`, Linux uses bubblewrap (`sudo apt install bubblewrap`; unprivileged user namespaces must be enabled). Without a working backend the launcher refuses to run; `node packages/worker/scripts/run-worker-tests.mjs --probe` demonstrates the denials. CI installs bubblewrap and runs the same isolation.

### UI Audit Baselines

Historical UI debt is stored in `apps/web/scripts/audit-baseline.json`. Audits compare both count and a hash of the exact violation set, so replacing one violation with another does not silently pass.

Rules:

- do not increase a baseline;
- after intentionally reducing debt, print the new snapshot and update only that entry;
- do not accept a same-count hash change without reviewing every changed violation.

Example:

```bash
cd apps/web
FOUNDRY_AUDIT_PRINT_BASELINE=1 node scripts/audit-app-boundary.mjs
```

`App.tsx` currently has zero tracked visual-boundary violations. The remaining button, native-control, CSS, and V3 layout baselines are migration debt and should only shrink.

Expected local URLs:

- Web: `http://127.0.0.1:31983/`
- Server health: `http://127.0.0.1:31982/healthz`

## Regression Cases

Product-level behavior and its executable coverage are catalogued under
[`cases/`](../cases/README.md). Run the full commit gate after a change:

```bash
pnpm regression:commit
```

For a live API smoke check, start the server with an isolated database and run:

```bash
FOUNDRY_DB_PATH=/tmp/foundry-regression.db pnpm dev:server
pnpm regression:api
```

API, daemon, storage, security, browser-interaction, and browser-visual cases
share one descriptor contract. Executable tests remain next to their owning
code; case files provide product intent, cadence, deterministic setup, semantic
steps, required evidence, and traceability to those tests. Add or update a case
with every feature and every bug fix that changes observable behavior.

## Visual States

Open `http://127.0.0.1:31983/?device=offline` to verify the no-device setup state without mutating server or SQLite data.
