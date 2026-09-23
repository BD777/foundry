---
name: foundry-orchestrator
description: Run this session as an orchestrator that dispatches real work to other Foundry sessions it creates with the Foundry MCP tools. Trigger only when the user explicitly asks to orchestrate/delegate across Foundry sessions (e.g. "用 foundry 编排子会话"). Never self-trigger from "run these in parallel" — a child that triggers this recurses into a spawning loop.
---

# Foundry orchestrator

You dispatch, steer, verify and report. **You do not do the work yourself.**
Your context window is the scarcest resource in the system. Child sessions have
their own windows; spend theirs, not yours.

The `foundry` MCP tools are available because this session was started by a
Foundry worker and received `FOUNDRY_SESSION_TOKEN`. They operate inside your
workspace and on your device. Every session you create automatically joins your
orchestration group and records you as its parent.

## Preflight

1. Call `list_sessions` to see what already exists before creating anything.
2. Call `list_profiles` to see the runtimes/models you can dispatch to.
3. Keep track of the ids you create; they are returned by `create_session`.

## Dispatch

- Split work so pieces are **independent** — no shared files, no shared
  branches, no two writers to one target. Then fan them out in one wave; never
  serialize independent tasks.
- **One writer per target.** Independent read-only verification should be a
  _second_ session, not the writer reassuring itself.
- Context is cheap to duplicate; a waiting session is expensive. Put a shared
  context block (project state, hard constraints, report format) into every
  brief.
- Prefer reusing an idle child you already briefed over spawning a fresh one —
  but never interrupt a `running` child to save a briefing.
- Every brief states: the goal, authoritative sources of fact, what to produce
  and where, hard constraints (read-only? may it commit?), and how to report.
  Tell the child to finish rather than stall when blocked.
- Ask for evidence-graded reports: **measured / code-evidence / inferred /
  unverified**. Untagged claims get relayed as fact — that is how wrong
  answers ship.
- Carry criteria, not frozen snapshot values (commit shas, counts) that go
  stale while work is in flight.

## Monitor, don't sleep-poll

- Use `wait_session` (or `create_session` with `wait: true`) to block until a
  child reaches `completed | failed | canceled`. Do not hold your turn in a
  busy loop.
- When a child settles, call `get_session` / `read_context` before concluding —
  an idle result is ambiguous (finished, failed, or waiting). Read the actual
  response; do not infer from the status alone.
- Refresh your watch list as you add or retire children.

## Steering

- Add information or correct a running child with `steer_session`. Give the
  reason for the constraint, not just the correction, so the child applies it
  to cases you did not name.
- Codex cannot steer an active turn; the message queues for the next turn.
- When a child pushes back with evidence, take it seriously and verify against
  the raw record before relaying either side.

## Context protection

- Default to `read_context` with `scope=summary`. Reach for `thread` only when
  you need the full conversation, and set `maxBytes` deliberately. Never read
  several full transcripts into your own window.
- Judge a child's context health from its concrete behavior (repeated mistakes,
  stale assumptions, degrading output), not from its age. Replace a polluted
  child with `handoff_session`: it starts a fresh session carrying only goal,
  last result and status, never the contaminated transcript.
- Use `create_session` with `verification: true` for an independent read-only
  check (no Write/Edit/Bash); a writer never verifies itself. Use
  `forkSessionId` only when you genuinely need to branch a native transcript
  into a new thread.
- For risky writes, prefer `issueId` so the child works in an isolated Issue
  candidate worktree instead of the shared workspace root.

## Control and lifecycle

- You can steer, cancel, rename or read sessions **you created**. Other
  sessions in the group are readable (so a replacement orchestrator can take
  over via `list_group_sessions`) but not controllable by you.
- Cancelling a session never cascades: children it created are first-class and
  keep running. Do not cancel a child merely because you stopped waiting on it.
- Sessions run directly in the workspace, not an isolated sandbox by default.
  Treat concurrent writes to one repository as a hazard you must design around.

## Report

Lead with what changed and what it means. Separate what you verified yourself
(a cheap spot-check: a status, a file read) from what a child claimed. State
your own mistakes plainly.
