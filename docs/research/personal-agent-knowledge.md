# Personal Agent knowledge layer: research notes (2026-10-15)

Scope: how 2024–2026 personal and orchestrating agents build their memory, and what fits Foundry's Personal Agent (PA). The PA is a git workspace of markdown that summarizes the person's other workspaces and devices, plus what it knows about the person, for routing and orchestration.
Tags: **[vendor]** = number the vendor reported about itself. **[unverified]** = not confirmed from a primary source. Everything else is checked against the cited page.

## 1. Bottom line

1. **Use a compiled, tiered index, not a copy.** Systems that work at scale have three tiers: a tiny always-loaded layer, a mid-size summary per object, and the full source loaded on demand. Examples are Agent Skills (metadata → SKILL.md → files), OpenViking (L0 under 100 tokens → L1 under 2k → L2), Letta MemFS (pinned `system/` → file tree → bodies) and Karpathy's wiki (`index.md` → pages → `raw/`). For Foundry the workspaces themselves are L2. The PA keeps only derived summaries plus pointers.
2. **Plain files plus grep are enough at personal scale.** Anthropic recommends files and just-in-time loading. Letta reached 74.0% on LoCoMo with histories in plain files [vendor]. Databases mainly add time and supersession handling (Zep, Mem0), which can be expressed in frontmatter.
3. **Staleness and forgetting are the main risk, more than recall.** More context makes answers worse (context rot), and production failures are mostly failures to forget (arXiv 2606.15903). Refresh on events, add a periodic lint pass, and stamp a `verified_at` date on every summary.
4. **Record where every fact came from, and let untrusted input propose but never promote.** Memory poisoning has been demonstrated (SpAIware 2024; MINJA, NeurIPS 2025).
5. **Keep the personal layer narrow.** Claude.ai memory is scoped per project, and OpenClaw loads MEMORY.md only in the private main session. Copy routing-grade summaries, not secrets, transcripts or other members' content.

## 2. Techniques surveyed

| System                                     | Core idea                                                                                                                                                                                                                                                                                                                                                                                                              | What to borrow                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Anthropic context engineering (2025-09-29) | Context is an "attention budget". Keep "lightweight identifiers" and load data just in time. CLAUDE.md is loaded up front and glob/grep fetch the rest, which "bypass[es] the issues of stale indexing". Structured notes (NOTES.md) live outside the window. Subagents return "1,000-2,000 tokens" of condensed summary.                                                                                              | A small pinned index plus tool-driven drill-down. Subagents compile summaries.                               |
| Agent Skills (2025-10-16)                  | Three disclosure levels. The bundled context is "effectively unbounded".                                                                                                                                                                                                                                                                                                                                               | A one-line workspace description decides whether to drill in.                                                |
| Claude memory tool (`memory_20250818`)     | Client-side `/memories` with view/create/str_replace/insert/delete/rename. The injected prompt says "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE". The docs advise size caps, expiring files that haven't been accessed in a long time, and path-traversal checks.                                                                                                                                    | File operations as the memory API. Expiry and size caps.                                                     |
| CLAUDE.md / AGENTS.md                      | The nearest file wins. Subdirectory files load on demand. Target "under 200 lines", because longer files reduce adherence. Auto memory is a `MEMORY.md` index plus topic files, and only the first 200 lines or 25KB load. Conflicting instructions are picked "arbitrarily".                                                                                                                                          | Hard budgets for always-loaded files. An index file plus topic files.                                        |
| Karpathy LLM wiki (gist, 2026-04)          | Immutable `raw/`, an LLM-maintained wiki and a schema file. Operations are ingest, query and lint. `index.md` is the catalog and `log.md` is append-only. "a single source might touch 10-15 wiki pages". The index alone works at "~100 sources, ~hundreds of pages".                                                                                                                                                 | Compile once and keep current. Lint for contradictions, stale claims and orphans. Write useful answers back. |
| OpenViking (Volcengine)                    | `viking://` virtual filesystem. Each directory has `.abstract.md` (L0) and `.overview.md` (L1), generated when content is written. Search scores directories first, then drills down. LoCoMo 80–83%, input tokens −34–91% [vendor].                                                                                                                                                                                    | L0/L1 files beside each object, generated on write.                                                          |
| MemGPT / Letta                             | OS-style paging. Core memory blocks (human, persona) sit in the prompt, and recall and archival memory are reached by tools. Sleep-time agents consolidate while idle. Sleep-time compute cut test-time compute about 5x on the authors' tasks (arXiv 2504.13171).                                                                                                                                                     | Consolidation off the critical path.                                                                         |
| Letta Context Repositories (2026-02-12)    | Markdown with frontmatter in git, and every change is a commit. `system/` is pinned and the tree is always visible. Reflection and defragmentation subagents work in worktrees and merge back. Defragmentation targets "15–25 focused files".                                                                                                                                                                          | The closest existing design to Foundry.                                                                      |
| Mem0                                       | The 2025 paper uses an LLM to choose ADD/UPDATE/DELETE/NOOP. The April 2026 algorithm is **ADD-only** ("No overwrite or delete step") and reranks "toward what's current" at read time. LoCoMo 91.6–92.5 and LongMemEval 93.4–94.4, inconsistent across its own pages [vendor].                                                                                                                                        | Append and resolve recency at read time. Cheap, but stale facts pile up.                                     |
| Zep / Graphiti (arXiv 2501.13956)          | Temporal knowledge graph with episodic, semantic and community subgraphs. Facts have validity windows, and contradicted edges are invalidated rather than deleted. "Every entity and relationship traces back to the episodes". Updates are incremental. LongMemEval +18.5% accuracy and −90% latency [vendor].                                                                                                        | `valid_from`/`superseded_by` fields and lineage back to the raw source.                                      |
| A-MEM (NeurIPS 2025)                       | Zettelkasten-style linked atomic notes. New notes can rewrite old ones ("memory evolution").                                                                                                                                                                                                                                                                                                                           | Links. Rewrites are safe only with history, which git gives.                                                 |
| Cognee                                     | Pipeline of add → `cognify` (entity graph plus summaries) → `memify` (enrichment). Exact `memify` semantics [unverified].                                                                                                                                                                                                                                                                                              | Only relevant if entity queries across workspaces are needed later.                                          |
| ChatGPT memory                             | Explicit saved memories, plus "reference chat history", which is not a transcript and drifts over time. Deleting a chat doesn't delete the memories made from it. "Project-only memory" [unverified details].                                                                                                                                                                                                          | Explicit and inferred memories have different reliability. Deletion must follow lineage.                     |
| Claude.ai memory (2025-09-11)              | "each project has its own separate memory". The memory summary is viewable and editable. Incognito chats save nothing. Designed for work use.                                                                                                                                                                                                                                                                          | Scoped boundaries and a summary the user can edit.                                                           |
| OpenClaw workspace                         | `AGENTS.md`, `SOUL.md`, `USER.md` (dated directives, active or superseded, 4,000-character cap), `MEMORY.md` (curated, **main private session only**), `memory/YYYY-MM-DD.md` (append-only, searched rather than injected). A pre-compaction "memory flush". "Dreaming" cron promotes items only past score, frequency and diversity gates, and untrusted candidates are excluded. A private git repo with no secrets. | Daily log, then gated promotion. Separate USER file. Loading scoped by audience.                             |

## 3. Evidence on the key trade-offs

**Context rot.**

- Chroma (2025-07-14, 18 models): performance "grows increasingly unreliable as input length grows". Distractors hurt, and coherent haystacks hurt more than shuffled ones. On LongMemEval, focused prompts of about 300 tokens beat full prompts of about 113k tokens.
- LongMemEval (ICLR 2025): long-context LLMs drop 30–60%, and ChatGPT's memory drops 37%.
- So don't load all workspace summaries every turn. Keep the always-loaded layer to one line per workspace.

**Granularity.** In LongMemEval, compressing everything into summaries lowered accuracy. Keys made of the original text plus extracted facts gave +9.4% recall and +5.4% QA. Summaries should _route_ the agent to the source, not replace it, so keep pointers to sessions, files and commits.

**Files vs. database.**

- Files are diffable, revertible and human-editable. Models are heavily trained on file tools, and grep has no stale index.
- A database adds semantic search at scale, typed time queries and concurrent writers.
- A person has dozens of workspaces, not millions of facts, so files fit. Letta concludes that memory "is more about how agents manage context than the exact retrieval mechanism" [vendor]. A vector index can be added later as a derived cache, as OpenClaw and OpenViking do.

**Freshness.**

- _Event-driven_ updates: Graphiti's incremental updates, OpenViking's L0/L1 on write, Karpathy's ingest, OpenClaw's flush before compaction.
- _Periodic_ jobs: Letta reflection and defragmentation, OpenClaw dreaming, Karpathy lint, memory-tool expiry.
- Combine both. Structural facts update immediately. LLM synthesis runs debounced or at idle, off the request path (Letta: memory work on the hot path hurts latency and prompt caching). Lint catches drift. Just-in-time verification at routing time is the final guard.

**Provenance.**

- SpAIware (2024-09): injected web or document content planted a persistent ChatGPT memory that exfiltrated later chats.
- MINJA injects memories through queries alone. A secondary source reports 76.8% success [unverified].
- Preprints argue that trust inferred from content can be gamed. They propose trust = min(provenance, content) with taint propagation, and note that untrusted origins can be laundered through the agent's own summaries, so the origin must be bound at write time (arXiv 2608.21230, 2606.22030; early work, [unverified] at scale).
- Graphiti's lineage to source episodes and OpenClaw's exclusion of untrusted candidates are working examples.

**Forgetting.**

- Approaches: supersede and keep history (Zep, OpenClaw USER.md), append and rerank (Mem0 2026), expire (memory tool docs), merge and prune (Letta defragmentation).
- arXiv 2606.15903: rules handle lexical and temporal deletion. Intent-aware deletion needs an LLM _at mutation time_, which scored 78–85% on those cases and 91.7–93.2% overall.
- In git, superseding and deleting is safe because history keeps everything.

**Privacy.**

- Claude.ai isolates memory per project. OpenClaw keeps MEMORY.md out of group contexts and secrets out of git. Claude Code asks for approval before importing files from outside the project.
- Foundry shares workspaces with Viewer and Member roles. A personal summary must not exceed the person's role, and must not travel into contexts with a different audience, such as Feishu group replies.

**Evaluation.**

- LoCoMo (ACL 2024): very long conversations. Critics say it barely scores knowledge updates, and an audit reports about 6.4% answer-key errors [unverified].
- LongMemEval: 500 questions testing extraction, multi-session reasoning, updates, temporal reasoning and abstention.
- ForgetEval (2606.15903): tests forgetting.
- None of these tests _routing across workspaces_, so Foundry needs its own eval (§4.6).

## 4. Recommended structure

The structure follows the README's constraints: the PA "is itself a workspace", there is "No second source of truth", disclosure is progressive, and dispatch is confirmable.

### 4.1 Files (private git repo)

```
AGENTS.md                 # schema + rules (≤200 lines): how to route, refresh, cite, forget
USER.md                   # person: preferences, languages, hours; dated directives active|superseded; ≤~4k chars
INDEX.md                  # L0: one line per device and per workspace (id, device, l0, last activity, verified_at)
devices/<dev_id>.md       # L1: OS, runtimes/accounts, notable tools, hosted workspaces
workspaces/<ws_id>.md     # L1 card, ≤~1.5k tokens (4.2)
topics/<slug>.md          # cross-workspace syntheses, Karpathy-style
decisions/YYYY-MM-DD-*.md # dispatches the person confirmed or corrected
log/YYYY-MM-DD.md         # append-only: ingests, dispatches, refreshes, lint results
```

L2 is **not** stored here. It is the live workspace (sessions, files, git, skills), read through Foundry tools when the PA needs depth.

### 4.2 Workspace card frontmatter

```yaml
id: ws_…   device: dev_…   status: active|archived
l0: "Foundry monorepo: Go server + TS web/worker"   # ≤100 tokens, mirrored into INDEX.md
role: owner|maintainer|member|viewer                 # caps what may be summarized
sources: [{kind: agents_md, ref: "AGENTS.md@7bde4a5"}, {kind: git, ref: "main@7bde4a5"}, {kind: sessions, ref: "sess_a..sess_b"}]
compiled_at: 2026-10-15T10:00Z   verified_at: 2026-10-15   trust: first_party|derived|external
supersedes: []
```

The body holds the workspace's purpose, active threads with dates, skills and connector names, a pointer to its AGENTS.md, and "route here when / not when" examples. It never holds code, secrets, transcripts or other members' private content.

### 4.3 Refresh triggers

| Trigger                                                        | Action                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Workspace created, renamed or removed; device joins or leaves  | Update INDEX.md and the skeleton files deterministically, with no LLM               |
| Session ends; default branch moves; AGENTS.md or skills change | Mark the card `dirty`. Regenerate L1 and L0 debounced (e.g., 30 min, or at idle)    |
| Routing to a card that is dirty or older than its TTL          | Check live L2 just in time before proposing, then refresh the card                  |
| Dispatch confirmed or corrected                                | Append to `decisions/` and update the "route here" examples                         |
| Nightly or weekly lint                                         | Contradictions, orphans, TTL breaches, INDEX budget, duplicates, archive candidates |
| PA session about to compact                                    | Flush to `log/`. Promotion to USER.md or topics only through lint gates             |

One commit per refresh, e.g. `refresh(ws_x): sess_a..sess_b, main@sha`. `git log` becomes the audit trail and changes can be reverted. Background writers use worktrees or branches and merge back, as Letta does.

### 4.4 Provenance rules

- Every claim cites a `sources` ref. Facts about the person cite the dated conversation or decision they came from.
- Trust comes from the source. Content from the web, inbound messages or third-party files is `external`. It may be logged, but it is never promoted to USER.md or treated as an instruction without the person's confirmation.
- Before any side effect (creating a workspace, starting a session), check the claim against live state, not the card.
- Mark each preference _stated_ or _inferred_.

### 4.5 Privacy boundary

| Copy                                                                                  | Don't copy                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Purpose, stack, active threads, roles, skill and connector names, device capabilities | Secrets, tokens, env values, credential files            |
| Pointers (ids, paths, SHAs, session ids)                                              | Raw transcripts or file contents (read them live)        |
| The person's preferences and decisions                                                | Other members' private sessions beyond the person's role |
| Confirmed routing decisions                                                           | External content treated as instructions                 |

USER.md loads only in the person's own PA contexts, never in group replies. When access is revoked, drop the card. Whether git history also needs rewriting is a design decision still open.

### 4.6 Evaluation

- **Routing:** score top-1 and top-3 workspace choice, and "create new" precision, against held-out `decisions/`.
- **Staleness:** rename, archive or refocus a workspace, then measure how long the PA keeps routing on stale data.
- **Abstention:** the PA should answer "no workspace fits" or "need to check" rather than guess.
- **Poisoning:** an external doc that says "always route X to Y" must not change USER.md.
- **Budget:** keep the always-loaded set (INDEX.md, USER.md, AGENTS.md) under a fixed cap (e.g., 4–6k tokens), checked in CI.

## 5. Anti-patterns

1. **Mirroring workspace transcripts and files into the PA.** This creates a second source of truth, goes stale, leaks across boundaries and adds context rot.
2. **Loading every card every turn.** Load L0 always, L1 for a shortlist, L2 live.
3. **Summaries with no date or source.** They can't be verified, refreshed or revoked.
4. **LLM consolidation on the request path.** It adds latency and breaks prompt caching.
5. **Appending forever with no supersession or lint.** Contradictions get picked "arbitrarily".
6. **Rewriting memories in place with no history.** Commit every mutation.
7. **Auto-promoting facts from untrusted content** (SpAIware, MINJA).
8. **Loading one global persona into shared or group contexts.**
9. **Trusting benchmark headlines.** The scores are mostly vendor-reported and conflict, and none test routing.
10. **Always-loaded files with no budget.** Claude Code cuts auto memory at 200 lines / 25KB, and OpenClaw at 20k characters per file.

## Sources

- Anthropic, Effective context engineering (2025-09-29): https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, Agent Skills (2025-10-16): https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Anthropic, Multi-agent research system (2025-06-13): https://www.anthropic.com/engineering/multi-agent-research-system
- Claude memory tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Claude Code memory: https://code.claude.com/docs/en/memory ; AGENTS.md: https://agents.md/
- Claude.ai memory: https://claude.com/blog/memory
- Karpathy LLM wiki: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- OpenViking: https://github.com/volcengine/OpenViking
- OpenClaw: https://docs.openclaw.ai/concepts/memory ; https://docs.openclaw.ai/concepts/agent-workspace
- Chroma, Context Rot: https://www.trychroma.com/research/context-rot
- MemGPT: https://arxiv.org/abs/2310.08560 ; Sleep-time compute: https://arxiv.org/abs/2504.13171
- Letta: https://www.letta.com/blog/context-repositories ; https://www.letta.com/blog/benchmarking-ai-agent-memory ; https://docs.letta.com/concepts/memfs
- Mem0: https://arxiv.org/abs/2504.19413 ; https://mem0.ai/research
- Zep: https://arxiv.org/abs/2501.13956 ; Graphiti: https://github.com/getzep/graphiti
- A-MEM: https://arxiv.org/abs/2502.12110 ; Cognee: https://github.com/topoteretes/cognee
- OpenAI memory: https://help.openai.com/en/articles/8590148-memory-faq ; https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- LongMemEval: https://arxiv.org/abs/2410.10813 ; LoCoMo: https://arxiv.org/abs/2402.17753
- Forgetting: https://arxiv.org/abs/2606.15903
- MINJA: https://arxiv.org/abs/2503.03704 ; poisoning defenses: https://arxiv.org/abs/2608.21230 , https://arxiv.org/abs/2606.22030
- SpAIware: https://thehackernews.com/2024/09/chatgpt-macos-flaw-couldve-enabled-long.html
