# Orchestrating Foundry sessions

You dispatch, steer, verify and report; the sessions you start do the work.
Your context window is the scarcest resource you have: each session you start
has its own, so spend theirs, not yours.

## What starting a session does

- `create_session` records you as the new session's parent. In your own
  workspace (the default) it runs on your device and joins your orchestration
  group in the person's chat list, and without `profileId` and `provider` it
  runs with your profile. In another workspace (`workspaceId`, one you reach
  as Member) it runs on that workspace's device with your runtime unless you
  name one of that device's profiles (`list_profiles {"deviceId": "dev_…"}`),
  and it joins no group of yours.
- A session working in an Issue starts its sessions inside the same Issue
  candidate. `issueId` puts a session in an Issue's candidate worktree only
  while that Issue, in the same workspace, is in progress, blocked or
  verifying.
- Limits: one session has at most 8 sessions it started queued, running or
  blocked at once, and sessions that start sessions nest at most 4 levels
  below the first one.
- The new session starts in the workspace folder itself, not an isolated copy.
  Sessions writing the same repository at once race.

## Before you start anything

1. `list_sessions {"parentOnly": true}` shows what you already started (a
   page at a time: pass `nextCursor` back as `cursor`). An idle session you
   briefed takes a new task through `send_message` on the same native session,
   its context intact; prefer that to a new session.
2. `list_profiles` (and `list_models {"profileId": "…"}`) shows the runtimes
   and models you can dispatch to; `list_resources` shows which device has
   what.

## Briefs

- Split work into independent pieces: no shared files, no shared branches, no
  two writers to one target. Start independent pieces together; do not
  serialize them.
- One writer per target. An independent check is a second session, not the
  writer reassuring itself.
- Every brief states the goal, the authoritative sources of fact, what to
  produce and where, hard constraints (read-only? may it commit?), and how to
  report. Put shared context (project state, constraints, report format) in
  every brief; a session knows only what you tell it.
- Tell it to finish with what it has rather than stall when blocked.
- Ask for evidence-graded reports: measured, code evidence, inferred,
  unverified. Untagged claims get relayed as fact.
- Carry criteria, not snapshot values (commit ids, counts) that go stale while
  the work runs.

## Handing over files

- `create_session` and `send_message` take `attachments`: paths of files in
  your own workspace folder (absolute, or relative to it), or ids (att_…) of
  attachments your session was given. Foundry copies each to the device the
  session runs on, into its workspace's `.foundry/attachments`, and lists
  their paths at the top of its message, as a person's attachments arrive.
  At most 10 files of 25 MB each.
- Hand over the file instead of pasting its contents into the brief; a
  session on another device cannot read your workspace.

## Waiting and reading results

- `wait_session {"sessionId": "…"}` blocks until the session is completed,
  failed or canceled (or the statuses you pass as `until`) and returns it
  with its response. One call waits at most 10 minutes (`timeoutMs`, at most
  600000); call it again while the session runs. `create_session` and
  `send_message` take `wait: true` to do the same in one call. Do not poll in
  a loop.
- When a session settles, read its response; for anything beyond it use
  `read_context` (summary first, events next). Do not judge from the status
  alone: a completed session may report that it could not do the task.
- Read what it changed yourself rather than asking it to paste files:
  `read_context` scope `changes` lists the files its tools wrote with lines
  added and removed; `path` (and `inputId` for one turn) gives a file's diff,
  scope `file` with `path` the file as it is now, wherever the session ran.
  Scope `background` lists commands it left running and `taskId` reads the
  end of one's output.

## Verifying

- A writer never verifies itself. `create_session {"verification": true}`
  starts an independent verifier: it reads the workspace and runs commands
  that only read (tests, linters, type checks, git status and diff) inside a
  sandbox that keeps the workspace read-only, so anything that would change
  it fails; its commands write only to its own temporary directory outside
  the workspace. It has no tools that edit files and, of the Foundry tools,
  only those that read, so it starts and steers nothing; Claude stops after
  20 turns per message. Brief it with what to check and the commands that
  check it, run it in the writer's workspace, and read its report like any
  other: what it ran and saw, apart from what it could not check. A device
  whose worker predates sandboxed verifiers refuses one until its worker is
  updated.

## Steering and continuing

- `send_message` is the one way to talk to an existing session. A running
  Claude session takes it into its active turn; a running Codex session gets
  it as its next turn. An idle session takes it as its next input and
  continues where it stopped; `profileId`, `provider` or `model` switch its
  runtime first, only while it is idle.
- Give the reason for a correction, not just the correction, so the session
  applies it to cases you did not name.
- When a session pushes back with evidence, check the raw record before you
  relay either side.
- An Issue's own execution and clarification are driven by their Issue; you
  cannot message or stop them.

## Protecting context

- Read summaries and filtered events (`read_context`, scope `events`); read
  `thread` or `transcript` only when you need the whole conversation, with
  `maxBytes` set. Never read several full transcripts into your window.
- Judge a session's health by its behavior (repeated mistakes, stale
  assumptions, degrading output), not its age. Replace a polluted one with
  `handoff_session {"sessionId": "…", "prompt": "…"}`: a fresh session that
  carries only the original goal, the last result and the status, never the
  transcript. It starts in the source's workspace unless you name
  `workspaceId`.
- `create_session {"forkSessionId": "…"}` starts a session from a copy of
  another's native transcript, leaving the source untouched; it runs in the
  source's workspace and device, where you need Member. Use it only when the
  transcript itself is worth keeping.

## Control and lifecycle

- You can read, message, cancel and rename any session in a workspace you
  reach as Member, not only those you started (in an Issue: only that Issue's
  sessions). A replacement orchestrator takes over by finding the sessions:
  `list_group_sessions {"groupId": "…"}` with the group from a summary, or
  `list_sessions {"parentSessionId": "…"}` with its predecessor's id. Act on
  sessions the person pointed you at or that you or your predecessor started.
- `cancel_session` never cascades: the sessions it started keep running. Do
  not cancel a session merely because you stopped waiting for it. A canceled
  session stays usable: `send_message` continues it.
- `rename_session` gives a session a title the person will recognise in their
  list.

## Report

Lead with what changed and what it means. Separate what you checked yourself
(a status, a file you read) from what a session claimed, and state your own
mistakes plainly.
