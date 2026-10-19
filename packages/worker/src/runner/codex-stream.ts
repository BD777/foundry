import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { validateWorkspaceSkillPrompt } from "../skill-isolation.js";
import { userMessageText } from "../session-prompt.js";
import { appendFileSync } from "node:fs";
import { processLabels } from "@bd777/foundry-protocol";
import type { CodexContextFollower } from "../context-usage.js";
import {
  sdkMessageText,
  sdkProcessEvent,
  sdkResponseMessage,
} from "../sdk-messages.js";
import {
  AgentSessionCanceledError,
  registerActiveSessionCancelTarget,
  registerActiveSessionSteerTarget,
} from "../session-control.js";
import { codexFileWrites, type SessionTurnFiles } from "../session-files.js";
import type {
  ActiveCodexThread,
  CodexSDKThread,
  SessionEventEmitter,
} from "../session-state.js";
import { codexTurnUsage, type TurnTokenUsage } from "../turn-usage.js";
import type { CodexTransportLearner } from "./codex-transport.js";
import {
  CodexTurnLiveness,
  livenessDuration,
  turnLivenessNoticeText,
  turnLivenessSettings,
} from "../watchdog.js";

/** What one Codex turn learns as it runs; every phase reads and updates it. */
export interface CodexTurnState {
  emit: SessionEventEmitter;
  reportNativeSessionId: (nativeSessionId: string) => void;
  files: SessionTurnFiles;
  eventsPath: string;
  /**
   * This turn's thread: what the turn learns updates it, never a newer
   * thread that took the key meanwhile.
   */
  thread: ActiveCodexThread;
  /** How full the thread's context is, from the log Codex keeps of it. */
  context: CodexContextFollower;
  nativeSessionId: string;
  managedSkills?: ManagedSkillRuntime;
  finalResult: string;
  usage?: TurnTokenUsage;
  /** What the turn shows about the endpoint's Responses WebSocket. */
  transport?: CodexTransportLearner;
}

type StreamedCodexThread = CodexSDKThread &
  Required<Pick<CodexSDKThread, "runStreamed">>;

export function streamsCodexEvents(
  thread: CodexSDKThread,
): thread is StreamedCodexThread {
  return typeof thread.runStreamed === "function";
}

/**
 * Runs the turn over Codex's event stream, until its turn.completed, a
 * failure, a stop or Foundry's ceiling for one turn.
 */
export async function runCodexStreamedTurn(
  state: CodexTurnState,
  thread: StreamedCodexThread,
  input: unknown,
  sessionId: string,
): Promise<void> {
  const abortController = new AbortController();
  let canceled = false;
  const unregisterCancel = registerActiveSessionCancelTarget(sessionId, {
    provider: "codex",
    cancel: () => {
      canceled = true;
      abortController.abort();
    },
  });
  const unregisterSteer = thread.steer
    ? registerActiveSessionSteerTarget(sessionId, {
        provider: "codex",
        steer: async (message, attachments = [], steerId, sentBySessionId) => {
          if (state.managedSkills)
            validateWorkspaceSkillPrompt(message, state.managedSkills);
          const input = [
            {
              type: "text",
              text: userMessageText(message, attachments, sentBySessionId),
            },
            ...attachments
              .filter((attachment) => attachment.kind === "image")
              .map((attachment) => ({
                type: "local_image",
                path: attachment.path,
              })),
          ];
          await thread.steer!(input, steerId);
          await state.emit(
            "Steered into active turn",
            message,
            "info",
            undefined,
            { id: steerId ?? "", kind: "user", text: message, attachments },
            steerId ? `evt_${steerId}` : undefined,
          );
        },
      })
    : () => {};
  // Quiet is not failure: Codex bounds its own stream and tools.
  let ceilingError: Error | undefined;
  const liveness = new CodexTurnLiveness({
    ...turnLivenessSettings(),
    startupTimeoutMs: undefined,
    onNotice: (notice) =>
      void state.emit(
        processLabels.notice,
        turnLivenessNoticeText(notice),
        "warning",
      ),
    onFailure: (failure) => {
      ceilingError = new Error(
        `The turn ran for ${livenessDuration(failure.kind === "ceiling" ? failure.elapsedMs : failure.waitedMs)}, Foundry's ceiling for one turn (FOUNDRY_TURN_MAX_DURATION_MS), and was stopped.`,
      );
      abortController.abort();
    },
  });
  let events: AsyncIterator<unknown> | undefined;
  let turnFailed = false;
  try {
    const streamed = await thread.runStreamed(input, {
      signal: abortController.signal,
      onStartupWait: () =>
        state.emit(
          "Notice",
          "Codex is still preparing its native thread. No model turn has started yet; you can stop this startup from the chat.",
          "warning",
        ),
    });
    events = streamed.events[Symbol.asyncIterator]();
    while (true) {
      let next: IteratorResult<unknown>;
      try {
        next = await events.next();
      } catch (error) {
        if (ceilingError) throw ceilingError;
        if (canceled || abortController.signal.aborted) {
          throw new AgentSessionCanceledError();
        }
        throw error;
      }
      if (next.done) break;
      liveness.observe(next.value);
      if (await handleCodexEvent(state, next.value)) {
        abortController.abort();
        break;
      }
    }
    if (ceilingError) throw ceilingError;
    if (canceled) {
      throw new AgentSessionCanceledError();
    }
  } catch (error) {
    turnFailed = true;
    if (canceled) throw new AgentSessionCanceledError();
    throw error;
  } finally {
    // The turn's process ends with it: one a failure left running would
    // write the thread alongside the next turn's.
    abortController.abort();
    // A terminal native failure is handled outside the iterator. Abort may
    // already be a no-op for that terminal turn; return still runs the
    // producer's finally and releases its native thread writer.
    try {
      await events?.return?.();
    } catch (error) {
      // Keep the original execution error, but do not hide an unconfirmed
      // shutdown or report a successful turn when its writer did not close.
      if (!turnFailed) throw error;
      await state
        .emit("Notice", `Codex cleanup failed: ${String(error)}`, "warning")
        .catch(() => {});
    } finally {
      liveness.close();
      unregisterCancel();
      unregisterSteer();
    }
  }
}

/** A Codex SDK without streaming: one call returns the whole turn. */
export async function runCodexUnstreamedTurn(
  state: CodexTurnState,
  thread: CodexSDKThread,
  input: unknown,
): Promise<void> {
  const turn = await thread.run(input);
  appendFileSync(state.eventsPath, `${JSON.stringify(turn ?? null)}\n`);
  state.nativeSessionId = thread.id || state.nativeSessionId;
  state.reportNativeSessionId(state.nativeSessionId);
  state.finalResult = sdkMessageText(turn);
  state.usage = codexTurnUsage(turn);
}

/** Records and publishes one stream event. True once the turn completed. */
async function handleCodexEvent(
  state: CodexTurnState,
  event: unknown,
): Promise<boolean> {
  appendFileSync(state.eventsPath, `${JSON.stringify(event ?? null)}\n`);
  await followCodexThread(state, nativeSessionIdFromEvent(event));
  const processEvent = sdkProcessEvent(event);
  if (processEvent) {
    await state.emit(
      processEvent.label,
      processEvent.detail,
      processEvent.level,
      undefined,
      processEvent.message,
    );
  }
  for (const write of codexFileWrites(event))
    await state.files.recordToolWrite(write);
  const eventType =
    event && typeof event === "object"
      ? (event as Record<string, unknown>).type
      : undefined;
  if (eventType === "item.completed") await reportCodexContext(state);
  await emitCodexText(state, event);
  await state.transport?.observe(event, eventType === "turn.completed");
  if (eventType === "turn.failed") throw codexTurnFailure(event);
  if (eventType !== "turn.completed") return false;
  state.usage = codexTurnUsage(event);
  // The log trails the stream a little: its last count is read before the
  // process stops.
  for (let wait = 0; ; wait += 1) {
    await reportCodexContext(state);
    if (
      !state.context.found ||
      state.context.turnInputTokens >= (state.usage?.inputTokens ?? 0) ||
      wait >= 10
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** The thread Codex named for a new native session, once it does. */
async function followCodexThread(
  state: CodexTurnState,
  nativeSessionId: string,
): Promise<void> {
  if (!nativeSessionId) return;
  state.nativeSessionId = nativeSessionId;
  state.reportNativeSessionId(nativeSessionId);
  await state.context.follow(nativeSessionId, { resumed: false });
  state.thread.nativeSessionId = nativeSessionId;
  state.thread.lastUsed = Date.now();
}

/** Commentary as it streams; anything else is the turn's latest answer. */
async function emitCodexText(
  state: CodexTurnState,
  event: unknown,
): Promise<void> {
  const text = sdkMessageText(event);
  if (!text || text === state.finalResult) return;
  const message = sdkResponseMessage(event, text);
  if (message.kind === "commentary") {
    await state.emit(
      processLabels.commentary,
      text,
      undefined,
      undefined,
      message,
    );
    return;
  }
  state.finalResult = text;
  await state.emit("Response stream", text, undefined, undefined, message);
}

function codexTurnFailure(event: unknown): Error {
  const error = (event as Record<string, unknown>).error;
  return new Error(
    error &&
      typeof error === "object" &&
      typeof (error as Record<string, unknown>).message === "string"
      ? String((error as Record<string, unknown>).message)
      : "Codex turn failed",
  );
}

async function reportCodexContext(state: CodexTurnState): Promise<void> {
  const reports = await state.context.read().catch(() => []);
  for (const contextUsage of reports)
    await state.emit(
      processLabels.modelRequestUsage,
      contextUsage.model ?? "",
      undefined,
      { contextUsage },
    );
}

export function nativeSessionIdFromEvent(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  const record = event as Record<string, unknown>;
  if (
    record.type === "thread.started" &&
    typeof record.thread_id === "string"
  ) {
    return record.thread_id.trim();
  }
  return "";
}
