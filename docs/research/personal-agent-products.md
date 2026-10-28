# Personal Agent research: how others build personal agents / orchestrators

As of 2026-10-15. **[U]** = unverified: from secondary or vendor-adjacent sources, or primary pages that disagree. Anything without [U] was read on a primary page (vendor docs or blog). This is a sample of notable products, not an exhaustive survey.

## 1. Per-product findings

### OpenClaw (ex-Clawdbot/Moltbot), the reference "personal agent via chat apps"

- **Owns vs delegates:** One gateway process. Each agent owns a workspace (AGENTS.md operating rules, SOUL.md persona, USER.md person profile, IDENTITY.md, MEMORY.md curated long-term memory, `memory/YYYY-MM-DD.md` daily logs, `skills/`), an auth/model dir, and a session store ([workspace](https://docs.openclaw.ai/concepts/agent-workspace), [multi-agent](https://docs.openclaw.ai/concepts/multi-agent)). It hands coding off to Claude Code, Codex or Pi through a `coding-agent` skill (background process) or ACP `sessions_spawn` **[U]** ([community listing](https://getclawkit.com/skills/official-openclaw-coding-agent), [cookbook](https://cookbook.solomonneas.dev/ai-stack/sub-agent-patterns/)).
- **Routing:** Static **bindings** map a channel, account, peer or guild to an agent. Most-specific wins (peer > parent peer > guild+roles > … > channel > fallback owner). Within a tier, config order decides. Agents can reach each other's sessions unless `tools.agentToAgent` restricts it ([multi-agent](https://docs.openclaw.ai/concepts/multi-agent)). Routing is configuration, not model judgment.
- **Creates environments:** `openclaw agents add`. A first-run `BOOTSTRAP.md` ritual writes the identity. The agent edits its own workspace files.
- **Confirmation:** None built in. The workspace "is not a sandbox" unless sandboxing is enabled.
- **Entry points:** WhatsApp, Telegram, Slack, Discord, iMessage and others.
- **Proactivity:** A **heartbeat** runs a full turn every 30–60 min, returns `NO_REPLY` when nothing matters, respects `activeHours`, and goes to the owner DM, never a group. `isolatedSession` cuts a turn from ~100K to 2–5K tokens ([heartbeat](https://docs.openclaw.ai/gateway/heartbeat)).
- **State scoping:** MEMORY.md loads only in the private main session, not in group chats.
- **Failures:** Summer Yue (Meta) told it "confirm before acting". Context **compaction dropped the instruction** and it bulk-deleted her inbox. "I couldn't stop it from my phone" ([Willison](https://simonwillison.net/2026/Feb/23/summer-yue/)). Other reports: 1-click RCE CVE-2026-25253, 341 to 1,400+ malicious ClawHub skills, tens of thousands of exposed instances **[U]** ([clawdocs](https://clawdocs.org/security/known-vulnerabilities), [InsiderLLM](https://insiderllm.com/guides/openclaw-security-report-january-2026/)). On cost, one audit found about 90% of spend came from context accumulation, heartbeats and tool output, not from requested work **[U]** ([fast.io](https://fast.io/resources/openclaw-token-usage/)). Microsoft's **Scout** (June 2026, M365 "Autopilot", reached through Teams) is reportedly built on OpenClaw **[U]** ([itelio/MC1332811](https://www.itelio.com/en/microsoft-message-center/MC1332811)).

### Hermes Agent (Nous Research)

- **Memory:** Two tiny files. MEMORY.md (environment and lessons) is capped at 2,200 chars and USER.md (the person) at 1,375. Both are injected as a **frozen snapshot at session start**. The agent edits them with `add/patch/remove`. When a write would exceed the cap it gets an error, so it must consolidate rather than silently drop. Past sessions sit in SQLite FTS5 for verbatim recall ([memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)). Honcho handles user modeling, and the agent writes and refines its own skills ([docs](https://hermes-agent.nousresearch.com/docs)).
- **Delegation:** `delegate_task` starts children with fresh context, plus only the goal, the context and project files. Only the final summary returns. Children cannot talk to the user, write memory, send messages or schedule cron jobs. Delegation is flat by default (depth 1), with 10 concurrent children ([delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)).
- **Confirmation:** Dangerous-command approval has three modes. `smart` (default) has an auxiliary LLM decide low, high or uncertain risk, and uncertain cases go to a human. The other modes are `manual` and `off`. A **hardline blocklist** cannot be overridden. In chat apps the person answers "yes/no", with a 300 s timeout that denies. "Always" approvals go to an allowlist, and suggested allowlist entries are never auto-applied ([security](https://hermes-agent.nousresearch.com/docs/user-guide/security)).
- **Entry points and auth:** 20+ chat platforms. Unknown DMs get a one-time **pairing code** that the owner approves. Default is deny.

### ChatGPT (OpenAI)

- **Memory and Projects:** Global memory has two parts: saved memories and implicit "reference chat history". **Project-only memory** isolates a project, so "Chats cannot reference conversations outside the project" ([Academy](https://academy.openai.com/public/resources/projects)). It reportedly has to be chosen when the project is created **[U]** ([memx](https://memx.app/blog/chatgpt-project-only-memory-control/)).
- **Pulse:** Overnight asynchronous research over memory, chat history, feedback and connected Gmail/Calendar, delivered as next-day cards. It requires memory ([help](https://help.openai.com/articles/12293630-chatgpt-pulse)).
- **Tasks:** Scheduled prompts that do _not_ reliably see project files or old chats, so the advice is to put needed facts into the task prompt **[U]** ([guide](https://blog.laozhang.ai/en/posts/chatgpt-scheduled-tasks-context-memory-tools)).
- **Agent mode to ChatGPT Work:** Agent mode had confirmations for high-impact actions, "watch mode" on sensitive sites, and refused bank transfers. The help page now says agent mode is retired in favour of **ChatGPT Work** (July 9, 2026) **[U]** ([help mirror](https://help-lb.openai.com/en/articles/11752874-chatgpt-agent)). Work runs hours-long projects locally (desktop) or in the cloud, uses plugins, and lets the person "review progress and approve key actions" **[U]** ([OpenAI](https://openai.com/index/chatgpt-for-your-most-ambitious-work/), [eWeek](https://www.eweek.com/de/news/openai-chatgpt-work-enterprise-ai-agent/)).
- **Codex routing from chat:** `@Codex` in Slack picks a workspace-shared cloud environment the user can access. Naming the repo helps. Follow-ups in the same thread continue the same task ([docs](https://learn.chatgpt.com/docs/third-party/slack)). An older doc version reportedly fell back to the most-recently-used environment when the request was ambiguous **[U]** ([eesel](https://www.eesel.ai/blog/openai-codex-integrations-with-slack)). The current page instead says to resolve the problem and retry.
- **Failures:** memory **bleed** across topics; a large project drowning out a small one **[U]** ([forum](https://community.openai.com/t/memory-not-updating-in-chatgpt-4o-issue-persists-across-conversations/1105721)).

### Claude (Anthropic)

- **Memory:** "Claude creates a separate memory for each project." Memory is a viewable and editable summary, with incognito chats and import/export ([blog](https://claude.com/blog/memory)).
- **Claude Code orchestration:** Subagents are selected automatically by matching the request to each subagent's **`description`** field. Each runs in its own context window with its own tool allow/deny list, and only its summary returns. Nesting goes up to 3 levels ([sub-agents](https://code.claude.com/docs/en/sub-agents)). **Agent teams** (experimental) add a lead session, teammates and a shared task list ([agent teams](https://code.claude.com/docs/en/agent-teams)).
- **Entry points:** **Channels** (preview, March 2026) forward Telegram/Discord messages into a running local session via pairing codes; the session must be open and permission prompts don't work remotely **[U]** ([atcyrus](https://www.atcyrus.com/stories/what-are-claude-code-channels)). **Cowork Dispatch** (phone↔desktop, desktop must stay awake) is closed to new users, who are pointed to cloud sessions ([support](https://support.claude.com/en/articles/13947068-assign-tasks-to-claude-from-anywhere-in-cowork)).
- **Claude for Chrome:** Per-site permissions ("always allow" vs "ask"). It asks before publishing, purchasing or sharing personal data. Prompt-injection success fell from 23.6% to 11.2% with mitigations ([Anthropic](https://www.anthropic.com/news/claude-for-chrome)), which Willison called still unacceptable ([post](https://simonwillison.net/2025/Aug/26/piloting-claude-for-chrome/)).

### Gemini (Google)

- **Personal Intelligence:** Opt-in links to Gmail, Photos, YouTube and Search. Off by default, and the person chooses which apps ([blog](https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/)).
- **Daily Brief and Spark (May 2026):** Daily Brief is an opt-in morning agent working over connected apps. **Spark** is a 24/7 cloud agent with recurring tasks and triggers, user-taught skills and multi-app workflows. It is "designed to ask you first before … spending money or sending emails". Planned additions: MCP connectors, texting/emailing Spark, and custom sub-agents ([blog](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)).
- **Jules:** The person picks the repo and branch. Jules produces a plan that is "review[ed] and approve[d] … before any code changes". It notifies "when the task completes or needs your input" ([docs](https://jules.google/docs)). Astra, Mariner and Gems: no current primary material found **[U]**.

### Microsoft Copilot

- Editable consumer memory (Fall 2025) **[U]** ([Redmond](https://redmondmag.com/articles/2025/10/27/microsoft-brings-expanded-memo-copilot.aspx)). **Copilot Tasks** (background cloud computer, Feb 2026) is migrating to **Copilot Cowork** ([support](https://support.microsoft.com/en-us/microsoft-365-copilot/learning/changes-microsoft-copilot-app)). Scout: see OpenClaw.

### Manus

- From the [context-engineering post](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus): KV-cache hit rate is "the single most important metric" (stable, append-only prefixes); mask tools rather than remove them; **file system as memory** with restorable compression; recite goals in `todo.md`; leave errors in context; sub-agents isolate context.
- One report says Manus later replaced `todo.md` with a planner agent because about 1/3 of actions went to todo updates **[U]** ([Lance Martin](https://rlancemartin.github.io/2025/10/15/manus)).

### Devin (Cognition)

- A **coordinator session** "scopes the work, monitors progress, resolves conflicts, and compiles results" across managed child Devins, each in its own VM. By default it starts children **without asking**, and the person can turn off "Auto-approve child sessions". It can also turn finished sessions into **playbooks**, maintain knowledge, and run scheduled sessions ([docs](https://docs.devin.ai/work-with-devin/advanced-capabilities)).

### Lindy

- iMessage, email, Slack and browser: "Same assistant, same memory, wherever you are"; default is draft, then the person sends ([blog](https://www.lindy.ai/blog/lindy-assistant-launch)). Memory is preset, user-added or agent-updated ([docs](https://docs.lindy.ai/fundamentals/lindy-101/memory)). A second-model **Validator** checks authorization before side effects **[U]** ([Zapier](https://zapier.com/blog/lindy-review/)).

### Letta (MemGPT)

- Typed **memory blocks** that can be shared across agents and edited through tools, so an edit by one agent is visible to the others immediately. **Sleep-time agents** consolidate memory in the background into "learned context" ([blocks](https://www.letta.com/blog/memory-blocks), [blog](https://www.letta.com/blog)). One customer kept "research state" in a block.

### Rabbit R1, Humane AI Pin, Apple Intelligence, Rewind/Limitless

- **Rabbit/Humane:** a general "Large Action Model" or voice-only device shipped little that worked; Humane shut down Feb 2025. Lesson: ship what you promise **[U]** ([Engadget](https://www.engadget.com/rabbit-r1-review-a-199-ai-toy-that-fails-at-almost-everything-161043050.html)).
- **Apple:** personal-context Siri, shown 2024, was delayed in March 2025 over quality and re-announced at WWDC 2026 on Gemini. Third-party actions go only through developer-declared App Intents **[U]** ([BGR](https://www.bgr.com/tech/apples-big-ai-powered-siri-upgrade-was-just-delayed-to-2026/), [MacRumors](https://macrumors.com/guide/wwdc-2026-what-to-expect)).
- **Rewind/Limitless:** capture-everything recall; Meta acquired it Dec 2025 and disabled capture ([TechCrunch](https://www.techcrunch.com/2025/12/05/meta-acquires-ai-device-startup-limitless/)). Recall without action was not a durable product.

### Open-source alternatives

- **nanobot** (token budgets) and **NanoClaw** (about 500 lines, containers by default) react to OpenClaw's attack surface and cost **[U]** ([DataCamp](https://www.datacamp.com/blog/nanoclaw-vs-openclaw)).

## 2. Cross-cutting patterns

1. **Thin personal layer, thick delegates.** The personal layer owns identity, the person profile, routing, memory and the inbox/outbox. Execution happens in isolated children that get fresh context and return summaries only: Hermes `delegate_task`, Claude Code subagents, Devin's coordinator, OpenClaw's coding-agent skill. Children usually **cannot talk to the user or write shared memory** (Hermes).
2. **Two memory tiers with hard scoping.** A small, capped person profile is always in context (Hermes 1,375 chars; OpenClaw USER.md 4,000 chars). Project or workspace memory is isolated (Claude per-project, ChatGPT project-only). Searchable history is retrieved on demand (Hermes FTS5), not injected. Private memory is withheld from group contexts (OpenClaw).
3. **Routing is mostly deterministic, model-assisted at the edge.** Examples: chat-binding tables (OpenClaw), explicit naming plus thread continuity (Codex in Slack), and description-matching for delegation (Claude Code). Nobody we found lets a model silently decide _where_ side-effecting work lands without a visible or declared target.
4. **Plan-then-approve for anything that creates work or environments.** Examples: Jules's plan approval, Devin's optional child-session approval, Codex environment setup that "asks you when something is missing" **[U]**.
5. **Graduated confirmation.** Typical shape: read and draft are free, external or irreversible actions are gated, and some categories are hard-blocked. Implementations: Hermes manual/smart/off plus blocklist, Claude for Chrome per-site, Spark and Lindy for money and email.
6. **Proactivity is a digest, not a stream.** Pulse, Daily Brief and the OpenClaw heartbeat run on a schedule or event, suppress output when nothing matters, deliver to the owner DM, and respect active hours.
7. **Chat apps are first-class entry points**, paired to a user by codes and allowlists (Hermes, Channels), hosted server-side because "laptop must stay awake" fails (Dispatch, Channels).
8. **Procedural memory accrues** as skills and playbooks from successful runs (Hermes, Devin, Spark).

## 3. Anti-patterns and failure modes

- **Safety rules kept only in context.** A compaction summary dropped "confirm before acting", leading to mass deletion (Yue/OpenClaw).
- **No out-of-band stop.** The person could not halt the agent from a phone.
- **Lethal trifecta.** A personal agent that reads untrusted content, holds private data and can communicate outward is exploitable by design ([Willison](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)). Even 11% injection success is too high.
- **Unvetted skill marketplaces and exposed gateways** (OpenClaw CVEs and ClawHub).
- **Always-on cost blowups.** Heartbeats are full turns, and context accumulation dominates spend.
- **Memory bleed.** Global implicit memory mixes projects, and big projects drown out small ones (ChatGPT reports). Memory that can't be inspected loses trust. Every major vendor added view, edit and incognito controls.
- **Context-poor background jobs.** Scheduled tasks that don't see project context produce generic output (ChatGPT Tasks).
- **Overpromising breadth** (Rabbit, Humane, Siri delays).
- **Default auto-spawn without visibility** (Devin's default): fine in sandboxes, risky on real devices.

## 4. Recommendations for Foundry's Personal Agent

1. **Make the PA a router and supervisor, never the executor.** It should own:
   - a person profile (small, capped, editable),
   - a **workspace registry** of per-workspace cards (purpose, repo, device, runtime/account, open sessions, last state summary, open commitments),
   - the inbox (web plus chat) and the outbox.

   All file and shell work goes to Claude Code / Codex sessions in the target workspace through existing Foundry session tools. This also satisfies the "all inference via the agent's own SDK/CLI" rule: the PA itself is a Claude Code or Codex session with no shell or filesystem tools (Hermes leaf/child model, Claude subagent tool lists).

2. **Route deterministically first, then by model, then ask.** Order:
   1. Explicit mention of a workspace or session.
   2. Reply or thread continuity: a reply to a session's message goes to that session, as in Codex threads.
   3. Chat binding: a Feishu group bound to a workspace, as in OpenClaw bindings.
   4. Model match against workspace-card descriptions, as in subagent `description`.
   5. If confidence is low, ask with a pick list of 2–4 workspaces plus "new workspace".

   Never silently fall back to "most recent" for work that writes. Always echo the decision in the reply ("→ foundry on dev-server, new Claude Code session"), so a misroute is visible and correctable in one reply.

3. **Graduate autonomy by action class, enforced by the platform rather than by the prompt.**
   - **Free:** read status, summarize, draft, ask, start read-only investigations.
   - **Act, then report:** start or steer sessions in an existing workspace the person uses.
   - **Confirm (one tap, with a plan):** create, rename or remove a workspace; add a folder; switch device, runtime or account; push, deploy or send outside Foundry.
   - **Never:** the hardline list.

   This matches AGENTS.md (commit device + workspace only after an explicit choice). Store standing instructions ("always confirm X") as **structured policy** checked server-side, so compaction cannot erase them.

4. **Provide a hard stop that bypasses the model.** "stop" or "停" in any channel cancels the PA's and its children's in-flight sessions through the server (`cancel_session`), not through a model turn.
5. **Scope memory and keep it inspectable.**
   - The person profile is always loaded and capped (Hermes caps fail loudly, which forces consolidation).
   - Workspace memory stays in the workspace's own AGENTS.md / Workspace Memory. The PA reads it on demand and doesn't copy it, to avoid two sources of truth.
   - Private memory is excluded when the PA answers in group chats.
   - A UI page shows what the PA remembers and lets the person edit it.
6. **Build the composed view from data, not probing.** Summaries come from worker-reported events and transcripts, updated on events. No periodic model check-ins on devices (OpenClaw heartbeat cost). Use a model only to summarize deltas, with a cache-stable prefix (Manus).
7. **Supervise with summaries and escalations.** Children return final summaries. The PA tracks commitments and escalates only on needs input, failed, done-to-review, or stuck past a deadline (Jules: "completes or needs your input"). Children never message the person directly: one voice, one dedup point.
8. **Make proactivity opt-in digests.** Use a daily or on-demand "state of my workspaces" brief with nothing-to-report suppression, active hours, owner DM only, and an isolated cheap context (Pulse, Daily Brief, OpenClaw `NO_REPLY`/`activeHours`).
9. **Break the trifecta structurally.** The PA reads untrusted content and knows private state, so its only egress is replying to the owner. Side effects happen in workspace sessions under their own permissions. Pair chat identities with codes and allowlists (Hermes, Channels). Skills only from the person's or the built-in set.
10. **Make workspace creation a plan:** device, path, clone source, runtime, account and initial instructions in one confirmation; cancel or failure preserves context; then the PA writes the new card.
11. **Ship narrow first:** routing, digests, and dispatch into existing workspaces; then creation; cross-workspace orchestration last. Measure misroutes and confirmation rate before widening autonomy.
