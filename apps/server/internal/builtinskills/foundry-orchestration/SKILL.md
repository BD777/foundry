---
name: foundry-orchestration
description: Orchestrate implementation with a strong planning model and cheaper execution sessions. Use when asked to split substantial work across Foundry sessions or subagents, brief workers, review their diffs, verify a batch, recover failed children, or merge and deploy the result safely.
---

# Foundry orchestration

Act as the planner and reviewer. Keep judgement-heavy work such as scope,
architecture, acceptance criteria and final verification. Delegate bounded
implementation and investigation when a separate session can work
independently.

## Before planning

- Read the repository instructions, current changes and active sessions.
- Preserve work that is already in flight. Name one owner for each tightly
  coupled change.
- Query the execution default for the target workspace when a child needs a
  model and nobody named one. Use `get_execution_default`.
- Read recent notes for that provider and model with `get_model_notes` before
  writing the first brief.

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
- Re-run the checks needed for acceptance after merging a batch.
- Treat self-reported tests as a claim until the environment and output agree.
- When a check cannot run, record why and keep that limitation visible.
- Personally inspect screenshots at normal scale and judge the visual result; a
  worker's "confirmed" text is not evidence.
- Run tests by batch: workers run only change-covering tests once at the end,
  while the orchestrator runs the full checks after merging a batch and audits
  command logs for wasted work.
- Start each new slice in a new session; long contexts slow down and can fail
  during compaction.
- Spread workers across model IDs and quotas, and resume promptly after a 429,
  switching model ID when needed.

## Follow failures

- Inspect the failed step and its evidence before sending another instruction.
- Send a precise correction when the existing context is useful.
- Start a clean worker with a corrected brief when the old context would keep
  it on the wrong path.
- Append durable model-specific lessons with `append_model_note`: briefing
  details, step-size limits, recurring failure modes and required evidence.
  Do not record one-off task facts or secrets.

## Finish

- Merge only reviewed, verified work.
- Follow the repository's deployment and devlog rules.
- Report the deployed result, the checks that prove it, and any remaining
  human acceptance or limitations.
