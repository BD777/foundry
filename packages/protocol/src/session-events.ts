/**
 * Labels of transcript events that readers recognise by label, and the ids
 * that tie events to inputs. Workers and the server write them; the server,
 * the web and Feishu compare them. Labels a step shows (and the web
 * translates) are processLabels (process-labels.ts).
 *
 * The server mirrors both sets in apps/server/internal/store/
 * session_event_labels.go; scripts/audit-contract.mjs pins the two.
 */
export const sessionEventLabels = {
  /** A session input's message (the server writes it). */
  userMessage: "User message",
  /** A message steered into a running turn; its id is the input's event id. */
  steeredIntoTurn: "Steered into active turn",
  /** The model read a steered message; the detail is the input id. */
  steerConsumed: "Steered message read",
  /** The answer's text so far, one event per streamed answer. */
  responseStream: "Response stream",
  /** An Issue execution's streamed answer: appended or restarted. */
  /** The events that end a turn and carry its usage and result path. */
  claudeTurnEnd: "Claude Agent SDK finished",
  codexTurnEnd: "Codex finished",
  profileCommandTurnEnd: "Custom profile command finished",
  /** A Claude process started for the session (it fires due timers). */
  claudeProcessStarted: "Started Claude Agent SDK",
  /** One tool frame; it is not shown as a step. */
  toolFrame: "Tool frame",
  /** A queued input waits for its device (offline, or not starting it yet). */
  deviceWait: "Waiting for device",
  /** A queued input waits for its device's worker to update. */
  workerUpdate: "Worker update in progress",
  /** A message of a native session's history before Foundry ran it. */
  nativeTranscript: "Native transcript",
  /** The note that an input continues on another profile. */
  profileTransition: "Profile transition",
} as const;

export type SessionEventLabelKey = keyof typeof sessionEventLabels;

const turnEndLabels = new Set<string>([
  sessionEventLabels.claudeTurnEnd,
  sessionEventLabels.codexTurnEnd,
  sessionEventLabels.profileCommandTurnEnd,
]);

/** Whether the label is a turn-end event's. */
export function isTurnEndLabel(label: string | undefined): boolean {
  return label !== undefined && turnEndLabels.has(label.trim());
}

const eventIdPrefix = "evt_";

/**
 * The id of the event a session input writes; a message steered into a
 * running turn records its event under the same id.
 */
export function sessionInputEventId(inputId: string): string {
  return eventIdPrefix + inputId;
}

/** The input an input's event id names; undefined for any other id. */
export function sessionInputIdOfEvent(eventId: string): string | undefined {
  return eventId.startsWith(eventIdPrefix) &&
    eventId.length > eventIdPrefix.length
    ? eventId.slice(eventIdPrefix.length)
    : undefined;
}

const inputAnswerSuffix = "_answer";

/**
 * The id of the answer the server records for an input when the runtime
 * reported it only on completion (a custom command, or a turn that ended
 * without text). It is that input's answer, never a snapshot of another.
 */
export function sessionInputAnswerEventId(inputId: string): string {
  return sessionInputEventId(inputId) + inputAnswerSuffix;
}

/** Whether an event id is an input's recorded answer. */
export function isSessionInputAnswerEventId(eventId: string): boolean {
  return (
    eventId.startsWith(eventIdPrefix) &&
    eventId.endsWith(inputAnswerSuffix) &&
    eventId.length > eventIdPrefix.length + inputAnswerSuffix.length
  );
}

/**
 * The id of a dispatch's ordinal-th streamed answer (from 1). A dispatch is
 * named `<session>_<input>`, or `<session>` without an input.
 */
export function responseStreamEventId(
  dispatchId: string,
  ordinal: number,
): string {
  const id = `${eventIdPrefix}${dispatchId}_response_stream`;
  return ordinal === 1 ? id : `${id}_${ordinal}`;
}

/** The dispatch and ordinal a streamed answer's id names. */
export function parseResponseStreamEventId(
  eventId: string,
): { dispatchId: string; ordinal: number } | undefined {
  const match = eventId.match(/^evt_(.+)_response_stream(?:_(\d+))?$/);
  const dispatchId = match?.[1];
  if (dispatchId === undefined) return undefined;
  const ordinal = match?.[2] === undefined ? 1 : Number(match[2]);
  return Number.isSafeInteger(ordinal) && ordinal > 0
    ? { dispatchId, ordinal }
    : undefined;
}
