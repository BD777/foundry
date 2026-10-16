# Codex commentary as conversation body

## Decision

User-visible assistant commentary is conversation content, not reasoning or a
tool event. Render it with the same Markdown body as assistant answers, at its
original transcript position. Do not label or repeat it inside a Process card.
Reasoning, tools, context and status remain in independent process disclosures.
The shared projection applies the same semantic rule to managed, native and
subagent transcripts, regardless of provider.

## Changes

- `apps/web/src/features/chat/transcript-projection.ts`: commentary breaks a
  process group and renders as a bot body row; its identity and streaming state
  are preserved.
- `apps/web/test/transcript-pipeline.test.mjs`: regression for streaming body
  text, stable identity after completion, and separate thinking/tool groups.
  Existing cumulative-commentary replay coverage is preserved.
- `apps/web/test/conversation.tsx`: a repeatable Codex commentary scenario using
  the production projection and Conversation component, plus existing chunk,
  finish, theme and width controls.

## Browser evidence (2026-10-16)

Local Vite fixture at `http://127.0.0.1:31993/test/conversation.html`, real
headless Chromium, isolated temporary profile; no deployment or existing
service restart. Selected Codex, loaded commentary, appended a streaming chunk,
then finished the response. Commentary remained visible as Markdown body text,
without a Process heading, duplicated summary or disclosure. Keyboard focus +
Enter expanded the reasoning/tool disclosure independently.

Inspected the full fixture page at normal scale, 1280×900 and 390×844, light and
dark. Narrow viewport and document scroll width both measured 390px. No browser
page errors were reported.

Screenshots in `.foundry/attachments/`:

- `commentary-light.png`
- `commentary-dark.png`
- `commentary-light-narrow.png`
- `commentary-dark-narrow.png`
- `commentary-expanded.png`

## Limitations

Browser evidence uses synthetic transcript entries with the actual rendering
components, not a live provider turn or an authenticated production chat.
Managed/native/subagent semantic equivalence and cumulative snapshot replay
are covered by pipeline tests. Production deployment and live-session smoke
testing remain with the coordinating session. No Worker, account, catalog,
runtime-selection or deployment changes are part of this patch.

## Automated checks

- `scripts/check-changed.sh --files apps/web/src/features/chat/transcript-projection.ts apps/web/test/transcript-pipeline.test.mjs apps/web/test/conversation.tsx`:
  formatting passed, 45 Web test files passed, all 10 UI audits passed.
- That first check caught type errors in the new browser fixture. Simplified
  the fixture to use typed projection entries and give each rendered row its
  required identity; subsequent `cd apps/web && pnpm typecheck` passed.
- The targeted transcript pipeline run passed all 12 tests, including the new
  commentary body regression.
