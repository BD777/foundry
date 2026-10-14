---
name: foundry
description: Work with Foundry, the platform this session runs on - read other Foundry sessions, what they changed, native chats, Issues, workspaces and devices, and start, steer, wait on, verify or hand off sessions on this or another device. Use it whenever you see a Foundry id (sess_…, native_claude_…, native_codex_…, iss_…, ws_…, dev_…) or a Foundry chat link (…/chats/<id>?workspace=…); when asked what another session did, changed, why it failed or stopped, about an Issue, or about another device or workspace; when the person asks you to hand work to other Foundry sessions or to work in another workspace or on another device; when a task needs software only another device has; or when you decide part of your task is better done in other sessions.
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
- Only the assistant lists `find_workspace`, `get_workspace`,
  `create_workspace`, `update_workspace`, `archive_workspace`, `remember`,
  `update_rules` and `list_tasks`. Foundry checks each change it makes
  against the person's rules: some apply at once, some wait until the person
  confirms on a card, and some are never allowed (deleting, sharing, device
  settings, workspaces the person does not own). Nothing is deleted;
  archiving keeps every file and session.
- When the assistant started you, the person does not read your
  conversation: the assistant reads your final answer and your changes,
  checks the evidence and tells the person. Put the outcome first, then the
  evidence (files changed, checks run, links). If you are blocked, end with
  exactly one question for the person in plain words; the assistant asks it
  and sends you the answer. An approval quoted in your brief covers exactly
  what it says. You do not get the assistant's tools: when the work needs a
  new workspace or a workspace's skills or accounts changed, say so in your
  answer.
- The person's stop switch cancels the assistant's sessions and every
  session it started ("Session canceled"); nothing it stopped restarts on
  its own.
