# Context

Foundry is a workspace-centered AI work platform. The accepted Workspace state is
the single source of truth; agents work concurrently in candidate environments,
and verified, human-accepted results improve both the project and its reusable
working methods. Local deployment is the first implementation shape.

This note is a pointer, not a status report: what is built lives in each module
document's implementation boundary. Always inspect the current working tree and
`git log` before editing, and preserve unrelated work.

## Read in this order

1. [AGENTS.md](AGENTS.md) for binding workspace rules (UI principles, the
   conversation release-gate protocol, native-only provider access) and where
   code lives.
2. [Workspace and Sandbox overview](docs/workspace-sandbox-overview.md) for the
   target shape.
3. [Roadmap](docs/roadmap.md) for the module diagram and each module's current
   capability, next steps and completion criteria (the README shows the diagram
   and a one-line summary per module).
4. The [documentation index](docs/README.md#modules) for the owning document of
   the module you are changing; read its implementation boundary first.
5. [Module architecture](docs/architecture-modules.md) for layer rules and
   code-module boundaries.

## Boundaries to respect in any new work

- Worker isolation goes through the Sandbox module
  (`packages/worker/src/sandbox`, [execution kernel](docs/execution-kernel.md));
  never spawn `sandbox-exec` / `bwrap` or branch on the platform elsewhere.
  Separation of duties is enforced by identity and process (agent tokens cannot
  confirm, verify or Accept). Chats are not sandboxed.
- Every browser API call requires an account (no anonymous mode); workspaces
  are shared by role (Viewer / Member / Maintainer / Owner).
- No direct provider inference HTTP; `/models` catalog reads are the sole
  exception (approved 2026-09-16). A cached/local login is not online validity.

## Product decisions to preserve

- [docs/roadmap.md](docs/roadmap.md) is the only roadmap and to-do list,
  organized by the module diagram with stable item IDs. Module documents hold
  design and implementation boundary; the devlog holds execution records for
  started items. Neither keeps its own checklist.
- Chats reuse the native Claude Code / Codex harnesses; one Foundry session is
  one native session.
- Users work with Issues; internal Runs, attempts, sessions and evidence
  records remain, but users do not manage Runs as separate objects. Issue
  statuses: pending / in_progress / blocked / verifying / accepted / abandoned;
  Blocked carries a typed reason with a specific message
  ([Issue conversation and status](docs/issue-conversation-design.md)).
- Workspace capability accumulation is a property of the Issue loop, not an
  independent feature.
- The Personal Agent (built, under testing) is itself a workspace holding an
  index of the other workspaces; it dispatches and responds, and never becomes
  a second source of truth.

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
