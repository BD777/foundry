# Chat turn navigator

[Chat experience](chat-experience.md) · [Documentation index](README.md)

## Decision

A lightweight turn navigator sits at the left edge of the conversation message
stage. One marker represents one user query. The marker for the turn currently
passing the reading line is highlighted. Hover or keyboard focus fans the
markers out and opens a plain-text query preview; activating a marker jumps to
that user message.

The navigator is a projection of the existing transcript and virtualizer. It is
not persisted, does not change protocol DTOs, and does not maintain a second
scroll model. Chat and the Issue conversation share it.

## Ownership and files

The transcript is rendered by React Virtuoso, which owns variable-height
measurement, overscan and `scrollToIndex`. The navigator derives its active turn
from Virtuoso's measured item offsets and navigates through the same handle.

Shared modules live in `apps/web/src/components/conversation/`
(`features/chat/` keeps re-export shims under the old names):

```text
Conversation                   conversation.tsx (Chat and Issue)
  ChatTranscriptStage          chat-transcript-stage.tsx
    useChatScrollFollow        use-chat-scroll-follow.ts, chat-scroll-follow.ts
    useChatTurnNavigation      use-chat-turn-navigation.ts
    Virtuoso + ChatMessageList chat-message-list.tsx (memoized rows)
    ChatTurnNavigator          chat-turn-navigator.tsx (rail)
    ChatTurnMenu               chat-turn-menu.tsx (compact directory)
    Scroll-to-latest button
```

Pure anchor derivation, query normalization, reading-line lookup and density
sampling are in `chat-turn-navigation.ts`. Styles and container queries are in
`apps/web/src/styles/20-chat.css`. No server, storage, worker, or protocol
changes are involved.

## Product behavior

### What counts as a turn

An anchor is created for each message with `role === "user"` and a normal
message kind (not a boundary, process, tool, or failure row). Steered user
messages count. A prompt containing only attachments is labeled from the
attachment names. Folded injected context gets no anchor because the transcript
model already projects it as a bot tool row.

The preview shows only the user's query as normalized plain text. It does not
render Markdown or mirror the assistant response, which keeps it stable during
streaming and avoids mounting a second rich-text tree. The accessible label is
capped separately from the preview.

### Rail interaction

- Resting: marks are short; the current mark uses the strongest neutral color
  and carries `aria-current`, so state is not conveyed by color alone.
- Hover/focus: marks fan out around the previewed turn (longest for the
  previewed mark, shorter for its neighbors). Current-turn color stays
  independent from hover.
- Preview: a Radix Tooltip portal to the right of the marker, with collision
  handling. It has no controls and does not take focus.
- Activate: click or Enter/Space jumps to the start of the selected message.
- Keyboard: the rail is one tab stop. Arrow Up/Down moves among turns,
  Home/End selects the first/last turn.
- Motion: lines have a fixed width and animate `scaleX()` from the left edge;
  reduced motion disables the transitions. No blur or backdrop filters.

The navigator is enabled only with at least two anchors and an actually
scrollable transcript. Availability is rechecked on Virtuoso content-size
notifications and viewport resizes, including after initial hydration.

## Responsive policy

CSS container queries on the `fdy-chat-conversation` container are the sole
owner of responsive presentation; the hook does not duplicate width or pointer
checks. The chat can become narrow because of the app sidebar, the chat list, or
the detail pane, so a window breakpoint is insufficient.

- 880 px and above, fine hover pointer: a 72 px gutter with a 58 px marker hit
  region.
- 560–879 px, fine hover pointer: a 44 px gutter with a compact marker.
- Below 560 px, or on touch/coarse-pointer devices: the rail is replaced by a
  compact conversation directory (`ChatTurnMenu`) above the transcript. Radix
  Dropdown Menu owns focus, keyboard movement, dismissal, typeahead and collision
  handling. Every turn remains reachable through the same navigation command.

The gutter is reserved by width alone, for the transcript and the composer
alike, so messages arriving never reflow the column. The rail is an absolute
sibling of Virtuoso inside the message stage, so it does not scroll or get
clipped. Both directory and rail reset their local focus/preview state on
thread changes.

### Detail pane resize stability

`.fdy-chat-thread-layout` stays a Grid whether the detail pane is open or
closed; closing changes its columns, not its formatting context. In Chrome,
repeated detail resizing followed by a Grid-to-Flex switch can leave every child
(transcript, navigation, composer) with a zero layout rectangle and no React
error. A `minmax(0, 1fr)` row keeps long subagent content inside the available
height. Do not remount Virtuoso or force a refresh on close; the transcript and
its reading state should survive. Regression:
`cases/web/chat-detail-resize-interaction.case.json`.

## Deriving the active turn

The active turn is the anchor at a reading line slightly below the top of the
viewport, not the message with the largest visible area:

```ts
const readingInset = clamp(viewportHeight * 0.22, 72, 160);
```

`itemsRendered` supplies measured offsets for the bounded rendered set. A binary
search locates the message intersecting the reading line, then its user turn.
At the exact top the first anchor is active; at the exact bottom the last one
is. Do not treat Virtuoso's rendered range as the reading position or its end as
proof of being at the bottom: that range includes overscan.

### Viewport update ownership

`useChatTurnNavigation` owns one measured snapshot: scrollability and active
turn. `itemsRendered`, scroll, resize and message changes only invalidate that
snapshot. One `requestAnimationFrame` callback reads the settled viewport and
commits React state only when the snapshot changed. A message-count change does
not reset the active turn to the end; the reading position stays
authoritative. Pending frames are canceled on viewport replacement, thread
change, and unmount.

Virtuoso publishes `itemsRendered` while committing its own layout. Reading
geometry or updating its parent synchronously from that callback creates a
feedback loop (`itemsRendered → content resize → setScrollable → parent render
→ Virtuoso layout`) that observes intermediate geometry. The frame boundary
prevents it. The upstream projection scheduling contract is in
[Shared conversation pipeline](chat-transcript-design.md#live-projection-scheduling).

## Jump behavior

`useChatScrollFollow` exposes a semantic `readHistory()` operation. The follow
state machine uses `following`, `navigating`, and `reading` so that an initial
bottom-position read-back cannot cancel a history jump before the viewport
starts moving. A jump:

1. enters history reading unless the target is the latest message;
2. calls Virtuoso `scrollToIndex({ index, align: "start", behavior })`;
3. lets the active-turn calculation follow the real viewport position.

Smooth motion is used only for nearby targets; long distances and reduced
motion jump immediately, because dynamic measurement can move a far target
while it is being discovered. Never call `scrollIntoView()` for an offscreen
turn (it may not be mounted) and never set `scrollTop` from a separately
estimated offset.

## Very long conversations

The rail renders every turn up to a fixed marker cap (80). Beyond it,
`sampleChatTurnIndexes` renders a bounded, evenly spread set that always keeps
the first, last, active, keyboard-focused and previewed turns. Keyboard
movement walks real turns. There is no second virtualized list or nested
scrollbar.

## Performance budget

- at most one active-turn calculation per animation frame;
- `O(log n)` reading-line lookup over rendered items;
- React state commits only when scrollability or the active/previewed turn
  changes;
- bounded marker DOM;
- no Markdown rendering in previews;
- transform/opacity-only motion;
- `ChatMessageRow` stays memoized and scroll/DOM updates stay owned by Virtuoso.

## Verification

Automated (`apps/web/test/`):

- `chat-turn-navigation.test.mjs`: anchor filtering (steer and attachment-only
  prompts included; process/tool/boundary rows excluded), reading-line lookup,
  density sampling.
- `chat-scroll-follow.test.mjs`: history navigation cannot be canceled by the
  initial bottom read-back; content refreshes never override reading intent.
- `chat-viewport-lifecycle.test.mjs`: mounts the real hook under StrictMode and
  checks frame batching, history reading during append, convergence, and
  cleanup.

Browser: `cases/web/chat-turn-navigation-interaction.case.json` and
`cases/web/chat-detail-resize-interaction.case.json`. With the Vite dev server
running, `/test/chat-resume.html` exercises the real Virtuoso renderer with
synthetic history (resume, stream, navigate to an old turn, clear/re-hydrate,
switch narrow/wide layouts) without calling the server or a provider.

Visual checks: light and dark themes; 559/560 and 879/880 px boundaries,
detail pane open, and coarse pointer; composer/message alignment without
horizontal overflow; 2, 4, 30 and over-cap turn counts; first/last preview
collisions; 200% zoom, keyboard-only use, and reduced motion.
