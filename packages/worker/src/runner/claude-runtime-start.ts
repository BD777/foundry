import { nativeCli } from "../native-cli.js";
import { appendFileSync } from "node:fs";
import type { UUID } from "node:crypto";
import {
  claudeProcessStartedLabel,
  processLabels,
} from "@bd777/foundry-protocol";
import { ClaudeBackgroundTaskTracker } from "../agent-background-tasks.js";
import { claudeAgentSpawn } from "../agent-processes.js";
import { ClaudeTimerTracker } from "../agent-timers.js";
import { ClaudeContextTracker } from "../context-usage.js";
import { configuredWindow } from "../context-window.js";
import { knownSessionScratchDirectory } from "../resource-pool.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import { claudeFileWriteHooks, mergeClaudeHooks } from "../session-files.js";
import {
  activeClaudeRuntimes,
  AsyncInputQueue,
  reportClaudeOwnTurn,
  type ActiveClaudeRuntime,
  type ClaudeSDKQuery,
} from "../session-state.js";
import { sessionTimers } from "../session-timers.js";
import {
  workContext,
  observedSessionWork,
  managedWorkEnabled,
  recordWorkToolStarting,
  recordWorkToolCompleted,
} from "../session-work/supervisor.js";
import {
  busyClaudeWriter,
  claudeLaunchChanges,
  claudeRuntimeLaunch,
  cleanupActiveClaudeRuntimes,
  claudeRuntimeIsBusy,
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
  claudeToolsNeedHandOver,
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
  if (held && !reusable) {
    if (claudeRuntimeIsBusy(held))
      throw new Error(
        "The native runtime still has active work; wait before changing its session context.",
      );
    closeActiveClaudeRuntime(held);
  }
  const busy = reusable
    ? undefined
    : busyClaudeWriter(run.requestedNativeSessionId);
  if (busy) return { runtime: await continueOnBusyClaudeRuntime(run, busy) };
  closeOtherClaudeWriters(
    run.session.id,
    run.requestedNativeSessionId,
    reusable,
    { protectActiveWork: true },
  );
  if (reusable) {
    await reuseClaudeRuntime(run, reusable);
    return { runtime: reusable };
  }
  return startClaudeRuntime(run);
}

/**
 * A turn whose runtime key changed while the process holding its native
 * session still runs background work, timers or a turn of its own: the
 * message goes to that process, which keeps its work, and the person is
 * told which of their choices wait for it (DEV-072). The next turn after
 * that work ends starts a process with the new configuration. Another
 * account cannot use the process, so a switch waits for the person.
 */
async function continueOnBusyClaudeRuntime(
  run: ClaudeTurnRun,
  busy: ActiveClaudeRuntime,
): Promise<ActiveClaudeRuntime> {
  const next = claudeRuntimeLaunch(run.profile, run.baseOptions);
  if (busy.launch && busy.launch.profileId !== next.profileId)
    throw new Error(
      "Claude is still running this session's background work on its current account, so it cannot switch accounts yet. Stop the background task, or wait until it finishes, then send the message again.",
    );
  closeOtherClaudeWriters(run.session.id, run.requestedNativeSessionId, busy, {
    protectActiveWork: true,
  });
  await reuseClaudeRuntime(run, busy);
  const changes = claudeLaunchChanges(busy.launch, next);
  const kept =
    "Claude is still running this session's background work, so this message continues in the same Claude process.";
  await run.emit(
    processLabels.notice,
    changes.length
      ? `${kept} Not applied yet: ${changes.join("; ")}. They apply from the first message after that work ends; to apply them now, stop the background task and send again.`
      : `${kept} The session's updated setup applies from the first message after that work ends.`,
    changes.length ? "warning" : "info",
  );
  logClaudeRuntime(
    "kept for its own work",
    busy,
    `turn key ${run.runtimeKey.slice(0, 12)}`,
  );
  return busy;
}

async function startClaudeRuntime(
  run: ClaudeTurnRun,
): Promise<AcquiredClaudeRuntime> {
  const options = claudeProcessOptions(run);
  const runtime: ActiveClaudeRuntime = {
    releasePreparation: run.plan?.execution?.retain(),
    closed: false,
    foundrySessionId: run.session.id,
    input: new AsyncInputQueue<unknown>(),
    key: run.runtimeKey,
    launch: claudeRuntimeLaunch(run.profile, options),
    lastUsed: Date.now(),
    nativeSessionId: run.requestedNativeSessionId,
    workspacePath: run.workspacePath,
  };
  installClaudeRuntimeObservers(run, runtime, options);
  attachClaudeProcessOutput(run, runtime, options);
  activeClaudeRuntimes.set(run.runtimeKey, runtime);
  logClaudeRuntime("starting", runtime);
  try {
    await run.emitSetup();
    await run.emit(
      claudeProcessStartedLabel,
      `${claudeAgentSdkPackage} · ${run.command}`,
    );
    return { runtime, startOptions: options };
  } catch (error) {
    closeActiveClaudeRuntime(runtime, error);
    throw error;
  }
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
      timersObserved: (tasks) =>
        observedSessionWork()?.observeTimers(
          runtime.foundrySessionId,
          tasks,
          nativeCli("claude").version || "unknown",
          runtime.nativeSessionId,
        ),
      timerTurnStarting: async () => {
        reportClaudeOwnTurn(runtime);
        await refreshClaudeFoundryTools(runtime);
      },
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
    configured: configuredWindow(run.profile.contextWindow),
  });
  options.hooks = mergeClaudeHooks(
    {
      UserPromptSubmit: [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: {
                hookEventName: "UserPromptSubmit",
                additionalContext: workContext(runtime.foundrySessionId),
              },
            }),
          ],
        },
      ],
      PreToolUse: [
        {
          hooks: [
            async (input: unknown) => {
              const tool = (input as { tool_name?: string }).tool_name;
              if (tool === "Bash")
                recordWorkToolStarting(
                  runtime.foundrySessionId,
                  (input as { tool_use_id?: string }).tool_use_id || "",
                );
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: workContext(runtime.foundrySessionId),
                },
              };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          hooks: [
            async (input: unknown) => {
              recordWorkToolCompleted(
                (input as { tool_use_id?: string }).tool_use_id || "",
              );
              return {
                hookSpecificOutput: {
                  hookEventName: "PostToolUse",
                  additionalContext: workContext(runtime.foundrySessionId),
                },
              };
            },
          ],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [
            async (input: unknown) => {
              recordWorkToolCompleted(
                (input as { tool_use_id?: string }).tool_use_id || "",
              );
              return undefined;
            },
          ],
        },
      ],
      PostCompact: [
        {
          hooks: [
            async () => {
              if (managedWorkEnabled())
                runtime.input.push({
                  type: "user",
                  message: {
                    role: "user",
                    content: workContext(runtime.foundrySessionId),
                  },
                  parent_tool_use_id: null,
                  isSynthetic: true,
                  shouldQuery: false,
                });
              return undefined;
            },
          ],
        },
      ],
    },
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
      const releasePreparation = runtime.releasePreparation;
      runtime.releasePreparation = undefined;
      child.once("close", () => {
        void releasePreparation?.().catch(() => undefined);
      });
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
  const servers = run.plan?.mcpServers ?? {};
  const handOver = claudeToolsNeedHandOver(runtime, session.id, servers);
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
  // Each dispatch mints a new session token; the process keeps the one it
  // holds while that still works for this session (claudeToolsNeedHandOver).
  if (handOver) {
    runtime.mcpServers = servers;
    runtime.mcpServersAt = Date.now();
    await runtime.query?.setMcpServers?.(servers);
  }
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
    runtime.mcpServersAt = Date.now();
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
