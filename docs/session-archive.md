# Session archive — research and design

Status: implemented and dev deployed; DEV-048 Agent self-verification recorded, human acceptance pending (2026-10-27). Owner: research/design session `sess_1793002090480217302`, for orchestrator `sess_1792999134370683044`. Date: 2026-10-26.

User intent: an "Archive" like the Codex app. Archive one session or a group of sessions in Foundry. A session's native Codex/Claude conversation is archived in its own agent environment as well.

Evidence labels: **[verified]** means run or read on this device (codex-cli 0.163.0, Claude Code 2.1.295, claude-agent-sdk 0.3.201) or in Foundry source. **[docs]** means official docs or schema. **[reported]** means GitHub issues or forum posts.

---

## 1. Research findings

### 1.1 Product comparison

| Product                                  | Archive vs delete                                                                                                                                                                                                                                                           | Where archived items go                                                                                                                                                                                                                                                                  | Bulk / auto                                                                                                                                                                                                                                                | Unarchive                                                                                                                               | Archived items still allow                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Codex** (CLI, app-server, desktop app) | Separate `archive`, `unarchive` and `delete` actions [verified]                                                                                                                                                                                                             | Hidden from the default list. The desktop app shows them under Settings → Archived chats; a sidebar "Show archived" option is requested but not shipped ([#27207](https://github.com/openai/codex/issues/27207), [#46549](https://github.com/openai/codex/issues/46549)) [docs/reported] | One thread per call. No auto-archive                                                                                                                                                                                                                       | Yes. The thread "reappears in its original sidebar location" ([settings docs](https://developers.openai.com/codex/app/settings)) [docs] | **Read: yes. Resume: refused** until unarchived [verified]                        |
| **Claude Code CLI**                      | No archive. Only delete (SDK `deleteSession`) and `cleanupPeriodDays` (default 30) auto-deletion [verified]                                                                                                                                                                 | n/a. Requested in [#19138](https://github.com/anthropics/claude-code/issues/19138) and [#65615](https://github.com/anthropics/claude-code/issues/65615)                                                                                                                                  | —                                                                                                                                                                                                                                                          | —                                                                                                                                       | —                                                                                 |
| **Claude desktop / claude.ai/code**      | Archive exists. For local Code sessions it is an `isArchived` flag in the app's own JSON under `~/Library/Application Support/Claude/claude-code-sessions/…`, **not** in `~/.claude/projects` ([#67835](https://github.com/anthropics/claude-code/issues/67835)) [reported] | Status filter → Archived (hard to find; [#67835](https://github.com/anthropics/claude-code/issues/67835)) [reported]                                                                                                                                                                     | Auto-archives when a PR closes (`ccAutoArchiveOnPrClose`) and after inactivity ([#60043](https://github.com/anthropics/claude-code/issues/60043)). Bulk archive is requested ([#85704](https://github.com/anthropics/claude-code/issues/85704)) [reported] | An "Unarchive to continue chat" button. Sending a message also unarchives [reported]                                                    | Read: yes. Send: blocked ("Session … is archived; unarchive it first") [reported] |
| **ChatGPT**                              | Archive is separate from delete ([help](https://help.openai.com/en/articles/8809935-deleting-and-archiving-chats-in-chatgpt)) [docs]                                                                                                                                        | Settings → Data controls → Archived chats                                                                                                                                                                                                                                                | "Archive all chats" only; no multi-select or bulk restore. Archiving a scheduled-task chat **pauses the task** [docs]                                                                                                                                      | Yes, per chat                                                                                                                           | Read, **search (Cmd+K finds archived chats)**, continue after unarchive           |
| **Cursor** (Agents window)               | Archive replaced Delete in the menu ([forum](https://forum.cursor.com/t/restore-delete-option-alongside-archive-in-chat-history/154601)) [reported]                                                                                                                         | A collapsed "Archived" section or Filter → Status → Archived; it varies by version ([forum](https://forum.cursor.com/t/archived-projects-and-chats-are-hard-to-find-in-the-agents-window-sidebar-and-the-archived-view-is-unclear/173698)) [reported]                                    | "Archive Prior Chats" and "Archive All", with no confirmation and no bulk undo; users complain ([forum](https://forum.cursor.com/t/misclick-on-archive-prior-chats/159587)). A shortcut (Cmd+Shift+E) causes accidental archives [reported]                | Restore one at a time                                                                                                                   | Read, search, restore                                                             |

What Foundry should copy: archive is reversible and kept separate from delete. Archived items need a discoverable place (all five products are criticized for hiding it). Unarchive puts an item back where it was. Bulk archive needs **bulk undo** (Cursor's main failure). Archived chats stay searchable (ChatGPT). Scheduled work is paused rather than left running (ChatGPT). Avoid single-key archive shortcuts (Cursor).

### 1.2 Codex native mechanics [verified]

How this was tested: I copied one real rollout into a scratch `CODEX_HOME=/tmp/codex-arch-scratch/home` and rewrote its thread id to a fake UUID, so the real `~/.codex` could not be touched (checked afterwards). I then ran `codex archive`/`codex unarchive` and raw JSON-RPC over `codex app-server` stdio. Probe script: `/tmp/codex-arch-scripts/rpc.py`. Schema: `codex app-server generate-json-schema --out /tmp/codex-schema-arch`.

- **API.** App-server v2 has `thread/archive {threadId} → {}` with notification `thread/archived`. `thread/unarchive {threadId} → {thread}` emits `thread/unarchived`. `thread/delete` is separate. `thread/list {archived: true|false|null}`: `null`/`false` returns only non-archived threads. The CLI has `codex archive <id|name>` and `codex unarchive <id|name>` (same operation, prints `Archived session <id>.`).
- **On disk.**
  - Archive moves the rollout from `sessions/YYYY/MM/DD/rollout-…-<id>.jsonl` to the flat `archived_sessions/rollout-…-<id>.jsonl`. Content is unchanged (same 21,955 bytes).
  - Unarchive moves it back to `sessions/YYYY/MM/DD/`, with the date taken from the filename.
  - The real `~/.codex/archived_sessions` holds 2 such files.
- **SQLite** (`state_5.sqlite`, table `threads`): archive sets `archived=1`, sets `archived_at=<unix s>` and rewrites `rollout_path`. Unarchive sets `archived=0` and `archived_at=NULL`, and bumps `updated_at`, so the thread jumps to the top of recency. The real DB has 388 active and 2 archived threads. `session_index.jsonl` (titles) is not changed.
- **Behaviour of an archived thread.**
  - `thread/read` works.
  - `thread/resume` fails with `-32600 "session <id> is archived. Run \`codex unarchive <id>\` to unarchive it first."`
  - `thread/list {archived:true}` lists it.
- **Not idempotent.**
  - A second `thread/archive` fails with `"no rollout found for thread id …"`.
  - A second `thread/unarchive` fails with `"no archived rollout found …"`.
  - Callers must check state first.
- **Stale index path.** If `rollout_path` points into a dead directory, archive fails with `no rollout found` even when the file is present in `sessions/`.
  - This is the normal case for Foundry-run threads. In the real DB, 145 of 390 threads are indexed through Foundry execution homes (`~/.foundry/native-runtime/{owners/,}codex/<hash>/sessions/…`, which symlink `sessions/` and `archived_sessions/` to the data home and set `sqlite_home` to it: `packages/worker/src/runtime-isolation.ts:183-196`).
  - 59 of those paths are dead. `resumeCodexThread` (`runner/codex-app-server.ts:89`) already repairs this for resume, and archive needs the same repair.
- **Live threads.** Archive/delete of a live internal worker thread is rejected with `-32600` ([app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)) [docs]. Archiving the thread that is open in the desktop app produces "session is archived" errors there ([#25769](https://github.com/openai/codex/issues/25769)) [reported].
- **Shared state.** Every Codex client on a device (desktop app, CLI, Foundry's app-server) shares `sqlite_home`. An archive made through any of them is therefore seen by all of them.

### 1.3 Claude Code native mechanics [verified unless marked]

- **Local storage.** Transcripts live at `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd-slug>/<uuid>.jsonl`, plus a `<uuid>/` directory for subagent transcripts and tool results. Foundry's execution homes symlink `projects/` to the data home (`runtime-isolation.ts:263`).
- **No archive.**
  - `claude --help` has no archive command.
  - Every `archived` string in the CLI binary refers to **cloud/remote** sessions (`session_status==="archived"` from the claude.ai API), not local JSONL.
  - Agent SDK session functions are `listSessions`, `getSessionInfo`, `renameSession`, `tagSession` (appends a tag entry and exposes `SDKSessionInfo.tag`), `forkSession` and `deleteSession` (removes `<id>.jsonl` and `<id>/`). There is no archive.
- **Auto-deletion.** `cleanupPeriodDays` (default 30, minimum 1) deletes transcripts older than N days. It is not set on this device. **Implication:** today, a Foundry-run Claude session's native transcript can disappear after 30 days, independent of archive.
- **Desktop archive.** Claude desktop's archive is app-private metadata outside `~/.claude` [reported]. Writing it is not viable: the running app overwrites the file and re-archives sessions.

So for Claude, "archive in the raw environment" has to be a Foundry convention. Options are in §3.2.

---

## 2. Foundry today (what archive touches)

| Concept                                                                                                                                                                                                                                                    | Where                                                                            | Relevance                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session (`sess_…`) = one chat. `ThreadID==ID`; `ParentSessionID` gives lineage; `IssueID`/`Role` mark Issue execution, clarification or verification                                                                                                       | `store/sessions.go:126`, table `agent_sessions`                                  | The unit that gets archived                                                                                                                                            |
| Native sessions a session ran: `(provider, native_id) → session_id, device_id, current`                                                                                                                                                                    | `sqlitestore/native_sessions.go`, `agent_session_native_ids`                     | Fan-out targets for the native archive. **The profile/home is not recorded**                                                                                           |
| Unowned device native chats (`native_codex_…`/`native_claude_…`), synced by the worker scanning `sessions/` and `projects/`                                                                                                                                | worker `native-chat.ts:244-330`, server `chats` table, `saveComparedChat`        | The scanner never reads `archived_sessions/`, so a chat archived in Codex disappears from Foundry today. Adoption (`AdoptedChatID`) turns a native chat into a session |
| "Groups" = chat-layout folders. Orchestration auto-creates one when an agent starts a child (`PlaceChildWithParent`)                                                                                                                                       | `store/chats.go:68`, `sqlitestore/session_lineage.go`, MCP `list_group_sessions` | "Archive a group" means archiving a folder                                                                                                                             |
| Soft delete: `chat_deletions(workspace_id, deletion_key ∈ {id:…, native:provider:id})`, used only by **Delete folder**. Refuses queued/running sessions. Visibility SQL `visibleAgentSessionSQL`/`visibleChatSQL`. Deleted sessions' tokens stop resolving | `sqlitestore/chat_deletions.go`, `session_tokens.go:79`                          | Archive should follow the same key model but be reversible. There is no per-chat delete                                                                                |
| Workspace archive: `ArchivedAt`; hidden in an "Archived" group; starts no sessions; PA tool `archive_workspace` with a `needs_confirmation` flow                                                                                                           | `store/workspaces.go:27`, `httpapi/workspace_lifecycle.go`, `mcp_tools.json`     | Precedent for wording, PA policy and audit                                                                                                                             |
| Session work: timers, schedules, services and native work linked to a session (`desiredState`, `control_session_work`)                                                                                                                                     | `store/session_work.go`, `session_timers.go`                                     | Must be paused or blocked on archive                                                                                                                                   |
| Chat queue (messages waiting for a session)                                                                                                                                                                                                                | `sqlitestore/chat_queue.go`                                                      | Must not dispatch into an archived session                                                                                                                             |
| Device ops: `callDevice` over the daemon WS. Reconciled on reconnect (pattern: `forgetDeletedWorkspace`, once per connection). Capabilities are sent in hello (`workspace-ops.ts:456`, protocol `daemon-messages.ts`)                                      | `httpapi/daemon_requests.go:167-215`                                             | The pattern for a native archive on an offline device                                                                                                                  |
| Web: the sidebar list (`use-chat-list-items.ts`), row menu (`chat-list-row-menu.tsx`), folder menu, delete (`chat-thread-view.tsx:207`)                                                                                                                    | `apps/web/src/features/chat/`                                                    | **Naming trap:** the web prop `archivedChats` actually means _unowned native chats_ (`app/use-chat-view.ts:66`). Rename it before adding real archive                  |
| Search                                                                                                                                                                                                                                                     | No server-side session search. The list filter is client-side                    | The archived view needs its own title filter                                                                                                                           |

---

## 3. Proposed semantics

### 3.1 Foundry archive (server is the source of truth)

**Archive a session** sets `archivedAt` and `archivedBy` (user or agent session), plus a `batchId` shared by everything archived in one action.

- **Preconditions** (the server refuses with 409 and gives the reason as copy):
  - The session is not `queued`/`running`; otherwise "Stop it first". Same rule as Delete folder.
  - It is not an Issue-owned session (`IssueID` set, or an execution/clarification/verification role); otherwise "managed by Issue `iss_…`". Those follow the Issue lifecycle.
  - It is not a Personal Agent session (v1). The assistant chat is the home conversation.
- **Effects:**
  - Hidden from the sidebar, `GET /api/chats` and MCP `list_sessions` by default.
  - Keeps its folder position, so unarchive restores it in place, as Codex does.
  - Queued chat messages are held: the queue does not dispatch while archived.
  - Linked session work (schedules, timers, services) is **paused** and listed in the confirmation. Unarchive does not auto-resume it (see decision D3).
- **Still allowed:**
  - Open by link or from the Archived view.
  - Read the transcript, files and diffs.
  - `get_session`/`read_context`, which report `archivedAt` and native state.
  - Rename. Copy ids.
- **Not allowed:** sending input (Web, REST, MCP `send_message`, timers) returns 409 `session_archived`, "Unarchive to continue" (see D2).

**Archive a group (folder)** archives every chat in the folder in one batch, and the folder itself is marked archived (it stays in the layout, hidden).

- A preflight returns blockers: running or queued sessions, Issue-owned sessions, scheduled work to pause.
- The commit is atomic for the set the person confirmed.
- Unarchiving the folder restores the whole batch, folder name and order included.

**Children**

- Archiving a single parent does not cascade (D4). Children stay visible, and their parent link reads "archived".
- An orchestrator's sub-sessions share its auto-created folder, so "Archive folder" is the bulk path.

**Unarchive**

- Clears `archivedAt` for the item or the batch.
- An "Undo" toast after archive calls unarchive on the batch (fixes Cursor's no-bulk-undo).
- Unarchive is allowed inside an archived workspace, but no session starts until the workspace is restored (existing rule).

**Visibility details**

- The Archived view is per workspace and grouped by original folder. Each row shows title, runtime, device, archived date and native status, with a title/preview filter and multi-select Unarchive.
- MCP `list_group_sessions` includes archived members with `archived: true`, so a replacement orchestrator still sees the whole group.
- Unowned native chats (`native_…`) can be archived too. That archives them natively; there is no Foundry-only state for them (see §3.3).

**Delete stays separate.** The existing "Delete folder" (permanent hide) keeps its destructive copy. Archive is the default, reversible action.

### 3.2 Native archive per runtime

A native archive is a **device operation**. Foundry archive completes immediately; native state is tracked per `(provider, native_id, device_id)` and shown beside it.

**Codex: use Codex's own API, so the Codex app/CLI agree.**

1. Resolve the thread's home. Try the data home of the session's current profile (the identity hash in `runtime-isolation.ts`), then the other Codex data homes on the device (`codexHomeCandidates()` plus profile homes).
2. Start `codex app-server` with the same isolated execution environment the session uses: same identity, so the same execution home and the same indexed `rollout_path`.
3. Call `thread/read`:
   - Already in the desired state → success (idempotent).
   - Not found in any home → `not_found`, reported and not retried.
4. Call `thread/archive` or `thread/unarchive`.
   - On `no rollout found`, apply the dead-alias repair already in `resumeCodexThread` (factor it out and share it), then retry once.
   - Never edit `state_5.sqlite` directly.
5. If the thread is live, outside Foundry or in a Foundry turn (-32600), the result is `failed: in use`. Retry later; a Retry button is shown.

Resume guard (also fixes a latent bug: a thread archived in the Codex app breaks the next Foundry turn today): before `thread/resume`, the worker checks archived state. If the **Foundry** session is not archived, the worker unarchives natively, then resumes. The notice says "Codex had this thread archived; Foundry restored it."

**Claude: Foundry convention (options; recommendation is D1).**

- **(A) Foundry-only.** No native change. `claude --resume` and `/resume` still list the session. Zero risk, but it does not meet "archived in the raw environment".
- **(B) Move aside (recommended).** Mirrors Codex exactly.
  - Archive: atomically `rename` `<dataHome>/projects/<slug>/<id>.jsonl` and `<id>/` into `<dataHome>/archived_sessions/projects/<slug>/`, and write `<id>.foundry-archive.json` with the original path, time and Foundry session id.
  - Effects: hidden from `/resume` and `--resume`, which fail until unarchived. Foundry unarchives before resuming. Out of `cleanupPeriodDays`' sweep (to verify), so archived transcripts are _kept_; this is a feature but costs disk.
  - Unarchive: rename back to the recorded path. If the target exists, the result is `failed: conflict` and nothing is overwritten.
  - Guard: refuse with `in use` if the file was written in the last 2 minutes or a Claude process holds it.
  - Untouched: `file-history/`, `todos/` and `session-env/`, which are keyed by id.
  - Risk: unknown third-party readers (Claude desktop's local Code sessions on macOS) lose the transcript while it is archived. This is reversible.
- **(C) Tag.** `tagSession(id, "archived")` through the SDK. Native, non-destructive, and resume still works. Visible in session metadata, but `/resume` is **not** documented to hide tagged sessions, so the CLI picker still lists it. Easy to undo (`tagSession(id, null)`).

**Device offline and reconciliation**

- The server keeps the desired state with a generation number per native target.
- On archive, unarchive, or the device's (re)connect (like `forgetDeletedWorkspace`), the hub sends `native_archive` with the latest desired state. The worker applies it and answers each item with `archived | active | not_found | failed(reason)`. An item already in the desired state counts as success.
- A newer generation supersedes older ones, so archive→unarchive while offline nets to "do nothing".
- UI states:
  - "Archived in Codex on <device>" ✓
  - "Pending: <device> offline; applies when it reconnects"
  - "Failed: <reason>" [Retry]
  - "Needs worker update"
- Unarchive while the device is offline: the Foundry unarchive succeeds, and the native unarchive is queued. A new message already waits for the device (`waitingForDevice`), and the worker's resume guard unarchives natively first, so ordering is safe.

**Old workers.** Gate on a new capability `native_archive_v1` in hello. Without it, the native state is `unsupported` with the copy "Update the worker on <device> to archive in Codex/Claude too". The Foundry archive still works, and native archive reconciles once the worker updates. The chat sync of an old worker keeps dropping externally archived Codex threads, as it does today.

**Externally archived native chats (two-way).**

- With the capability, the worker also scans `archived_sessions/` (Codex) and `archived_sessions/projects/` (Claude B) and reports those chats with `archived: true`. An unowned native chat archived in the Codex app therefore shows in Foundry's Archived view instead of vanishing, and unarchiving it in Foundry unarchives it in Codex.
- For a Foundry-owned session, the Foundry state wins (D5). Native archive state is shown but never archives the Foundry session by itself.
- History import (`native_history`) and `nativeChatLogPath` must look in the archived locations too.

### 3.3 Data model

- **New table `chat_archives`** (mirrors `chat_deletions` keys so aliases stay consistent):
  - Columns: `(workspace_id, archive_key, archived_at, archived_by_user, archived_by_session, batch_id)`, PK `(workspace_id, archive_key)`.
  - Keys `id:<sess|native chat id>` and `native:<provider>:<nativeId>` are written for every native id the session owns.
  - Visibility SQL gets an `archived` mode: `exclude` (default) | `only` | `include`.
  - Unarchive deletes the batch's or item's rows.
  - An unowned native chat synced again while its key is archived is stored as archived.
- **`ChatLayoutGroup.archivedAt`** (layout JSON, so no migration). The folder is hidden when every member is archived.
- **New table `native_archive_targets`**: `(provider, native_id, device_id, session_id, desired, generation, state, error, attempted_at, applied_at)`. Written only by a new `sqlitestore/native_archive.go`.
- **Projections:**
  - `AgentSession` and `ChatThread` gain `archivedAt?`, `archiveBatchId?` and `nativeArchive?: {provider, deviceId, state, error?}[]`.
  - Protocol: `chat.ts`, `session.ts`, plus `daemon-messages.ts` (`native_archive` request/result and `nativeArchiveCapability`).
  - Recommended: record `profile_id` on `agent_session_native_ids` going forward, so the worker targets the exact home.

### 3.4 API, MCP and access

| Surface                                                                         | Shape                                                                                                                                                                                                  | Access rule                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/chats/archive`                                                       | `{workspaceId, chatIds?[], groupId?, dryRun?}` → `{batchId, archived[], blockers[{id, reason}], pausedWork[]}`. `dryRun` is the preflight                                                              | workspace `member` (as rename). Session token: only sessions the agent controls (same as `rename_session`)                                                                         |
| `POST /api/chats/unarchive`                                                     | `{workspaceId, chatIds?[] \| batchId? \| groupId?}`                                                                                                                                                    | same                                                                                                                                                                               |
| `GET /api/chats?archived=only\|include` and `GET /api/agent-sessions?archived=` | Archived view and listing                                                                                                                                                                              | `viewer`                                                                                                                                                                           |
| `POST /api/chats/{id}/native-archive/retry`                                     | Re-sends the current desired state                                                                                                                                                                     | `member`                                                                                                                                                                           |
| Send, enqueue, timer fire                                                       | 409 `session_archived` while archived                                                                                                                                                                  | —                                                                                                                                                                                  |
| MCP `archive_session` (new)                                                     | `{sessionId \| sessionIds[] \| groupId, restore?}`. Returns per-item results; blockers are explained                                                                                                   | Agents: sessions they control. Personal Agent: the policy key `archive_session`, which asks the person by default for groups or more than 3 sessions (reuses `needs_confirmation`) |
| MCP `list_sessions`                                                             | Adds `archived: "exclude"\|"only"\|"include"`                                                                                                                                                          | read                                                                                                                                                                               |
| MCP `get_session` / `read_context` / `list_group_sessions`                      | Show `archivedAt` and native state                                                                                                                                                                     | read                                                                                                                                                                               |
| Daemon WS                                                                       | `native_archive {items:[{provider, nativeSessionId, profileId?, workspacePath, desired, generation}]}` → `native_archive_result {items:[{…, state, error?}]}`; chats sync items gain `archived?: true` | daemonProtocol                                                                                                                                                                     |

### 3.5 Web UI (AGENTS.md principles)

- **Row menu.**
  - Add **Archive** (an icon and a text label).
  - On a running or queued chat, the item is disabled with visible secondary text "Stop it first"; the reason is not hover-only.
  - Issue-owned chats do not show the item.
  - No single-key or global shortcut.
- **Folder menu.**
  - Add **Archive folder (N chats)**. It opens a dialog built from the `dryRun` preflight: the chats included, blockers (each with a "Stop" or "Open" link), and scheduled work that will be paused.
  - Buttons: "Archive N chats" (primary) and Cancel.
  - "Delete folder" stays the separate, red, destructive action, with copy that says it cannot be undone.
- **After archive.** A toast reads "Archived N chats. Codex/Claude copies follow on each device." with **Undo**, which unarchives the batch.
  - If the open chat was archived, the selection moves to the adjacent chat ([#105021](https://github.com/anthropics/claude-code/issues/105021) asks Claude for exactly this).
- **Archived entry.**
  - A flat row "Archived (N)" with a forward chevron sits at the bottom of the chat list. It opens the Archived view (route `/chats/archived`, a route field in `navigation.ts`).
  - The view has a filter box, rows grouped by original folder, and checkboxes using the `Checkbox` primitive.
  - Each row has a visible **Unarchive** button; multi-select gives "Unarchive N".
  - The view has its own empty state.
- **Opening an archived chat.**
  - The transcript is read-only. A banner reads "Archived on <date> by <who>." with an **Unarchive** button, plus one line per native target: ✓, pending, failed with Retry, or needs update.
  - The composer is replaced by "Unarchive to continue".
- **Copy.** Both locales live in `i18n/locales/{en,zh-CN}/chat.ts`.
- **Prerequisite.** Rename the web prop `archivedChats` to `nativeChats`.

---

## 4. Decisions needed from the user

1. **Claude native archive.** Options: (A) Foundry-only; (B) move the transcript into `archived_sessions/`, which hides it from `claude --resume` until Foundry unarchives it and keeps it from 30-day cleanup; (C) a native SDK tag, which does not hide it from `/resume`. **Recommend B.** It matches Codex semantics and the request that it be archived in the raw environment, and it is reversible.
2. **Sending to an archived session.** Options: (a) block until an explicit Unarchive (Codex); (b) auto-unarchive on send (Claude desktop). **Recommend (a)** in Web, REST and MCP: one click on the banner. Agents get a clear 409, so an orchestrator never silently revives a session the person archived.
3. **Scheduled work and timers of an archived session.** Options: block archive until they are stopped; pause them on archive; leave them running. **Recommend pause on archive** (listed in the confirmation, like ChatGPT). Unarchive does **not** auto-resume them; resume is explicit in the work panel.
4. **Archiving a parent with children.** Options: archive only the parent; or cascade to its sub-sessions. **Recommend parent only** for single archive, plus **Archive folder** as the bulk path (orchestrators already group children in a folder).
5. **External native archive of a Foundry-owned session** (archived in the Codex app). Options: mirror it (archive the Foundry session as well); or keep the Foundry state and auto-unarchive natively on the next Foundry turn. **Recommend keep the Foundry state.** Show "archived in Codex" and unarchive natively on resume. Unowned native chats mirror both ways.
6. **Scope of v1 bulk.** Options: folder archive only; or also multi-select in the main list. **Recommend folder archive plus multi-select unarchive** in the Archived view for v1. Main-list multi-select later. No auto-archive in v1. "Archive finished chats older than N days" is a later option.
7. **Who may archive.** **Recommend:** workspace members, and agents for sessions they control (same rule as `rename_session`). The Personal Agent asks the person first for folders or more than 3 sessions.

---

## 5. Implementation plan

Order: WP0 must land first because consumers read the protocol `dist/`. Then WP1–WP4 run in parallel. WP5 runs last.

| WP                                    | Owner area | Files owned (exclusive)                                                                                                                                                                                                                                                                                                                                                                                                                 | Content                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WP0 Protocol**                      | protocol   | `packages/protocol/src/chat.ts`, `session.ts`, `daemon-messages.ts` (new types and the `nativeArchiveCapability` const only)                                                                                                                                                                                                                                                                                                            | Archive fields, the `native_archive` request/result, chat-sync `archived` flag. `pnpm --filter @bd777/foundry-protocol build`                                                                                                                                                                                                                                                       |
| **WP1 Server: Foundry archive**       | server     | New `sqlitestore/chat_archives.go` (+ test), `schema.go` (new table), `store/chats.go`/`store/sessions.go` (fields, interface), `chat_deletions.go` visibility consts (extend to an archived mode), `chat_queue.go` (hold), `session_tokens.go` if needed; new `httpapi/chat_archive.go` (+ test), `routes.go`, `policy.go`, `mcp_tools.json`, new `mcp_archive.go`, `mcp.go` registration, PA policy key in `store/personal_agent*.go` | Preflight/commit/unarchive and batches; refusing sends and enqueues; pausing session work through existing work control; list filters; MCP `archive_session` and the `list_sessions` filter; audit                                                                                                                                                                                  |
| **WP2 Server: native reconciliation** | server     | New `sqlitestore/native_archive.go` (+ test, schema in-file like `nativeSessionSchema`), `httpapi/daemon_wire.go`, `daemon_requests.go`, new `httpapi/daemon_native_archive.go` (+ test), the chats-sync save path in `sqlitestore/sqlitestore.go` (`saveComparedChat`: keep archived native chats)                                                                                                                                     | Desired-state rows and generations; push on change and on connect; results into the projection; capability gating; retry endpoint handler. WP1 exposes a store hook `ArchiveNativeTargets(sessionIDs, desired)`, and WP2 implements it. The interface is agreed in WP0 notes                                                                                                        |
| **WP3 Worker**                        | worker     | New `src/native-archive.ts` (+ `test/native-archive.test.mjs`), new `src/daemon/handlers/native-archive.ts`, `src/native-chat.ts` (scan archived locations; `nativeChatLogPath`), `src/runner/codex-app-server.ts` (factor out the alias repair; resume guard), the Claude resume path in `src/runner/claude-launch.ts` (unarchive before `--resume`), and the capability line in `src/workspace-ops.ts:456`                            | Codex archive through app-server with an idempotent check; Claude option B (or the chosen option) with a manifest and conflict/in-use guards; result reporting. **Conflict:** DEV-044 currently edits `workspace-ops.ts`, `daemon/control-connection.ts` and `runner/claude-launch.ts`. Rebase onto it, or hand the one-line capability and Claude resume hook to the DEV-044 owner |
| **WP4 Web**                           | web        | `apps/web/src/features/chat/*` (row menu, folder menu, new `chat-archive-dialog.tsx`, new `archived-chats-view.tsx`, banner in `chat-thread-view.tsx`/`chat-surface.tsx`, list items), `app/use-chat-view.ts` (rename `archivedChats`), `app/navigation.ts` + `use-app-route-sync.ts` (`/chats/archived`), `api/` client, `i18n/locales/{en,zh-CN}/chat.ts`, `styles/NN-chat*.css`                                                      | The UI in §3.5, built from existing primitives (`Checkbox`, `Button`, `ActionRow`, dialog)                                                                                                                                                                                                                                                                                          |
| **WP5 Docs and acceptance**           | docs       | `docs/devlog/DEV-0NN-session-archive.md`, `docs/devlog/README.md`, this doc                                                                                                                                                                                                                                                                                                                                                             | Evidence, acceptance steps                                                                                                                                                                                                                                                                                                                                                          |

### Tests and acceptance

- **Unit / store (WP1/WP2).** Cover:
  - Archive/unarchive round trip.
  - Batch undo.
  - Refusal for running, queued and Issue-owned sessions.
  - Native-key aliasing (an adopted native chat stays archived after re-sync).
  - Queue held. Send gets 409. Work paused.
  - Folder archive is atomic.
  - Generations collapse while offline.
  - Reconcile on connect.
  - An old worker reports `unsupported`.
- **Worker (WP3).** Use a scratch `CODEX_HOME`, with no real `~/.codex`, as in §1.2, and cover:
  - Archive/unarchive through app-server.
  - Second call is idempotent.
  - Stale-alias repair.
  - Resume guard.
  - Scanner reports archived.
  - Claude B round trip, conflict and in-use guard.
  - Run with `node scripts/run-worker-tests.mjs -- native-archive.test.mjs`.
- **End-to-end on the dev stack, real browser, both themes, narrow width.** Steps 1–4 use a synthetic workspace.
  1. Start a Codex session and archive it.
     - Expect: it leaves the list; the toast shows Undo; the Archived view shows it; `codex app-server thread/list {archived:true}` includes the thread; the file is in `archived_sessions/`.
     - Unarchive. Expect: it is back in its folder, with the file back in `sessions/…`, and sending a message works.
  2. Repeat step 1 with Claude (per D1). For B, `claude --resume <id>` fails while archived and works after unarchive.
  3. Archive a folder containing a running chat. Expect: the preflight blocks with "Stop it first"; stop it and archive; the timers are paused.
  4. Take the device offline (stop the worker) and archive. Expect: the native state is Pending. Start the worker. Expect: it becomes ✓ without any action.
  5. Archive an unowned native chat in the Codex app. Expect: it appears in Foundry's Archived view, and Unarchive in Foundry restores it in Codex.
  6. Run MCP `archive_session` from an orchestrator on its child, then `send_message` to the child. Expect: 409 `session_archived`.
- **Checks.** `scripts/check-changed.sh --files …`, `pnpm audit:ui`, `pnpm typecheck`, and Go tests for `sqlitestore` and `httpapi`.

### Open verification items — resolved 2026-10-27

- Does Codex `thread/archive` cascade to a parent's subagent threads (`parentThreadId`)? Test in the scratch home.
- Does Claude's `cleanupPeriodDays` sweep anything outside `projects/`?
- Does `claude --resume <id>` search across project slugs? This affects option B's hiding.

DEV-048 verification update (2026-10-27): all three research questions above were exercised with synthetic native homes. Codex archive cascades to native descendants; native unarchive restores only the parent, so Foundry records originally-active descendants and restores exactly those. Claude retention removed an old projects transcript while preserving an equally-old archived transcript, with `.last-cleanup` confirming the sweep. Claude can resume indexed histories across project slugs; moving the transcript outside projects hides it in both cwd controls. Evidence, versions, limitations and dev deployment are recorded in [DEV-048](devlog/DEV-048-session-archive.md) and the linked worker handoff. Implementation and dev self-verification are complete; human acceptance and documented platform limits remain tracked there.

2026-10-27 user acceptance clarifications: observed Claude/Codex work bound to an owner that is not running or queued (legacy subagents and unified-exec terminals included) is neither a blocker nor paused/stopped. Independent Foundry child sessions keep their own state; only independent processes/schedules participate in archive work controls. Dialog blockers use translated reason codes and actual resolving controls with verified receipts, replacing dead-end Open links. The shared Dialog uses a counted, bounded list and a visible disabled reason; native cascade details are secondary. The user confirmed D7 uniformly permits controlling agents to unarchive, regardless of the original archiver; actor attribution remains visible and audited. Updated tests, deployment and synthetic before/after evidence are in DEV-048.
