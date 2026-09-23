# Foundry Storage Strategy

Source of truth for the layouts below: `apps/server/internal/sqlitestore/*.go`,
`packages/worker/src/state-root.ts`, `execution-storage.ts` and
`workspaces.ts`.

## Decision

Foundry uses worker-owned local storage as the durable source of truth for
workspace and execution state, and SQLite as the server projection store.

```text
protocol types
  define contracts shared by web/server/worker

worker-owned local storage
  device state root (~/.foundry) + external execution store
  workspace .foundry/ plus artifacts/ and accepted/
  durable, filesystem-native, daemon-owned

server storage
  SQLite behind the Go Store interface
  projections for the web UI plus server-owned records
  (accounts, memberships, chat organization, sealed secrets, skill catalog)

browser attachment storage
  registered-workspace .foundry/attachments/
  narrowly scoped, private, path-confined
```

The server must not become the owner of user workspace contents or
device-local provider credentials. It has one narrow filesystem exception: the
Go server stores browser-uploaded attachments inside a registered workspace's
`.foundry/attachments/` directory and serves supported images from that
directory only.

Some records exist only on the server and cannot be rebuilt from the worker:
accounts and sessions, workspace members, device credentials, server profiles
and sealed secrets, the promoted skill catalog, Feishu bot bindings, and
chat-list organization (group names, group order, membership and manual
session order in `chat_layouts`). They must be included in database backups.
Daemon projection refreshes do not overwrite them. Browser Local Storage owns
only each chat group's expanded/collapsed presentation preference.

The storage layer is abstracted behind the Go `Store` interface
(`apps/server/internal/store/store.go`) so a hosted deployment could add a
PostgreSQL implementation without changing HTTP handlers or the web API shape.

## Layer 1: Protocol Contracts

`packages/protocol` defines the shared projection objects (workspaces,
devices, issues, runs, sessions, chats, profiles, skills, the Feishu bot and
the Evidence/Verify contract in `src/evidence.ts`, which also generates the Go
models and JSON Schema).

The package also exports fixture data for the web app's opt-in demo fallback
(`VITE_DEMO_FALLBACK=1` or `?demo=1`); it is demo data only, never real state.

## Layer 2: Worker Storage

### Device state root

Device-level configuration lives under the stack state root, selected by
`FOUNDRY_STATE_ROOT` or `FOUNDRY_STACK` (named stacks live under
`~/.foundry-stacks/<name>`), defaulting to `~/.foundry`
(`packages/worker/src/state-root.ts`). Issue executors are denied read access
to both the default and named-stack state parents.

```text
<state-root>/                    # ~/.foundry, or ~/.foundry-stacks/<name>
  device.json                    # device identity
  runtime-settings.local.json    # active-run TTL and concurrency
  workspaces.json                # local workspace registry
  forgotten-workspaces.json
  daemon-config.json             # paired server and device credential
  agent-profiles.local.json      # device-local profiles
  storage.local.json             # optional absolute executionRoot override
  logs/
  workspaces/
    <workspace-id>/
      registration.local.json    # source path and content scan
      environment-locations/     # pointers to Issue environments
      locks/
```

`daemon-config.json` holds the paired server and the device credential.
`agent-profiles.local.json` may contain provider credentials, environment
variables, or custom commands. These files are owner-only and are never
projected to the server verbatim.

### Execution store

Issue environments, run records, evidence and acceptance journals live outside
the workspace tree, under the execution root. It defaults to
`<state-root>/workspaces` and can be moved with `executionRoot` in
`storage.local.json` (`ExecutionStore` in `execution-storage.ts`). The layout
follows the [multi-repository execution plan](issue-workspace-execution.md).

```text
<executionRoot>/<workspace-id>/
  environments/<issue-id>/
    environment.json
    workspace/                   # root and participating repository worktrees
    scratch/
  runs/<run-id>/
  evidence-store/                # materials, evidence, snapshots
  acceptances/                   # integration journals
```

Environments persist across runs and review; request-changes keeps the
candidate environment. Because evidence and journals live beside, not inside,
the environment, worktree cleanup cannot delete proof.

### Workspace `.foundry/`

`initWorkspace` in `packages/worker/src/workspaces.ts` creates:

```text
workspace/
  AGENTS.md
  CONTEXT.md
  artifacts/issues/
  accepted/
  .foundry/
    workspace.json
    daemon.json
    assets.yaml
    skills.yaml
    providers.yaml
    agent-profiles.local.example.json
    preview.example.json
    issues/  integrations/  runs/  reviews/  worktrees/
```

and, at runtime:

```text
  .foundry/
    preview.json                 # optional workspace preview command and port range
    sessions/<session-id>/       # local provider session messages, logs, results
    attachments/YYYYMMDD/        # browser uploads
```

Rules:

- `.foundry/workspace.json` identifies the workspace and baseline metadata.
- `.foundry/sessions/` stores Chat session records; `.foundry/attachments/`
  stores browser uploads. The server resolves symlinks and rejects reads
  outside registered attachment roots.
- `.foundry/preview.json` configures the workspace preview that the daemon
  starts inside an Issue's candidate write boundary.
- `providers.yaml` stores provider configuration metadata, never secret values.
  Device-scoped
  profile secrets, environment variables, and commands belong in the state
  root's `agent-profiles.local.json`.
- `assets.yaml` stores configured assets and lease policies; `skills.yaml`
  declares workspace skill packs projected to the server's `skills` table
  (device skill roots and the promoted catalog are configured separately).
- `artifacts/issues/<issue-id>/` stores reviewable artifacts; `accepted/`
  stores accepted non-code artifacts when applicable.
- `.foundry/issues/`, `integrations/`, `runs/`, `reviews/` and `worktrees/`
  are the legacy per-workspace Issue layout. New Issue candidates, runs and
  journals use the execution store above; legacy records remain readable and
  are never moved automatically.
- Private JSON and attachment files use mode `0600`; private directories use
  mode `0700`.

`packages/worker/src/storage.ts` owns atomic writes: private JSON writes use
temporary files, `fsync`, rename, file mode `0600` and directory mode `0700`.
Run and provider event streams use append-only JSONL. Provider prompts, stdout,
stderr, git status, patches and preview logs stay local.

The daemon may read and write these files. Except for the confined browser
attachment path, the server only receives projections sent by the daemon.

## Layer 3: Server Storage

The Go server keeps a SQLite database behind the `Store` interface. Most
records use a compact typed column set plus `payload_json` for protocol
evolution. Multi-record mutations (daemon registration replacement, issue-run
transitions, event append, issue completion) run in SQLite transactions and
cannot expose partial state; issue claiming and display-sequence allocation are
serialized by the transaction, and hot lookup/ordering paths have explicit
indexes (`indexes.go`). Schema changes require explicit migration tests.

Tables by file (from the `CREATE TABLE` statements in
`apps/server/internal/sqlitestore/`):

- `sqlitestore.go`: `devices`, `removed_devices`, `workspaces`,
  `workspace_display_names`, `provider_health`, `agent_profiles`, `agents`,
  `workspace_files`, `issues`, `runs`, `run_events`, `agent_sessions`,
  `agent_session_events`, `agent_session_tokens`, `acceptance_artifacts`,
  `chat_titles`, `chat_layouts`, `chat_deletions`, `chats`, `assets`,
  `skills`, `secret_records`, `secret_store_meta`, `evidence_records`,
  `evidence_requests`.
- `accounts.go`: `users`, `user_sessions`, `user_invites`.
- `ownership.go`: `workspace_members`.
- `device_credentials.go`: `device_identities`, `device_pairing_tokens`.
- `profiles.go`: `profiles`, `device_profiles`.
- `skills_catalog.go`: `device_skill_roots`, `device_skills`,
  `promoted_skills`, `promoted_skill_revisions`, `workspace_skill_bindings`.
- `skill_versions.go`: `skill_sources`, `skill_revision_index`,
  `skill_version_migrations`.
- `feishu.go`: `workspace_feishu_bots`, `feishu_chat_threads`.

## Authority Rules

- Worker storage is authoritative for local Issue, run, session and evidence
  history.
- Server projections are authoritative only for currently connected UI state;
  server-owned records (listed under Decision) are authoritative on the server.
- Device-local provider credentials stay on the device.
- The daemon decides what workspace metadata is safe to project.
- The web app reads from the server, never directly from the filesystem.
- Accepted code changes update the git baseline through the worker's
  fast-forward integration; accepted non-code artifacts move into `accepted/`.
- Browser uploads are the only server-managed workspace files and are confined
  to `.foundry/attachments/`.
- A profile's `env` and `command` are always rejected at the control-plane
  boundary and stay machine-local; a remote-endpoint server profile may submit
  an `apiKey` write-only, which the server seals in its encrypted secret store
  and never returns (see [security](security.md#secret-store)).
- If the server database is lost, reconnecting daemons re-register and rebuild
  the device and workspace projections; server-owned records must come from a
  backup.

## Asset Leases

Worktree allocation and preview port selection are handled locally without a
lease table: worktrees live in the execution store and preview state is held by
the daemon for the running Issue. A generalized lease record for simulators,
devices or deploy targets is not built (see
[tool use and resources](tool-use-and-resources.md)); there is no background
reaper, and upload-cache cleanup is lazy.

## Why SQLite, Not PostgreSQL

SQLite gives persistence with a single-binary deployment and no extra service.
PostgreSQL remains deferred until hosted multi-tenant deployment requires it;
an implementation must satisfy the same `Store` interface, likely keeping
`payload_json` as `jsonb`, and preserve the existing web API shape.
