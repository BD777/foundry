import type { AgentSession, AgentSessionEvent } from "@bd777/foundry-protocol";
import type { WindowedAgentSession } from "../api";
import { isProcessLabel } from "./process-labels";
import {
  appendAgentEvent,
  normalizeAgentEvents,
  reconcileAgentEvents,
} from "./agent-event-log";

// i18n-ignore: protocol event label the worker emits, never shown as copy
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
    isProcessLabel(
      event.label,
      "startingSubtask",
      "subtaskRunning",
      "subtaskCompleted",
      "subtaskFailed",
    ) ||
    /^Subtask (?:started|finished)$/i.test(event.label.trim())
  ) {
    return false;
  }
  // Timer and background-work snapshots drive the side panel only; they are
  // not chat.
  if (event.metadata?.timerSnapshot || event.metadata?.backgroundTaskSnapshot) {
    return false;
  }
  // Bookkeeping the worker records after an answer: known by its label too,
  // so one that arrives without its metadata never becomes a step of its own.
  if (
    isProcessLabel(
      event.label,
      "timerSync",
      "backgroundTasksSync",
      "recordedFile",
      "modelRequestUsage",
    )
  ) {
    return false;
  }
  // Recorded files fill the side panel. Older workers' "Produced output
  // file" rows credited any file that changed meanwhile; they stay hidden.
  if (
    event.metadata?.sessionFile ||
    // i18n-ignore: protocol event label older workers emitted
    event.label === "Produced output file"
  ) {
    return false;
  }
  // A model request's final tokens belong to its steps, not a step of its own.
  if (event.metadata?.requestUsage) {
    return false;
  }
  if (isProcessLabel(event.label, "loadedWorkspace")) {
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

/** Adds one live event in O(1) amortized time; see agent-event-log. */
export function mergeAgentSessionEvent(
  events: AgentSessionEvent[] | undefined,
  incoming: AgentSessionEvent,
): AgentSessionEvent[] {
  return appendAgentEvent(events, incoming);
}

/** Collapses persisted response snapshots and repeated ids, in one pass. */
export function normalizeAgentSessionEvents(
  events: AgentSessionEvent[] | undefined,
): AgentSessionEvent[] {
  return normalizeAgentEvents(events);
}

function isTerminalStatus(status: AgentSession["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isResponseLike(event: AgentSessionEvent): boolean {
  return event.message
    ? event.message.kind === "assistant"
    : event.label === responseStreamLabel;
}

/** The input a response event answers: its id is `evt_<session>_<input>_response_stream[_N]`. */
function responseEventInputId(
  sessionId: string,
  eventId: string,
): string | undefined {
  const prefix = `evt_${sessionId}_`;
  if (!eventId.startsWith(prefix)) return undefined;
  const match = eventId
    .slice(prefix.length)
    .match(/^(.+)_response_stream(?:_\d+)?$/);
  return match?.[1];
}

const displayed = new WeakMap<
  AgentSessionEvent[],
  {
    response: string;
    inputId: string;
    status: string;
    events: AgentSessionEvent[];
  }
>();

/**
 * The events a transcript shows. Never stored: `session.response` can be a
 * previous turn's answer (the server keeps it while a new turn runs, and a
 * missed completion leaves it stale), so it never rewrites an event. It only
 * stands in for a finished session's answer when the current input has no
 * response event of its own, every response event is tied to an input, and
 * the text is not an earlier turn's answer.
 */
export function agentSessionDisplayEvents(
  session: AgentSession,
): AgentSessionEvent[] {
  const events = normalizeAgentEvents(session.events);
  const response = session.response?.trim() ?? "";
  const inputId = session.input?.id ?? "";
  const status = session.status ?? "";
  const cached = displayed.get(events);
  if (
    cached &&
    cached.response === response &&
    cached.inputId === inputId &&
    cached.status === status
  ) {
    return cached.events;
  }
  const synthesized = terminalResponseEvent(session, events, response);
  const result = synthesized ? [...events, synthesized] : events;
  displayed.set(events, { response, inputId, status, events: result });
  return result;
}

function terminalResponseEvent(
  session: AgentSession,
  events: AgentSessionEvent[],
  response: string,
): AgentSessionEvent | undefined {
  if (!response || !isTerminalStatus(session.status)) return undefined;
  const inputId = session.input?.id;
  const responses = events.filter(isResponseLike);
  if (responses.length > 0) {
    if (!inputId) return undefined;
    for (const event of responses) {
      const answers = responseEventInputId(session.id, event.id);
      // An answer that cannot be tied to its input, or the current input's
      // own answer: the events already say everything.
      if (answers === undefined || answers === inputId) return undefined;
      // An earlier turn's answer: the response is stale.
      if ((event.message?.text ?? event.detail).trim() === response)
        return undefined;
    }
  }
  return {
    at: session.completedAt || session.startedAt || "",
    detail: response,
    id: inputId
      ? `evt_${session.id}_${inputId}_response_stream_final`
      : `evt_${session.id}_response_stream_final`,
    label: responseStreamLabel,
    level: "info",
    sessionId: session.id,
  };
}

/** A session as a transcript shows it; see agentSessionDisplayEvents. */
export function normalizeAgentSessionForDisplay(
  session: AgentSession,
): AgentSession {
  if (session.events === undefined) {
    return session;
  }
  const events = agentSessionDisplayEvents(session);
  return events === session.events ? session : { ...session, events };
}

/**
 * Merges a session payload (SSE, a POST reply, a list refresh, a transcript
 * load) into the one shown. Events are reconciled append-only: a payload
 * adds and updates events but never removes one already shown, so an older
 * snapshot cannot erase a newer steer. A payload without events keeps the
 * events shown. Display normalization is never stored.
 */
export function mergeLoadedAgentSession(
  existing: AgentSession | undefined,
  incoming: AgentSession,
): AgentSession {
  if (!existing) {
    return incoming.events === undefined
      ? incoming
      : { ...incoming, events: normalizeAgentEvents(incoming.events) };
  }
  if (incoming.events !== undefined) {
    const merged: WindowedAgentSession = {
      ...incoming,
      events: reconcileAgentEvents(existing.events, incoming.events),
    };
    // A page of older events brings no state events: those held stay.
    const stateEvents =
      (incoming as WindowedAgentSession).stateEvents ??
      (existing as WindowedAgentSession).stateEvents;
    if (stateEvents) merged.stateEvents = stateEvents;
    return merged;
  }
  if (!agentSessionHasDetails(existing)) {
    return incoming;
  }
  return {
    ...existing,
    ...incoming,
    error: incoming.error || existing.error,
    events: existing.events,
    input:
      incoming.input?.id === existing.input?.id && existing.input
        ? {
            ...existing.input,
            ...incoming.input,
            importedContext:
              incoming.input?.importedContext || existing.input.importedContext,
            profileTransitionNote:
              incoming.input?.profileTransitionNote ||
              existing.input.profileTransitionNote,
          }
        : incoming.input,
    // List summaries carry no response. The kept one only answers "is this
    // session's detail loaded"; a transcript never shows it over events.
    response: incoming.response || existing.response,
    // A session without one holds no timers any more.
    scheduled: incoming.scheduled,
  };
}

export function agentSessionNeedsDetails(session: AgentSession): boolean {
  return (
    agentSessionLacksDetails(session) || agentSessionBehindActivity(session)
  );
}

/**
 * What is shown is missing outright: no transcript at all, or a finished
 * session without its answer or error.
 */
export function agentSessionLacksDetails(session: AgentSession): boolean {
  if (session.events === undefined) {
    return true;
  }
  return (
    isTerminalStatus(session.status) && !session.response && !session.error
  );
}

/**
 * The session reports activity newer than its newest event shown. A sign of
 * missed events only while live events are not arriving: with the stream
 * delivering, they arrive (or the server says resync), and the times of a
 * summary and of the events need not match exactly.
 */
export function agentSessionBehindActivity(session: AgentSession): boolean {
  if (session.events === undefined || isTerminalStatus(session.status)) {
    return false;
  }
  const lastActivityAt = Date.parse(session.lastActivityAt ?? "");
  const latestEventAt = latestEventTime(session.events);
  return (
    Number.isFinite(lastActivityAt) &&
    (!Number.isFinite(latestEventAt) || lastActivityAt > latestEventAt)
  );
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
    session.input?.importedContext ||
    session.input?.profileTransitionNote,
  );
}

function latestEventTime(events: readonly AgentSessionEvent[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    const at = Date.parse(event.at);
    if (at > latest) latest = at;
  }
  return latest;
}
