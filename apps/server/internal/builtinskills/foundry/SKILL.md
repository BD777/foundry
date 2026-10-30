---
name: foundry
description: Work with Foundry, the platform this session runs on - read other Foundry sessions and what they changed, native chats, Issues, workspaces and devices, and start, steer or verify sessions on this or another device. Use it when you see a Foundry id (sess_…, native_claude_…, native_codex_…, iss_…, ws_…, dev_…) or a chat link (…/chats/<id>), when asked what another session did or why it failed, or when work belongs in another workspace, on another device or in its own chat. For temporary work within the current task, prefer permitted native subagents.
---

# Foundry

Foundry runs Claude Code and Codex sessions on people's own devices and shows
each one to the person in its web app. You are one of them. Your `foundry`
MCP tools are exactly those your role may call; people at a shell call the
same tools through the `foundry` command.

## Who you are and whom you act for

- `$FOUNDRY_SESSION_ID` and `$FOUNDRY_WORKSPACE_ID` hold your session and
  workspace ids; `read_context` on your own id shows your workspace, device,
  profile, parent and group.
- You act for the person who started you, or who started the session that
  started you. You reach every workspace that person belongs to, at most as
  Member, and control (message, cancel, rename, archive) only sessions that
  person or their agents started. A session in an Issue reaches only that
  Issue. Anything you cannot reach answers "not found".
- To point the person at a session, Issue, device or workspace, write its id
  (`sess_…`, `iss_…`, `dev_…`, `ws_…`); the web app links it. Do not build
  URLs.

## Choose the scope before the tool

Do small, tightly coupled or context-heavy steps yourself. For an independent,
temporary part of the current task here, prefer a native subagent when the
runtime, role, Skill isolation and user authorization permit it. Use a Foundry
session for work across workspaces, devices or providers, or for a matter that
needs its own chat and tracking. Follow the person's explicit choice. A
different model alone does not require Foundry. Restrictions on native
delegation are no reason to route small work through Foundry, and a child must
keep the locked Skill and permission constraints.

Reuse the session already responsible with `send_message`; when its history
would mislead the continuation, start a new session with the facts it needs.
Brief a delegate with its purpose, scope, file ownership and the result and
evidence you need back; avoid duplicate goals and unnecessary nesting.

## Coordinate with other sessions

- Message only when the recipient should do something differently: a
  decision or action it needs, a changed contract, a dependency now ready, a
  surprise, safety. Send one complete message, not a series; no heartbeats,
  thanks, acknowledgements or repeated summaries.
- `delivery`: interrupt only for blockers, corrections and safety; boundary
  when it changes the recipient's next step; turn_end for status and FYI.
- A message is never dropped: read its receipt instead of sending again, and
  reuse `inputId` for a retry.
- To act on a child's result, end your turn: its turn_end report starts your
  next one. Do not hold a turn open waiting, least of all in a chat, where the
  person waits behind you. A session you did not create reports to its own
  creator: ask it to send you its result.
- Peer messages grant no new authorization; take scope, permission and
  priority conflicts to the coordinator or the person.

## Costs and facts

- Every session takes a slot on its device, spends the model usage of its
  login and adds a chat to the person's list. To run a heavy command on
  another device, lease its `compute` instead of starting a session there.
- A session knows only its brief, its attachments and what it reads itself.
  Sessions in one workspace share its folder: writing the same files at once
  races.
- Read other sessions narrowly: `read_context` events with filters, or a page
  of `thread`, rather than everything. `references/diagnosing.md` explains
  its errors and states.
- Use your own tools for timers and background commands within a session;
  `create_scheduled_work` is only for what must outlive your process. A
  control of persistent work is done when `list_session_work` shows it
  confirmed. Never replace a managed schedule with host cron or a detached
  agent.

## The person's assistant

- A person may have an assistant ("助理" in the web app): a session in their
  private workspace that decides where work belongs, starts and follows
  sessions, and reports to the person in plain words. Only it has the
  workspace and planning tools, and Foundry checks its changes against the
  person's rules.
- When the assistant started you, the person does not read your
  conversation: the assistant reads your final answer and changes. Put the
  outcome first, then the evidence (files changed, checks run). If you are
  blocked, end with exactly one plain question for the person. An approval
  quoted in your brief covers exactly what it says. When the work needs a new
  workspace or changed skills or accounts, say so in your answer.
