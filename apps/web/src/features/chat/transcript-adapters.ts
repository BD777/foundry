import type { AgentSession, AgentSubagentTranscript } from "@foundry/protocol";
import {
  responseStreamLabel,
  shouldDisplayAgentSessionEvent,
} from "../../lib/agent-session-events";
import { shouldDisplayResponseEvent } from "./subagent-response-filter";
import type { ChatViewMessage } from "./chat-types";
import type { TranscriptEntry } from "./transcript-projection";

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

/** Translate the managed event envelope; new events can supply typed messages. */
export function sessionTranscriptEntries(
  session: AgentSession,
  suppressed: ReadonlySet<string> = new Set(),
): TranscriptEntry[] {
  const events = (session.events ?? []).filter(
    (event) => event.message || shouldDisplayAgentSessionEvent(event),
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
  const flushResponse = () => {
    if (response) entries.push(response);
    response = undefined;
  };
  for (const event of events) {
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
    flushResponse();
    const timerFire = event.metadata?.timerFire;
    if (timerFire) {
      const firedAt = timerFire.completedAt
        ? new Date(timerFire.completedAt)
        : undefined;
      const when =
        firedAt && !Number.isNaN(firedAt.getTime())
          ? firedAt.toLocaleString("zh-CN", {
              hour12: false,
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
      entries.push({
        id: `${id}:timer-fire-boundary`,
        at: event.at,
        kind: "boundary",
        text: when ? `⏰ 定时任务触发 · ${when}` : "⏰ 定时任务触发",
      });
      if (timerFire.response) {
        entries.push({
          id: `${id}:timer-fire-response`,
          at: timerFire.completedAt || event.at,
          kind: "assistant",
          text: timerFire.response,
        });
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
    streaming:
      transcript.status === "running" &&
      index === transcript.messages.length - 1,
  }));
}
