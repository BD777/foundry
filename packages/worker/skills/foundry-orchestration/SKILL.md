---
name: foundry-orchestration
description: Act as orchestrator - plan, brief and review while Foundry worker sessions do the implementation, checks and deployment. Only when the person invokes it explicitly (/foundry-orchestration); otherwise use your own subagents as usual.
disable-model-invocation: true
---

# Foundry orchestration

Act as the planner and reviewer. Keep judgement-heavy work such as scope,
architecture, acceptance criteria and final verification. Delegate bounded
implementation and investigation when a separate session can work
independently.

## Stay out of the work

Delegating is the default, small changes included. A task done yourself costs
far more than its edit: exploration, rework, checks, deployment and browser
verification all land in your context, which every later task shares, and the
person's next task waits while you work.

- Brief a worker for any change that needs a build, a deploy or a real-browser
  check, however small the edit.
- Do it yourself only when:
  - a few reads or one lookup decide what you plan or brief next;
  - the brief would be longer than the change and the change needs no build,
    deploy or browser check (a typo, one line of copy);
  - workers failed twice on the same step and the remaining fix is local.
- Your verification is review: read the diff and the evidence (command output,
  screenshots at normal scale). Workers run the checks, deployment and browser
  logins and report their output.
- Choose models only through the execution models above, never to balance
  quota.
- While workers run, take the person's next task instead of waiting on one
  child.

## Before planning

- Read the repository instructions, current changes and active sessions.
- Preserve work that is already in flight. Name one owner for each tightly
  coupled change.
- When a child needs a model and nobody named one, read the target
  workspace's execution models with `get_execution_default`: a default and
  the alternatives the person allows. Start ordinary workers on the default;
  when it is a worker group, pass its `workerGroupId` and let Foundry pick the
  member. A group balances load among interchangeable models; quotas and
  weights say nothing about capability or cost.
- Use an alternative only when a step falls under a specific bullet of the
  default model's guide (`avoid` or `weaknesses`): pick the alternative whose
  guide fits the step, and quote that bullet in the brief and in your report.
  When no alternative fits or the guides do not say, ask the person. Never
  start a worker on a model outside the default and its alternatives.
- After choosing a worker's model, call `model_guides` with `resolve` for its
  provider, runtime and model id. Read the guide with `get` and write the brief
  as it says: slice size, context budget, required evidence, what to avoid.
- With no guide, `resolve` answers a `suggestedId`: create a minimal guide
  under it with `upsert`, or add the model id to an existing guide as an alias
  (the alias actions) when it is the same weights under another provider's
  name.

## Split the work

- Make each step small enough to inspect as one diff and finish in one worker
  turn.
- Give disjoint file ownership. Do not ask two workers to edit the same
  tightly coupled area.
- Put the risky or blocking investigation locally when the next local action
  depends on it.
- Match checks to risk. Keep narrow changes narrow, and broaden checks when a
  change crosses storage, contracts, permissions or a user workflow.

## Write the brief

Every worker brief states:

1. The objective and the exact scope boundary.
2. The repository and worktree path, plus the baseline setup it must follow.
3. Files it owns and files it must leave alone.
4. Product or implementation constraints, including approved designs.
5. The checks to run, with the expected evidence.
6. What not to do: unrelated refactors, commits, deployment or destructive
   cleanup unless explicitly authorized.
7. The answer format: outcome first, changed files, checks and limitations.

For weaker workers, spell out exact paths and commands, define "done", and
require evidence instead of accepting an unsupported success claim.

## Review and verify

- Read every changed diff. Do not rely on the worker's summary.
- Check that the implementation follows existing patterns and stays inside
  the brief.
- After merging a batch, have the acceptance checks re-run and read their
  output.
- Treat self-reported tests as a claim until the environment and output agree.
- When a check cannot run, record why and keep that limitation visible.
- Personally inspect screenshots at normal scale and judge the visual result; a
  worker's "confirmed" text is not evidence.
- Run tests by batch: workers run only change-covering tests once at the end,
  one checker runs the full checks after a batch is merged, and you audit
  command logs for wasted work.
- Start each new slice in a new session; long contexts slow down and can fail
  during compaction.
- A worker keeps the provider and model it started on for its whole session,
  so switching IDs loses the prompt cache: a worker group (members may come
  from different providers) only picks the member a new worker starts on, from
  those available on its device. Foundry retries a 429 on the same ID with
  backoff; when a member's quota is exhausted, start a fresh worker from the
  group.

## Follow failures

- Inspect the failed step and its evidence before sending another instruction.
- Send a precise correction when the existing context is useful.
- Start a clean worker with a corrected brief when the old context would keep
  it on the wrong path.
- Record what a batch showed about a model with `model_guides` `observe`:
  the session ids and what happened, such as briefing details, step-size
  limits, recurring failure modes and required evidence. Do not record
  one-off task facts or secrets.
- A guide describes its own model only: what it does well, its limits, cost
  and how to brief it, with session evidence. Never name, compare with or
  route to another model in a guide; which models to use is the person's
  execution-model setting.
- Once an experience holds up across sessions, `upsert` the matching section
  of the guide and say in `changeSummary` which sessions showed what. Keep
  each section short: at most 8 bullet points, no generic advice.

## Finish

- Merge only reviewed, verified work.
- Follow the repository's deployment and devlog rules.
- Report the deployed result, the checks that prove it, and any remaining
  human acceptance or limitations.
