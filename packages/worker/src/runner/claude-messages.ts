import { appendFileSync, writeFileSync } from "node:fs";
import {
  processLabels,
  type AgentSessionEvent,
  type AgentSessionEventMetadata,
  type SessionFileReference,
} from "@bd777/foundry-protocol";
import { timerFireEvent } from "../agent-timers.js";
import { redactSecrets } from "../secret-redaction.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import { SessionTurnFiles } from "../session-files.js";
import {
  claudeAgentResultError,
  claudeApiErrorMessage,
  claudeCommandLifecycle,
  claudeMessageText,
  claudeNativeSessionId,
  claudePartialText,
  claudeProcessEvent,
  claudeTaskLifecycleChange,
  claudeTaskNotificationBookkeeping,
  isForwardedClaudeSubagentMessage,
  sdkString,
} from "../sdk-messages.js";
import {
  activeClaudeRuntimes,
  emitOutOfBandSessionEvent,
  type ActiveClaudeContinuation,
  type ActiveClaudeRuntime,
  type ActiveClaudeTurn,
  type AgentSessionRunResult,
  type ClaudeSDKQuery,
} from "../session-state.js";
import {
  addTurnUsage,
  claudeResultUsage,
  turnUsageMetadata,
} from "../turn-usage.js";
import {
  claudeRuntimeHasLiveWork,
  closeActiveClaudeRuntime,
  logClaudeRuntime,
} from "./active-runtimes.js";

/**
 * Every message of a Claude process: to the turn that owns the stream, or
 * to the work Claude does on its own between turns.
 */

export function resolveActiveClaudeTurn(
  runtime: ActiveClaudeRuntime,
  turn: ActiveClaudeTurn,
  result: AgentSessionRunResult,
): void {
  if (runtime.pending !== turn) {
    return;
  }
  runtime.pending = undefined;
  if (turn.commandId) runtime.lastInputId = turn.commandId;
  // A timer's prompt this turn answered (the device sent it) is not a turn
  // Claude runs on its own.
  runtime.timers?.dropFire();
  turn.liveness.close();
  turn.resolve(result);
}

export function updateActiveClaudeTurnTasks(
  turn: ActiveClaudeTurn,
  message: unknown,
): void {
  const change = claudeTaskLifecycleChange(message);
  if (!change) {
    return;
  }
  if (change.kind === "snapshot") {
    turn.openTaskIds.clear();
    for (const taskId of change.taskIds) {
      turn.openTaskIds.add(taskId);
    }
    return;
  }
  if (change.kind === "started") {
    turn.openTaskIds.add(change.taskId);
    return;
  }
  turn.openTaskIds.delete(change.taskId);
}

/** A runtime's event: to the turn it serves, else the out-of-band channel. */
export function emitForClaudeRuntime(
  runtime: ActiveClaudeRuntime,
  event: {
    detail: string;
    label: string;
    level?: AgentSessionEvent["level"];
    message?: AgentSessionEvent["message"];
    metadata?: AgentSessionEventMetadata;
  },
): void {
  const turn = runtime.pending;
  if (turn && !runtime.closed) {
    void turn.emit(
      event.label,
      event.detail,
      event.level ?? "info",
      event.metadata,
      event.message,
    );
    return;
  }
  emitOutOfBandSessionEvent(runtime.foundrySessionId, {
    detail: event.detail,
    label: event.label,
    level: event.level,
    message: event.message,
    metadata: event.metadata,
  });
}

/**
 * Whether the pending Foundry turn answers this message. Claude Code
 * reports when it starts an input (command lifecycle), so a turn owns the
 * stream from then on, even when its input joined a follow-up Claude was
 * running. Before that, or on a CLI without these reports, a follow-up in
 * progress keeps its own messages.
 */
export function claudeTurnOwnsMessage(
  runtime: ActiveClaudeRuntime,
  turn: ActiveClaudeTurn,
): boolean {
  if (turn.commandState === "started") return true;
  if (turn.commandState === "queued") return false;
  return !runtime.continuation && !turn.behindContinuation;
}

function claudeContinuation(
  runtime: ActiveClaudeRuntime,
): ActiveClaudeContinuation {
  runtime.continuation ??= {
    finalResult: "",
    partialResult: "",
    startedAt: Date.now(),
  };
  return runtime.continuation;
}

/**
 * Files Claude's tools write and its answers name while no Foundry turn owns
 * the stream (after background work, or on a timer). They are the session's,
 * credited to the input whose turn ended last.
 */
function claudeBetweenTurnFiles(
  runtime: ActiveClaudeRuntime,
): SessionTurnFiles | undefined {
  if (runtime.betweenTurnFiles) return runtime.betweenTurnFiles;
  if (!runtime.workspacePath) return undefined;
  runtime.betweenTurnFiles = new SessionTurnFiles({
    workspacePath: runtime.workspacePath,
    sessionsRoot: executionSessionsRoot(runtime.workspacePath),
    sessionId: runtime.foundrySessionId,
    inputId: runtime.lastInputId,
    emit: async (label, detail, level, metadata, message) =>
      emitForClaudeRuntime(runtime, {
        label,
        detail,
        level,
        metadata,
        message,
      }),
    startedAt: runtime.continuation?.startedAt ?? Date.now(),
  });
  return runtime.betweenTurnFiles;
}

/** Where a write tool's call is recorded: the turn the stream answers. */
export function claudeWriteFiles(
  runtime: ActiveClaudeRuntime,
): SessionTurnFiles | undefined {
  const turn = runtime.pending;
  if (turn && claudeTurnOwnsMessage(runtime, turn)) return turn.files;
  return claudeBetweenTurnFiles(runtime);
}

/** Ends work between turns: records its files and links its answer's. */
export async function finishClaudeBetweenTurnFiles(
  runtime: ActiveClaudeRuntime,
  answer: string,
): Promise<SessionFileReference[]> {
  const files = claudeBetweenTurnFiles(runtime);
  runtime.betweenTurnFiles = undefined;
  return (await files?.finish(answer)) ?? [];
}

const taskLifecycleSubtypes = new Set([
  "task_started",
  "task_progress",
  "task_notification",
]);

/**
 * A turn Claude ran on its own, published once it is complete: a divider
 * and the answer. Claude ran it for a timer when it submitted the timer's
 * prompt (ClaudeTimerTracker.takeFire), else as its follow-up after
 * background work ended.
 */
async function finishClaudeContinuation(
  runtime: ActiveClaudeRuntime,
  result?: unknown,
): Promise<void> {
  const continuation = runtime.continuation;
  const notifications = runtime.notifications ?? [];
  const fire = runtime.timers?.takeFire();
  runtime.continuation = undefined;
  runtime.notifications = [];
  if (runtime.pending) runtime.pending.behindContinuation = false;
  const error = result ? claudeAgentResultError(result) : undefined;
  const response = (
    continuation?.finalResult || (result ? claudeMessageText(result) : "")
  ).trim();
  const fileReferences = await finishClaudeBetweenTurnFiles(
    runtime,
    error ? "" : response,
  );
  if (!fire && !response && !error) return;
  const startedAt = fire
    ? Date.parse(fire.startedAt)
    : (continuation?.startedAt ?? Date.now());
  const usage = result
    ? claudeResultUsage(result, runtime.context?.costOf(result))
    : undefined;
  const completedAt = new Date().toISOString();
  const metadata = {
    ...turnUsageMetadata(usage, startedAt),
    ...(fileReferences.length > 0 ? { fileReferences } : {}),
  };
  const answer = error ? error.message : response;
  if (fire) {
    const event = timerFireEvent(fire, {
      completedAt,
      response: answer,
      failed: Boolean(error),
    });
    emitForClaudeRuntime(runtime, {
      ...event,
      metadata: { ...event.metadata, ...metadata },
    });
    return;
  }
  emitForClaudeRuntime(runtime, {
    label: processLabels.backgroundTurn,
    detail:
      notifications[0] ??
      (error ? error.message : "Claude continued after background work."),
    level: error ? "error" : "info",
    metadata: {
      timerFire: {
        origin: "background",
        prompt: notifications.join("\n"),
        response: answer,
        startedAt: new Date(startedAt).toISOString(),
        completedAt,
      },
      ...metadata,
    },
  });
}

/** A message no Foundry turn answers: Claude working on its own. */
async function handleClaudeContinuationMessage(
  runtime: ActiveClaudeRuntime,
  message: unknown,
): Promise<void> {
  if (!message || typeof message !== "object") return;
  if (isForwardedClaudeSubagentMessage(message)) return;
  const record = message as Record<string, unknown>;
  if (record.type === "system") {
    const subtype = sdkString(record.subtype);
    if (!taskLifecycleSubtypes.has(subtype)) return;
    // Subagent lifecycle drives the side panel; it is not transcript text.
    const processEvent = claudeProcessEvent(message);
    if (processEvent) emitForClaudeRuntime(runtime, processEvent);
    const summary = sdkString(record.summary);
    if (subtype === "task_notification" && summary) {
      runtime.notifications = [
        ...(runtime.notifications ?? []),
        redactSecrets(summary),
      ].slice(-10);
    }
    return;
  }
  if (record.type === "result") {
    if (claudeTaskNotificationBookkeeping(message)) {
      runtime.continuation = undefined;
      runtime.notifications = [];
      return;
    }
    await finishClaudeContinuation(runtime, message);
    return;
  }
  if (claudeApiErrorMessage(message)) return;
  const delta = claudePartialText(message);
  if (delta) {
    const continuation = claudeContinuation(runtime);
    continuation.partialResult += delta;
    continuation.finalResult = continuation.partialResult.trim();
    return;
  }
  if (record.type === "stream_event") {
    claudeContinuation(runtime);
    return;
  }
  if (record.type === "assistant") {
    const continuation = claudeContinuation(runtime);
    const text = claudeMessageText(message);
    if (text) {
      continuation.finalResult = text;
      continuation.partialResult = text;
    }
  }
}

export async function handleActiveClaudeMessage(
  runtime: ActiveClaudeRuntime,
  message: unknown,
): Promise<void> {
  runtime.lastUsed = Date.now();
  const turn = runtime.pending;
  const messageNativeSessionId = claudeNativeSessionId(message);
  if (messageNativeSessionId) {
    runtime.nativeSessionId = messageNativeSessionId;
    if (turn) {
      turn.nativeSessionId = messageNativeSessionId;
      turn.reportNativeSessionId?.(messageNativeSessionId);
    }
  }
  const messagesPath = turn?.messagesPath ?? runtime.messagesPath;
  if (messagesPath)
    appendFileSync(messagesPath, `${JSON.stringify(message ?? null)}\n`);
  // Background work outlives turns: every message is observed.
  runtime.background?.observe(message);
  const contextUsage = runtime.context?.observe(message);
  if (contextUsage)
    emitForClaudeRuntime(runtime, {
      label: processLabels.modelRequestUsage,
      detail: contextUsage.model ?? "",
      metadata: { contextUsage },
    });
  const lifecycle = claudeCommandLifecycle(message);
  if (lifecycle) {
    runtime.commandLifecycle = true;
    if (turn && turn.commandId && lifecycle.commandId === turn.commandId) {
      if (lifecycle.state === "started" && turn.commandState !== "started") {
        // The input may join a follow-up Claude was running: what Claude
        // said before it is its own; from here the stream answers the input.
        if (runtime.continuation) await finishClaudeContinuation(runtime);
        turn.commandState = "started";
      } else if (lifecycle.state === "queued" && !turn.commandState) {
        turn.commandState = "queued";
      }
    }
  }
  // What the process is busy with, including work a queued turn waits on.
  const finishedTools = turn?.liveness.observe(message) ?? [];
  if (!turn || !claudeTurnOwnsMessage(runtime, turn)) {
    await handleClaudeContinuationMessage(runtime, message);
    return;
  }
  updateActiveClaudeTurnTasks(turn, message);
  const processEvent = claudeProcessEvent(message);
  if (processEvent) {
    await turn.emit(
      processEvent.label,
      processEvent.detail,
      processEvent.level,
      processEvent.metadata,
      processEvent.message,
    );
  }
  // A tool call runs from Claude's call until its result.
  for (const tool of finishedTools) {
    const title = tool.failed
      ? processLabels.toolFailed
      : processLabels.usedTool;
    await turn.emit(title, tool.detail, undefined, undefined, {
      id: tool.id,
      kind: "tool",
      callId: tool.id,
      status: tool.failed ? "failed" : "completed",
      title,
      text: tool.detail,
    });
  }
  const requestUsage = turn.requestUsage?.observe(message);
  if (requestUsage) {
    await turn.emit(
      processLabels.modelRequestUsage,
      requestUsage.requestId,
      undefined,
      { requestUsage },
    );
  }
  const resultError = claudeAgentResultError(message);
  if (resultError) {
    closeActiveClaudeRuntime(runtime, resultError);
    return;
  }
  // A synthetic pre-turn API rejection (401, prompt too long, …) is an error,
  // not an assistant answer: never stream its text as the turn response. The
  // following result record closes the turn with the same error.
  if (claudeApiErrorMessage(message)) {
    return;
  }
  const delta = claudePartialText(message);
  if (delta) {
    turn.partialResult += delta;
    turn.finalResult = turn.partialResult.trim();
    if (turn.finalResult) {
      await turn.emit("Response stream", turn.finalResult);
    }
    return;
  }
  const text = claudeMessageText(message);
  if (text && text !== turn.finalResult) {
    turn.finalResult = text;
    turn.partialResult = text;
    await turn.emit("Response stream", text);
  }
  if (claudeTaskNotificationBookkeeping(message)) {
    return;
  }
  const resultUsage = claudeResultUsage(
    message,
    runtime.context?.costOf(message),
  );
  if (resultUsage) turn.usage = addTurnUsage(turn.usage, resultUsage);
  if (
    message &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "result"
  ) {
    const response =
      turn.finalResult ||
      turn.deliveredResponse ||
      "Claude Agent SDK completed without a text response.";
    if (turn.waitForBackgroundTasks && turn.openTaskIds.size > 0) {
      await turn.emit(
        processLabels.waitingBackgroundTasks,
        `${turn.openTaskIds.size} background task(s) are still open; this result is intermediate, and Foundry waits for the main agent to continue.`,
      );
      // A result in streaming-input mode ends one model turn, not necessarily
      // the Foundry turn. Clear the text accumulator so the continuation's
      // final response replaces this provisional response instead of being
      // concatenated with it.
      // The answer is delivered: whatever ends the runtime from here, the
      // turn completes with it.
      if (turn.finalResult) turn.deliveredResponse = turn.finalResult;
      turn.finalResult = "";
      turn.partialResult = "";
      return;
    }
    writeFileSync(turn.resultPath, `${response}\n`);
    const fileReferences = (await turn.files?.finish(turn.finalResult)) ?? [];
    await turn.emit("Claude Agent SDK finished", turn.resultPath, undefined, {
      ...turnUsageMetadata(turn.usage, turn.startedAt),
      ...(fileReferences.length > 0 ? { fileReferences } : {}),
    });
    resolveActiveClaudeTurn(runtime, turn, {
      nativeSessionId: turn.nativeSessionId || runtime.nativeSessionId,
      response,
    });
    // If the SDK returned no text, the runtime is likely in a bad state
    // (e.g. orphaned background agents from a killed session). Close it so
    // the next session starts fresh instead of reusing the broken runtime —
    // unless background work or timers of its own are still alive.
    if (!turn.finalResult && !claudeRuntimeHasLiveWork(runtime)) {
      closeActiveClaudeRuntime(
        runtime,
        new Error(
          "Session completed without a text response; closing runtime to recover.",
        ),
      );
    }
  }
}

export function startActiveClaudePump(
  runtime: ActiveClaudeRuntime,
  query: ClaudeSDKQuery,
): void {
  runtime.query = query;
  void (async () => {
    try {
      for await (const message of query) {
        await handleActiveClaudeMessage(runtime, message);
      }
      runtime.closed = true;
      closeActiveClaudeRuntime(
        runtime,
        new Error("Claude Agent SDK stream ended before a result message"),
      );
    } catch (error) {
      runtime.closed = true;
      closeActiveClaudeRuntime(runtime, error);
    } finally {
      closeActiveClaudeRuntime(runtime);
      const successor = activeClaudeRuntimes.get(runtime.key);
      logClaudeRuntime(
        "ended",
        runtime,
        successor
          ? `its key now serves a newer process (pid ${successor.pid ?? "-"})`
          : undefined,
      );
    }
  })();
}
