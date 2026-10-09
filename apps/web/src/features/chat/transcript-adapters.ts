import {
  sessionInputEventLabel,
  type ModelRequestUsage,
  type AgentSession,
  type AgentSubagentTranscript,
} from "@bd777/foundry-protocol";
import {
  responseStreamLabel,
  shouldDisplayAgentSessionEvent,
} from "../../lib/agent-session-events";
import { shouldDisplayResponseEvent } from "./subagent-response-filter";
import type { ChatViewMessage } from "./chat-types";
import type { TranscriptEntry } from "./transcript-projection";
import { i18n } from "../../i18n";

/** Compatibility for old handoff records, kept outside the grouping core. */
export function legacyTranscriptEntries(
  messages: ChatViewMessage[],
  prefix: string,
): TranscriptEntry[] {
  return messages.map((message, index) => ({
    ...message,
    id: message.id ?? `${prefix}:${index}`,
    kind:
      message.role === "user"
        ? "user"
        : message.kind === "tool"
          ? "context"
          : message.kind === "process"
            ? "status"
            : message.kind === "boundary" || message.kind === "failure"
              ? message.kind
              : "assistant",
  }));
}

/**
 * A model request's final tokens arrive after its steps. Steps that already
 * name the request take the larger counts; otherwise the request's steps are
 * the latest ones, unless it ended with an answer (then the turn's footer
 * covers it).
 */
function applyRequestUsage(
  entries: TranscriptEntry[],
  pendingAnswer: TranscriptEntry | undefined,
  usage: ModelRequestUsage,
): void {
  const named = entries.filter(
    (entry) => entry.requestUsage?.requestId === usage.requestId,
  );
  for (const entry of named)
    entry.requestUsage = {
      requestId: usage.requestId,
      inputTokens: Math.max(entry.requestUsage!.inputTokens, usage.inputTokens),
      cacheReadTokens: Math.max(
        entry.requestUsage!.cacheReadTokens,
        usage.cacheReadTokens,
      ),
      cacheWriteTokens: Math.max(
        entry.requestUsage!.cacheWriteTokens,
        usage.cacheWriteTokens,
      ),
      outputTokens: Math.max(
        entry.requestUsage!.outputTokens,
        usage.outputTokens,
      ),
    };
  if (named.length > 0 || pendingAnswer) return;
  const last = entries[entries.length - 1];
  if (last && processEntryKinds.has(last.kind) && !last.requestUsage)
    last.requestUsage = usage;
}

const processEntryKinds = new Set<TranscriptEntry["kind"]>([
  "reasoning",
  "commentary",
  "tool",
  "context",
  "status",
]);

/** Translate the managed event envelope; new events can supply typed messages. */
export function sessionTranscriptEntries(
  session: AgentSession,
  suppressed: ReadonlySet<string> = new Set(),
): TranscriptEntry[] {
  const events = (session.events ?? []).filter(
    (event) =>
      event.message ||
      event.metadata?.turnUsage ||
      event.metadata?.requestUsage ||
      event.metadata?.sessionFile ||
      event.metadata?.fileReferences ||
      shouldDisplayAgentSessionEvent(event),
  );
  const terminalId = [...events]
    .reverse()
    .find((event) =>
      event.message
        ? event.message.kind === "assistant"
        : event.label === responseStreamLabel,
    )?.id;
  const entries: TranscriptEntry[] = [];
  let response: TranscriptEntry | undefined;
  // Files are counted per turn (input) and shown on the turn's last answer.
  let turnId = session.id;
  const turnFiles = new Map<string, Set<string>>();
  const lastAnswer = new Map<string, TranscriptEntry>();
  const flushResponse = () => {
    if (response) {
      entries.push(response);
      lastAnswer.set(turnId, response);
    }
    response = undefined;
  };
  for (const event of events) {
    const sessionFile = event.metadata?.sessionFile;
    if (sessionFile) {
      const id = sessionFile.inputId ?? session.id;
      const paths = turnFiles.get(id) ?? new Set<string>();
      paths.add(sessionFile.path);
      turnFiles.set(id, paths);
      continue;
    }
    if (event.label === sessionInputEventLabel && event.message?.id) {
      flushResponse();
      turnId = event.message.id;
    }
    const isResponse = event.message
      ? event.message.kind === "assistant"
      : event.label === responseStreamLabel;
    const id = `agent-session:${session.id}:${event.message?.id ?? event.id}`;
    if (isResponse) {
      const value = event.message?.text ?? event.detail;
      if (shouldDisplayResponseEvent(event.id, value, terminalId, suppressed)) {
        // Legacy snapshots update a contiguous answer. Typed identities allow
        // consecutive independent answers without guessing from their text.
        if (event.message && response && response.id !== id) flushResponse();
        response = {
          ...event.message,
          id,
          at: event.message?.at ?? event.at,
          kind: "assistant",
          text: value,
        };
      }
      continue;
    }
    // A timer's firing, or Claude continuing on its own after background
    // work: a divider, then the answer it gave (with its usage).
    const timerFire = event.metadata?.timerFire;
    if (timerFire) {
      flushResponse();
      const firedAt = timerFire.completedAt
        ? new Date(timerFire.completedAt)
        : undefined;
      const when =
        firedAt && !Number.isNaN(firedAt.getTime())
          ? firedAt.toLocaleString(i18n.language, {
              hour12: false,
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
      const background = timerFire.origin === "background";
      entries.push({
        id: `${id}:timer-fire-boundary`,
        at: event.at,
        kind: "boundary",
        text: when
          ? i18n.t(
              background
                ? "chat:transcript.backgroundContinuedAt"
                : "chat:transcript.timerFiredAt",
              { when },
            )
          : i18n.t(
              background
                ? "chat:transcript.backgroundContinued"
                : "chat:transcript.timerFired",
            ),
      });
      if (timerFire.response) {
        entries.push({
          id: `${id}:timer-fire-response`,
          at: timerFire.completedAt || event.at,
          kind: event.level === "error" ? "failure" : "assistant",
          text: timerFire.response,
          ...(event.metadata?.turnUsage
            ? { usage: event.metadata.turnUsage }
            : {}),
          ...(event.level !== "error" && event.metadata?.fileReferences?.length
            ? { fileReferences: event.metadata.fileReferences }
            : {}),
        });
      }
      continue;
    }
    const requestUsage = event.metadata?.requestUsage;
    if (requestUsage) {
      applyRequestUsage(entries, response, requestUsage);
      continue;
    }
    flushResponse();
    const turnUsage = event.metadata?.turnUsage;
    const fileReferences = event.metadata?.fileReferences;
    if (turnUsage || fileReferences) {
      // Both belong to the answer this turn ended with, if it gave one.
      const answer = [...entries]
        .reverse()
        .find((entry) => entry.kind === "assistant" || entry.kind === "user");
      if (answer?.kind === "assistant") {
        if (turnUsage) answer.usage = turnUsage;
        if (fileReferences?.length) answer.fileReferences = fileReferences;
      }
      continue;
    }
    if (event.message) {
      entries.push({ ...event.message, id, at: event.message.at ?? event.at });
    } else if (event.detail.trim()) {
      entries.push({
        id,
        at: event.at,
        kind: event.label === "Steered into active turn" ? "user" : "status",
        title: event.label,
        text: event.detail,
      });
    }
  }
  flushResponse();
  for (const [id, paths] of turnFiles) {
    const answer = lastAnswer.get(id);
    if (answer) answer.turnFiles = { turnId: id, count: paths.size };
  }
  const last = entries.at(-1);
  if (last && (session.status === "running" || session.status === "queued"))
    last.streaming = true;
  return entries;
}

export function subagentTranscriptEntries(
  transcript: AgentSubagentTranscript,
): TranscriptEntry[] {
  return transcript.messages.map((message, index) => ({
    id: `${transcript.taskId}:${message.id}`,
    text: message.content,
    kind:
      message.kind ??
      (message.role === "user"
        ? "user"
        : message.role === "tool"
          ? "tool"
          : message.title
            ? "reasoning"
            : "assistant"),
    title: message.title,
    callId: message.callId,
    status: message.status,
    requestUsage: message.requestUsage,
    streaming:
      transcript.status === "running" &&
      index === transcript.messages.length - 1,
  }));
}
