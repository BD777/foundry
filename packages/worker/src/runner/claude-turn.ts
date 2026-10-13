import { appendFileSync, writeFileSync } from "node:fs";
import { randomUUID, type UUID } from "node:crypto";
import { resolve } from "node:path";
import {
  claudeProcessStartedLabel,
  processLabels,
  type AgentSession,
  type ChatAttachment,
} from "@bd777/foundry-protocol";
import { ClaudeBackgroundTaskTracker } from "../agent-background-tasks.js";
import { claudeAgentSpawn } from "../agent-processes.js";
import { ClaudeTimerTracker } from "../agent-timers.js";
import { ClaudeContextTracker } from "../context-usage.js";
import {
  runOnNativeSession,
  type NativeSessionStart,
} from "../native-session.js";
import { officialSkills, refreshOfficialSkills } from "../official-skills.js";
import {
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "../profiles.js";
import { knownSessionScratchDirectory } from "../resource-pool.js";
import { ClaudeAgentTurnError } from "../sdk-messages.js";
import { redactSecrets } from "../secret-redaction.js";
import { sessionEnvironment, withoutSessionToken } from "../session-ambient.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import {
  AgentSessionCanceledError,
  registerActiveSessionCancelTarget,
  registerActiveSessionSteerTarget,
} from "../session-control.js";
import {
  claudeFileWriteHooks,
  mergeClaudeHooks,
  SessionTurnFiles,
} from "../session-files.js";
import {
  buildClaudeLaunchPlan,
  claudeSessionOptions,
  claudeSettingsFile,
  validateClaudeLaunch,
  type ClaudeLaunchPlan,
} from "../session-policy.js";
import { sessionPrompt, userMessageText } from "../session-prompt.js";
import {
  activeClaudeRuntimes,
  AsyncInputQueue,
  type ActiveClaudeTurn,
  type AgentSessionRunResult,
  type ClaudeSDKQuery,
  type SessionEventEmitter,
} from "../session-state.js";
import { sessionTimers } from "../session-timers.js";
import {
  claudeManagedPrompt,
  validateWorkspaceSkillPrompt,
} from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { ClaudeRequestUsageTracker } from "../turn-usage.js";
import { isUtilitySession } from "../session-roles.js";
import { resolveClaudeCommand } from "../native-cli.js";
import {
  ClaudeTurnLiveness,
  claudeOperationBounds,
  livenessDuration,
  turnLivenessNoticeText,
  turnLivenessSettings,
  type TurnLivenessFailure,
  type TurnLivenessNotice,
} from "../watchdog.js";
import {
  activeRuntimeKey,
  claudeRuntimeHasLiveWork,
  cleanupActiveClaudeRuntimes,
  closeActiveClaudeRuntime,
  closeOtherClaudeWriters,
  logClaudeRuntime,
} from "./active-runtimes.js";
import {
  claudeEffort,
  claudeMaxTurns,
  claudePermissionMode,
  claudeRootBypassRefusal,
} from "./claude-options.js";
import {
  claudeWriteFiles,
  emitForClaudeRuntime,
  startActiveClaudePump,
} from "./claude-messages.js";
import {
  refreshClaudeFoundryTools,
  startClaudeFoundryTools,
} from "./foundry-tools.js";
import { runProfileCommandSession } from "./profile-command.js";
import { prepareTurnDirectory } from "./turn-directory.js";

export async function runClaudeWorkspaceSession(
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  // Claude Code's own skills stay available under workspace isolation; they
  // are read once per installed version.
  if (managedSkills && !managedSkills.officialSkills) {
    if (!officialSkills("claude")) await refreshOfficialSkills(["claude"]);
    managedSkills = {
      ...managedSkills,
      officialSkills: officialSkills("claude") ?? [],
    };
  }
  // Fail-closed validation (managed skills reject custom commands and
  // unconfigured invocations) before any directory or process work happens.
  validateClaudeLaunch({ session, profile, managedSkills });
  const sessionDir = await prepareTurnDirectory(workspacePath, session);
  if (profile.command?.trim()) {
    await emitSetup();
    return runProfileCommandSession(
      workspacePath,
      session,
      sessionDir,
      profile,
      emit,
    );
  }
  const refusal = claudeRootBypassRefusal(
    claudePermissionMode(session, profile),
  );
  if (refusal) throw new ClaudeAgentTurnError("root_bypass", refusal);
  return runOnNativeSession(
    {
      provider: "claude",
      session,
      workspacePath,
      env: withoutSessionToken(
        sessionEnvironment(workspacePath, profile, session),
      ),
      isolated: Boolean(managedSkills),
      emit: (label, detail, level) => emit(label, detail, level),
      reportNativeSessionId,
    },
    async (prepared, start, report) => {
      const plan = buildClaudeLaunchPlan({
        workspacePath,
        session: prepared,
        profile,
        managedSkills,
      });
      for (const warning of plan.warnings) {
        await emit("Connection credential missing", warning, "warning");
      }
      return runClaudeAgentSdkSession(
        workspacePath,
        prepared,
        sessionDir,
        profile,
        emit,
        emitSetup,
        report,
        managedSkills,
        plan,
        start,
      );
    },
  );
}

/**
 * Why a start-up or ceiling bound failed a turn. Quiet never does: see
 * watchdog.ts.
 */
export function claudeTurnLivenessError(
  failure: TurnLivenessFailure,
  stderrTail = "",
): Error {
  const tail = stderrTail.trim()
    ? ` Claude Code's last output: ${redactSecrets(stderrTail.trim()).slice(-1200)}`
    : "";
  if (failure.kind === "ceiling")
    return new ClaudeAgentTurnError(
      "turn_ceiling",
      `The turn ran for ${livenessDuration(failure.elapsedMs)}, Foundry's ceiling for one turn (FOUNDRY_TURN_MAX_DURATION_MS), and was stopped.`,
    );
  if (failure.phase === "spawn")
    return new ClaudeAgentTurnError(
      "startup_timeout",
      `Claude Code did not start: its process sent nothing within ${livenessDuration(failure.waitedMs)} of launch (phase: starting the process).${tail}`,
    );
  return new ClaudeAgentTurnError(
    "startup_timeout",
    `Claude Code started but never reached the model within ${livenessDuration(failure.waitedMs)} of launch (phase: sign-in or first response).${tail}`,
  );
}

/** A liveness notice, on the turn's transcript. */
export function claudeTurnLivenessNotice(
  turn: Pick<ActiveClaudeTurn, "emit">,
  notice: TurnLivenessNotice,
): void {
  void turn.emit(
    processLabels.notice,
    turnLivenessNoticeText(notice),
    "warning",
  );
}

/**
 * Sessions judged on their answer keep their turn until background work
 * settles: an Issue's execution is verified on it (and a sandboxed run's
 * process ends with the turn), and an agent that created a session waits for
 * its answer. A person's chat ends its turn with Claude's answer.
 */
export function waitsForBackgroundWork(session: AgentSession): boolean {
  return (
    Boolean(session.issueId?.trim()) ||
    Boolean(session.role) ||
    (session.source !== undefined && session.source !== "chat")
  );
}

export async function runClaudeAgentSdkSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
  plan?: ClaudeLaunchPlan,
  start?: NativeSessionStart,
): Promise<AgentSessionRunResult> {
  const startedAt = Date.now();
  const packageName = "@anthropic-ai/claude-agent-sdk";
  const command = resolveClaudeCommand();
  const messagesPath = resolve(sessionDir, "claude-sdk.messages.jsonl");
  const stderrPath = resolve(sessionDir, "claude-sdk.stderr.log");
  const resultPath = resolve(sessionDir, "result.md");
  const prompt =
    plan?.prompt ??
    claudeManagedPrompt(sessionPrompt(session, profile), managedSkills);
  const env =
    plan?.env ??
    withoutSessionToken(sessionEnvironment(workspacePath, profile, session));
  const sdk = (await import(packageName)) as {
    query?: (input: {
      options?: Record<string, unknown>;
      prompt: string | AsyncIterable<unknown>;
    }) => AsyncIterable<unknown>;
  };
  if (typeof sdk.query !== "function") {
    throw new Error(`${packageName} does not export query()`);
  }
  const query = sdk.query;
  const model = session.model?.trim() || profile.model?.trim();
  const effort = claudeEffort(session, profile);
  const permissionMode = claudePermissionMode(session, profile);
  const maxTurns = claudeMaxTurns(session);
  // Claude Code applies ~/.claude/settings.json's `env` block ON TOP of the
  // spawned process environment, so a pinned gateway/base URL/model in that
  // file would otherwise silently override the Foundry-selected profile — the
  // session would show one profile but call another provider. The SDK
  // `settings` option is the flag-settings layer, the highest-priority
  // user-controlled tier; mirroring the profile runtime env there makes the
  // chosen profile authoritative (empty values clear a local override).
  // autoCompactEnabled is pinned here too: a user-level disable otherwise
  // turns a resumed long session into a hard "Prompt is too long" failure.
  const runtimeEnv = profileRuntimeEnvironment(profile, session);
  const flagSettings = plan?.settings ?? {
    env: runtimeEnv,
    autoCompactEnabled: true,
  };
  const baseOptions: Record<string, unknown> = {
    additionalDirectories: [workspacePath],
    cwd: workspacePath,
    env: {
      ...env,
      CLAUDE_AGENT_SDK_CLIENT_APP: "foundry-worker",
    },
    forwardSubagentText: true,
    includePartialMessages: true,
    pathToClaudeCodeExecutable: command,
    permissionMode,
    settings: claudeSettingsFile(session.id || workspacePath, flagSettings),
    tools: { type: "preset", preset: "claude_code" },
    ...(plan?.sdk ?? claudeSessionOptions(managedSkills)),
  };
  if (maxTurns !== undefined) {
    baseOptions.maxTurns = maxTurns;
  }
  if (model) {
    baseOptions.model = model;
  }
  if (effort) {
    baseOptions.effort = effort;
  }
  if (permissionMode === "bypassPermissions") {
    baseOptions.allowDangerouslySkipPermissions = true;
  }
  if (isUtilitySession(session)) {
    baseOptions.disallowedTools = ["Write", "Edit", "Bash"];
  }
  if (session.source === "naming") baseOptions.tools = [];

  const runtimeKey = activeRuntimeKey(
    "claude",
    workspacePath,
    session,
    profile,
    baseOptions,
  );
  const requestedNativeSessionId = session.nativeSessionId?.trim() ?? "";
  // A fork's native session exists once Claude reports it.
  if (start?.kind !== "fork") reportNativeSessionId(requestedNativeSessionId);

  try {
    cleanupActiveClaudeRuntimes();
    let runtime = activeClaudeRuntimes.get(runtimeKey);
    let runtimeStartOptions: Record<string, unknown> | undefined;
    // A runtime in memory continues only the native session it holds.
    const canReuseRuntime =
      runtime &&
      !runtime.closed &&
      (!runtime.nativeSessionId ||
        runtime.nativeSessionId === requestedNativeSessionId);
    if (runtime && !canReuseRuntime) closeActiveClaudeRuntime(runtime);
    closeOtherClaudeWriters(
      session.id,
      requestedNativeSessionId,
      canReuseRuntime ? runtime : undefined,
    );
    if (!canReuseRuntime) {
      const options = { ...baseOptions };
      if (start?.kind === "fork") {
        // The SDK copies the source into the id the server already claimed.
        options.resume = start.from;
        options.forkSession = true;
        options.sessionId = start.nativeSessionId;
      } else if (requestedNativeSessionId) {
        options.resume = requestedNativeSessionId;
      }
      runtime = {
        closed: false,
        foundrySessionId: session.id,
        input: new AsyncInputQueue<unknown>(),
        key: runtimeKey,
        lastUsed: Date.now(),
        nativeSessionId: requestedNativeSessionId,
        workspacePath,
      };
      const owner = runtime;
      // Timer and background-work observation hooks must live for the whole
      // process lifetime; they are installed once, when the SDK query stream
      // is created. Their events go to the turn the runtime serves, or out of
      // band between turns.
      // A resumed session's timers come back with it; the device kept them.
      runtime.timers = new ClaudeTimerTracker(
        {
          emit: (event) => emitForClaudeRuntime(owner, event),
          isActiveTurn: () => owner.pending !== undefined,
          sessionId: () => owner.foundrySessionId,
          timersChanged: (tasks) =>
            sessionTimers.record(
              owner.foundrySessionId,
              owner.nativeSessionId,
              tasks,
            ),
          timerTurnStarting: () => refreshClaudeFoundryTools(owner),
        },
        sessionTimers.attach(session.id, requestedNativeSessionId, owner),
      );
      runtime.background = new ClaudeBackgroundTaskTracker({
        emit: (event) => emitForClaudeRuntime(owner, event),
        sessionId: () => owner.foundrySessionId,
        sessionsRoot: () => executionSessionsRoot(workspacePath),
        scratchDirectory: () =>
          knownSessionScratchDirectory(owner.foundrySessionId),
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
          (write) => claudeWriteFiles(owner)?.recordToolWrite(write),
          (write) => claudeWriteFiles(owner)?.captureBeforeWrite(write),
        ),
      );
      // A start-up failure names what the process last said.
      const onStderr = (data: string) => {
        owner.stderrTail = `${owner.stderrTail ?? ""}${data}`.slice(-4000);
        try {
          appendFileSync(stderrPath, data);
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
          owner.pid = child.pid;
          logClaudeRuntime("process started", owner);
          return child;
        };
      activeClaudeRuntimes.set(runtimeKey, runtime);
      logClaudeRuntime("starting", runtime);
      await emitSetup();
      await emit(claudeProcessStartedLabel, `${packageName} · ${command}`);
      runtimeStartOptions = options;
    } else {
      const reusableRuntime = runtime;
      if (!reusableRuntime) {
        throw new Error("Claude active runtime was not initialized");
      }
      reusableRuntime.lastUsed = Date.now();
      // The long-lived thread may serve continued Foundry sessions; timer
      // events between turns belong to the session currently attached.
      if (reusableRuntime.foundrySessionId !== session.id)
        sessionTimers.detach(
          reusableRuntime.foundrySessionId,
          reusableRuntime.nativeSessionId,
          [],
          reusableRuntime,
        );
      reusableRuntime.foundrySessionId = session.id;
      sessionTimers.attach(
        session.id,
        reusableRuntime.nativeSessionId,
        reusableRuntime,
      );
      reusableRuntime.background?.attach();
      // Each dispatch mints a new session token: the Foundry tools carry
      // this turn's, which stays valid while the session is active.
      reusableRuntime.mcpServers = plan?.mcpServers ?? {};
      await reusableRuntime.query?.setMcpServers?.(reusableRuntime.mcpServers);
      await emit(
        "Reused active Claude Agent SDK",
        reusableRuntime.nativeSessionId || "in memory",
      );
      runtime = reusableRuntime;
    }
    if (!runtime) {
      throw new Error("Claude active runtime was not initialized");
    }
    const activeRuntime = runtime;
    if (activeRuntime.pending) {
      throw new Error("Claude active runtime already has a pending turn");
    }
    writeFileSync(messagesPath, "");
    writeFileSync(stderrPath, "");
    activeRuntime.messagesPath = messagesPath;
    const files = SessionTurnFiles.forSession(
      workspacePath,
      executionSessionsRoot(workspacePath),
      session,
      emit,
      startedAt,
    );
    return await new Promise<AgentSessionRunResult>(
      (resolveTurn, rejectTurn) => {
        const unregisterSteer = registerActiveSessionSteerTarget(session.id, {
          provider: "claude",
          steer: async (
            message: string,
            attachments: ChatAttachment[] = [],
            steerId?: string,
          ) => {
            if (activeRuntime.pending?.resultPath !== resultPath) {
              throw new Error(
                "Claude is not accepting steer input for this active turn.",
              );
            }
            const text = message.trim();
            if (plan) plan.validatePrompt(text);
            else if (managedSkills)
              validateWorkspaceSkillPrompt(text, managedSkills);
            if (!text && attachments.length === 0) {
              throw new Error("Steer message is required.");
            }
            activeRuntime.input.push({
              message: {
                role: "user",
                content: userMessageText(text, attachments),
              },
              parent_tool_use_id: null,
              priority: "next",
              type: "user",
            });
            await emit(
              "Steered into active turn",
              text,
              "info",
              undefined,
              attachments.length > 0
                ? {
                    id: `steer_${randomUUID()}`,
                    kind: "user",
                    text,
                    attachments,
                  }
                : undefined,
              // Named like a sent message's input event: the server then
              // knows the message is in this session and never sends it
              // again as an input of its own.
              steerId ? `evt_${steerId}` : undefined,
            );
          },
        });
        const unregisterCancel = registerActiveSessionCancelTarget(session.id, {
          provider: "claude",
          cancel: async () => {
            if (activeRuntime.pending?.resultPath !== resultPath) {
              throw new Error(
                "Claude is not accepting cancellation for this active turn.",
              );
            }
            const turn = activeRuntime.pending;
            if (!turn) {
              throw new Error(
                "Claude is not accepting cancellation for this active turn.",
              );
            }
            const answered = turn.deliveredResponse !== undefined;
            closeActiveClaudeRuntime(
              activeRuntime,
              new AgentSessionCanceledError(),
            );
            return { answered };
          },
        });
        const livenessSettings = turnLivenessSettings();
        const settingsEnv = (flagSettings as { env?: unknown }).env;
        // Claude Code's own bounds, from the environment its process gets.
        const operationBounds = claudeOperationBounds({
          ...(baseOptions.env as Record<string, string | undefined>),
          ...(settingsEnv && typeof settingsEnv === "object"
            ? (settingsEnv as Record<string, string | undefined>)
            : {}),
        });
        let turn: ActiveClaudeTurn;
        turn = {
          emit,
          finalResult: "",
          messagesPath,
          nativeSessionId:
            activeRuntime.nativeSessionId || requestedNativeSessionId,
          partialResult: "",
          openTaskIds: new Set<string>(),
          waitForBackgroundTasks: waitsForBackgroundWork(session),
          ...(session.input?.id ? { commandId: session.input.id } : {}),
          behindContinuation: Boolean(activeRuntime.continuation),
          requestUsage: new ClaudeRequestUsageTracker(),
          reject: (error: unknown) => {
            unregisterSteer();
            unregisterCancel();
            rejectTurn(error);
          },
          reportNativeSessionId,
          resolve: (result: AgentSessionRunResult) => {
            unregisterSteer();
            unregisterCancel();
            resolveTurn(result);
          },
          resultPath,
          startedAt,
          files,
          liveness: new ClaudeTurnLiveness(
            {
              ...livenessSettings,
              // Only a process started for this turn has a start-up to bound.
              ...(runtimeStartOptions
                ? {
                    firstResponseTimeoutMs:
                      operationBounds.apiTimeoutMs + livenessSettings.graceMs,
                  }
                : { startupTimeoutMs: undefined }),
              backgroundBusy: () =>
                turn.openTaskIds.size > 0 ||
                claudeRuntimeHasLiveWork(activeRuntime),
              onNotice: (notice) => {
                if (activeRuntime.pending === turn)
                  claudeTurnLivenessNotice(turn, notice);
              },
              onFailure: (failure) => {
                if (activeRuntime.pending !== turn) return;
                closeActiveClaudeRuntime(
                  activeRuntime,
                  claudeTurnLivenessError(failure, activeRuntime.stderrTail),
                );
              },
            },
            operationBounds,
          ),
        };
        activeRuntime.pending = turn;
        const pushPrompt = () =>
          activeRuntime.input.push({
            message: { role: "user", content: prompt },
            parent_tool_use_id: null,
            type: "user",
            // The Foundry input is Claude's user message: one identity.
            ...(session.input ? { uuid: session.input.id as UUID } : {}),
          });
        try {
          if (!runtimeStartOptions) pushPrompt();
          else {
            const started = query({
              prompt: activeRuntime.input,
              options: runtimeStartOptions,
            }) as ClaudeSDKQuery;
            startActiveClaudePump(activeRuntime, started);
            activeRuntime.mcpServers = plan?.mcpServers;
            // The Foundry tools reach a new process over its input stream,
            // before its first turn: in --mcp-config or the environment
            // their token would be readable by every command Claude runs.
            void startClaudeFoundryTools(started, plan?.mcpServers, emit)
              .then(pushPrompt)
              .catch((error) => closeActiveClaudeRuntime(activeRuntime, error));
          }
        } catch (error) {
          closeActiveClaudeRuntime(activeRuntime, error);
        }
      },
    );
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    writeFileSync(stderrPath, `${message}\n`);
    throw error;
  }
}
