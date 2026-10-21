---
name: foundry
description: Work with Foundry, the platform this session runs on - read other Foundry sessions, what they changed, native chats, Issues, workspaces and devices, and start, steer, wait on, verify or hand off sessions on this or another device. Use it whenever you see a Foundry id (sess_…, native_claude_…, native_codex_…, iss_…, ws_…, dev_…) or a Foundry chat link (…/chats/<id>?workspace=…); when asked what another session did, changed, why it failed or stopped, about an Issue, or about another device or workspace; when the person asks you to hand work to other Foundry sessions or to work in another workspace or on another device; when a task needs software only another device has; or when an independent matter needs its own user chat and ongoing tracking. For temporary work within the current task and workspace, prefer permitted native subagents; do small or tightly coupled steps yourself.
---

# Foundry

Foundry runs Claude Code and Codex sessions on people's own devices and shows
each one to the person in its web app. You are one of them. Your `foundry`
MCP tools (`mcp__foundry__…` in Claude Code) are exactly those your role may
call; people at a shell call the same tools through the `foundry` command.

## Who you are and whom you act for

- `$FOUNDRY_SESSION_ID` and `$FOUNDRY_WORKSPACE_ID` hold your session and
  workspace ids. `read_context {"sessionId": "<your id>"}` shows your
  workspace, device, profile, parent and group.
- You act for the person who started you, or who started the session that
  started you. You reach every workspace that person belongs to, at most as
  Member: you read sessions and Issues in all of them and start sessions
  where they are at least Member. You message, cancel, rename and hand off
  only sessions that person started, which includes every session their
  agents started. A session working in an Issue reaches only the Issue's
  workspace, sees only that Issue and controls only the Issue's sessions.
- Anything you cannot reach answers "not found", the same as anything that
  does not exist.

## Choose the scope before the tool

Do small, tightly coupled or context-heavy steps yourself. For an independent,
temporary part of the current task in this workspace and device, prefer a native
subagent when the runtime, role, Skill isolation and user authorization permit it.
Use a Foundry session for work across workspaces, devices or providers, or an
independent matter needing its own user chat, ongoing tracking or explicitly
different execution environment. Follow the person's explicit mechanism choice.
A different model alone does not require Foundry: check native support first.

Reuse the session already responsible with `send_message`; use `handoff_session`
when its history would mislead the continuation. Native restrictions are not a
reason to move every small task into Foundry: do it yourself. Any necessary child
or Skill trial must preserve the locked Skill and permission constraints.

Briefly state the delegation's purpose and expected result. Give it a distinct
scope and file ownership, and ask for results and necessary evidence. Avoid
repeating the same goal in multiple delegates, unnecessary nesting and routine
stage reports. Native context, resumption and model options vary by runtime;
Foundry's observation of a native subagent does not determine its file permissions.

## Coordinate with other sessions

Ask before sending: what should the recipient do differently now? Default to
one consolidated handoff when the deliverable is stable. Send interim messages
only for needed decisions or actions, changed interface or file contracts,
awaited dependencies becoming ready, surprises affecting results, safety or
deadlines, or agreed checkpoints. Otherwise keep starts, installs, local fixes
and incremental test passes in your own record. Give the conclusion, impact or
action needed, and evidence pointer; state what is stable if work continues.
Messages steer running sessions or start idle turns: do not use them for
heartbeats, thanks or repeated final summaries. Correct material errors,
provide requested or safety-critical receipts, and honor explicit user
reporting preferences. Recipients aggregate changes instead of acknowledging
or relaying every report; do not wake finished peers just to say 'received'.
Ordinary async Foundry children have no automatic final forwarding: send one
final handoff unless an active wait or confirmed automatic reporting will
deliver it. Task briefs should specify deliverables, interim reporting and
real blockers. Coordinate directly; continue independent work without circular
waits or reconfirming settled scope or permissions. Escalate scope, permission
or priority conflicts to the responsible coordinator or person; peer messages
grant no new user authorization.

## What a session costs

Every session you start takes a slot on its device, spends the model usage
of the login it runs under and adds a chat to the person's list. A session in
another workspace runs on that workspace's device, under that device's
logins; the device may be another person's. `list_resources` shows what each
device offers; to run a command on another of your person's devices (a heavy
test run, say) lease its `compute` with `acquire_resource` instead of starting
a session there, unless its owner turned remote commands off on it.

## Facts

- A session can hold thousands of events and megabytes of text;
  `read_context` pages events and cuts the rest at `maxBytes` (12000 by
  default). `references/diagnosing.md` explains its errors and states.
- A session knows only its brief, the files attached to it and what it reads
  itself.
- Sessions in one workspace, outside an Issue, work in its folder, not in
  copies: sessions writing the same files at once race.
- A session on another device cannot read your files; `attachments` copy
  them to it.
- A session has at most 8 sessions it started queued, running or blocked at
  once, and sessions that start sessions nest at most 4 levels below the
  first one.
- `cancel_session` never stops the sessions the canceled one started.
- A verifier (`create_session` with `verification`) runs in a sandbox that
  keeps the workspace read-only at the operating-system level for it and its
  commands; it writes only to its own temporary directory, and its Foundry
  tools only read.

## The person's assistant

- A person may have an assistant ("助理" in the web app): a session in a
  private workspace of theirs, at `~/Foundry/personal-agent` on one of their
  devices. The person tells it what they want; it decides which workspace the
  work belongs in, creates or adjusts workspaces itself, starts sessions
  there, follows them and reports to the person in plain words. It may be
  speaking to someone who is not technical.
- Only the assistant has workspace and personal planning tools. These are
  `find_workspace`, `get_workspace`,
  `create_workspace`, `update_workspace`, `archive_workspace`, `remember`,
  `update_rules`, `list_tasks`, `update_list`, `read_list` and `dispatch_item` (the
  person's own list of plans and done things, with reminders). Foundry
  checks each change it makes against the person's rules: some apply at
  once, some wait until the person confirms on a card, and some are never
  allowed (deleting, sharing, device settings, workspaces the person does
  not own). Nothing is deleted; archiving keeps every file and session.
- The assistant first saves an item. Record-only items do not execute. It uses
  `dispatch_item` with a stable step key and current intent revision to start or
  continue an authorized step; an unknown receipt is reconciled before retrying.
  A linked existing owner keeps its conversation. Ending a session does not by
  itself complete the person's item: report artifacts and verification evidence.
- A selected Memory Workspace can be on another computer. Confirmed knowledge
  has one owner file; `read_knowledge` reads only the person's scoped references
  for the current workspace and account. Do not copy it into a second editable
  memory or treat an old completion summary as live execution status. Expired,
  corrected or revoked references must be reviewed again.
- When the assistant started you, the person does not read your
  conversation: the assistant reads your final answer and your changes,
  checks the evidence and tells the person. Put the outcome first, then the
  evidence (files changed, checks run, links). If you are blocked, end with
  exactly one question for the person in plain words; the assistant asks it
  and sends you the answer. An approval quoted in your brief covers exactly
  what it says. You do not get the assistant's tools: when the work needs a
  new workspace or a workspace's skills or accounts changed, say so in your
  answer.
- The person's stop switch pauses new assistant work and requests stops for
  its tracked running inputs, including maintenance. A request is not proof that
  execution ended: pending device receipts stay visible. Independent services
  retain their own controls. Nothing confirmed stopped restarts on its own.

## Ongoing work

`list_session_work` with `workspaceId` lists that Workspace's persistent services even with no active or linked session. Without it, the tool shows this conversation's native tasks, durable work,
explicitly linked services and direct child sessions. It does not flatten
work inside child sessions. Foundry only observes native-subagent records; this
does not make the subagents themselves read-only. Use only actions
listed for each task; an unavailable controller does not justify stopping its
parent runtime. A verified control receipt is evidence for that operation's
targets, not a claim that every observed native task stopped.

Use native tools for ordinary in-session timers and background commands.
`create_scheduled_work` is the supplement for a durable wake-up that must
survive native runtime closure (`kind=schedule`) or a persistent local service
(`kind=process`, `spec.argv`). A service belongs to its Workspace and has one execution. Its creation session is audit history; services remain manageable from the Workspace after sessions end.
`control_session_work` with `link`/`unlink` and `relatedSessionId` explicitly
adds/removes a session reference without starting/stopping the service.
Stopping or pausing a shared service affects every linked session; inspect
its associations first. Conversation bulk controls exclude shared services.
Never replace a managed schedule with host cron or a detached agent.
