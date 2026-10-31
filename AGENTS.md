# foundry

Treat this workspace context as authoritative. The workspace evolves, skills accumulate, workers do not remember.

## Native agents first

Claude Code and Codex are post-trained for their own native form, so that form works best.

- Run them as their vendors intend. Do not inject behavior guidance into system prompts or tool results, change their config/filesystem defaults, or re-implement what they already do (subagents, background tasks, timers, skill discovery, waiting).
- Foundry tools offer only what an agent cannot do itself: other sessions, other devices and workspaces, credential gateways, durable work. Descriptions state the contract (what, arguments, limits); results are small and pageable (offset/limit, filters, concise by default), never dumps. The context window is the scarcest resource.
- Never hold a turn open to wait: end it and let the report or notification wake you; run long commands in the background.

## Iteration workflow

- New session: choose model and effort for the task (Astra, high, for complex iterations; xhigh only with a concrete reason). Do not change running sessions just for this default.
- Start from the person's problem: inspect code and incident evidence, research established solutions when useful, explain cause and fix, and ask only for real product or implementation tradeoffs.
- Work on local `main`. Inspect existing changes and active sessions first and preserve other work; one owner per tightly coupled change; reconcile branch/worktree work without discarding either side.
- Disk: check before and after large builds, package staging and DB backups. Below 10 GiB free or above 90% used, reclaim verified disposable caches first; below 5 GiB or above 95%, defer large writes. Coordinate cleanup with active builders. Never delete DB/WAL files, user work, active temp files or the only rollback copy. Reuse dependency trees and DB snapshots.
- Git submission is separate from implementation and validation: a commit restriction never blocks edits, builds, deploys or checks that create no commits. If a test flow commits (candidate sealing, Accept), defer only that step, naming the step, repository and dependencies. Never change product semantics or erase history to evade a restriction; keep private submission arrangements in session context, not in repository files.
- Build and deploy affected dev Server/Web directly (authorized, no commit needed); preserve active sessions and check health after a restart. Update Worker/daemon yourself when authorized and safe and verify the loaded execution host, not just the package; if that would interrupt sessions or needs permission, explain the impact and ask, never force-stop their work.
- Verify yourself: tests, API requests, real-browser end-to-end. The person's dev account is authorized with clearly scoped synthetic data that leaves unrelated work alone; or reuse a test account recorded (non-secret identity, environment) in `docs/devlog/test-environment.md`, with credentials outside the repo.
- Devlog: keep `docs/devlog/README.md` current per item; after self-verification record problem, investigation, fix, deployment/version evidence, checks and limitations in `docs/devlog/DEV-NNN-topic.md` (link, don't duplicate), and give concrete acceptance steps with expected results. Human acceptance is the default. If the person delegates acceptance to an Agent, close only the verified scope, record date, source and evidence in the timeline, keep open limitations, and never describe it as the person testing. A finished session is not a finished delivery.

## UI principles

- Every action is discoverable: visible labels, chevrons or action icons, deliberate hover, focus, selected, disabled, busy and error states; never hover-only or color-only.
- Frequent navigation is compact and flat, with no cards inside cards for switchers or lists. Device and workspace selection has its own page; sidebar entries use forward arrows, not dropdowns. Restrained spacing, one surface boundary, a distinct selected fill or checkmark. Selected and hovered stay distinguishable side by side in both themes; never stack selection borders, inset bars, badges and heavy focus rings. Visual acceptance is separate from test success: inspect at normal scale in the full page, not only enlarged components.
- Browsing, selecting and managing are distinct. Browsing a device never changes the active location; commit device plus workspace together only after an explicit workspace choice succeeds, and cancel or failure keeps the context.
- One page per object. The Workspaces page (the sidebar location entry) lists every workspace grouped by device: Switch is the only action that changes the active location, adding a folder sits on its device group, rename and remove sit in the row menu with explicit destructive copy. Device pages manage machines (system, worker, accounts, skills, resources, settings), not workspaces, and link to the device's group.
- Customize shared or third-party UI only through public props, variants, slots, `className` or `style`, and style your own elements. Never reach into a component's private DOM or classes, add `!important`, or repair CSS with JS measurement. If the API is insufficient, extend the shared component's API and its own stylesheet; lay out with CSS grid/flex/min-width/wrapping.
- Use the primitives in `apps/web/src/components/ui` (`Checkbox`, `TextInput`/`Textarea`, `Button`, `SelectMenu`, `ActionRow`…); never rebuild a native control (checkbox, switch, radio, input, textarea, select, button, menu, dialog) from `<div>`/`<span>`, bespoke borders, fake checkmarks or click handlers. Style only through documented props/variants/`className` and shared tokens.
- Hover, focus and press never move content: an interaction-only affordance floats out of flow (zero-size anchor plus `position: absolute`) or keeps its space at rest (`audit:state-layout` enforces it).
- Verify changed interactions in a real browser (keyboard, active/inactive, busy/error, light/dark, narrow) and record evidence and limitations.
- Device accounts and model providers (server API endpoints) are equal, discoverable choices, not buried sections; each runtime appears once, its details holding status and defaults; hints and fields get a deliberate vertical gap.
- Never claim an official account is valid online from cached identity alone: show the native configuration being read, distinguish local login from verified usage, never silently change the execution account. Official model pickers are selection-only and share controls with server connections.

## Active conversation UX delivery

When continuing the conversation-driven Issue / Evidence UI work, read `docs/foundry-conversation-release-gate.md` in full before acting and again after every compaction: it is the person's approved feature release gate, not a test Issue's contract. Record acceptance evidence in the PR or change notes, not in that file, and do not claim completion without its real-browser checks.

## Agent provider access

Every model request (any inference) goes through the agent's own SDK or CLI: Claude Agent SDK / Claude Code for Claude, Codex SDK / CLI for Codex. Never call inference endpoints (`/messages`, `/responses`, `/chat/completions`) directly or probe provider health with stored credentials. The one exception (approved 2026-09-16): a profile's endpoint may be asked for `/models`, a metadata read, since no CLI can list a compatible endpoint's catalog.

## Where things live

Pointers, not specs; read the code first. Paths from the repo root.

- New page and sidebar entry: `apps/web/src/app/navigation.ts` (view, path, `pageViews`, `navSections`), `App.tsx`, `app/use-app-route-sync.ts`, `app/view-error-policy.ts`, `components/ui/page-surface.tsx`; copy Connectors. Its body is `apps/web/src/features/<name>/`, public only via `index.ts`; features never import each other or `app/` (`apps/web/src/ARCHITECTURE.md`). Tabs: a route field in `navigation.ts` (`connectorTab` → `/connectors/<tab>`) drawn with `components/ui/segmented-control.tsx`.
- i18n: `apps/web/src/i18n/locales/{en,zh-CN}/<ns>.ts`, namespaces in `i18n/resources.ts`; both locales in one change, no literal copy in TSX. Document title: `app/use-document-title.ts`. Features open other pages only through `apps/web/src/lib/in-app-navigation.ts`.
- UI primitives in `apps/web/src/components/ui/` (extend their props). CSS: `--fdy-*` tokens in `src/styles/00-foundation.css`; area sheets `styles/NN-*.css`, imported by `src/styles.css`.
- Web checks in `apps/web`: audits `scripts/audit-*.mjs` (all: `pnpm audit:ui`), `pnpm typecheck`, one test: `node --import ./test/register-bundler-resolve.mjs --test test/<f>.test.mjs`.
- Protocol types in `packages/protocol/src/`; consumers read `dist/`, so run `pnpm --filter @bd777/foundry-protocol build` after edits.
- Server: routes in `apps/server/internal/httpapi/routes.go`, each with an access rule; session-token reach is `agentRouteAllowed` in `policy.go`; MCP tool schemas in `httpapi/mcp_tools.json` (embedded), handlers `mcp*.go`. Store: `internal/store/` (interfaces, models), `internal/sqlitestore/<area>.go` with `setup<Area>` migrations; every `foundry-server` run migrates its DB, so always set `FOUNDRY_DB_PATH`.
- Worker: `packages/worker/src/cli.ts` (`foundry-worker`), `foundry-cli.ts` (`foundry`), `daemon-connection.ts` (server link). Bare `node --test` writes into the real `~/.foundry`: test in `packages/worker` with `node scripts/run-worker-tests.mjs -- <f>.test.mjs`.
- Foundry skill: `packages/worker/skills/foundry/` = `apps/server/internal/builtinskills/foundry/`, byte for byte (`packages/worker/test/foundry-skill.test.mjs`). Docs: `docs/`.

Working fast:

- Batch independent reads, greps and checks in one turn.
- Before reporting, run `scripts/check-changed.sh --files <your files>` once (`--list` shows the plan; `--since "$START"` also catches other agents' edits). Heavy checks on another device: `scripts/remote-check.sh <device> [--files …]`. Full `pnpm verify` only for release PRs.
- Scratch stacks (optional): `scripts/scratch-stack.sh up|shot|down <name>`. A server on a DB copy acts on its integrations (a second Feishu bot, Connectors refreshes rotating real tokens) unless `FOUNDRY_INTEGRATIONS=off`, which the script sets.
