---
name: foundry
description: Read-only inspection of Foundry sessions, native chats, workspaces and devices. Use it whenever you see a Foundry id (sess_…, native_claude_…, native_codex_…, ws_…, dev_…) or a Foundry chat link (…/chats/<id>?workspace=…), or are asked what another session did, why it failed or stopped, or about another device or workspace. Not for creating or steering sessions.
---

# Foundry inspection

Foundry runs Claude Code and Codex sessions on people's devices. A session can
hold thousands of events and megabytes of text: read it in small, targeted
steps, never whole.

## Tools

- Inside a Foundry session, use the `foundry` MCP tools (`mcp__foundry__…` in
  Claude Code): `get_session`, `read_context`, `list_workspaces`,
  `list_resources`, `list_sessions`.
- Elsewhere on a paired device, use the `foundry` CLI (it reads the device's
  credential):
  `foundry session get <id|link>`,
  `foundry session events <id|link> [--errors] [--level …] [--label …] [--query …] [--tail N] [--limit N] [--context N] [--after C] [--before C] [--max-bytes N]`,
  `foundry workspace list`, `foundry device list`.

Ids and links work across every workspace you reach, no workspace id needed:
a session's tools reach every workspace of the person who started it; the
CLI with a device's credential reaches that device's workspaces. A session
you cannot reach answers "not found".

## Reading a session

Every call names the session as `sessionId` (an id or a link).

1. **Summary**: `get_session {"sessionId": "sess_…"}` /
   `foundry session get <id|link>`. Status, error, device (and whether it is
   online), workspace, times, last input, last answer, `lastError` with the
   events just before it, `openBackgroundTasks`.
2. **Errors**:
   `read_context {"sessionId": "sess_…", "scope": "events", "levels": ["error", "warning"], "tail": 20, "context": 2}`
   / `foundry session events <id> --errors --tail 20 --context 2`.
3. **Latest activity**: `scope=events` with `tail: 20` and no filter.
4. **Search and page**: `query` (label, detail and message text), `labels`,
   and the `before`/`after` cursors each read prints. Times such as
   `2026-10-09T20:40:00Z` work as cursors too.
5. Only then, and with `maxBytes`, the full conversation: `scope=thread`
   (session) or `scope=transcript` (native chat).

Quote times and event lines as evidence; do not guess beyond them.

## Diagnosing a failed or stuck session

- Start from `status`, `error` and `lastError.before`.
- "Claude Agent SDK stopped producing events before the session idle timeout"
  comes from older workers, which failed a turn after 10 minutes without
  events. If "Waiting for background tasks" comes just before it, a background
  task (a Monitor, a `run_in_background` command) kept the turn open: see
  `openBackgroundTasks` and the "Starting subtask" events. Current workers
  never fail a turn for being quiet: a "Notice" saying there was no progress,
  or that an operation ran past its limit, is a warning while the turn keeps
  running. "Claude Code did not start" or "never reached the model" is a
  start-up hang; the message names the phase and quotes Claude Code's output.
- "Subtask failed" errors are background tasks ending badly; they rarely end a
  session on their own.
- "Session canceled" (warning) means someone stopped it.
- `device.online: false` or "local daemon is not connected": the device's
  worker is offline; check `foundry device list` / `list_resources`.
- Compare the gap between the last events and `completedAt`: a long silence
  is a wait, not work.

## Boundaries

Read only. Do not send messages to, cancel, rename, create or hand off
sessions while inspecting; that is orchestration, done only when the person
explicitly asks for it.
