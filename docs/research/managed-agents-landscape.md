# Managed Agents Landscape Research

Date: 2026-07-03

This note surveyed managed-agent products to understand their core logic, functional boundary, and what Foundry should borrow or deliberately avoid. The original pass also covered several non-public products; those analyses are omitted from this public copy, and their lessons appear below only as generic patterns. The Foundry implications (sections 6–9) are early positioning notes: current design lives in the [Workspace and Sandbox overview](../workspace-sandbox-overview.md) and the [README Roadmap](../../README.md#roadmap).

## 1. Executive Summary

The "managed agents" landscape is splitting into several layers:

1. **Managed runtime substrate**
   - Example: Claude Managed Agents, and several hosted runtimes built on the same shape.
   - Core job: host long-running agent sessions safely, with sandbox, event log, credentials, tools, files, and recovery.
   - They are infrastructure platforms. They do not usually own the product workflow around an evolving workspace.

2. **Agent factory and integration console**
   - Core job: let teams configure agents, prompts, tools, workflows, scheduled tasks, IM bots, OpenAPI integrations, evaluations, and operational dashboards.
   - They make agents easier to create and embed into business systems.

3. **Human-agent project management**
   - Example: Multica.
   - Core job: let humans assign issues to agents, watch progress, review blockers, and manage status.
   - They treat agents more like assignees or teammates.

4. **Cloud-local engineering workspace**
   - Core job: coordinate cloud agents, local coding agents, context, tasks, knowledge, and team collaboration.
   - The closest references to Foundry use a wiki plus requirement context as their source of truth. Foundry's intended source of truth is the workspace itself.

5. **Loop/workbench and system-agent layer**
   - Core job: make the agentic work loop explicit, observable, replayable, reviewable, and governed.
   - These matter because Foundry is not just "run an agent"; it is a durable loop where issue, artifact, review, feedback, and context compound.

Foundry's strongest differentiation should be:

- **Filesystem-native workspace context**: the workspace root, `AGENTS.md`, repos, artifacts, and history are the durable context body.
- **Issue/feedback loop**: every human input becomes triaged work; every result and review becomes new workspace context.
- **Resource leases as first-class objects**: Vite preview, deploy slot, simulator, device, database, browser, and repo write access should be scheduled explicitly.
- **Runtime-agnostic execution**: Foundry should use managed runtime contracts or local CLI adapters, not bake itself into one agent provider.

## 2. Public Sources

| Product               | Evidence quality | Notes                                            |
| --------------------- | ---------------- | ------------------------------------------------ |
| Claude Managed Agents | High             | Official Anthropic docs and engineering article. |
| Multica               | High             | Public website and GitHub repo.                  |

## 3. Product Analyses

### 3.1 Claude Managed Agents

Sources:

- https://platform.claude.com/docs/en/managed-agents/overview
- https://www.anthropic.com/engineering/managed-agents

**Core logic**

Claude Managed Agents defines a clean runtime abstraction for long-running, asynchronous agent execution. Its conceptual split is:

- **Agent**: the configured brain, prompt, instructions, and tools.
- **Environment**: the hands, usually an isolated execution context with files, commands, browser, and tool access.
- **Session**: the durable conversation and execution history.
- **Events**: the append-only protocol for user messages, agent actions, tool calls, tool results, status, and steering.

Anthropic's engineering framing is especially useful: separate **brain**, **hands**, and **session**. The harness manages context, state, and execution protocol outside the container, while the environment provides executable tools.

**Product functions**

- Create and configure agents.
- Create execution environments.
- Start long-running sessions.
- Send and stream events.
- Steer, interrupt, and resume sessions.
- Run secure commands, browse, read/write files, and use tools.
- Persist session state and filesystem state.
- Handle prompt caching, context compaction, and managed infrastructure.

**Implication for Foundry**

Claude Managed Agents is not a Foundry-like workspace product. It is a strong reference for the runtime contract under Foundry:

- Foundry should model `WorkerRuntime`, `Environment`, `Session`, and `Event` explicitly.
- Foundry's `Run` should be an event stream, not just a final answer.
- Foundry's resource scheduler can treat each environment as a leaseable "hands" provider.
- Foundry should avoid coupling workspace state directly to one runtime vendor.

### 3.2 Multica

Sources:

- https://github.com/multica-ai/multica
- https://multica.ai/

**Core logic**

Multica is an open-source project-management layer for human-agent teams. It treats coding agents as teammates that can be assigned issues, update status, report blockers, and participate in a shared activity timeline.

The product's center is not "an agent session" but **work management with agents in the assignee pool**.

**Product functions**

- Agents appear in the assignee picker.
- Assign issues to agents like assigning to a teammate.
- Agents autonomously execute tasks, report blockers, and update status.
- Unified activity timeline for human and agent progress.
- Reusable skills.
- Multiple runtime support:
  - Claude Code.
  - Codex.
  - GitHub Copilot CLI.
  - OpenCode.
  - Gemini and others.
- Squads:
  - Multiple agents can be grouped.
  - A leader agent can coordinate.
- Autopilots and autonomous execution.
- Multi-workspace support.
- Self-hosting and no vendor lock-in.
- Local daemon or own cloud infrastructure.
- Concurrency bounded by available hardware.

**Implication for Foundry**

Multica is a strong reference for Foundry's issue board:

- Agents as assignees.
- Status updates and blockers.
- Activity timeline.
- Runtime abstraction.
- Squads or agent teams.

Its apparent gap relative to Foundry:

- Less emphasis on a filesystem-root workspace as the source of truth.
- Less explicit resource lease scheduling.
- More project-management-first than workspace-context-first.

## 4. Cross-Product Comparison

| Product                    | Core object                        | Execution locus                  | Context source             | Task model           | Runtime model          | Review/feedback            | Resource model               | Fit for Foundry         |
| -------------------------- | ---------------------------------- | -------------------------------- | -------------------------- | -------------------- | ---------------------- | -------------------------- | ---------------------------- | ----------------------- |
| Claude Managed Agents      | Agent, Environment, Session, Event | Managed cloud or self-hosted env | Session/files/environment  | Session/event driven | Managed harness        | Steering/interruption      | Environment as sandbox       | Runtime contract        |
| Multica                    | Issue, Agent teammate, Squad       | Local daemon or own cloud        | Project management         | Issue assignment     | Multi-runtime adapters | Status, blockers, timeline | Hardware-bounded concurrency | Issue board inspiration |
| Hosted runtimes (generic)  | Agent config, session              | Cloud sandbox                    | Agent config, tools, vault | Task/session         | Cloud runtime          | Trace, tool confirmation   | Sandbox governance           | Substrate candidate     |
| Loop workbenches (generic) | Loop/run state                     | Local-first                      | Local project state        | Objective to closure | Multi-agent adapters   | Maker/checker, HITL        | Local runtime capacity       | Loop state machine      |

## 5. Repeating Patterns

### 5.1 Runtime abstractions are converging

Most products are rediscovering the same primitives: Agent, Environment, Session, Event, Tool, Permission, Memory, Credential/Vault, Artifact. Foundry should use these words unless it has a strong reason not to. They are becoming the shared language of the category.

### 5.2 The unresolved layer is not "how to run an agent"

Managed runtimes solve pieces of the runtime problem. The harder product problem is:

- What is the durable context?
- Where do ideas and feedback enter?
- How does work get decomposed?
- How are artifacts reviewed?
- How does the workspace learn from each iteration?
- How are scarce resources scheduled?

This is exactly where Foundry should focus.

### 5.3 Cloud-only is not sufficient for engineering workflows

Engineering work often needs local debugging, long multi-turn evolution, domain-specific context, and repo-adjacent tooling. Foundry should be cloud-local from the beginning:

- Cloud for orchestration, intake, scheduling, persistent sessions, and review surfaces.
- Local for repo work, debugging, previews, simulators, credentials, and developer-specific tools.

### 5.4 The context bus is the product's real heart

Different products choose different context buses: session and environment (managed runtimes), a wiki plus an IM group, an issue board plus activity timeline (Multica), local loop state, or team/system memory.

Foundry should choose:

- Filesystem workspace root as the primary bus.
- Product database as index and control plane.
- Runtime event logs as execution history.
- Issues and feedback as the work queue.

### 5.5 Tasks are becoming agent-facing

Traditional task trackers were designed for humans. Agent-facing products show a shift:

- A task should be directly consumable by an agent.
- It should include context links, acceptance criteria, resource requirements, risk level, and review policy.
- Status should be machine-updatable but human-auditable.

Foundry's issue model should be agent-native from day one.

### 5.6 Skills and knowledge are compounding assets

Across the surveyed products:

- Skills should be discoverable and installable.
- Skills should be scoped to workspace/project/team.
- Agent usage should reveal which skills are valuable.
- Knowledge packs and memory should compound over time.

Foundry's workspace should have a visible capability inventory: agents, skills, tools, MCP servers, credentials, knowledge sources, and resource types.

### 5.7 Resource scheduling is under-modeled

Most products can run agents, but few make competitive resources central:

- One Vite server may be shared by several issues, or each issue may need its own preview.
- One iOS simulator cannot run arbitrary concurrent app validations cleanly.
- One repo branch, database, device, browser profile, deploy slot, or test environment may be a bottleneck.
- Some tasks can run in parallel until they reach a shared resource gate.

Foundry should model resource type, lease, queue, locking policy, shareability, preemption, warm pool, validation ownership, and preview URL or artifact binding. This would make Foundry materially different from generic issue boards and managed runtime platforms.

## 6. Foundry Product Implications

### 6.1 Foundry should be an upper-layer product

Do not rebuild managed runtimes. Foundry should sit above them:

- Use local CLI agents first.
- Add runtime adapters.
- Treat cloud managed runtimes as execution backends.
- Own workspace context, work intake, resource scheduling, review, feedback, and context updates.
- Keep durable context in the workspace and cross-workspace capability in explicit skill packs.

### 6.2 Foundry's workspace object should be filesystem-native

The workspace should be a real directory:

```text
foundry-workspace/
  AGENTS.md
  foundry.md
  docs/
  issues/
  artifacts/
  runs/
  repos/
    product-web/
    product-ios/
    backend/
  .foundry/
    index.db
    resources.yaml
    skills.yaml
    workers.yaml
```

The product database can index and accelerate, but the filesystem should remain readable and useful without the product UI.

### 6.3 Foundry should formalize the loop

The core loop:

```text
Topic / Issue / Idea / Feedback
  -> Inbox
  -> Triage
  -> Issue
  -> Resource Plan
  -> Worker Run
  -> Artifact / Diff / Preview
  -> Validation
  -> Human Review
  -> Merge / Deploy / Archive
  -> Context Update
  -> New Feedback
```

Every step should leave an inspectable trail.

### 6.4 Foundry should model resource leases explicitly

Example resource types:

- `repo-write-lock`
- `worktree`
- `vite-preview`
- `deploy-slot`
- `browser-profile`
- `ios-simulator`
- `android-emulator`
- `mac-builder`
- `database-sandbox`
- `test-account`
- `im-bot`
- `human-reviewer`

Each issue can declare:

- required resources,
- optional resources,
- shareable resources,
- exclusive resources,
- validation resources,
- release resources.

### 6.5 Foundry should separate context, skills, and workers cleanly

Foundry should not recreate a long-lived agent profile layer. The clean separation is:

- **Workspace**: owns durable facts, goals, style, decisions, issue history, accepted artifacts, and context.
- **Skill pack**: owns reusable cross-workspace technique, scripts, checks, workflows, and instructions.
- **Worker runtime**: Claude/Codex execution for one run; does not own durable memory.
- **Human reviewer**: accepts, rejects, redirects, or adds feedback at the output edge.

The operating rule:

> Workspace evolves. Skills accumulate. Workers do not remember.

### 6.6 Foundry should treat feedback as first-class input

Feedback should not be a comment lost inside a chat. It should be convertible into:

- new issue,
- issue comment,
- acceptance criteria update,
- workspace doc update,
- test case,
- skill pack improvement,
- resource policy change,
- workspace instruction update.

This is the key to making the workspace output compound.

## 7. Suggested MVP Direction

The first useful Foundry can be narrow:

1. **Workspace root bootstrap**
   - Initialize `.foundry`.
   - Create `AGENTS.md`, `docs/`, `issues/`, `runs/`, `artifacts/`, and repo registry.

2. **Inbox and issue board**
   - Capture topics, ideas, bugs, and feedback.
   - Triage into worker-readable issues.
   - Track state, risk, acceptance criteria, resource needs, selected runtime, and selected skill packs.

3. **Run execution adapter**
   - Start with local Codex/Claude CLI adapters.
   - Store event logs, commands, diffs, artifacts, and summaries.
   - Keep per-issue worktrees.

4. **Resource lease manager**
   - Support a few concrete resources first:
     - repo write lock,
     - worktree,
     - Vite preview port,
     - deploy preview URL,
     - iOS simulator.

5. **Review surface**
   - Show diff, preview, checks, logs, and worker notes.
   - Accept, request changes, or convert feedback into the next issue.

6. **Context update**
   - Approved artifacts and decisions update docs and workspace memory.
   - Runs remain inspectable.
   - Reusable technique can be proposed as a skill pack update.

This MVP would already differ from agent consoles and issue boards such as Multica because the filesystem workspace and resource scheduler are central.

## 8. Follow-Up Research Questions

1. Which managed runtime should Foundry target as the first cloud runtime adapter?
2. What is the minimum adapter contract: create session, stream events, mount workspace, request resources, return artifacts?
3. Should humans be modeled as routable resources, with capability, approval, or escalation semantics for review?
4. How should concurrent local agent execution resolve resource conflicts?

## 9. Provisional Foundry Positioning

Foundry is not another managed runtime, no-code agent builder, or generic issue board.

Foundry should be:

> A filesystem-native workspace OS where ideas, issues, feedback, skill packs, worker runtimes, resources, runs, artifacts, and reviews form one durable production loop.

Short version:

> Foundry turns a workspace directory into a living production loop powered by stateless workers and reusable skill packs.

Category phrase:

> Workspace-native worker orchestration.
