import type { AgentSessionInputSource } from "@bd777/foundry-protocol";
import type {
  ChatMessageItem,
  ConversationBackgroundTask,
} from "./conversation-types";

/**
 * Who started a turn. The person's inputs stay their bubble; every other
 * input names its source above a compact system row, so an answer that a
 * timer, a background task or another session brought into the conversation
 * never reads as the person's.
 *
 * The server states the source on the input event (`inputSource`, DEV-246);
 * a transcript stored before that field still holds only the markers
 * Foundry wrote into the prompt, which the legacy fallback reads.
 */
export type TurnSourceKind =
  | "session"
  | "report"
  | "background"
  | "scheduled"
  | "notice"
  | "channel"
  | "automatic";

export interface TurnSource {
  kind: TurnSourceKind;
  /** The session that sent it (session, report), or the work that woke it. */
  title?: string;
  onOpen?: () => void;
  /** A child report's session, linked by its title when no sender resolved it (DEV-289). */
  sessionId?: string;
  /** The raw kind, for a source this build does not know. */
  raw?: string;
  /** A child report's turn status: completed, failed or canceled. */
  status?: string;
  /** A child report's final answer, shown instead of the report's prose. */
  body?: string;
  /** Background tasks the turn followed: named in the title, detailed below (DEV-249). */
  tasks?: ConversationBackgroundTask[];
  /** Free text under the row's expansion: a timer's prompt, an old event's summary. */
  detail?: string;
  /** The timer was delivered late; the message text says so. */
  caughtUp?: boolean;
}

/** A title that still reads on one line: the prompt's first line, clipped. */
const continuationTitleLimit = 80;

/** The first non-empty line of a prompt, clipped for a source row's title. */
export function continuationTitle(
  text: string | undefined,
): string | undefined {
  const first = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return undefined;
  return first.length > continuationTitleLimit
    ? `${first.slice(0, continuationTitleLimit).trimEnd()}…`
    : first;
}

function continuationDetail(message: ChatMessageItem): string | undefined {
  return (
    message.continuationBody?.trim() ||
    message.continuationDetail?.trim() ||
    undefined
  );
}

/** A timer's row: a short title, with the whole prompt under its expansion. */
function scheduledSource(message: ChatMessageItem): TurnSource {
  const body = continuationDetail(message);
  const title = continuationTitle(body);
  // A prompt longer than its title, or with more lines, stays expandable.
  const long = Boolean(
    body && (body !== title || body.split(/\r?\n/).length > 1),
  );
  return {
    kind: "scheduled",
    title,
    ...(long && body ? { detail: body } : {}),
    ...(message.continuationCatchUp ? { caughtUp: true } : {}),
  };
}

/** A background turn's row: task names in the title, command and output below. */
function backgroundSource(message: ChatMessageItem): TurnSource {
  const detail = continuationDetail(message);
  return {
    kind: "background",
    ...(message.backgroundTasks?.length
      ? { tasks: message.backgroundTasks }
      : {}),
    ...(detail ? { detail } : {}),
    ...(message.continuationCatchUp ? { caughtUp: true } : {}),
  };
}

/** A legacy event's marker opening a child session's turn_end report. */
const reportPrefix = "Foundry report:";
/** A legacy event's marker opening an input the server sent, not the person. */
const noticePrefix = "[Foundry]";

function plainUserMessage(message: ChatMessageItem): boolean {
  return (
    message.role === "user" &&
    (message.kind === undefined || message.kind === "message")
  );
}

function textOf(message: ChatMessageItem): string {
  return typeof message.text === "string" ? message.text.trimStart() : "";
}

/**
 * Whether the message starts a turn: a user message that was not steered
 * into a running turn, or the divider of a turn the agent ran on its own.
 */
export function isTurnInput(message: ChatMessageItem): boolean {
  if (message.kind === "boundary") return Boolean(message.continuation);
  return plainUserMessage(message) && !message.steered && !message.steer;
}

/** The source the server stated, or undefined for the person's own input. */
function structuredSource(
  message: ChatMessageItem,
  source: AgentSessionInputSource,
): TurnSource | undefined {
  const sender = message.sentBy;
  switch (source.kind) {
    case "person":
      return undefined;
    case "session":
      return {
        kind: "session",
        title: sender?.label ?? source.title,
        onOpen: sender?.onOpen,
      };
    case "child_report":
      return {
        kind: "report",
        title: sender?.label ?? source.title,
        onOpen: sender?.onOpen,
        // A resolved sender that cannot be opened is "another session": no link.
        ...(sender || !source.sessionId ? {} : { sessionId: source.sessionId }),
        status: source.status,
        body: source.response,
      };
    case "background":
      return backgroundSource(message);
    case "scheduled":
      return scheduledSource(message);
    case "foundry_notice":
      return { kind: "notice" };
    case "channel":
      return { kind: "channel" };
    default:
      return { kind: "automatic", raw: source.kind };
  }
}

/**
 * The input's source, or undefined for what the person typed. The server's
 * `inputSource` decides; the prompt markers only cover events stored before
 * it existed.
 */
export function turnSource(message: ChatMessageItem): TurnSource | undefined {
  if (!isTurnInput(message)) return undefined;
  if (message.channelOrigin && !message.inputSource) return { kind: "channel" };
  if (message.inputSource)
    return structuredSource(message, message.inputSource);
  if (message.kind === "boundary" && message.continuation) {
    if (message.continuation === "background") return backgroundSource(message);
    if (message.continuation === "scheduled") return scheduledSource(message);
    return { kind: "automatic", raw: message.continuation };
  }
  const text = textOf(message);
  if (message.sentBy) {
    const base = {
      title: message.sentBy.label,
      onOpen: message.sentBy.onOpen,
    };
    return text.startsWith(reportPrefix)
      ? { kind: "report", ...base }
      : { kind: "session", ...base };
  }
  if (text.startsWith(noticePrefix)) return { kind: "notice" };
  return undefined;
}

/**
 * A legacy body without the marker its source row already names. A
 * structured child report shows only its final answer.
 */
export function sourceBody(message: ChatMessageItem): string {
  if (message.inputSource?.kind === "child_report") {
    const answer = message.inputSource.response?.trim();
    if (answer) return answer;
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (message.sentBy && text.startsWith(reportPrefix))
    return text.slice(reportPrefix.length).trimStart();
  if (!message.sentBy && text.startsWith(noticePrefix))
    return text.slice(noticePrefix.length).trimStart();
  return text;
}
