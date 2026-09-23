# foundry

Foundry workers should treat this workspace context as authoritative.

- Workspace evolves.
- Skills accumulate.
- Workers do not remember.

## UI interaction and component principles

- Make every action discoverable: use visible labels, chevrons or action
  icons, and intentional hover, keyboard-focus, selected, disabled, busy and
  error states. Do not rely on hover-only controls or color alone.
- Keep frequent navigation compact and flat. Do not nest cards inside cards
  for switchers or lists. Device/workspace selection belongs in a dedicated
  application page; sidebar entries use forward arrows, not dropdown arrows.
  Use restrained spacing, one surface boundary, and a distinct selected
  fill/checkmark. Selected and hovered items must remain distinguishable
  when visible simultaneously, in both themes. Do not stack
  selection borders, inset bars, badges and heavy focus rings. Visual
  acceptance is separate from functional/test success; inspect at normal
  scale in the full page, not only enlarged component screenshots.
- Distinguish browsing, selection and management. Browsing a device never
  changes the active location. Commit device + workspace together only after
  an explicit workspace choice succeeds; cancel/failure preserves context.
- Keep location switchers selection-only. Workspace CRUD belongs under
  Devices → device → Workspaces, with explicit destructive-action copy.
- Customize shared/third-party UI through public props, variants, slots,
  `className` or `style`. Style classes attached to your own elements.
  Never reach through a component's private DOM/class structure, inject
  `!important` overrides, or use JS measurements/mutations to repair CSS.
- If the public API is insufficient, improve the shared component's explicit
  API and its owned stylesheet; do not add consumer-side hacks. Use CSS
  grid/flex/min-width/wrapping for layout, not JS size calculations.
- Prefer UI-library primitives over hand-drawn controls. Never rebuild a
  native control (checkbox, switch, radio, text input, textarea, select,
  button, menu, dialog) out of `<div>`/`<span>` + bespoke borders, fake
  checkmarks, or click handlers — use the matching component in
  `apps/web/src/components/ui` (e.g. `Checkbox`, `TextInput`/`Textarea`,
  `Button`, `SelectMenu`, `ActionRow`). Apply look-and-feel only through the
  component's documented props/variants/`className` and shared CSS tokens;
  never scoped one-off box/border/icon markup that imitates a control.
- Verify changed interactions in a real browser: keyboard, active/inactive,
  busy/error, light/dark and narrow layouts. Record evidence and limitations.
- Device accounts and server API connections are equal, discoverable choices,
  not vertically buried sections. Each runtime appears once; its details
  contain status and defaults. Hints and fields need a deliberate vertical gap.
- Never claim an official account is online-valid from cached identity alone.
  Show the native configuration being read, distinguish local login from
  verified usage, and do not silently change the execution account. Official
  model pickers are selection-only and share controls with server connections.

## Active conversation UX delivery

- When continuing the conversation-driven Issue / Evidence UI work, read
  `docs/foundry-conversation-release-gate.md` in full before task actions.
- Re-read that file after every context compaction; it is the user-approved
  Foundry feature release gate, not a test Issue's contract.
- Record acceptance evidence in the PR or change notes, not in that file. Do
  not claim completion without the real-browser acceptance checks it requires.

## Agent provider access

- User requirement: every model _request_ — completions, messages, responses, any inference — must go through the agent's own SDK or CLI: Claude Agent SDK / Claude Code CLI for Claude, Codex SDK / CLI for Codex.
- Never call provider inference endpoints directly (`/messages`, `/responses`, `/chat/completions`), and never probe provider health or diagnostics with stored credentials.
- Catalog listing is the one sanctioned exception, approved 2026-09-16: a profile's configured endpoint may be asked for `/models`, because no native CLI can enumerate a compatible endpoint's catalog. It is a metadata read, never inference.
