# foundry

Foundry workers should treat this workspace context as authoritative.

- Workspace evolves.
- Skills accumulate.
- Workers do not remember.

## Foundry iteration workflow

- Choose a new session's model and reasoning effort for the task. Prefer Astra
  with high effort for complex iterations; use xhigh only with a concrete reason
  for the extra cost. Do not change already-running sessions just to apply this default.
- Start from the person's problem; inspect the code and incident evidence, and
  research established solutions when useful. Explain the cause and proposed fix;
  ask for decisions when a real product or implementation tradeoff needs the person.
- Work on local `main` by default. Inspect existing changes and active sessions
  before editing; preserve other work. One owner should handle tightly coupled
  changes. Reconcile existing branch/worktree work without discarding either side.
- Check free disk space before and after large builds, package staging and database
  backups. Below 10 GiB free or above 90% usage, reclaim verified disposable caches
  before substantial new writes; below 5 GiB free or above 95%, defer large writes
  until space is recovered. Coordinate cleanup with active builders. Never delete
  database/WAL files, user work, active temporary files or the only rollback copy.
  Prefer reuse over duplicate dependency trees and database snapshots.
- Separate Git submission from implementation and validation. A restriction on
  commits does not block local edits, builds, deployments, API/browser checks or
  other validation that creates no Git commits. Continue all independent work.
  If a test flow itself creates commits (for example candidate sealing or Accept),
  identify the exact step, target repository and dependencies; defer only the
  affected steps under the applicable instruction, not the whole validation phase.
  Do not alter product semantics or erase Git history to evade a restriction.
  Keep private submission arrangements in session context, not repository files.
- Build and deploy affected dev Server/Web components directly; this is authorized
  without another approval. Preserve active sessions and check service health after
  restart. Deployment need not wait for a commit.
- Update Worker/daemon yourself when authorized and safe. Verify the actual loaded
  execution host, not only the installed package. If permission is missing or the
  update would interrupt active sessions, explain the impact and ask the person to
  perform or approve that update; do not force-stop their work.
- Verify the change yourself with appropriate tests, API requests and real-browser
  end-to-end checks. The person's dev account is authorized for validation; use
  clearly scoped synthetic data and preserve unrelated work. Alternatively reuse
  a dedicated test account: record its non-secret identity/environment in
  `docs/devlog/test-environment.md`, with credentials kept outside the repository.
- Keep `docs/devlog/README.md` current by item. After self-verification, archive the
  problem, investigation, fix, deployment/version evidence, checks and limitations
  in `docs/devlog/DEV-NNN-topic.md` (link existing detailed records rather than
  duplicating them). Give the person concrete acceptance steps and expected results.
  Human acceptance is the default. The person may explicitly delegate release
  acceptance to an Agent; then close only the verified scope, record the delegation
  date/source and Agent evidence in the item's timeline, and retain unresolved
  limitations. Never describe delegated acceptance as the person testing it.
  A finished session is not a finished delivery.

## UI interaction and component principles

- Make every action discoverable: use visible labels, chevrons or action
  icons, and intentional hover, keyboard-focus, selected, disabled, busy and
  error states. Do not rely on hover-only controls or color alone.
- Keep frequent navigation compact and flat. Do not nest cards inside cards
  for switchers or lists. Device/workspace selection belongs in a dedicated
  application page; sidebar entries use forward arrows, not dropdown arrows.
  Use restrained spacing, one surface boundary, and a distinct selected
  fill/checkmark. Selected and hovered items must remain distinguishable
  when visible simultaneously, in both themes. Do not stack
  selection borders, inset bars, badges and heavy focus rings. Visual
  acceptance is separate from functional/test success; inspect at normal
  scale in the full page, not only enlarged component screenshots.
- Distinguish browsing, selection and management. Browsing a device never
  changes the active location. Commit device + workspace together only after
  an explicit workspace choice succeeds; cancel/failure preserves context.
- One page per object. The Workspaces page (the sidebar location entry)
  lists every workspace grouped by its device: Switch is the only action that
  changes the active location; adding a folder sits on its device group,
  rename/remove in the row menu with explicit destructive-action copy.
  Devices pages manage machines (system, worker, accounts, skills,
  resources, settings), not workspaces; they link to the device's group.
- Customize shared/third-party UI through public props, variants, slots,
  `className` or `style`. Style classes attached to your own elements.
  Never reach through a component's private DOM/class structure, inject
  `!important` overrides, or use JS measurements/mutations to repair CSS.
- If the public API is insufficient, improve the shared component's explicit
  API and its owned stylesheet; do not add consumer-side hacks. Use CSS
  grid/flex/min-width/wrapping for layout, not JS size calculations.
- Prefer UI-library primitives over hand-drawn controls. Never rebuild a
  native control (checkbox, switch, radio, text input, textarea, select,
  button, menu, dialog) out of `<div>`/`<span>` + bespoke borders, fake
  checkmarks, or click handlers — use the matching component in
  `apps/web/src/components/ui` (e.g. `Checkbox`, `TextInput`/`Textarea`,
  `Button`, `SelectMenu`, `ActionRow`). Apply look-and-feel only through the
  component's documented props/variants/`className` and shared CSS tokens;
  never scoped one-off box/border/icon markup that imitates a control.
- Verify changed interactions in a real browser: keyboard, active/inactive,
  busy/error, light/dark and narrow layouts. Record evidence and limitations.
- Device accounts and model providers (server API endpoints) are equal, discoverable choices,
  not vertically buried sections. Each runtime appears once; its details
  contain status and defaults. Hints and fields need a deliberate vertical gap.
- Never claim an official account is online-valid from cached identity alone.
  Show the native configuration being read, distinguish local login from
  verified usage, and do not silently change the execution account. Official
  model pickers are selection-only and share controls with server connections.

## Active conversation UX delivery

- When continuing the conversation-driven Issue / Evidence UI work, read
  `docs/foundry-conversation-release-gate.md` in full before task actions.
- Re-read that file after every context compaction; it is the user-approved
  Foundry feature release gate, not a test Issue's contract.
- Record acceptance evidence in the PR or change notes, not in that file. Do
  not claim completion without the real-browser acceptance checks it requires.

## Agent provider access

- User requirement: every model _request_ — completions, messages, responses, any inference — must go through the agent's own SDK or CLI: Claude Agent SDK / Claude Code CLI for Claude, Codex SDK / CLI for Codex.
- Never call provider inference endpoints directly (`/messages`, `/responses`, `/chat/completions`), and never probe provider health or diagnostics with stored credentials.
- Catalog listing is the one sanctioned exception, approved 2026-09-16: a profile's configured endpoint may be asked for `/models`, because no native CLI can enumerate a compatible endpoint's catalog. It is a metadata read, never inference.

## Where things live

Pointers, not specs: read the code there first. Paths are from the repo root.

- New page + sidebar entry: `apps/web/src/app/navigation.ts` (view, path, `pageViews`,
  `navSections`), `App.tsx`, `app/use-app-route-sync.ts`, `app/view-error-policy.ts`,
  `components/ui/page-surface.tsx`; copy Connectors (`grep -rl connectors apps/web/src`).
  The body is `apps/web/src/features/<name>/`, public only via `index.ts`; features never
  import each other or `app/` (`apps/web/src/ARCHITECTURE.md`).
- Tabs in a page: a route field in `navigation.ts` (`connectorTab` → `/connectors/<tab>`)
  drawn with `components/ui/segmented-control.tsx`.
- i18n: `apps/web/src/i18n/locales/{en,zh-CN}/<ns>.ts`, namespaces in `i18n/resources.ts`;
  both locales in one change, no literal copy in TSX.
- Document title: `app/use-document-title.ts`. Features open other pages only through
  `apps/web/src/lib/in-app-navigation.ts`.
- UI primitives `apps/web/src/components/ui/` (extend their props). CSS: `--fdy-*` tokens in
  `src/styles/00-foundation.css`; area sheets `styles/NN-*.css`, imported by `src/styles.css`.
- Web checks, in `apps/web`: audits `scripts/audit-*.mjs` (all: `pnpm audit:ui`), `pnpm typecheck`,
  one test: `node --import ./test/register-bundler-resolve.mjs --test test/<f>.test.mjs`.
- Protocol types: `packages/protocol/src/`; consumers read `dist/`, so run
  `pnpm --filter @bd777/foundry-protocol build` after edits.
- Server: routes in `apps/server/internal/httpapi/routes.go`, each with an access rule;
  session-token reach is `agentRouteAllowed` in `policy.go`; MCP tool schemas in
  `httpapi/mcp_tools.json` (embedded), handlers `mcp*.go`.
- Store: `apps/server/internal/store/` (interfaces, models), `internal/sqlitestore/<area>.go`
  with `setup<Area>` migrations. Every `foundry-server` run migrates its DB: always set
  `FOUNDRY_DB_PATH`.
- Worker: `packages/worker/src/cli.ts` (`foundry-worker`), `foundry-cli.ts` (`foundry`),
  `daemon-connection.ts` (server link). Bare `node --test` writes into the real `~/.foundry`;
  test in `packages/worker` via `node scripts/run-worker-tests.mjs -- <f>.test.mjs`.
- Foundry skill: `packages/worker/skills/foundry/` = `apps/server/internal/builtinskills/foundry/`,
  byte for byte (`packages/worker/test/foundry-skill.test.mjs`). Docs: `docs/`.

Working fast:

- Batch independent reads, greps and checks in one turn.
- Before reporting run `scripts/check-changed.sh --files <the files you changed>` once
  (`--list` shows the plan); `--since "$START"` also catches other agents' edits.
- Heavy checks on another device: `scripts/remote-check.sh <device> [--files …]` (session token; device's owner allows remote commands).
- Full `pnpm verify` only for release PRs.
- Scratch stacks (a shortcut, not a requirement): `scripts/scratch-stack.sh up|shot|down <name>`.
  A server on a DB copy acts on its integrations (a second Feishu bot connection, Connectors
  refreshes rotating the real tokens) unless `FOUNDRY_INTEGRATIONS=off`, which the script sets.
