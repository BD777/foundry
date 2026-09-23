import type { AgentSession, AgentSessionEvent } from "@foundry/protocol";

export const responseStreamLabel = "Response stream";

export function shouldDisplayAgentSessionEvent(
  event: AgentSessionEvent,
): boolean {
  // Legacy workers emitted synthetic liveness events once per minute. They
  // contain no provider progress and must never appear as conversation data.
  if (/^Still working$/i.test(event.label.trim())) {
    return false;
  }
  if (
    /^(?:正在启动子任务|子任务进行中|子任务完成|子任务失败|Starting subtask|Subtask (?:started|running|completed|finished|failed))$/i.test(
      event.label.trim(),
    )
  ) {
    return false;
  }
  // Timer snapshot syncs drive the sidecar card only; they are not chat.
  if (event.metadata?.timerSnapshot) {
    return false;
  }
  if (/^(?:Loaded workspace|已加载工作区)$/i.test(event.label.trim())) {
    return false;
  }
  if (
    event.level === "info" &&
    /\b(?:SDK|CLI|command) finished$/i.test(event.label.trim())
  ) {
    return false;
  }
  return true;
}

function responseStreamOrder(id: string): number | undefined {
  const match = id.match(/_response_stream(?:_(\d+))?$/);
  if (!match) {
    return undefined;
  }
  const suffix = match[1];
  if (!suffix) {
    return 1;
  }
  const order = Number(suffix);
  return Number.isSafeInteger(order) && order > 0 ? order : undefined;
}

export function isMatchingResponseStreamEvent(
  candidate: AgentSessionEvent,
  incoming: AgentSessionEvent,
): boolean {
  if (candidate.message || incoming.message) {
    return (
      candidate.message?.kind === "assistant" &&
      incoming.message?.kind === "assistant" &&
      candidate.message.id === incoming.message.id &&
      candidate.sessionId === incoming.sessionId
    );
  }
  if (
    candidate.label !== responseStreamLabel ||
    incoming.label !== responseStreamLabel
  ) {
    return false;
  }
  if (candidate.id === incoming.id) {
    return true;
  }
  const incomingOrder = responseStreamOrder(incoming.id);
  if (incomingOrder === undefined) {
    return true;
  }
  return (
    incomingOrder === 1 &&
    responseStreamOrder(candidate.id) === undefined &&
    candidate.sessionId === incoming.sessionId
  );
}

export function mergeAgentSessionEvent(
  events: AgentSessionEvent[] | undefined,
  incoming: AgentSessionEvent,
): AgentSessionEvent[] {
  const current = events ?? [];
  if (
    incoming.message
      ? incoming.message.kind !== "assistant"
      : incoming.label !== responseStreamLabel
  ) {
    return [
      ...current.filter((candidate) => candidate.id !== incoming.id),
      incoming,
    ];
  }

  const existingIndex = current.findIndex((candidate) =>
    isMatchingResponseStreamEvent(candidate, incoming),
  );

  if (existingIndex < 0) {
    return [...current, incoming];
  }
  return current.map((candidate, index) =>
    index === existingIndex ? incoming : candidate,
  );
}

export function normalizeAgentSessionEvents(
  events: AgentSessionEvent[] | undefined,
): AgentSessionEvent[] {
  return (events ?? []).reduce<AgentSessionEvent[]>(
    (merged, event) => mergeAgentSessionEvent(merged, event),
    [],
  );
}

export function normalizeAgentSessionForDisplay(
  session: AgentSession,
): AgentSession {
  if (session.events === undefined) {
    return session;
  }
  const events = normalizeAgentSessionEvents(session.events);
  return {
    ...session,
    events: normalizeTerminalResponseEvent(session, events),
  };
}

function normalizeTerminalResponseEvent(
  session: AgentSession,
  events: AgentSessionEvent[],
): AgentSessionEvent[] {
  const response = session.response?.trim();
  if (!response) {
    return events;
  }
  const responseIndex = findLastIndex(events, (event) =>
    event.message
      ? event.message.kind === "assistant"
      : event.label === responseStreamLabel,
  );
  const existingResponseEvent =
    responseIndex >= 0 ? events[responseIndex] : undefined;
  const responseEvent: AgentSessionEvent =
    existingResponseEvent !== undefined
      ? {
          ...existingResponseEvent,
          detail: response,
          message: existingResponseEvent.message
            ? { ...existingResponseEvent.message, text: response }
            : undefined,
        }
      : {
          at: session.completedAt || session.startedAt || "",
          detail: response,
          id: `evt_${session.id}_response_stream_final`,
          label: responseStreamLabel,
          level: "info",
          sessionId: session.id,
        };
  if (responseIndex < 0) {
    return [...events, responseEvent];
  }
  return events.map((event, index) =>
    index === responseIndex ? responseEvent : event,
  );
}

function findLastIndex<T>(
  values: T[],
  predicate: (value: T, index: number) => boolean,
): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index] as T, index)) {
      return index;
    }
  }
  return -1;
}

export function mergeLoadedAgentSession(
  existing: AgentSession | undefined,
  incoming: AgentSession,
): AgentSession {
  const normalizedIncoming = normalizeAgentSessionForDisplay(incoming);
  if (!existing || normalizedIncoming.events !== undefined) {
    return normalizedIncoming;
  }
  if (!agentSessionHasDetails(existing)) {
    return normalizedIncoming;
  }
  return normalizeAgentSessionForDisplay({
    ...existing,
    ...normalizedIncoming,
    error: normalizedIncoming.error || existing.error,
    events: existing.events,
    importedContext:
      normalizedIncoming.importedContext || existing.importedContext,
    profileTransitionNote:
      normalizedIncoming.profileTransitionNote ||
      existing.profileTransitionNote,
    response: normalizedIncoming.response || existing.response,
  });
}

export function agentSessionNeedsDetails(session: AgentSession): boolean {
  if (session.events === undefined) {
    return true;
  }
  if (
    session.status === "completed" ||
    session.status === "failed" ||
    session.status === "canceled"
  ) {
    return !session.response && !session.error;
  }
  const lastActivityAt = Date.parse(session.lastActivityAt ?? "");
  const latestEventAt = Math.max(
    Number.NEGATIVE_INFINITY,
    ...session.events.map((event) => Date.parse(event.at)),
  );
  if (
    Number.isFinite(lastActivityAt) &&
    (!Number.isFinite(latestEventAt) || lastActivityAt > latestEventAt)
  ) {
    return true;
  }
  return false;
}

/** A terminal list projection whose response has not been hydrated yet. */
export function agentSessionIsAwaitingDetails(session: AgentSession): boolean {
  return (
    session.events === undefined &&
    !session.response &&
    !session.error &&
    (session.status === "completed" ||
      session.status === "failed" ||
      session.status === "canceled")
  );
}

function agentSessionHasDetails(session: AgentSession): boolean {
  return Boolean(
    session.events !== undefined ||
    session.response ||
    session.error ||
    session.importedContext ||
    session.profileTransitionNote,
  );
}
