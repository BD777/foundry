import { sessionConnectorEnvironment } from "../../connectors/index.js";
import { privateConfigurationVersion } from "../../harness/agent-runtime/private-identity.js";
import { nativeCli } from "../../harness/native/native-cli.js";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  processLabels,
  type AgentBackgroundTaskOutput,
  type AgentProjection,
  type AgentSession,
  sessionEventLabels,
} from "@bd777/foundry-protocol";
import {
  backgroundTaskOutputLocation,
  readBackgroundTaskOutput,
} from "../tasks/agent-background-tasks.js";
import type { FollowedLog } from "../tasks/background-output-follow.js";
import { personalAgentFilesRevision } from "../personal-agent-files.js";
import { readAgentRuntimeSettings } from "../../device/device.js";
import {
  profileID,
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "../../harness/profiles.js";
import { knownSessionScratchDirectory } from "../../resources/resource-pool.js";
import { redactSecrets } from "../../platform/secret-redaction.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import {
  clearSessionControl,
  isAgentSessionCanceledError,
} from "../session-control.js";
import {
  activeClaudeRuntimes,
  activeCodexThreads,
  reportClaudeOwnTurn,
  type ActiveClaudeRuntime,
  type ActiveCodexThread,
  type ActiveClaudeTurn,
  type ClaudeRuntimeLaunch,
} from "../session-state.js";
import { sessionTimers } from "../tasks/session-timers.js";
import type { SessionGoalAction } from "../goals.js";
import {
  addTurnUsage,
  emitTurnUsage,
  requestTurnUsage,
  turnUsageMetadata,
  type TurnOutcome,
} from "../usage/turn-usage.js";
import { errorMessage } from "../../platform/utils.js";

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
  const processEnv = options.env as NodeJS.ProcessEnv | undefined;
  if (processEnv)
    stableOptions.configurationHome =
      provider === "claude"
        ? processEnv.CLAUDE_CONFIG_DIR
        : processEnv.CODEX_HOME;
  delete stableOptions.env;
  // Native processes cannot acquire newly granted connector variables after
  // launch. Gateway endpoints also live for one turn: resume the same native
  // conversation in a new process whenever its connector environment changes.
  // Only a digest enters runtime identity; handles never enter logs or config.
  stableOptions.connectorEnvironment = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(sessionConnectorEnvironment(session.id)).sort(
          ([a], [b]) => a.localeCompare(b),
        ),
      ),
    )
    .digest("hex");
  // New instructions for the person's assistant start a runtime that reads them.
  stableOptions.personalAgentFiles = personalAgentFilesRevision(session.id);
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
  // Where a context window was learned (an endpoint's catalog, the official
  // table, a default) is a report, not process configuration: a catalog read
  // that fails once must not make the same window a different process.
  const window = profile.contextWindow;
  const identity = JSON.stringify({
    configurationVersion: privateConfigurationVersion({
      options: stableOptions,
      profile: window
        ? {
            ...profile,
            contextWindow: { model: window.model, tokens: window.tokens },
          }
        : profile,
      runtimeEnvironment,
    }),
    runtimeGeneration: nativeCli(provider).generation,
    profileId: profileID(profile),
    provider,
    threadId: session.id,
    workspaceId: session.workspaceId,
    workspacePath,
  });
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Forgets idle Codex threads. One whose app-server still works on its own
 * (a turn, a goal, background terminals, queued inputs) is kept, as a busy
 * Claude runtime is: forgetting it would leave its process unowned.
 */
export function cleanupActiveCodexThreads(): void {
  const now = Date.now();
  const settings = readAgentRuntimeSettings();
  for (const [key, runtime] of activeCodexThreads) {
    if (
      now - runtime.lastUsed > settings.activeRuntimeTtlMs &&
      !runtime.thread.isBusy?.()
    ) {
      activeCodexThreads.delete(key);
      void runtime.thread.close?.().catch(() => undefined);
    }
  }
}

/**
 * Pauses, resumes or clears the goal of the session's Codex thread, the one
 * it last ran on. The thread stays in memory for activeRuntimeTtlMs after
 * its last turn (longer while Codex works on its own); after that the
 * session's next message opens it again.
 */
export async function controlCodexGoal(
  sessionId: string,
  action: SessionGoalAction,
): Promise<void> {
  const entry = [...activeCodexThreads.values()]
    .filter((candidate) => candidate.sessionId === sessionId)
    .sort((left, right) => right.lastUsed - left.lastUsed)[0];
  if (!entry?.thread.controlGoal)
    throw new Error(
      "Codex's thread for this chat is not open on its device now. Send the chat a message, then try again.",
    );
  await entry.thread.controlGoal(action);
}

/**
 * The thread whose app-server still works on `nativeSessionId` between
 * turns. A turn whose runtime key no longer matches it runs on it rather
 * than starting a second writer, which would end that work (DEV-072).
 */
export function busyCodexWriter(
  nativeSessionId: string,
): ActiveCodexThread | undefined {
  if (!nativeSessionId) return undefined;
  return [...activeCodexThreads.values()].find(
    (entry) =>
      entry.nativeSessionId === nativeSessionId && entry.thread.isBusy?.(),
  );
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

/** What a turn's process is started with, from its options and profile. */
export function claudeRuntimeLaunch(
  profile: AgentProfileLocalConfig,
  options: Record<string, unknown>,
): ClaudeRuntimeLaunch {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    profileId: profileID(profile),
    model: text(options.model),
    effort: text(options.effort),
    permissionMode: text(options.permissionMode),
  };
}

/** The person's choices a process started with `from` would not apply. */
export function claudeLaunchChanges(
  from: ClaudeRuntimeLaunch | undefined,
  to: ClaudeRuntimeLaunch,
): string[] {
  if (!from) return [];
  const changes: string[] = [];
  const name = (value: string) => value || "default";
  for (const [field, label] of [
    ["model", "model"],
    ["effort", "effort"],
    ["permissionMode", "permission mode"],
  ] as const)
    if (from[field] !== to[field])
      changes.push(`${label} ${name(from[field])} → ${name(to[field])}`);
  return changes;
}

/**
 * The process that still writes `nativeSessionId` with work of its own
 * (background tasks, timers, a turn Claude continues by itself) and no
 * Foundry turn open. A turn whose runtime key no longer matches it runs on
 * it rather than failing: closing it would end that work (DEV-072).
 */
export function busyClaudeWriter(
  nativeSessionId: string,
): ActiveClaudeRuntime | undefined {
  if (!nativeSessionId) return undefined;
  return [...activeClaudeRuntimes.values()].find(
    (runtime) =>
      runtime.nativeSessionId === nativeSessionId &&
      runtime.pending === undefined &&
      claudeRuntimeIsBusy(runtime),
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

/** Idle cached agents must expire even when no next chat arrives. */
export function startIdleRuntimeSweeps(): () => void {
  const timer = setInterval(() => {
    cleanupActiveClaudeRuntimes();
    cleanupActiveCodexThreads();
  }, 30_000);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Close this execution owner’s runtimes and clear its controls on shutdown
 * or an idle upgrade. A normal Worker/server connection replacement does
 * not call this on the independent execution owner.
 */
export function closeAllActiveRuntimes(): void {
  const disconnectError = new Error("WebSocket disconnected");
  for (const runtime of activeClaudeRuntimes.values())
    closeActiveClaudeRuntime(runtime, disconnectError);
  for (const [key, runtime] of activeCodexThreads) {
    // An app-server kept between turns closes here; one inside a turn
    // closes when that turn ends.
    void runtime.thread.close?.().catch(() => undefined);
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
  options: { protectActiveWork?: boolean } = {},
): void {
  const others = [...activeClaudeRuntimes.values()].filter(
    (other) =>
      other !== keep &&
      ((sessionId && other.foundrySessionId === sessionId) ||
        (nativeSessionId && other.nativeSessionId === nativeSessionId)),
  );
  if (options.protectActiveWork && others.some(claudeRuntimeIsBusy))
    throw new Error(
      "Another Claude process of this session is still working (a turn or background work), so a new one cannot take over its native session yet. Wait for that work to finish, or stop its background tasks, then send the message again.",
    );
  for (const other of others)
    closeActiveClaudeRuntime(
      other,
      new Error(
        "A newer Claude process took over this session's native session.",
      ),
    );
}

export function closeActiveClaudeRuntime(
  runtime: ActiveClaudeRuntime,
  reason: unknown = new Error(
    "Claude active runtime closed before the turn completed.",
  ),
): void {
  runtime.closed = true;
  runtime.foundryToolsSupervisor?.close();
  runtime.foundryToolsSupervisor = undefined;
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
  runtime.questions?.close();
  runtime.continuation = undefined;
  reportClaudeOwnTurn(runtime);
  if (turn) {
    turn.liveness.close();
    if (turn.deliveredResponse === undefined) {
      const outcome: TurnOutcome = isAgentSessionCanceledError(reason)
        ? "canceled"
        : "failed";
      void reportClaudeTurnUsage(turn, outcome);
    }
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
  void runtime.releasePreparation?.().catch(() => undefined);
}

/** Records a failed or canceled Claude turn's usage without changing how it ends. */
export async function reportClaudeTurnUsage(
  turn: ActiveClaudeTurn,
  outcome: Exclude<TurnOutcome, "completed">,
): Promise<void> {
  if (turn.usageOutcomeReported) return;
  const request = turn.requestUsage?.flush();
  if (request) turn.usage = addTurnUsage(turn.usage, requestTurnUsage(request));
  if (!turn.usage) return;
  turn.usageOutcomeReported = true;
  await emitTurnUsage(turn.emit, turn.usage, turn.startedAt, outcome);
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
    await turn.emit(
      sessionEventLabels.claudeTurnEnd,
      turn.resultPath,
      undefined,
      {
        ...turnUsageMetadata(
          turn.usage,
          turn.startedAt,
          isAgentSessionCanceledError(reason) ? "canceled" : "failed",
        ),
        ...(fileReferences.length > 0 ? { fileReferences } : {}),
      },
    );
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

/**
 * Whether a live Claude process of this worker runs the subagent. One that
 * ended (closed, crashed, replaced, or gone with an earlier worker) took its
 * subagents along, whether or not they reported their end.
 */
export function claudeProcessRunsSubagent(taskId: string): boolean {
  for (const runtime of activeClaudeRuntimes.values())
    if (!runtime.closed && runtime.background?.runsSubagent(taskId))
      return true;
  return false;
}

/**
 * The sessions whose agents work on their own now, outside any Foundry turn
 * or after it: a Claude process with background tasks, timers or a turn it
 * continues by itself; a kept Codex app-server with a goal, background
 * terminals or queued input. Their connector environment stays (see
 * holdUntilNativeWorkEnds) and the worker claims them to the server, which
 * keeps their connector grants live meanwhile (DEV-155).
 */
export function sessionsWithNativeWork(): string[] {
  const sessions = new Set<string>();
  for (const runtime of activeClaudeRuntimes.values())
    if (
      runtime.foundrySessionId &&
      !runtime.closed &&
      (runtime.continuation !== undefined || claudeRuntimeHasLiveWork(runtime))
    )
      sessions.add(runtime.foundrySessionId);
  for (const entry of activeCodexThreads.values())
    if (entry.sessionId && entry.thread.isBusy?.())
      sessions.add(entry.sessionId);
  return [...sessions].sort();
}

export function sessionHasNativeWork(sessionId: string): boolean {
  return sessionsWithNativeWork().includes(sessionId);
}

/**
 * How long a session without native work keeps what its run set up: the
 * moment between a background task's end and the turn Claude starts on its
 * notification, and a Codex goal's next round.
 */
export const nativeWorkGraceMs = 30_000;
const nativeWorkSweepMs = 5_000;

interface NativeWorkHold {
  sessionId: string;
  release: () => void;
  idleSince?: number;
}

const nativeWorkHolds = new Set<NativeWorkHold>();
let nativeWorkSweep: NodeJS.Timeout | undefined;

/**
 * Runs `release` (what a run set up for its session's processes: connector
 * profiles and forwarders, the tool folder) once the session's agent no
 * longer works on its own; at once when it does not now. Processes the
 * agent started during the run (a background command, a turn it starts on
 * a task's notification or a timer) were started with that environment and
 * keep using it after the run.
 */
export function holdUntilNativeWorkEnds(
  sessionId: string,
  release: () => void,
): void {
  if (!sessionId || !sessionHasNativeWork(sessionId)) {
    release();
    return;
  }
  nativeWorkHolds.add({ sessionId, release });
  nativeWorkSweep ??= setInterval(
    () => sweepNativeWorkHolds(),
    nativeWorkSweepMs,
  );
  nativeWorkSweep.unref();
}

/** Releases the holds whose sessions have had no native work for a while. */
export function sweepNativeWorkHolds(
  now = Date.now(),
  graceMs = nativeWorkGraceMs,
): void {
  const working = new Set(sessionsWithNativeWork());
  for (const hold of nativeWorkHolds) {
    if (working.has(hold.sessionId)) {
      hold.idleSince = undefined;
      continue;
    }
    hold.idleSince ??= now;
    if (now - hold.idleSince < graceMs) continue;
    nativeWorkHolds.delete(hold);
    try {
      hold.release();
    } catch (error) {
      console.error(
        `Could not release session ${hold.sessionId}'s run environment: ${errorMessage(error)}`,
      );
    }
  }
  if (nativeWorkHolds.size === 0 && nativeWorkSweep) {
    clearInterval(nativeWorkSweep);
    nativeWorkSweep = undefined;
  }
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
