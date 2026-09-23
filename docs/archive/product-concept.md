# Foundry Product Concept

Created: 2026-07-03

> **Archived planning document.** This is the early (2026-07-03) product concept, kept verbatim. It is superseded by the [Workspace and Sandbox overview](../workspace-sandbox-overview.md), the [README Roadmap](../../README.md#roadmap) and the topic docs, and does not describe current behaviour. In particular, wording such as "infer the executable issue contract" is replaced by the current flow: the Agent only proposes a contract draft and the human confirms an exact revision/digest before any execution ([Issue conversation](../issue-conversation-design.md), [Evidence & Verify v1](../evidence-and-verify-v1.md)). The filesystem-native Workspace and "Workspace evolves. Skills accumulate. Workers do not remember." remain current principles.

## One-Line Definition

Foundry is a filesystem-native workspace OS for stateless AI workers.

People can throw any topic, issue, idea, or feedback into a workspace. Foundry uses the workspace context, installed skill packs, and local Claude/Codex workers to infer the executable issue contract, allocate workspace assets, execute, produce an acceptance artifact, and ask for human acceptance. Human feedback then becomes the next round of topic, issue, or idea. Over time, the workspace itself becomes the durable product and context.

## Product Intuition

Foundry is not just a chat UI, an issue tracker, or an agent IDE.

The central object is a real workspace root on the filesystem:

- A root directory represents the long-lived project boundary.
- `AGENTS.md` or `CLAUDE.md` defines goals, constraints, roles, and operating rules.
- One workspace can contain one repo or multiple repos.
- Iteration outputs, artifacts, decisions, feedback, and repo updates all become new context.
- Workers enter the workspace to work; they do not own the workspace.

This differs from Mew's current shape, where workspace is more like a platform-side container for issues, chats, automations, agents, members, and resources. Foundry keeps that object model, but makes the filesystem workspace a first-class product primitive.

Foundry's operating principle is:

> Humans stay at the edges of the production loop.

The human side should feel close to the current Codex app input box:

- free-form text
- pasted context
- files
- screenshots
- links
- optional preference notes about design, architecture, or code structure

The human should not have to fill a structured issue schema. The structured issue exists, but it is an internal worker-facing contract inferred from workspace context and the user's raw input.

## Design Principles

1. **Light input, heavy inference**
   - Human input should be a message, not a form.
   - Workspace context should carry the stable structure.
   - Foundry should infer scope, assets, acceptance criteria, and execution strategy.

2. **Humans at input and output only**
   - Humans provide intent at the beginning.
   - Humans accept or reject artifacts at the end.
   - The production middle should be autonomous unless blocked by ambiguity, safety, resource contention, or unverifiable output.

3. **One issue, one primary acceptance asset**
   - Each issue should produce one focused thing to inspect.
   - This can be a preview URL, simulator run, report, build, design artifact, or archived file.
   - Keeping acceptance focused is what allows high throughput.

4. **Workspace assets determine throughput**
   - Baselines, previews, simulators, deploy slots, worktrees, test accounts, and human reviewer groups belong to the workspace.
   - Some assets can be cloned per issue.
   - Some assets are shared or exclusive.
   - Foundry should schedule around those constraints instead of hiding them inside worker runs.

5. **Accepted output updates the baseline**
   - For code products, acceptance usually means merge into the baseline branch or deployment stream.
   - For non-code products, acceptance means the artifact enters the accepted archive.
   - Feedback on accepted or rejected output becomes the next input.

6. **Humans exit production, not governance**
   - Humans should not routinely debug plans, assign resources, or supervise worker steps.
   - Humans still define workspace goals, risk tolerance, review policy, quality bars, and long-term direction.
   - Foundry should convert these governance choices into workspace context and policy so they do not have to be repeated for every issue.

7. **Workspace evolves, skills accumulate, workers do not remember**
   - Durable context belongs to the workspace.
   - Transferable capability belongs to skill packs.
   - Claude/Codex workers are stateless executors inside a run.
   - Foundry should not create long-lived agent profiles that compete with workspace context.
   - Cross-workspace learning must be distilled into explicit skill packs, not hidden agent memory.

## Context Ownership

Foundry is intentionally workspace-centric, not agent-centric.

```text
Workspace
  = facts, goals, style, decisions, artifacts, issue history
  = the long-lived thing being solved and grown

Skill Pack
  = reusable technique, tool protocol, checklist, workflow, scripts
  = the cross-workspace carrier of capability

Worker Runtime
  = Claude or Codex executing one run in a local environment
  = does not own durable memory
```

The design invariant:

> Workspace evolves. Skills accumulate. Workers do not remember.

This is a deliberate difference from Mew. Mew's agent-centric model lets an agent grow across workspaces. Foundry gives the context budget to the current workspace instead. Since context is limited and valuable, the active workspace should receive the majority of context. Anything worth carrying to another workspace should be extracted, sanitized, versioned, and installed as a skill pack.

The migration path is:

```text
A workspace accepted runs
  -> extract reusable technique
  -> propose skill pack update
  -> remove workspace-specific facts
  -> version the skill pack
  -> B workspace explicitly installs or opts in
```

Bad migration:

```text
A workspace context -> worker private memory -> B workspace
```

Good migration:

```text
A workspace success -> skill pack -> B workspace opt-in
```

## Execution Readiness and Gates

Foundry should not blindly execute every input. It should classify each incoming topic, idea, issue, or feedback item before production.

Possible readiness states:

- `ready_to_execute`: small enough, scoped enough, and has a clear acceptance path.
- `needs_split`: valuable but too large; Foundry should split it into smaller executable issues.
- `needs_proposal`: ambiguous or high-impact; a worker should first produce a proposal as the acceptance asset.
- `needs_human_direction`: the system cannot infer intent, taste, or tradeoff safely enough.
- `not_suitable_for_automation`: the work is too risky, sensitive, or unverifiable for the current workspace policy.

This shifts the responsibility for issue slicing away from the human. Humans may write coarse-grained intent; Foundry should decide whether to execute, split, propose, or clarify.

Acceptance also needs two distinct gates for code-producing work:

- `accepted`: the human accepts the issue's primary acceptance asset.
- `integrated`: the accepted change has merged into the baseline and passed integration validation.

This matters because several issues can be individually acceptable but conflict once combined. Foundry should allow high-throughput per-issue acceptance while still protecting the baseline with an integration gate.

An issue should expose one **primary acceptance surface**, not a pile of unrelated evidence. Supporting evidence can still be attached:

- diff
- test results
- screenshots
- logs
- performance numbers
- checker notes

The person should accept or reject the primary surface. The supporting evidence exists for confidence and debugging.

Workspace assets can be grouped by function:

- **Context assets**: repos, docs, `AGENTS.md`, design systems, historical decisions.
- **Execution assets**: worktrees, runners, machines, dependency caches, model quota.
- **Acceptance assets**: previews, simulators, reports, builds, screenshot sets.
- **Release assets**: deploy slots, release pipelines, artifact archives.
- **Governance assets**: review policies, human reviewer groups, risk rules, credentials, permissions.

## Influences

### From Mew

Mew has a strong product structure:

- `workspace -> issues`
- `workspace -> chats`
- `workspace -> automations`
- `workspace -> agents`
- workspace members, permissions, Lark integration, shared agents, shared skills

Foundry borrows the team-oriented operating model, but not the agent-centric context model. In Foundry, agents do not become cross-workspace memory subjects. Reusable cross-workspace capability is carried by skill packs.

### From Orca

Orca has a strong developer execution loop:

- git worktree isolation
- parallel worker execution
- diff review
- terminal/browser preview
- source control workflow
- human review before merge

Foundry borrows this code-production and review loop.

### Foundry's Own Center

Foundry's key departure is:

> The workspace is not merely a platform grouping. It is a worker-readable filesystem workspace.

The filesystem is the durable memory. Platform state should index, summarize, and coordinate it, but should not replace it.

## Core Loop

```text
Topic / Idea / Feedback / Attachment
  -> Inbox
  -> Triage
  -> Internal Issue Contract
  -> Resource Plan
  -> Worker Production
  -> Acceptance Asset
  -> Human Acceptance
  -> Merge / Archive / Context Update
  -> New Feedback
```

The loop is intentionally continuous. A finished run is not the end of the work; it updates the workspace and creates new context for future runs.

Human participation is intentionally concentrated at the two ends:

- **Input edge**: the person expresses what they want, with optional supporting material.
- **Output edge**: the person accepts, rejects, or gives feedback on a concrete artifact.

The middle should stay autonomous by default. Foundry should only pull a human into the production process when the issue is too ambiguous to infer, the requested action is unsafe, a required resource is unavailable, or the output cannot be made verifiable.

## Filesystem Shape

A Foundry workspace could look like this:

```text
my-workspace/
  AGENTS.md
  CONTEXT.md
  decisions/
  feedback/
  artifacts/
  accepted/
  repos/
    web-app/
    backend/
    infra/
  .foundry/
    issues/
    runs/
    reviews/
    assets.yaml
    skills.yaml
    resources.yaml
    state.json
```

Key files and directories:

- `AGENTS.md`: workspace constitution; goals, boundaries, operating rules, worker behavior.
- `CONTEXT.md`: current state summary; can be maintained by humans or automated context maintenance.
- `decisions/`: durable architecture, product, and process decisions.
- `feedback/`: human review notes and feedback loops.
- `artifacts/`: screenshots, reports, generated docs, builds, exported assets.
- `accepted/`: non-code artifacts that have been accepted into the workspace archive.
- `repos/`: one or more checked-out repositories.
- `.foundry/issues/`: filesystem-backed issue records.
- `.foundry/runs/`: run metadata, logs, summaries, links to artifacts.
- `.foundry/reviews/`: acceptance records, rejection reasons, and review history.
- `.foundry/assets.yaml`: workspace asset registry.
- `.foundry/skills.yaml`: installed skill packs and workspace-level skill configuration.
- `.foundry/resources.yaml`: resource pool and lease declarations; may later merge into `assets.yaml`.

## Core Objects

### Workspace

The long-lived production boundary. It owns:

- filesystem root
- repos
- workspace context
- installed skill packs
- worker runtime availability
- issues
- runs
- artifacts
- assets and resources
- automations

### Topic / Idea

Any raw user input. It can be vague, incomplete, emotional, or exploratory.

The input format should stay lightweight. A topic or idea is usually just a free-form message plus optional attachments. The workspace context and installed skill packs should let Foundry infer the rest.

Examples:

- "The dashboard feels noisy."
- "Can we add a mobile preview?"
- "This flow should work more like Linear."
- screenshot annotations
- production bug reports
- product strategy notes

### Issue

A triaged, executable unit of work. It is worker-readable, but it should not be user-authored as a form.

The user-facing issue can be as small as:

- raw request
- attachments
- optional preference notes

The internal issue contract can then be inferred from the raw request, workspace context, installed skill packs, and available worker runtimes. It should include:

- goal
- scope
- target repo or area
- acceptance criteria
- required workspace assets
- acceptance asset plan
- priority
- linked feedback or source topic
- suggested skill packs or checks
- risk level

If the system cannot infer these fields with enough confidence, it should ask a focused clarification question or split the request into smaller candidate issues. The default path should be inference, not form filling.

### Workspace Asset

A durable capability, environment, or object owned by the workspace.

Assets are broader than resources. A resource is something that can be leased; an asset may also be a baseline, accepted artifact, knowledge source, credential, preview environment, or validation surface.

Examples:

- baseline website
- production URL
- Vite preview pool
- preview deployment slot
- iOS simulator
- Android emulator
- Mac builder
- repo write lock
- worktree pool
- browser profile
- test account
- database sandbox
- accepted artifact archive
- human reviewer group

The workspace owns assets because asset availability and policy determine how much parallel work the workspace can safely run.

### Skill Pack

A reusable capability package that can be installed into one or more workspaces.

Skill packs are the official cross-workspace knowledge carrier in Foundry. They can encode tools, scripts, checklists, workflows, examples, and structured instructions.

Examples:

- web preview acceptance
- baseline comparison
- issue splitting
- visual QA
- shadcn/Radix UI cleanup
- iOS simulator validation
- release checklist
- context sanitation

Skill packs should not contain workspace-specific facts unless they are explicitly scoped to that workspace. A reusable skill pack should be sanitized before it is migrated across workspaces.

### Worker Runtime

A stateless execution capability that enters the workspace for one run.

In V1, worker runtimes are:

- Claude
- Codex

A worker runtime may have tools, permissions, provider-specific configuration, and access to installed skill packs, but it should not own durable workspace context or private cross-workspace memory.

### Run

One worker execution attempt against one issue or topic.

A run should bind:

- worker runtime
- issue
- installed skill packs used
- worktree or execution directory
- resource leases
- logs
- tool calls
- artifacts
- diff
- preview
- review result

### Artifact

A reviewable output.

Examples:

- code diff
- preview URL
- iOS simulator screenshot
- generated report
- design proposal
- test result
- release note

### Acceptance Asset

The concrete thing a human can inspect to accept or reject an issue.

An issue should generally produce exactly one primary acceptance asset. This keeps review focused and lets Foundry release expensive validation resources quickly after acceptance.

Examples:

- a Vite preview URL for one web issue
- a preview deployment for one backend or full-stack issue
- an iOS simulator run with screenshots and logs
- a generated report
- a design proposal
- a packaged build
- an accepted non-code artifact in `accepted/`

For code products, acceptance often means merging the issue's diff into the baseline branch. For non-code products, acceptance may mean moving the artifact into the accepted archive.

### Feedback

Human review output. Feedback is not merely a comment; it is a first-class input to the next loop.

Feedback can become:

- a new issue
- a reopened issue
- an update to acceptance criteria
- a workspace decision
- an update to `CONTEXT.md` or `AGENTS.md`

## Workspace Assets and Resource Allocation

Asset and resource scheduling is a first-class product problem.

Parallel worker execution is only useful if scarce workspace assets are modeled explicitly. Real bottlenecks include:

- dev servers
- preview ports
- deployment slots
- simulators
- physical machines
- test databases
- authenticated browser sessions
- repo write access
- GPU or expensive model quota

Foundry should model leaseable assets as resource leases.

Example:

```yaml
assets:
  baseline_web:
    kind: baseline
    url: "https://example.com"
    source: "repos/web-app:main"

  web_preview_pool:
    kind: service_pool
    command: "pnpm dev -- --port $PORT"
    capacity: 4
    lease: per_issue
    role: acceptance

  integration_preview:
    kind: deploy_slot
    capacity: 1
    lease: exclusive
    role: acceptance

  ios_simulator:
    kind: simulator
    host: "mac-mini-1"
    runtime: "iOS 18"
    capacity: 1
    lease: shared_or_exclusive
    role: acceptance

  repo_write:
    kind: git_worktree
    strategy: per_issue
```

For a web product:

- the accepted baseline is the already-reviewed main branch or deployed website
- each issue can get its own worktree and Vite preview
- the preview contains baseline plus that issue's specific change
- humans review issue-level previews independently
- acceptance merges the diff into the baseline branch
- rejection releases the preview and creates feedback
- only integration deploy is serialized

For an iOS product:

- code edits can happen in parallel worktrees
- simulator runs may require a shared or exclusive simulator lease
- adding another Mac or simulator host increases throughput
- workspace policy decides whether multiple issues share one simulator or wait for isolated validation

Acceptance assets are a key asset class. They are the bridge between autonomous production and human output-side judgment.

## Autonomous Production Layers

Issue execution can be divided into autonomous layers. These layers should be observable and auditable, but they should not require routine human participation.

1. Inference
   - read the raw request and attachments
   - inspect workspace context
   - infer the internal issue contract
   - infer acceptance criteria
   - infer required assets and risk level
   - ask only focused clarification questions when inference is not good enough

2. Exploration
   - read code
   - inspect context
   - search docs
   - produce a private execution plan
   - usually does not need exclusive resources

3. Modification
   - create per-issue worktree
   - edit files
   - run focused tests
   - produce diff

4. Validation
   - acquire preview, deploy, simulator, browser, or test resource
   - compare against the accepted baseline when possible
   - produce one primary acceptance asset
   - prepare review notes

This makes resource contention visible and schedulable instead of accidental. It also keeps the human out of the production loop until there is something concrete to accept or reject.

## Product Surface

### Workspace Home

The first screen should not be just chat.

It should show:

- workspace goal
- current context summary
- input box for new ideas, issues, and feedback
- pending acceptance assets
- accepted baseline or latest accepted artifact
- active issues
- pending human reviews
- asset and resource occupancy
- installed skill packs
- worker runtime health
- recent artifacts
- recent decisions

Running workers can be visible, but they should not dominate the screen. Foundry should optimize for "what needs my input or acceptance?" rather than "what are all workers currently doing?"

### Inbox

The place where humans throw everything:

- ideas
- bug notes
- screenshots
- voice notes
- pasted chats
- feedback
- external links

Foundry can triage inbox items into issues. The inbox should not ask for scope, priority, repo, resource, acceptance criteria, runtime, or assignee up front unless the user voluntarily provides those details.

### Issue Detail

An issue page should include:

- source idea or feedback
- triaged task statement
- acceptance criteria
- inferred asset requirements
- acceptance asset plan
- selected worker runtime
- selected skill packs
- production status
- primary acceptance asset
- review controls

Advanced details can be progressively disclosed:

- inferred plan
- run history
- worktree
- diff
- logs
- secondary artifacts

Primary actions:

- accept
- request changes
- split issue
- convert to decision
- merge
- deploy
- archive

### Review Inbox

Humans should have a dedicated review surface:

- what changed
- what can be clicked or inspected
- primary acceptance asset
- baseline comparison
- what Foundry wants accepted or rejected
- what tests passed or failed
- what assets were used
- what skill packs were used
- feedback input

The review inbox should be the main human work surface after the inbox. Humans should be able to ignore most production detail unless they are debugging a bad result.

### Asset Dashboard

This should make bottlenecks obvious:

- accepted baseline status
- preview pool usage
- simulator queue
- deploy slot status
- active worktrees
- blocked runs
- resource wait time
- acceptance assets awaiting review
- assets that are shared, exclusive, or saturated
- installed skill packs and versions

## MVP

The first version should make the loop real with the fewest concepts:

1. Filesystem workspace root
2. `AGENTS.md` as workspace constitution
3. Free-form inbox input with attachments
4. Foundry-inferred issue contracts
5. Per-issue worktree execution
6. Web baseline plus per-issue Vite preview acceptance asset
7. Human accept/reject feedback loop
8. Accepted diff merges into baseline
9. Feedback becomes the next issue or context update
10. Skill pack installation and usage tracking

This MVP is enough to validate the core taste:

> A person feeds intent into a durable workspace, stateless workers produce one focused acceptance asset per issue, and the workspace gets richer through accepted outputs and feedback.

## Future Research Directions

Horizontal product research should compare Foundry against:

- Mew
- Orca
- Claude Code
- Codex
- Cursor
- Devin
- OpenHands
- Factory
- Replit Agent
- GitHub Copilot Workspace / coding agent experiences
- Linear / issue-driven product workflows
- Vercel preview deployment workflows
- mobile build and simulator orchestration tools

Research should focus on:

- workspace and context model
- issue/task model
- worker runtime model
- skill pack model
- worktree or sandbox isolation
- preview and artifact review
- human feedback loop
- resource scheduling
- team collaboration
- automation model
- persistence and workspace memory
- filesystem interoperability

## Open Questions

- Should `.foundry/` be fully human-editable, or should it be treated as generated state?
- Should issues be plain markdown, structured YAML, SQLite, or both?
- How much should automated context maintenance be allowed to rewrite `CONTEXT.md` and `AGENTS.md`?
- What is the minimum viable skill pack protocol?
- When should an accepted run propose a reusable skill pack update?
- Should workspaces be local-first, cloud-synced, or server-owned?
- How should Foundry handle secrets and authenticated sessions?
- How should Foundry decide that an inferred issue contract is confident enough to execute without asking a clarification question?
- How should Foundry store and compare baselines for different workspace types, such as websites, iOS apps, data reports, or documents?
- When should an acceptance asset be isolated per issue, and when should it share a scarce resource like an iOS simulator?
- How should conflicting issues be detected before wasting agent time?
- Should resource leases be optimistic, scheduled, manually approved, or policy-driven by asset type?
- What should happen when two accepted runs modify the same repo area?
- How much production detail should be visible by default versus hidden behind progressive disclosure?

## Working Name

Foundry.

The name fits because ideas, feedback, and rough material enter the workspace; stateless workers apply heat and tools; artifacts, product increments, decisions, and reusable skill packs come out.
