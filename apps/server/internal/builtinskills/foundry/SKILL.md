---
name: foundry
description: Work with Foundry, the platform this session runs on - read other Foundry sessions, what they changed, native chats, Issues, workspaces and devices, and start, steer, wait on, verify or hand off sessions on this or another device. Use it whenever you see a Foundry id (sess_…, native_claude_…, native_codex_…, iss_…, ws_…, dev_…) or a Foundry chat link (…/chats/<id>?workspace=…); when asked what another session did, changed, why it failed or stopped, about an Issue, or about another device or workspace; when the person asks you to hand work to other Foundry sessions or to work in another workspace or on another device; or when a task needs software only another device has. Not for splitting your own task into parallel sessions on your own initiative.
---

# Foundry

Foundry runs Claude Code and Codex sessions on people's own devices and shows
every session to the person in its web app, where they read, message and stop
it. You are one of these sessions.

## Who you act for

- Your device notes say which session you are ("You are Foundry session
  sess_…"); `$FOUNDRY_SESSION_ID` and `$FOUNDRY_WORKSPACE_ID` hold your session
  and workspace ids. `read_context {"sessionId": "<your id>"}` shows your
  workspace, device, profile, parent and group.
- You act for the person who started you, or who started the session that
  started you. Your Foundry tools reach every workspace that person belongs
  to, at most as Member: you read sessions and Issues in all of them, and
  start, message, cancel and rename sessions where they are at least Member.
  A session working in an Issue reaches only the Issue's workspace, sees only
  that Issue and controls only the Issue's sessions.
- `list_workspaces` lists those workspaces; `list_resources` lists the devices
  behind them, whether each is online, and what it offers (installed browsers,
  macOS screen control).
- Anything you cannot reach answers "not found", the same as anything that
  does not exist.

## Tools

Use the `foundry` MCP tools (`mcp__foundry__…` in Claude Code). Your tool list
holds only the tools your role may call: an Issue's clarification has only
`list_sessions` and `read_context`, a verifier only the tools that change
nothing, and only an Issue's execution has `ask_person`.

- Summary of a session or native chat: `read_context` (scope `summary`, the
  default; `get_session` is the same).
- Its events, filtered and paged: `read_context` with scope `events`.
- A whole conversation: `read_context` with scope `thread` (a session) or
  `transcript` (a native chat).
- Its native subagents: `read_context` with scope `subagents`.
- What it produced: `read_context` with scope `changes` (the files its tools
  wrote and its answers named; with `path`, one file's diff), `file` (a file
  as it is now) and `background` (commands it left running; with `taskId`,
  one's output).
- Sessions of a workspace, or the ones a session started: `list_sessions`.
- Sessions of an orchestration group: `list_group_sessions`.
- Issues, read-only (the person drives them): `list_issues`, `get_issue`.
- Workspaces and devices: `list_workspaces`, `list_resources`.
- Profiles and models: `list_profiles`, `list_models`.
- Start a session: `create_session`, with files it should read as
  `attachments`.
- Continue a session from facts only: `handoff_session`.
- Message or steer, wait, stop, rename: `send_message`, `wait_session`,
  `cancel_session`, `rename_session`.
- Ask the person, in an Issue's execution only: `ask_person`.

The same tools answer people at a shell through the `foundry` command; you
call the MCP tools.

## Reading a session

Name it as `sessionId`: an id or a Foundry chat link, from any workspace you
reach; no `workspaceId` is needed. Read it in small, targeted steps, never
whole: a session can hold thousands of events and megabytes of text.

1. **Summary**: `read_context {"sessionId": "sess_…"}`. Status, error, device
   (and whether it is online), workspace, group, times, last input, last
   answer, `lastError` with the events just before it, `openBackgroundTasks`.
2. **Errors**:
   `read_context {"sessionId": "sess_…", "scope": "events", "levels": ["error", "warning"], "tail": 20, "context": 2}`.
3. **Latest activity**: scope events with `tail: 20` and no filter.
4. **Search and page**: `query` (label, detail and message text), `labels`,
   and the `before`/`after` cursors each read prints; times such as
   `2026-10-09T20:40:00Z` work as cursors too.
5. **What it changed**: `read_context {"sessionId": "sess_…", "scope": "changes"}`
   lists its files with lines added and removed and the turns that wrote
   them; `read_context {"sessionId": "sess_…", "scope": "changes", "path": "<a path it listed>"}`
   is that file's diff (one turn's with `inputId`), and scope `file` with the
   same `path` the file as it is now. Scope `background` lists the commands
   it left running; `taskId` reads the end of one's output (Member only).
6. Only then, and with `maxBytes`, the full conversation: scope `thread` (a
   session) or `transcript` (a native chat).

Quote times and event lines as evidence; do not guess beyond them. To find
why a session failed or seems stuck, read `references/diagnosing.md`.

## Reading an Issue

`list_issues` lists a workspace's Issues one line each: status, contract,
run, a question waiting for the person and how many required criteria
passed. `get_issue {"issueId": "iss_…"}` reads one: the person's request, the
confirmed contract with each criterion's latest verdict, a newer draft
waiting for confirmation, the question it waits on, the latest review and
its execution run, whose `sessionId` `read_context` reads. Issues are the
person's: these tools only read them.

## Showing things to the person

- **An image**: save it under your workspace's `.foundry/attachments/` folder
  (your device notes give its path) and put `<image path="<its absolute path>">`
  in your reply. An image another session saved in its own workspace's
  `.foundry/attachments/`, on any device the person reaches, shows too when you
  repeat its `<image path="…">` tag unchanged.
- **Files** you created or changed: cite each by its absolute or
  workspace-relative path in inline code (for example `docs/summary.md`); the
  person opens it from your reply.

## Working through other sessions

Start sessions only when the person asks you to hand work to other Foundry
sessions, to run work in parallel sessions, or to work in another workspace or
on another device; or when the task needs software only another device has
(`list_resources`), such as a browser for a screenshot. Not because a task
merely looks parallel: do that with your own tools. Every session takes a slot
on its device, spends model usage and adds a chat to the person's list.

A session that another session started (your summary shows a
`parentSessionId`, and `$FOUNDRY_SESSION_SOURCE` is `agent`) does its brief
itself and starts sessions only when the brief asks for it.

The short path:

1. `list_sessions {"parentOnly": true}`: what you already started. Continue an
   idle one with `send_message` rather than starting another.
2. `create_session {"prompt": "<brief>"}`. Add `workspaceId` for another
   workspace (it runs on that workspace's device), `profileId` from
   `list_profiles` for another runtime or model, `attachments` for files of
   yours it should read, `wait: true` to block until it answers.
3. `wait_session {"sessionId": "sess_…"}` until it settles (at most 10 minutes
   a call; call again while it runs), then read its answer from the result
   and what it changed with `read_context` scope `changes`.
4. `send_message` steers a running session or continues an idle one;
   `cancel_session` stops it and never stops the sessions it started.
5. To check a session's work, start an independent verifier:
   `create_session {"prompt": "<what to check, and how>", "verification": true}`.

Before you orchestrate, read `references/orchestration.md`: briefs, files,
one writer per target, verification, handoff, taking over a group, limits and
reporting.

## Boundaries

- Inspecting is read-only: do not message, cancel, rename, create or hand off
  sessions while you inspect.
- Act on sessions the person pointed you at or that you started; leave other
  work alone even where your tools could control it.
- Start nothing in another workspace or on another device unless the person
  asked for work there or it has what the task needs.
