import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  processLabels,
  type AgentBackgroundTaskOutput,
  type AgentProjection,
  type AgentSession,
} from "@bd777/foundry-protocol";
import {
  backgroundTaskOutputLocation,
  readBackgroundTaskOutput,
} from "../agent-background-tasks.js";
import type { FollowedLog } from "../background-output-follow.js";
import { readAgentRuntimeSettings } from "../device.js";
import {
  profileFingerprint,
  profileID,
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "../profiles.js";
import { knownSessionScratchDirectory } from "../resource-pool.js";
import { redactSecrets } from "../secret-redaction.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import {
  clearSessionControl,
  isAgentSessionCanceledError,
} from "../session-control.js";
import {
  activeClaudeRuntimes,
  activeCodexThreads,
  type ActiveClaudeRuntime,
  type ActiveClaudeTurn,
} from "../session-state.js";
import { sessionTimers } from "../session-timers.js";
import { turnUsageMetadata } from "../turn-usage.js";
import { errorMessage } from "../utils.js";

/**
 * The agent processes and threads that outlive a turn: their identity, how
 * they end, and what their sessions still run in the background.
 */

export function activeRuntimeKey(
  provider: AgentProjection["provider"],
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  options: Record<string, unknown>,
): string {
  const stableOptions = { ...options };
  delete stableOptions.env;
  const inheritedEnvironmentKeys = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_BASE_URL",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    "CODEX_BASE_URL",
    "CODEX_CLI_PATH",
    "CODEX_HOME",
    "FOUNDRY_CLAUDE_BIN",
    "FOUNDRY_CODEX_BIN",
    "OPENAI_API_BASE",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ];
  const runtimeEnvironment = Object.fromEntries(
    Object.entries({
      ...Object.fromEntries(
        inheritedEnvironmentKeys
          .map((key) => [key, process.env[key]])
          .filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
      ),
      ...profileRuntimeEnvironment(profile, session),
    }).sort(([left], [right]) => left.localeCompare(right)),
  );
  const identity = JSON.stringify({
    options: stableOptions,
    profileFingerprint: profileFingerprint(profile),
    profileId: profileID(profile),
    provider,
    runtimeEnvironment,
    threadId: session.threadId ?? session.id,
    workspaceId: session.workspaceId,
    workspacePath,
  });
  return createHash("sha256").update(identity).digest("hex");
}

export function cleanupActiveCodexThreads(): void {
  const now = Date.now();
  const settings = readAgentRuntimeSettings();
  for (const [key, runtime] of activeCodexThreads) {
    if (now - runtime.lastUsed > settings.activeRuntimeTtlMs) {
      activeCodexThreads.delete(key);
    }
  }
}

/**
 * Whether the agent process still has work of its own: background tasks
 * that are running, or timers that will wake it. Closing it would end them.
 */
export function claudeRuntimeHasLiveWork(
  runtime: ActiveClaudeRuntime,
): boolean {
  return (
    !runtime.closed &&
    (Boolean(runtime.background?.hasRunning()) ||
      (runtime.timers?.snapshot().length ?? 0) > 0)
  );
}

/**
 * Whether the agent process is busy: a turn in progress (whatever it waits
 * on), Claude continuing on its own between turns, or its background work
 * and timers.
 */
export function claudeRuntimeIsBusy(runtime: ActiveClaudeRuntime): boolean {
  return (
    !runtime.closed &&
    (runtime.pending !== undefined ||
      runtime.continuation !== undefined ||
      claudeRuntimeHasLiveWork(runtime))
  );
}

/**
 * Reaps idle runtimes only. Time since the last message says nothing about
 * a busy process — a long tool call or model request is quiet — so a busy
 * runtime is never reaped; its own exit ends it.
 */
export function cleanupActiveClaudeRuntimes(): void {
  const now = Date.now();
  const settings = readAgentRuntimeSettings();
  for (const runtime of activeClaudeRuntimes.values()) {
    if (
      runtime.closed ||
      (now - runtime.lastUsed > settings.activeRuntimeTtlMs &&
        !claudeRuntimeIsBusy(runtime))
    ) {
      closeActiveClaudeRuntime(
        runtime,
        new Error("Claude active runtime expired after being idle."),
      );
    }
  }
}

/**
 * Close ALL active runtimes and clear session registries. Called when the
 * WebSocket drops — runtimes can no longer deliver events to the server,
 * so keeping them alive only leaks state and causes stale-runtime reuse
 * on reconnect.
 */
export function closeAllActiveRuntimes(): void {
  const disconnectError = new Error("WebSocket disconnected");
  for (const runtime of activeClaudeRuntimes.values())
    closeActiveClaudeRuntime(runtime, disconnectError);
  for (const [key] of activeCodexThreads) {
    // Codex threads don't have a close method — the AbortController is
    // local to the session execution and will be garbage collected.
    activeCodexThreads.delete(key);
  }
  clearSessionControl();
}

/** A worker log line per agent process change: which process served what. */
export function logClaudeRuntime(
  event: string,
  runtime: ActiveClaudeRuntime,
  detail?: unknown,
): void {
  const text = errorMessage(detail);
  const note =
    detail === undefined
      ? ""
      : `: ${redactSecrets(text).replace(/\s+/g, " ").slice(0, 300)}`;
  console.error(
    `${new Date().toISOString()} [claude-runtime] ${event} pid=${runtime.pid ?? "-"} key=${runtime.key.slice(0, 12)} native=${runtime.nativeSessionId || "-"} session=${runtime.foundrySessionId}${note}`,
  );
}

/**
 * Takes a closed runtime out of the registry. A runtime that ends after a
 * newer one took its key (it was reaped or replaced, and its process exits
 * later) leaves the newer one registered: the registry only ever loses
 * runtimes that were closed.
 */
function forgetClaudeRuntime(
  runtime: ActiveClaudeRuntime,
  reason: unknown,
): void {
  if (activeClaudeRuntimes.get(runtime.key) !== runtime) return;
  activeClaudeRuntimes.delete(runtime.key);
  logClaudeRuntime("closed", runtime, reason);
}

/**
 * One process writes a native session. Before a turn runs on `keep` (or on
 * a process about to start), every other runtime of the Foundry session or
 * holding the native session it writes is closed, whatever its key: an
 * earlier skill catalog, profile or model, or a process left over. A turn
 * still open on one ends here: one Claude already answered completes with
 * that answer (completeInterruptedClaudeTurn); otherwise it fails.
 */
export function closeOtherClaudeWriters(
  sessionId: string,
  nativeSessionId: string,
  keep: ActiveClaudeRuntime | undefined,
): void {
  for (const other of activeClaudeRuntimes.values()) {
    if (
      other !== keep &&
      ((sessionId && other.foundrySessionId === sessionId) ||
        (nativeSessionId && other.nativeSessionId === nativeSessionId))
    )
      closeActiveClaudeRuntime(
        other,
        new Error(
          "A newer Claude process took over this session's native session.",
        ),
      );
  }
}

export function closeActiveClaudeRuntime(
  runtime: ActiveClaudeRuntime,
  reason: unknown = new Error(
    "Claude active runtime closed before the turn completed.",
  ),
): void {
  runtime.closed = true;
  forgetClaudeRuntime(runtime, reason);
  const turn = runtime.pending;
  runtime.pending = undefined;
  // Background work lives in the agent process and dies with it; publish
  // that before tearing down event plumbing. Its timers live in the native
  // session: the device keeps them until a process resumes it.
  sessionTimers.detach(
    runtime.foundrySessionId,
    runtime.nativeSessionId,
    runtime.timers?.close() ?? [],
    runtime,
  );
  runtime.background?.close();
  runtime.continuation = undefined;
  if (turn) {
    turn.liveness.close();
    if (turn.deliveredResponse !== undefined)
      void completeInterruptedClaudeTurn(runtime, turn, reason);
    else turn.reject(reason);
  }
  runtime.input.close();
  try {
    runtime.query?.close?.();
  } catch {
    // Best-effort cleanup only.
  }
}

/**
 * A turn that already answered, ended by something else before the
 * background work it waited for settled (a stop, the process ending, a new
 * runtime): the answer stands, with a note on what was cut off.
 */
async function completeInterruptedClaudeTurn(
  runtime: ActiveClaudeRuntime,
  turn: ActiveClaudeTurn,
  reason: unknown,
): Promise<void> {
  const response = turn.deliveredResponse ?? "";
  const cause = isAgentSessionCanceledError(reason)
    ? "it was stopped"
    : `the run ended early (${errorMessage(reason)})`;
  try {
    await turn.emit(
      processLabels.notice,
      `Claude had answered; ${cause} before the background work it was waiting for finished, so that work was cut off. The answer above stands.`,
      "warning",
    );
    writeFileSync(turn.resultPath, `${response}\n`);
    const fileReferences = (await turn.files?.finish(response)) ?? [];
    await turn.emit("Claude Agent SDK finished", turn.resultPath, undefined, {
      ...turnUsageMetadata(turn.usage, turn.startedAt),
      ...(fileReferences.length > 0 ? { fileReferences } : {}),
    });
  } catch (error) {
    console.error(
      `Could not record the answer of an interrupted Claude turn: ${errorMessage(error)}`,
    );
  } finally {
    if (turn.commandId) runtime.lastInputId = turn.commandId;
    turn.resolve({
      nativeSessionId: turn.nativeSessionId || runtime.nativeSessionId,
      response,
    });
  }
}

/** The live Claude process serving a Foundry session, if any. */
function claudeRuntimeForSession(
  sessionId: string,
): ActiveClaudeRuntime | undefined {
  for (const runtime of activeClaudeRuntimes.values())
    if (runtime.foundrySessionId === sessionId && !runtime.closed)
      return runtime;
  return undefined;
}

/** Whether a session's agent process still runs background work. */
export function sessionHasRunningBackgroundTasks(sessionId: string): boolean {
  return Boolean(claudeRuntimeForSession(sessionId)?.background?.hasRunning());
}

/**
 * Stops one of a session's running background tasks through Claude Code
 * itself (never by process id); Claude reads that it was stopped.
 */
export async function stopClaudeBackgroundTask(
  sessionId: string,
  taskId: string,
): Promise<void> {
  const runtime = claudeRuntimeForSession(sessionId);
  const task = runtime?.background?.record(taskId);
  if (!runtime?.query || task?.status !== "running")
    throw new Error("This background task is not running.");
  if (typeof runtime.query.stopTask !== "function")
    throw new Error(
      "This Claude Code version cannot stop background tasks; update Claude Code on the device.",
    );
  runtime.background?.requestStop(taskId);
  await runtime.query.stopTask(taskId);
}

/**
 * The end of a background task's output. The task's log is the one the
 * device recorded for it, from the live process or the session's records.
 */
export function claudeBackgroundTaskOutput(input: {
  workspacePath: string;
  sessionId: string;
  taskId: string;
  /** Continue an earlier read (its `lineEnd`). */
  after?: number;
}): AgentBackgroundTaskOutput {
  const runtime = claudeRuntimeForSession(input.sessionId);
  const record = runtime?.background?.record(input.taskId);
  return readBackgroundTaskOutput({
    sessionId: input.sessionId,
    taskId: input.taskId,
    record,
    scratchDirectory: record
      ? knownSessionScratchDirectory(input.sessionId)
      : undefined,
    sessionsRoot: executionSessionsRoot(input.workspacePath),
    after: input.after,
  });
}

/**
 * A live background task's log and whether the task still runs, for
 * following it; a task the live process does not run is not followed.
 */
export function claudeBackgroundTaskLog(
  sessionId: string,
  taskId: string,
): FollowedLog {
  const record = claudeRuntimeForSession(sessionId)?.background?.record(taskId);
  if (record?.status !== "running") return { running: false };
  const { path } = backgroundTaskOutputLocation({
    sessionId,
    taskId,
    record,
    scratchDirectory: knownSessionScratchDirectory(sessionId),
  });
  return { path, running: true };
}
