# Context

Foundry is a workspace-centered AI work platform. The accepted Workspace state is
the single source of truth; agents work concurrently in candidate environments,
and verified, human-accepted results improve both the project and its reusable
working methods. Local deployment is the first implementation shape.

Reviewed checkout: `main` at `18cd558` (2026-09-23, documentation review; no
services or models were run). Always inspect the current working tree
and `git log` before editing; this note is a pointer, not the code. Preserve
unrelated work.

Updated: 2026-09-23

## Read in this order

1. [AGENTS.md](AGENTS.md) for binding workspace rules (UI principles, the
   conversation release-gate protocol, native-only provider access).
2. [Workspace and Sandbox overview](docs/workspace-sandbox-overview.md) for the
   target shape and module outline the roadmap follows.
3. [README Roadmap](README.md#roadmap) for the sole maintained capability
   checklist; [English](docs/README.en.md#roadmap) mirrors it.
4. [Current status](docs/current-status.md) for the 2026-09-23 implementation
   boundary and explicit non-goals.
5. [Issue workflow](docs/issue-workflow.md),
   [Evidence / Verify v1](docs/evidence-and-verify-v1.md) and
   [tools/resources](docs/tool-use-and-resources.md) for the implemented
   contract and remaining design scope.
6. [Module architecture](docs/architecture-modules.md) for the layer rules,
   module boundaries and milestone order that new work follows.
7. [0908 Plan](docs/archive/workspace-ai-product-plan-2026-09-08.md) for full
   reasoning (archived); explicit later decisions in the topic docs take
   precedence.

## Current implementation snapshot

The full Issue chain is on main:

- Issue creation stores only the raw goal as a draft contract; an Agent
  clarification session proposes revisions, and a human confirms an exact
  `revision + contentDigest`. No inferred task, no fixed three criteria.
- Claims require a confirmed contract (`sqlitestore/daemon.go`); before a run
  starts, the worker independently re-validates the confirmed revision and
  content digest in `packages/worker/src/issue-execution.ts`.
- Execution happens in per-Issue git worktrees outside the source workspace
  (`~/.foundry/workspaces/<ws>/environments/<issue>/workspace/` by default),
  constrained by macOS sandbox-exec or Linux bubblewrap.
- Candidates are sealed as `CandidateSnapshot`; materials persist under the
  evidence store; verification uses deterministic collectors
  (`command` / `project_command` / controlled local HTTP / candidate export /
  candidate changes) or a separate read-only Agent session; review snapshots
  are immutable and Accept binds their id + digest.
- Acceptance re-checks trees and baselines under lock, integrates each
  repository `--ff-only`, and requires alignment + reverification + a new
  Accept when the baseline moved.
- End-to-end loops with real Claude sessions were recorded on 2026-09-12
  and at the 2026-09-18 merge; they are dated evidence, not a standing claim
  that everything currently passes. A real Codex image judgment has not been
  completed.

Main entry points:

- Server: `apps/server/cmd/foundry-server` (default port 31982, SQLite at
  `apps/server/.data/foundry.db`); routes in
  `apps/server/internal/httpapi/server.go` with one access rule per route in
  `routes.go`; schema in `internal/sqlitestore/*.go`; Feishu bot in
  `internal/feishu`.
- Worker: `packages/worker/src/cli.ts` (`foundry-worker`: setup, pairing,
  service install, status, doctor, workspace scan) and `foundry-cli.ts`
  (`foundry`: session orchestration commands and the stdio MCP server);
  execution in `issue-executor.ts`, evidence in `evidence-*.ts`, skills in
  `skill-*.ts`, native accounts in `native-inspection.ts`.
- Web: `apps/web` (Vite 31983); feature-first architecture documented beside
  the code in [apps/web/src/ARCHITECTURE.md](apps/web/src/ARCHITECTURE.md);
  the working-location page is `/locations`, workspace CRUD is under devices.
- Dev tooling: `scripts/dev-stack.mjs` (parallel isolated stacks,
  [docs/dev-stacks.md](docs/dev-stacks.md)); gate is `pnpm verify`.

Known boundaries to respect in any new work:

- Agent clarification, independent verifier sessions and Accept/integration
  are enabled on macOS only and explicitly refused elsewhere.
- Every browser API call requires an account (no anonymous mode); workspaces
  are shared by role (Viewer / Member / Maintainer / Owner). Per-sender
  Feishu identity, personal connection grants and audit are not built yet (see
  [accounts permissions v2](docs/accounts-permissions-design.md) P3–P4).
- The Issues web entry is hidden until its experience is polished; the Issue
  engine stays on main and remains the product's main line.
- No direct provider inference HTTP; `/models` catalog reads are the sole
  exception (approved 2026-09-16). A cached/local login is not online validity.
- No browser automation, general IM adapter, cloud workspace, multi-host
  scheduling, multi-agent-per-Issue or workflow plugins exist in code — these
  stay roadmap items. The Feishu bot maps threads to Chat sessions, not Issues.

## Product decisions to preserve

- README lists capabilities, not infrastructure components or individual coding
  tasks. There is no separate `docs/roadmap.md`; topic docs hold design,
  dependencies and acceptance expectations without duplicate checklists.
- Chats is checked for core conversation capability, broadly approaching the
  Codex App experience; complete Tool Use interaction is not implied. Reuse
  native Claude/Codex harnesses; Web handles UI, Daemon execution and Worker
  Pool capacity are foundations.
- Users work with Issues; internal Runs, attempts, sessions and evidence
  records remain, but users do not manage Runs as separate objects.
- Issue statuses: pending / in_progress / blocked / verifying / accepted /
  abandoned. Blocked carries a typed reason (needs_input, needs_permission,
  system_error) with a specific message. Temporary retries and capacity waits
  remain progress; an execution that cannot continue is Blocked. Resume the
  same Issue; only the user accepts or abandons it.
  See [Issue conversation and status](docs/issue-conversation-design.md).
- Basic Tool Use covers the operations and evidence capture needed for the
  selected scenario. Minimal environment identity, isolation, permissions,
  occupancy protection and cleanup are part of first integration.
- Shared resource scheduling covers single-host and multi-host allocation,
  reuse and recovery; cross-host verification is a scenario within it.
- IM started with a Feishu-specific bot; a common Bot Adapter is later work.
  A paired group acts as the account that generated its code; per-sender
  identities mapping to Foundry accounts come later.
- Cloud Workspace hosts project files and persistent state as one logical
  filesystem; it does not require hosted agents or supplied execution machines.
- Workspace capability accumulation is a property of the Issue loop, not an
  independent feature. Workspace skills (promote, select, isolate) are
  shipped; automatic skill extraction and advanced storage stay unscheduled.
- Issues is the agreed main line. Workflows may later become plugins with
  Issues as the built-in one; that is exploration, not a reason to change
  Issue semantics.

## Trust Boundary

- Server and web development ports bind to `127.0.0.1` by default.
- Browser API calls use the account session cookie; workers use their own
  device credential, obtained once from a one-time pairing token.
- Provider `apiKey`, `env`, and `command` values stay in owner-only local
  worker configuration; a server profile may seal only a remote-endpoint
  apiKey in the server secret store — `env`/`command` are rejected at the API.
- Local private JSON uses atomic writes, mode `0600`, and owner-only parent
  directories.
- See [docs/security.md](docs/security.md) for the complete boundary.

## Development Gate

Run the commit regression gate before committing:

```bash
pnpm regression:commit
```

GitHub Actions runs the same gates on pushes and pull requests.

## Structural notes

- SQLite multi-record mutations use transactions; issue claiming and sequence
  allocation are contention-safe; hot projection paths have explicit indexes.
  New multi-table store operations must use the transaction helper in
  `internal/sqlitestore/tx.go`.
- Daemon request/response correlation is centralized in
  `httpapi/daemon_rpc.go`; teardown must release every waiter and close every
  upgraded socket, including sockets that never completed `hello`.
- The web feature audit (`apps/web/scripts/audit-feature-architecture.mjs`)
  forbids cross-feature imports, shared-layer back-dependencies and module
  growth beyond its limits; checked-in UI audit baselines may only shrink.
- `packages/worker/src/cli.ts` is a thin dispatcher; implementation lives in
  sibling modules (`issues.ts`, `models.ts`, `workspace-ops.ts`,
  `session-helpers.ts`, `daemon-connection.ts`, and the `evidence-*.ts`,
  `issue-*.ts`, `execution-*.ts`, `native-*.ts` families).
