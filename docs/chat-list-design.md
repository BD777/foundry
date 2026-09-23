# Chat list and session naming

[Chat experience](chat-experience.md) · [Documentation index](README.md)

## Presentation

Rows contain the provider mark, a single-line title, and at most one status:
processing uses a slow circular spinner; failure uses an error icon; unread uses
a blue dot; completed/read sessions have no trailing decoration. Processing and
failure take precedence over the unread dot. The unread flag remains independent.

The Radix Context Menu owns right-click and keyboard menu interactions. Radix
Dialog owns manual renaming. Copy exposes the latest Foundry execution session
ID and its provider-native ID; native-only imports expose their Foundry chat ID.
Missing native IDs disable that menu item instead of guessing an identifier.

## Groups and search

Chats supports one level of named groups above ungrouped sessions. The header's
new-group action inserts an expanded group at the top and focuses its inline
name editor. Enter or blur saves the trimmed name; Escape retains the previous
name. A blank draft retains the default name. Group headers also offer renaming.
The row context menu's “移至分组” submenu lists existing groups, permits moving
back out of a group, and offers the same creation flow with the source chat
assigned immediately.

The sidebar search matches group names and chat titles case-insensitively.
Matching a group name includes all its chats; matching a chat title retains its
parent group. Empty groups remain searchable. Search preserves collapse choices.

Chat rows can be dragged onto a group header, an empty group, the ungrouped
header, or above/below another row. Insertion lines and group highlights show the
destination; the viewport scrolls at its edges while dragging. Dropping into a
collapsed group expands it. Context-menu “上移” / “下移” and Alt+Up / Alt+Down
provide keyboard ordering. Filtering never removes hidden positions when saving.

Group names/order and chat membership/order are durable, workspace-scoped user
metadata in SQLite `chat_layouts`, separate from daemon-synchronized transcripts.
The ordered `groups` and `positions` arrays are saved as one versioned document.
An empty `groupId` means ungrouped. Stable list chat IDs preserve order when
messages arrive, titles change, or native sessions are temporarily unavailable.
Newly discovered chats appear above positioned chats until their position is saved.

`GET /api/chat-layout?workspaceId=...` reads the current document;
`POST /api/chat-layout` takes `workspaceId`, `expectedRevision`, and `layout`.
The transaction checks the revision and atomically stores membership and order;
stale writes receive 409. The UI applies changes immediately and serializes saves.
On failure it discards unconfirmed queued edits, reloads server state, and shows
a retry notice. Polling and window focus refresh other clients' saved layouts.
`POST /api/chat-layout/delete-group` removes one group in the same
revision-checked transaction; the group's member chats are soft-deleted (stored
in `chat_deletions`) rather than moved to ungrouped.

Legacy `foundry.chatGroups.v1:<workspaceId>` data is merged once into the server
layout. Existing server assignments win. The legacy copy remains available if
migration fails, and its completion marker is set only after a confirmed save.
Only collapse preferences continue to be written to browser storage, under
`foundry.chatGroupCollapsed.v1:<workspaceId>`. New groups default to expanded.

## Read state

`chat-list-state` contains pure status/revision rules. `useChatReadState` keeps
per-workspace browser read receipts in Local Storage. A completed answer has a
stable identity (`AgentSession.answerRevision`; native imports hash the latest
assistant record), independent of activity labels, title updates and tool logs.
An answer is unread until that session is viewed. A visible, selected session is
read as answers arrive; hidden tabs and other app views do not mark it read.
Explicitly marking a session unread stays in effect until it is explicitly
selected again. Existing answers without a read receipt are initially unread.

Native imports obtain recent messages from a bounded tail read, while keeping
their existing transcript import unchanged. Recap payloads are omitted from list
summaries and loaded only when naming is requested.

## Naming ownership

- `internal/chattitle` selects the last two exchanges, caps input size, builds
  the recap prompt, and validates the generated title. It has no UI, HTTP,
  database or provider dependencies.
- `chatTitleService` resolves the target's provider/profile and dispatches an
  independent `source=naming` session through the existing daemon execution path.
  The context menu and first-answer completion both call this service.
- `chat_titles` stores display names separately from native chat imports, so a
  later daemon sync cannot overwrite them. It also stores the generation owner.
  Session creation and generation ownership are transactional. A late result may
  update the title only while its session ID still owns that slot. Manual rename
  revokes ownership, and repeated generation requests coalesce while in flight.
- Completing a naming job atomically validates and applies the result. It does
  not depend on a browser request remaining open. Failed jobs keep the old title
  and expose their error for retry. Naming jobs cannot recursively name themselves.

Automatic first-answer naming applies only to a new Foundry chat's first
completed execution (`threadId == id`, source `chat`, nonempty response), not to
historical imports or every subsequent answer. An existing manual title or prior
automatic attempt prevents automatic re-execution. Explicit recap remains available.

Naming keeps the selected agent/profile and model, uses a fresh runtime identity,
and rejects resume IDs, imported context and attachments. Utility execution is
read-only; Claude SDK naming disables tools. Naming-native sessions are hidden
from normal import discovery. Completed naming jobs do not displace regular
sessions in the bounded session-summary list.

## APIs

- `GET /api/chat-titles?workspaceId=...`: display-name and generation metadata.
- `POST /api/chats/{id}/title`: manual rename with workspace scope and validation.
- `POST /api/chats/{id}/recap-title`: start or reuse an independent naming job.

The UI updates metadata on naming lifecycle changes and periodically while the
Chats view is active. List rendering does not invoke models or read transcripts.

## Resizable list

The Chats list owns its horizontal resizing in `useChatListResize`; message
rendering and the outer app sidebar do not own this preference.

- Default width: 270 px. Drag the right edge to resize, or double-click to reset.
- Bounds: 220–640 px, capped at half the available chat screen width to leave
  room for the conversation. Mobile keeps the existing full-width stacked list.
- Persist `foundry.chatListWidth` after a completed drag or a keyboard adjustment.
  Apply the saved preference before paint. Temporary window constraints must not
  overwrite it; expanding the window restores the preferred width.
- Pointer capture keeps dragging reliable outside the handle. Escape, pointer
  cancellation, lost capture, and unmount cancel the interaction. Cancellation
  restores the previous preference and does not write storage.
- Arrow keys adjust 16 px, Shift+Arrow adjusts 64 px, and Home/End select limits.
  The separator exposes its controlled list and current/minimum/maximum width.

### Performance

Pointer movement changes refs and schedules at most one `requestAnimationFrame`.
Each frame updates a scoped CSS width property and separator ARIA values only
when the effective width changes. There are no pointer-path layout reads,
React state updates, or storage writes. The final pointer-up flushes the pending
width and saves once. Bounds are measured on mount and through ResizeObserver
on the parent, not on each pointer event. Pending work is canceled on unmount.

### Browser checks

1. Drag an existing long chat's list back and forth; longer titles reveal more
   text and the conversation remains rendered.
2. Refresh before releasing a drag: the earlier saved width must return. Finish
   a drag and refresh: the new width must return.
3. Drag, press Escape, release, and refresh: retain the previous width.
4. Shrink the window until the saved width is constrained, switch to mobile,
   then restore the window: restore the original preferred width.
5. Check double-click reset, arrow keys and limits, and keyboard focus styling.
6. Recheck repeatedly resizing and closing the right detail pane while the Chats
   list has a custom width; the transcript and composer must remain visible.
