import { appendFileSync } from "node:fs";
import type { UUID } from "node:crypto";
import { claudeProcessStartedLabel } from "@bd777/foundry-protocol";
import { ClaudeBackgroundTaskTracker } from "../agent-background-tasks.js";
import { claudeAgentSpawn } from "../agent-processes.js";
import { ClaudeTimerTracker } from "../agent-timers.js";
import { ClaudeContextTracker } from "../context-usage.js";
import { knownSessionScratchDirectory } from "../resource-pool.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import { claudeFileWriteHooks, mergeClaudeHooks } from "../session-files.js";
import {
  activeClaudeRuntimes,
  AsyncInputQueue,
  type ActiveClaudeRuntime,
  type ClaudeSDKQuery,
} from "../session-state.js";
import { sessionTimers } from "../session-timers.js";
import {
  cleanupActiveClaudeRuntimes,
  closeActiveClaudeRuntime,
  closeOtherClaudeWriters,
  logClaudeRuntime,
} from "./active-runtimes.js";
import {
  claudeAgentSdkPackage,
  claudeProcessOptions,
  type ClaudeTurnRun,
} from "./claude-launch.js";
import {
  claudeWriteFiles,
  emitForClaudeRuntime,
  startActiveClaudePump,
} from "./claude-messages.js";
import {
  refreshClaudeFoundryTools,
  startClaudeFoundryTools,
} from "./foundry-tools.js";

export interface AcquiredClaudeRuntime {
  runtime: ActiveClaudeRuntime;
  /** Set when this turn starts the runtime's process with these options. */
  startOptions?: Record<string, unknown>;
}

/** The runtime that serves this turn: the one in memory if it may, else a new one. */
export async function acquireClaudeRuntime(
  run: ClaudeTurnRun,
): Promise<AcquiredClaudeRuntime> {
  cleanupActiveClaudeRuntimes();
  const held = activeClaudeRuntimes.get(run.runtimeKey);
  // A runtime in memory continues only the native session it holds.
  const reusable =
    held &&
    !held.closed &&
    (!held.nativeSessionId ||
      held.nativeSessionId === run.requestedNativeSessionId)
      ? held
      : undefined;
  if (held && !reusable) closeActiveClaudeRuntime(held);
  closeOtherClaudeWriters(
    run.session.id,
    run.requestedNativeSessionId,
    reusable,
  );
  if (reusable) {
    await reuseClaudeRuntime(run, reusable);
    return { runtime: reusable };
  }
  return startClaudeRuntime(run);
}

async function startClaudeRuntime(
  run: ClaudeTurnRun,
): Promise<AcquiredClaudeRuntime> {
  const options = claudeProcessOptions(run);
  const runtime: ActiveClaudeRuntime = {
    closed: false,
    foundrySessionId: run.session.id,
    input: new AsyncInputQueue<unknown>(),
    key: run.runtimeKey,
    lastUsed: Date.now(),
    nativeSessionId: run.requestedNativeSessionId,
    workspacePath: run.workspacePath,
  };
  installClaudeRuntimeObservers(run, runtime, options);
  attachClaudeProcessOutput(run, runtime, options);
  activeClaudeRuntimes.set(run.runtimeKey, runtime);
  logClaudeRuntime("starting", runtime);
  await run.emitSetup();
  await run.emit(
    claudeProcessStartedLabel,
    `${claudeAgentSdkPackage} · ${run.command}`,
  );
  return { runtime, startOptions: options };
}

/**
 * Timer and background-work observation hooks must live for the whole
 * process lifetime; they are installed once, when the SDK query stream is
 * created. Their events go to the turn the runtime serves, or out of band
 * between turns.
 */
function installClaudeRuntimeObservers(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
  options: Record<string, unknown>,
): void {
  // A resumed session's timers come back with it; the device kept them.
  runtime.timers = new ClaudeTimerTracker(
    {
      emit: (event) => emitForClaudeRuntime(runtime, event),
      isActiveTurn: () => runtime.pending !== undefined,
      sessionId: () => runtime.foundrySessionId,
      timersChanged: (tasks) =>
        sessionTimers.record(
          runtime.foundrySessionId,
          runtime.nativeSessionId,
          tasks,
        ),
      timerTurnStarting: () => refreshClaudeFoundryTools(runtime),
    },
    sessionTimers.attach(run.session.id, run.requestedNativeSessionId, runtime),
  );
  runtime.background = new ClaudeBackgroundTaskTracker({
    emit: (event) => emitForClaudeRuntime(runtime, event),
    sessionId: () => runtime.foundrySessionId,
    sessionsRoot: () => executionSessionsRoot(run.workspacePath),
    scratchDirectory: () =>
      knownSessionScratchDirectory(runtime.foundrySessionId),
  });
  runtime.background.attach();
  runtime.context = new ClaudeContextTracker({
    resumed: Boolean(options.resume),
  });
  options.hooks = mergeClaudeHooks(
    runtime.timers.hooks(),
    runtime.background.hooks(),
    // A write belongs to the turn the stream answers, else to the work
    // Claude does between turns.
    claudeFileWriteHooks(
      (write) => claudeWriteFiles(runtime)?.recordToolWrite(write),
      (write) => claudeWriteFiles(runtime)?.captureBeforeWrite(write),
    ),
  );
}

/** Where the process's stderr goes, and how it is spawned. */
function attachClaudeProcessOutput(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
  options: Record<string, unknown>,
): void {
  // A start-up failure names what the process last said.
  const onStderr = (data: string) => {
    runtime.stderrTail = `${runtime.stderrTail ?? ""}${data}`.slice(-4000);
    try {
      appendFileSync(run.stderrPath, data);
    } catch {
      // The tail in memory still serves the failure message.
    }
  };
  options.stderr = onStderr;
  // In the daemon the CLI leads a process group that dies with the
  // worker; the SDK then hands stderr to this spawn, not to the option.
  const spawnAgent = claudeAgentSpawn(onStderr);
  if (spawnAgent)
    options.spawnClaudeCodeProcess = (
      spawnOptions: Parameters<typeof spawnAgent>[0],
    ) => {
      const child = spawnAgent(spawnOptions);
      runtime.pid = child.pid;
      logClaudeRuntime("process started", runtime);
      return child;
    };
}

async function reuseClaudeRuntime(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
): Promise<void> {
  const { session } = run;
  runtime.lastUsed = Date.now();
  // The long-lived thread may serve continued Foundry sessions; timer
  // events between turns belong to the session currently attached.
  if (runtime.foundrySessionId !== session.id)
    sessionTimers.detach(
      runtime.foundrySessionId,
      runtime.nativeSessionId,
      [],
      runtime,
    );
  runtime.foundrySessionId = session.id;
  sessionTimers.attach(session.id, runtime.nativeSessionId, runtime);
  runtime.background?.attach();
  // Each dispatch mints a new session token: the Foundry tools carry
  // this turn's, which stays valid while the session is active.
  runtime.mcpServers = run.plan?.mcpServers ?? {};
  await runtime.query?.setMcpServers?.(runtime.mcpServers);
  await run.emit(
    "Reused active Claude Agent SDK",
    runtime.nativeSessionId || "in memory",
  );
}

/**
 * Hands the turn's prompt to its runtime: straight into a running process's
 * input, or, for a new process, once the query stream and the Foundry tools
 * are up.
 */
export function sendClaudeTurnPrompt(
  run: ClaudeTurnRun,
  runtime: ActiveClaudeRuntime,
  startOptions: Record<string, unknown> | undefined,
): void {
  const { session, plan } = run;
  const pushPrompt = () =>
    runtime.input.push({
      message: { role: "user", content: run.prompt },
      parent_tool_use_id: null,
      type: "user",
      // The Foundry input is Claude's user message: one identity.
      ...(session.input ? { uuid: session.input.id as UUID } : {}),
    });
  try {
    if (!startOptions) {
      pushPrompt();
      return;
    }
    const started = run.query({
      prompt: runtime.input,
      options: startOptions,
    }) as ClaudeSDKQuery;
    startActiveClaudePump(runtime, started);
    runtime.mcpServers = plan?.mcpServers;
    // The Foundry tools reach a new process over its input stream,
    // before its first turn: in --mcp-config or the environment
    // their token would be readable by every command Claude runs.
    void startClaudeFoundryTools(started, plan?.mcpServers, run.emit)
      .then(pushPrompt)
      .catch((error) => closeActiveClaudeRuntime(runtime, error));
  } catch (error) {
    closeActiveClaudeRuntime(runtime, error);
  }
}
