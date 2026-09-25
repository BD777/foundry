# Foundry Current Status

[Documentation index](README.md) · [Project overview](../README.md)

This page is a dated implementation boundary. Update it when code changes the
boundary; use Git history for delivered changes and the
[roadmap](../README.md#roadmap) for future work. Product/design goals are not
proof of implementation; code presence is not proof of operational acceptance.

## Snapshot: 2026-09-23 (at `18cd558`)

The base findings come from a source review at `ced848d` (2026-09-18,
**code-evidence**, paths attached). Capabilities added between `ced848d` and
`18cd558` (session orchestration, workspace skills, Feishu bot, accounts and
sharing, Linux isolation fixes, Docker deployment) were recorded on 2026-09-23
from their commits and source paths, not from a fresh end-to-end run. The named real-model and browser runs are
**historical records, not re-tested in this documentation pass**; each carries
its date. Nothing here was re-deployed or measured live.

Foundry is a self-hosted, multi-account product:

- a Go control plane (`apps/server`, HTTP + SSE + daemon WebSocket, SQLite
  projections, a sealed secret store, accounts and the Feishu bot);
- a React/Vite web app (`apps/web`, the only UI);
- a device-local Node worker daemon (`packages/worker`) owning workspace files,
  provider credentials, Issue execution and evidence collection; the default
  stack runs one daemon, and named dev stacks may run additional isolated
  daemons on the same machine;
- a shared TypeScript contract (`packages/protocol`) that also generates the Go
  models and JSON Schema.

The Issue loop on main is: raw input → read-only Agent clarification in the
selected workspace → human-confirmed contract pinned to `revision + digest` →
execution in a per-Issue git worktree outside the source tree → sealed
candidate snapshot → deterministic or independent-agent verification over real
materials → immutable review snapshot → explicit human Accept → per-repository
fast-forward integration. Unconfirmed contracts never execute; missing or
failed evidence blocks Accept; a moved baseline requires realignment,
reverification and a new Accept. Entry points and routes are in
`apps/server/internal/httpapi/server.go` (`(*Server).Routes`).

The Issues web entry is **hidden** while its experience is polished
(`c535d6a`): the sidebar has no Issues item and `/issues` renders the
workspace overview. The engine, APIs and worker paths above remain on main.

End-to-end runs of this loop with real Claude sessions were recorded on
2026-09-11/12 and at the 2026-09-18 merge; they are dated history, not a claim
that every path passes today. A full real-Codex image judgment has not been
completed.

## Current Features

| Area                          | Available now                                                                                                                                                                                                                                                                                                                                             | Remaining scope                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local execution               | Device pairing over an outbound daemon WebSocket (HTTP polling fallback), login service install (macOS launchd / Linux systemd user), workspace registration of any existing directory, including a subdirectory of a repository (with directory autocomplete), local agent profiles with runtime controls, device-scoped concurrency setting             | Explicit general permission request/response lifecycle; richer operational diagnostics                                                                                                                                           |
| Platform boundaries           | macOS `sandbox-exec` and Linux bubblewrap/user-namespace execution sandboxes; fail-closed on other OSes and when Linux namespaces are missing; Linux mounts the Node/CLI install prefixes read-only and recreates merged-`/usr` links (`7514228`)                                                                                                         | Linux (since 2026-09-25, `packages/worker/src/sandbox`): clarification, verification and Accept run; controlled HTTP targets remain **macOS only**; the Linux sandbox shares the host network and cannot block the control plane |
| Chats                         | Claude/Codex sessions via native SDK with CLI fallback, native session discovery, attachments, queued input, steering, cancellation, session recovery, thread-scoped transcripts, subagent transcripts, groups/search/rename/order, AI title recap; files a session produced are listed in the context card, and a workspace directory browser opens them | Broader recovery regression coverage                                                                                                                                                                                             |
| Issues                        | Six states (`pending / in_progress / blocked / verifying / accepted / abandoned`) with typed blocked reasons; draft contract from raw input; agent clarification proposals; digest-bound confirmation; worktree execution over root/nested/submodule repos; feedback, resume, abandon; Board and List (web entry hidden, see above)                       | General Ask/permission protocol; dependency scheduling; automatic contract _inference_ is deliberately not the design — the Agent proposes drafts and the human confirms                                                         |
| Evidence & Verify             | Contract revisions, sealed `CandidateSnapshot`, materials store, `command` / `project_command` / controlled local HTTP / candidate export / candidate changes / human upload collectors, independent read-only Agent judgments with structured JSON output, per-criterion results, immutable review snapshots, freshness/blocker gates                    | Codex image judgments (usage-blocked historically); PDF/audio/video; generic external service/dependency identity; full recovery for all mid-flight side effects; see [v1 §9](evidence-and-verify-v1.md)                         |
| Accept & integration          | Human approval pinned to review snapshot id + digest, worker-side lock and tree/baseline re-check, per-repository `--ff-only` merge with journals, baseline-move rejection with an explicit align/reverify path, idempotent replay, partial-apply recovery                                                                                                | Merge queue is per workspace via journals; cross-host verification does not exist; open-source release scope not selected                                                                                                        |
| Devices, workspaces, accounts | Browsing devices never changes the active location; `/locations` page selects device + workspace atomically; workspace register/rename/remove lives under the device (removal unregisters, never deletes files); official accounts are device-local native CLI logins; server profiles hold only remote endpoints with sealed keys                        | Official OAuth completion is always the user's own action                                                                                                                                                                        |
| Models                        | Native catalogs via Claude Agent SDK `supportedModels()` and Codex `model/list`/bundled fallback; compatible endpoints may be queried at `/models` only (metadata, approved 2026-09-16); official pickers are selection-only                                                                                                                              | No online validity/quota check for Claude; Codex online check is best-effort via its native usage read — a local login must never be displayed as online-valid                                                                   |
| Session orchestration         | Agents create, steer, hand off, fork and adopt sessions through `foundry` CLI / stdio MCP (`packages/worker/src/foundry-cli.ts`, `foundry-mcp.ts`) and server HTTP MCP (`httpapi/mcp.go`); session-scoped tokens, lineage, auto groups, worktree-backed child sessions, read-only verifier sessions ([design §9](session-orchestration-design.md))        | HTTP MCP OAuth 2.1, per-actor rate limits                                                                                                                                                                                        |
| Workspace skills              | Devices scan configurable local roots; skills are promoted into the server catalog as immutable zip revisions with dependency-aware promotion and version comparison; each workspace selects entries; Chats and Issue runs expose only that selection (`httpapi/skill_promotion.go`, `packages/worker/src/skill-*.ts`); `/` skill picker in the composer  | Automatic skill extraction/recommendation                                                                                                                                                                                        |
| Feishu bot                    | One bot per workspace over the Feishu long-connection client (no public IP); groups pair with a single-use hashed code; group threads map to Chat sessions; Card Schema 2.0 streaming replies; thread follow-ups without @mention; a group acts as the account that generated its code, re-checked per message (`apps/server/internal/feishu`)            | Threads as Issues; per-sender identity binding; a general Bot Adapter for other IMs                                                                                                                                              |
| Accounts and sharing          | Required sign-in for every browser API, first-admin setup code, invites, per-device credentials, resource ownership with per-caller filtered reads, workspace roles Viewer / Member / Maintainer / Owner with immediate revocation ([security](security.md#accounts), [design](accounts-permissions-design.md) P1–P2)                                     | P3 personal connections and Feishu identity binding; P4 audit view and ownership transfer; device key-pair authentication                                                                                                        |
| Deployment                    | Docker image and compose file for a self-hosted server + worker ([deploy](../deploy/README.md)); parallel isolated dev stacks (macOS)                                                                                                                                                                                                                     | The container worker has no bubblewrap, so Issues cannot run there; clean-environment install reproduction for the open-source release                                                                                           |
| Engineering                   | Shared protocol with generated Go/schema/field tables, strict wire validation, sealed secret store, SQLite transactions, UI/contract audits, CI gate and a regression case catalogue plus a parallel dev-stack tool (`scripts/dev-stack.mjs`)                                                                                                             | Focused decomposition of remaining large modules; case automation beyond the current manual browser evidence                                                                                                                     |

Preview: a workspace-configured command can run a local preview inside the
candidate write boundary; the preview shares the execution slot and is stopped
before Accept or "request changes". This is a controlled local port, not
browser automation.

## Explicitly not implemented

Keep these as roadmap scope; do not describe them as shipped:

- general Tool Use: no Browser Use / Computer Use / Simulator automation exists
  in code (the verifier configuration explicitly disables those capabilities);
- a general IM Bot Adapter (only the Feishu-specific bot exists), Issues in
  Feishu, per-sender Feishu identity, cloud workspaces, cross-host scheduling,
  multiple agents per Issue, Docker container isolation for execution (Docker
  is a deployment option only), workflow plugins;
- arbitrary HTTP services, production writes, or dependency/lockfile version
  registration for verification — only local GET/HEAD named targets exist;
- periodic upload-cache cleanup (reclaimed lazily on the next upload, with no
  background timer of its own; the daemon does keep unrelated timers such as
  its heartbeat) and silent restart of sealed HTTP targets;
- automatic skill extraction and a general plugin ecosystem (unscheduled).

## Local run

- Web: `http://127.0.0.1:31983/`; server health: `http://127.0.0.1:31982/healthz`.
- Install, worker pairing, env vars and verification: [Development](development.md).
- Running several isolated copies concurrently: [Parallel dev stacks](dev-stacks.md).
- Data placement, credentials and exposure rules: [Security](security.md).
