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
- Work on local `main`. Inspect existing changes and active sessions first and preserve other work; one owner per tightly coupled change; reconcile branch/worktree work without discarding either side. Work that leaves the tree unbuildable for a while (a cross-package refactor, a migration) belongs in its own worktree: every deploy ships whatever is in `main`.
- Disk: check before and after large builds, package staging and DB backups. Below 10 GiB free or above 90% used, reclaim verified disposable caches first; below 5 GiB or above 95%, defer large writes. Coordinate cleanup with active builders. Never delete DB/WAL files, user work, active temp files or the only rollback copy. Reuse dependency trees and DB snapshots.
- Git submission is separate from implementation and validation: a commit restriction never blocks edits, builds, deploys or checks that create no commits. If a test flow commits (candidate sealing, Accept), defer only that step, naming the step, repository and dependencies. Never change product semantics or erase history to evade a restriction; keep private submission arrangements in session context, not in repository files.
- Done means verified and deployed. Deploy each verified change to dev right away (Server, Web, Workers; authorized, no commit needed): never wait for a commit, merge or human acceptance, which happens on the deployed build. Preserve active sessions and check health after a restart. Update Workers yourself with the MCP tool `update_worker` and verify the loaded execution host, not just the package; if that would interrupt sessions or needs permission, explain the impact and ask, never force-stop their work.
- Verify yourself: tests, API requests, real-browser end-to-end. The person's dev account is authorized with clearly scoped synthetic data that leaves unrelated work alone; or reuse a test account recorded (non-secret identity, environment) in `docs/devlog/test-environment.md`, with credentials outside the repo.
- Devlog: a finished session is not a finished delivery. Keep `docs/devlog/README.md` current per item; after self-verification record problem, investigation, fix, deployment/version evidence, checks and limitations in `docs/devlog/DEV-NNN-topic.md` (link, don't duplicate), with concrete acceptance steps and expected results. Human acceptance is the default. If the person delegates acceptance to an Agent, close only the verified scope, record date, source and evidence in the timeline, keep open limitations, and never describe it as the person testing.

## Read before specific work

Each line says when to read a file. Read it then, before you start; skip it otherwise.

- Changing anything under `apps/web` (pages, components, copy, styles, UI behaviour): [apps/web/AGENTS.md](apps/web/AGENTS.md): UI principles, where web code lives, web checks.
- Changing protocol types, contracts, Server routes or storage, MCP tools, the Worker or the Foundry skill; running checks, remote checks or scratch stacks: [docs/where-things-live.md](docs/where-things-live.md).
- Splitting work across sub-sessions, merging worktrees, batching tests: [docs/agent-orchestration.md](docs/agent-orchestration.md).
- Continuing the conversation-driven Issue / Evidence UI work: read `docs/foundry-conversation-release-gate.md` in full before acting and again after every compaction. It is the person's approved feature release gate, not a test Issue's contract. Record acceptance evidence in the PR or change notes, not in that file, and do not claim completion without its real-browser checks.

## Agent provider access

Every model request (any inference) goes through the agent's own SDK or CLI: Claude Agent SDK / Claude Code for Claude, Codex SDK / CLI for Codex. Never call inference endpoints (`/messages`, `/responses`, `/chat/completions`) directly or probe provider health with stored credentials. The one exception (approved 2026-09-16): a profile's endpoint may be asked for `/models`, a metadata read, since no CLI can list a compatible endpoint's catalog.

## Working fast

- Batch independent reads, greps and checks in one turn.
- Before reporting, run the tests and typecheck that cover what you changed; full batch checks run once per merged batch before deploy (commands in `docs/where-things-live.md`).
