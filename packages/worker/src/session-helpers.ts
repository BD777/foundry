/**
 * Session helpers — session event management.
 */

import { processLabels } from "@bd777/foundry-protocol";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventMetadata,
} from "@bd777/foundry-protocol";
import type { AgentSessionRunResult } from "./session-state.js";
import { sessionInputDirectory } from "./session-artifacts.js";
import { writePrivateJSONAtomic } from "./storage.js";
import {
  redactTranscriptMessage,
  redactTranscriptText,
} from "./secret-redaction.js";

export interface AgentSessionCompletionMarker {
  completedAt: string;
  nativeSessionId?: string;
  response: string;
  sessionId: string;
  status: "completed";
}

// --- Response stream event ID allocator ---

export function createSessionStatusEventFilter(): (
  event: Pick<AgentSessionEvent, "label" | "detail" | "level" | "metadata">,
) => boolean {
  let previousStatus: string | undefined;
  return (event) => {
    const status =
      event.level === "info" &&
      !event.metadata &&
      (event.label === processLabels.requestingModel ||
        event.label === processLabels.compactingContext)
        ? JSON.stringify([event.label, event.detail])
        : undefined;
    const duplicate = status !== undefined && status === previousStatus;
    previousStatus = status;
    return !duplicate;
  };
}

/** A streamed answer is sent at most this often. */
export const responseStreamIntervalMs = 250;

/**
 * Batches a streamed answer. Each update carries the whole text so far and
 * was stored and streamed every 50ms; a quarter second keeps it live at a
 * fifth of the copies. The first update goes out at once, later ones within
 * the interval are held and the latest is sent when it ends. A different
 * message flushes the held one first; `flush` sends what is held, so the
 * final text is exact before the turn completes.
 */
export function createResponseStreamBatcher<
  T extends { message?: { id?: string } },
>(
  send: (update: T) => void,
  options: {
    intervalMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  } = {},
): { offer: (update: T) => void; flush: () => void } {
  const intervalMs = options.intervalMs ?? responseStreamIntervalMs;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let pending: T | undefined;
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  const flush = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    const update = pending;
    pending = undefined;
    if (!update) return;
    lastSentAt = now();
    send(update);
  };
  const offer = (update: T): void => {
    const heldID = pending?.message?.id;
    if (heldID && update.message?.id && heldID !== update.message.id) flush();
    pending = update;
    const elapsed = now() - lastSentAt;
    if (elapsed >= intervalMs) flush();
    else if (timer === undefined) timer = setTimer(flush, intervalMs - elapsed);
  };
  return { offer, flush };
}

/** A subagent's progress is sent at most this often; the latest wins. */
export const subtaskProgressIntervalMs = 10_000;
const subtaskProgressTaskLimit = 1024;
const subtaskBoundaryLabels = new Set<string>([
  processLabels.startingSubtask,
  processLabels.subtaskCompleted,
  processLabels.subtaskFailed,
]);

/**
 * Coalesces "Subtask running" progress: Claude reports it several times a
 * second per subagent, and every report was a stored, streamed event. The
 * first report of a task goes out at once; later ones within the interval
 * are held and only the latest is sent when it ends. Start, completion and
 * failure always go out, and drop held progress the completion supersedes.
 */
export function createSubtaskProgressCoalescer(
  options: {
    intervalMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  } = {},
): (
  sessionId: string,
  event: Pick<AgentSessionEvent, "label" | "metadata">,
  send: () => void,
) => void {
  const intervalMs = options.intervalMs ?? subtaskProgressIntervalMs;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer =
    options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const tasks = new Map<
    string,
    { sentAt: number; pending?: () => void; timer?: unknown }
  >();
  const forget = (key: string): void => {
    const task = tasks.get(key);
    if (task?.timer !== undefined) clearTimer(task.timer);
    tasks.delete(key);
  };
  return (sessionId, event, send) => {
    const taskId = event.metadata?.taskId;
    if (!taskId) {
      send();
      return;
    }
    const key = `${sessionId}\u0000${taskId}`;
    if (event.label !== processLabels.subtaskRunning) {
      if (subtaskBoundaryLabels.has(event.label)) forget(key);
      send();
      return;
    }
    let task = tasks.get(key);
    if (!task) {
      if (tasks.size >= subtaskProgressTaskLimit) {
        const oldest = tasks.keys().next().value;
        if (oldest !== undefined) forget(oldest);
      }
      task = { sentAt: Number.NEGATIVE_INFINITY };
      tasks.set(key, task);
    }
    const elapsed = now() - task.sentAt;
    if (task.timer === undefined && elapsed >= intervalMs) {
      task.sentAt = now();
      send();
      return;
    }
    task.pending = send;
    if (task.timer !== undefined) return;
    const held = task;
    held.timer = setTimer(
      () => {
        held.timer = undefined;
        const pending = held.pending;
        held.pending = undefined;
        if (!pending || tasks.get(key) !== held) return;
        held.sentAt = now();
        pending();
      },
      Math.max(0, intervalMs - elapsed),
    );
  };
}

/** Names one dispatch's response events after `dispatchID`. */
export function createResponseStreamEventIDAllocator(
  dispatchID: string,
): (label: string, messageID?: string) => string | undefined {
  let responseStreamOrdinal = 1;
  let responseStreamOpen = false;
  let lastMessageID: string | undefined;
  const messageEvents = new Map<string, string>();
  return (label: string, messageID?: string): string | undefined => {
    if (label === "Response stream") {
      if (messageID && messageEvents.has(messageID))
        return messageEvents.get(messageID);
      if (
        responseStreamOpen &&
        messageID &&
        lastMessageID &&
        messageID !== lastMessageID
      )
        responseStreamOrdinal += 1;
      const eventID =
        responseStreamOrdinal === 1
          ? `evt_${dispatchID}_response_stream`
          : `evt_${dispatchID}_response_stream_${responseStreamOrdinal}`;
      responseStreamOpen = true;
      lastMessageID = messageID;
      if (messageID) messageEvents.set(messageID, eventID);
      return eventID;
    }
    if (responseStreamOpen && label !== processLabels.requestingModel) {
      responseStreamOrdinal += 1;
      responseStreamOpen = false;
    }
    return undefined;
  };
}

export function sessionEvent(
  sessionID: string,
  label: string,
  detail: string,
  level: AgentSessionEvent["level"] = "info",
  eventID?: string,
  metadata?: AgentSessionEventMetadata,
  message?: AgentSessionEvent["message"],
): AgentSessionEvent {
  const id =
    eventID ??
    `evt_${sessionID}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return {
    id,
    sessionId: sessionID,
    at: "just now",
    label,
    // What an agent printed reaches every reader of the transcript.
    detail: redactTranscriptText(detail),
    level,
    metadata,
    message: message
      ? redactTranscriptMessage({ ...message, id: message.id || id })
      : undefined,
  };
}

export {
  cancelActiveSession,
  isAgentSessionCanceledError,
  noteSessionInput,
  registerActiveSessionSteerTarget,
  steerActiveSession,
  steerActiveSessionOnce,
} from "./session-control.js";

/**
 * A transcript message named within the input that produced it. Runtimes
 * number their items per turn (Codex restarts at item_0) while a session
 * holds many inputs, so a bare item id would let one input's answer replace
 * another's in the transcript.
 */
export function inputScopedMessage(
  session: AgentSession,
  message: AgentSessionEvent["message"],
): AgentSessionEvent["message"] {
  if (!message || !session.input) return message;
  return { ...message, id: `${session.input.id}/${message.id}` };
}

function completionMarkerPath(
  workspacePath: string,
  session: Pick<AgentSession, "id" | "input">,
): string {
  return resolve(
    sessionInputDirectory(
      resolve(workspacePath, ".foundry", "sessions"),
      session as AgentSession,
    ),
    "completion.json",
  );
}

export function writeAgentSessionCompletionMarker(
  workspacePath: string,
  session: AgentSession,
  result: AgentSessionRunResult,
): void {
  const markerPath = completionMarkerPath(workspacePath, session);
  const marker: AgentSessionCompletionMarker = {
    completedAt: new Date().toISOString(),
    nativeSessionId: result.nativeSessionId,
    response: result.response,
    sessionId: session.id,
    status: "completed",
  };
  writePrivateJSONAtomic(markerPath, marker);
}

/** The completion this device recorded for one input, if it finished. */
export function readAgentSessionCompletionMarker(
  workspacePath: string,
  sessionId: string,
  inputId: string,
): AgentSessionCompletionMarker | undefined {
  const markerPath = completionMarkerPath(workspacePath, {
    id: sessionId,
    input: inputId ? { id: inputId, prompt: "" } : undefined,
  });
  if (!existsSync(markerPath)) return undefined;
  const marker = JSON.parse(
    readFileSync(markerPath, "utf8"),
  ) as AgentSessionCompletionMarker;
  return marker.sessionId === sessionId &&
    marker.status === "completed" &&
    marker.response?.trim()
    ? marker
    : undefined;
}

/**
 * The session_completed report for an input this worker process does not
 * run: the recorded result, or that the result was lost with an earlier
 * process.
 */
export function recoveredSessionCompletion(
  workspacePath: string,
  sessionId: string,
  inputId: string,
): Record<string, string | undefined> {
  const marker = readAgentSessionCompletionMarker(
    workspacePath,
    sessionId,
    inputId,
  );
  if (marker) {
    return {
      sessionId,
      inputId: inputId || undefined,
      nativeSessionId: marker.nativeSessionId,
      response: marker.response,
    };
  }
  return {
    sessionId,
    inputId: inputId || undefined,
    error:
      "The worker stopped while this message was running, so its result was lost. Send it again to continue.",
  };
}
