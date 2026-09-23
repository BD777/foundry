# Shared conversation pipeline

[Chat experience](chat-experience.md) · [Documentation index](README.md)

All agents and all transcript sources use the same display contract. Provider
adapters translate protocols; they do not group messages or choose UI layouts.

`provider/source adapter → TranscriptMessage[] → projectTranscript → existing chat components`

## Contract

- Preserve item identity, semantic kind, text, tool-call identity and lifecycle.
- Assistant answers are explicit. Text length, Markdown headings, code fences,
  and the position of an answer never determine its kind.
- Only adjacent reasoning, commentary, tool, context and status items form a
  process group. User input, answers, failures and boundaries end a group.
- A process group exists before an answer arrives. Appending items keeps its ID
  stable so streaming updates do not reset expanded state.
- Structured process items reach the renderer intact, without a Markdown
  serialization/parsing round trip.
- Legacy records are interpreted in source adapters, not in the grouping core.
- Public reasoning summaries are preserved; unavailable encrypted content is
  never represented as recovered text.

## Sources and extension

Managed session events, native Codex/Claude files and subagent transcripts each
adapt to the contract. Provider-specific decoding lives at the worker boundary.
Adding an agent requires a protocol adapter and fixtures for this contract, not
a new transcript renderer or grouping algorithm.

## Acceptance

Equivalent conversations from each provider/source must produce the same group
boundaries. Cover streaming and completed replay, mixed reasoning and tools,
answers between process groups, repeated tool calls, lifecycle updates,
interruption, no final answer, and literal Markdown/speaker markers in content.
Preserve the existing Claude DOM/CSS and disclosure behavior; verify real Claude
and Codex conversations in the browser in addition to model tests.

## Live projection scheduling

SSE and HTTP hydration both write the shared `FoundryData` state. They must use
the same regular React update priority. `useFoundryLiveData` owns stream batching:
collect events until the next animation frame, compact consecutive snapshots,
then apply the batch with one state update. Do not wrap that update in
`startTransition`; batching already bounds the frequency.

Mixing transition-priority SSE updates with synchronous HTTP hydration is
unsafe: React rebases the synchronous updater over the pending transition,
allocating new session events and message arrays on every pass, while
Virtuoso's external store and Radix refs keep scheduling synchronous work. In a
large chat list this can prevent the transition from ever completing and ends
in a nested-update-limit error (observed when resuming an old session).

The fix belongs to shared projection scheduling, not provider adapters or the
virtualizer. Keep transport cadence here, navigation measurement in its hook,
and user follow/read intent in the scroll controller. New consumers should not
need render-retry counters, deep comparisons, or provider-specific remount keys.

Regression coverage:

- `apps/web/test/foundry-live-data-scheduling.test.mjs` runs the real SSE subscription,
  parser, batcher and React hook. A burst and same-turn HTTP hydration must commit
  one consistent snapshot, with no intermediate hydration-only projection. It
  fails against the prior `startTransition` implementation.
- With Vite running, open `http://localhost:31983/test/chat-live-data.html`.
  It mounts the complete App with 180 background chats and a long old session.
  Only HTTP/EventSource transport is mocked. Use the real composer to send;
  the fixture delivers SSE before the POST response and list refresh. Click
  **Stream and finish response**, send again, and repeat with Enter and while
  reading history. The prior implementation crashes in this scenario. Check
  console errors, successful completion and continued input availability.

The browser fixture uses synthetic data, rejects unexpected network requests,
and is not a production build entry. Use the localhost origin to keep fixture
storage separate from the regular 127.0.0.1 application. Reopen the fixture URL
to reset it; App routing changes the address after mount. The case record is
`cases/web/chat-resume-live-data.case.json`.
