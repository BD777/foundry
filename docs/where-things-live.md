# Where things live

Read before changing protocol types, contracts, Server routes or storage, MCP tools, the Worker or the Foundry skill, and before running checks or scratch stacks. Pointers, not specs; read the code first. Paths from the repo root. Web pointers are in `apps/web/AGENTS.md`.

## Code

- Protocol types in `packages/protocol/src/`; consumers read `dist/`, so run `pnpm --filter @bd777/foundry-protocol build` after edits.
- Contract (OpenAPI 3.1, single source for migrated types): `contracts/` (root `foundry.openapi.yaml`, models in `models/*.yaml`); `pnpm generate:contracts` writes the TS types, Go models (`store/*_gen.go`) and JSON Schema; never edit generated files. Plan: `docs/refactor/phase6-openapi-design.md`.
- Server: routes in `apps/server/internal/httpapi/routes.go`, each with an access rule; routes a session token may call are marked `agent(...)` in `routeTable` (`onlyAgentRoutes` in `policy.go`); MCP tool schemas in `httpapi/mcp_tools.json` (embedded), handlers `mcp*.go`. Store: `internal/store/` (interfaces, models), `internal/sqlitestore/<area>.go` with `setup<Area>` migrations; every `foundry-server` run migrates its DB, so always set `FOUNDRY_DB_PATH`.
- Worker: `packages/worker/src/cli.ts` (`foundry-worker`), `foundry-cli.ts` (`foundry`), `daemon-connection.ts` (server link). Bare `node --test` writes into the real `~/.foundry`: test in `packages/worker` with `node scripts/run-worker-tests.mjs -- <f>.test.mjs`.
- Foundry skill: `packages/worker/skills/foundry/` = `apps/server/internal/builtinskills/foundry/`, byte for byte (`packages/worker/test/foundry-skill.test.mjs`). Docs: `docs/`.

## Checks and stacks

- Orchestrating sub-sessions: small fresh slices, context and test discipline, shared heavy-command lock, merge rules: [docs/agent-orchestration.md](docs/agent-orchestration.md).
- Before reporting, run the tests and typecheck that cover what you changed. `scripts/check-changed.sh --files <files>` (`--list` shows the plan; `--since "$START"` also catches other agents' edits) runs once per batch of changes before deploy, not per edit or review round; an orchestrator runs it for its workers' merged batch. Heavy checks on another device: lease its compute with `acquire_resource` (`forCommands: true`, `holdFor: 3600`), then run `FOUNDRY_LEASE_TOKEN=<commandToken> scripts/remote-check.sh <leaseId> [--files …]` in the background. Full `pnpm verify` only for release PRs.
- Scratch stacks (optional): `scripts/scratch-stack.sh up|shot|down <name>`. A server on a DB copy acts on its integrations (a second Feishu bot, Connectors refreshes rotating real tokens) unless `FOUNDRY_INTEGRATIONS=off`, which the script sets.
