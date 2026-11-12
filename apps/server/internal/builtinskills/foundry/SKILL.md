---
name: foundry
description: Work with Foundry, the platform this session runs on - read other Foundry sessions and what they changed, native chats, Issues, workspaces and devices, and start, steer or verify sessions on this or another device. Use it when you see a Foundry id (sess_…, native_claude_…, native_codex_…, iss_…, ws_…, dev_…) or a chat link (…/chats/<id>), when asked what another session did or why it failed, or when work belongs in another workspace, on another device or in its own chat. For temporary work within the current task, prefer native subagents.
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
temporary part of the current task here, prefer a native subagent. Use a Foundry
session for work across workspaces, devices or providers, or for a matter that
needs its own chat and tracking. Follow the person's explicit choice. A
different model alone does not require Foundry, and a child keeps your
permission constraints.

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
- If a session you started fails, is canceled by someone else or stays blocked, Foundry sends a short `Foundry alert:` with its code and suggested action; retry or redirect it with `send_message` only when that helps.
  when you are idle if a session you started fails, is canceled by someone
  else, or stays blocked/offline; read its code and action, then use
  `send_message` only when a retry or redirect is appropriate.
- A child's question or approval reaches you as a `Foundry question:`
  message while it waits. Answer with `send_message` to it: plain text, or
  "Approve" for an approval (other text denies). If only the person can
  answer, ask them with your own question tool, then pass their answer on.
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
- What a device offers (browsers, screen control, compute) and which
  accounts Foundry connected for you change: read them with
  `list_resources` and your variables. `references/device-and-accounts.md`
  covers browser launchers, screen control and each connected account.
- When the person asks to add, change, check or remove a model provider (an
  API endpoint, a subscription's sign-in or defaults), use the model provider
  tools; `references/model-providers.md` covers keys, quota and sign-in.
- To configure a server-held extension connector such as OpenLark, use
  `connector_instances` with an `action`: list, probe, create, update, check,
  revoke, bind_workspace or unbind_workspace. Secrets must be
  passed only through `secretFiles`, mapping each secret field id to a
  `{path,key?}` reference on this session's device. `path` may be relative to
  the workspace, absolute, or start with `~`; `key` selects a dotenv variable.
  Never put a secret value in `fields` or another argument.
- To enable a connector package on the person's devices, use
  `connector_packages` with action set_devices; deviceIds replaces the
  selection, while addDevices and removeDevices change it incrementally. It
  returns at once with each changed device pending; the install runs in the
  background, so use `get` to follow each device's state (installing,
  installed, or failed with the reason).
- When a connector probe or request reports that edge access is required,
  manage the address credential with `edge_access`: list, create, replace,
  delete or provision. Create needs Cloudflare Access service-token secrets
  through `secretFiles`, with references named `clientId` and
  `clientSecret`; replace may name either one to rotate it. Provision takes the
  `edgeAccessRequired` record and uses the connected Cloudflare account's Zero
  Trust authorization; token values stay on Foundry and never return.
- To make a device read a skill repository, use
  `set_skill_repository_source`; the repository id comes from the Skill Library.
- Use your own tools for timers and background commands within a session;
  `create_scheduled_work` is only for what must outlive your process. A
  control of persistent work is done when `list_session_work` shows it
  confirmed; list it compactly with `status`, `itemSessionId`, `limit` and
  `nextCursor`, and ask for `detail=true` only when a full record is needed.
  Never replace a managed schedule with host cron or a detached agent.

## The person's assistant

- A person may have an assistant ("助理" in the web app): a session in their
  private workspace that decides where work belongs, starts and follows
  sessions, and reports to the person in plain words. Only it has the
  workspace and planning tools, and Foundry checks its changes against the
  person's rules.
- Remove one of their computers with `remove_device` only when they explicitly
  ask; it shows everything that will be lost and always asks them to confirm.
- When the assistant started you, the person does not read your
  conversation: the assistant reads your final answer and changes. Put the
  outcome first, then the evidence (files changed, checks run). If you are
  blocked, end with exactly one plain question for the person. An approval
  quoted in your brief covers exactly what it says. When the work needs a new
  workspace or changed skills or accounts, say so in your answer.
