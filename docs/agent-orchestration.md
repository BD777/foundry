# Orchestrating sub-sessions efficiently

[AGENTS.md](../AGENTS.md) · [Doc index](README.md)

What slowed or broke orchestrated work in practice (2026-11-10/11), and the rule each lesson became. The orchestrator plans, briefs, reviews every diff and screenshot, merges, batch-checks and deploys. Workers implement. Integration fixes also go to a worker; the orchestrator keeps its own context for management.

## Speed is context size

- Each model request resends the whole context. Above about 300k tokens a request took 10–50 s, and on a 1M-tokens-per-minute model id one request used most of the minute's quota. Measured: model time was 49 of 86 minutes in one slice and 101 of 110 in another, while commands took 19 and 6.
- Keep slices small and give each slice a fresh session. Never reuse a session for a redirect: one started at 226k tokens of history.
- Do not cap the model's context window to force compaction; compaction degrades the work. Split the work instead.
- Workers read with `rg -n` and then `sed -n 'a,bp'`, and truncate long output (`| tail -40`). Briefs name the files and functions to start from, so workers do not explore broadly.
- Spread sessions across model ids that have separate quotas. Heavy slices go to the id with the larger quota.

## Tests and builds

- Write everything first, then verify once; on failure rerun only the failing case. Do not test while implementing.
- Run targeted tests only: `go test -run`, named test files, at most one project typecheck. Do not run whole packages, `go test ./...`, full `pnpm test`, `pnpm verify`, or `-count=1` unless the request asks for that scope. Workers do not run `check-changed.sh`; the orchestrator runs one batch check per merged batch.
- A small machine (2 cores, 8 GB) thrashed to load 45 when several workers compiled at once. Prettier on touched files, gofmt, one small-package vet, one small JS test file and audits are light and run directly. Heavy work (project tsc, Vite build, Go build, large-package Go tests, Worker packs) goes to CanWendeMac-mini → byte-dev → byte-dev-sg through `scripts/remote-check.sh` / `remote-build.sh`. Remote compute is shared by default; runners use per-job checkouts over shared caches and a CPU/memory-sized counting slot, not a device lock, so a session can run several of its own jobs concurrently with `REMOTE_KEEP_LEASE=1`. `/tmp/fdy-heavy.lock` is only for heavy work actually running on sg-chaos, and is the last resort. Locks wrap one-shot commands only; a server or dev server started from the holding shell would inherit the descriptor and stall every worker.
- A foreground `sleep 300` or a blocking `--watch` holds the turn. Run long commands in the background and poll in short steps.
- A web test that compares a DOM node itself (`assert.equal(node, x)`) can hang the runner. Compare what the node shows instead, such as text, attributes or a boolean for presence.

## Worktrees and merging

- Baseline = the dev checkout's diff plus its untracked files, staged once. A worker's changes are then `git diff`: add new files with `git add -N`, and delete files with `rm`, never `git rm`, or the deletion vanishes from the diff.
- Save screenshots under the dev checkout's `.foundry/attachments/<task>/`, not inside a worktree. Merged worktrees are deleted, and answers would lose their images.
- Exclude generated files from patches and regenerate after merging (`node scripts/generate-contracts.mjs`).
- After merging a slice that started from an older baseline, take only that slice's own files; a whole-tree patch reverts newer work.
- A slice that leaves the tree unbuildable while it works (a cross-package refactor, a schema migration) runs in its own worktree and merges back when it builds and passes its tests. In the shared dev checkout every deploy ships whatever is in the tree: on 2026-11-12 another slice's Server deploy ran DEV-191's unfinished migration on dev before its owner had backed the database up, and two slices sat blocked on its compile errors.
- Topic-split PRs fail CI on files shared across topics (generated contracts, i18n, tests of a later topic). Land the verified final state as one PR and keep the topics apart in devlogs.
- CI runs checks that per-batch checks skip, such as `prettier --check .`, migration column classification and stale generated files. Run `generate-contracts --check`, the contract and module audits and `prettier --check` on the branch before pushing.

## Watching workers

- Watch each running worker's context size, average request time, test runs before the last edit, long-running commands and queue time. Agent session events record per-request `inputTokens` and `requestMs`.
- Intervene early: point a worker at the suspect code, stop rabbit holes (environment setup, unusual compiler tricks), and once context is large, have the worker deliver what it has and hand the rest to a fresh session.
- A worker never relaunches or restarts the person's apps to get a debug port, and never hands manual steps to the person. A missing capability becomes a Foundry change.
