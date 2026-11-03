/**
 * Side panels as the server derives them (AgentSessionPanel), for tests
 * that render a session's panel: the web reads `session.panel` and derives
 * nothing from events.
 */
export function emptyPanel() {
  return {
    usage: {
      turns: 0,
      totals: {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        costTurns: 0,
      },
      compactions: 0,
    },
    focus: false,
    subagents: [],
    background: [],
    timers: [],
    timerWakes: [],
    busy: false,
    files: [],
    previews: [],
    sources: [],
  };
}

/** A panel with `partial` over the empty one (`usage` merged one level). */
export function panel(partial = {}) {
  const base = emptyPanel();
  return {
    ...base,
    ...partial,
    usage: { ...base.usage, ...partial.usage },
  };
}

/** `session` with the panel its newest window read would bring. */
export function withPanel(session, partial = {}) {
  return { ...session, panel: panel(partial) };
}
