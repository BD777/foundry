import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { processLabels, type AgentSession } from "@bd777/foundry-protocol";
import { codexAgentExecutable } from "../agent-processes.js";
import { CodexContextFollower, codexHome } from "../context-usage.js";
import { runOnNativeSession } from "../native-session.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import {
  sdkMessageText,
  sdkProcessEvent,
  sdkResponseMessage,
} from "../sdk-messages.js";
import { executionSessionsRoot } from "../session-artifacts.js";
import {
  AgentSessionCanceledError,
  isAgentSessionCanceledError,
  registerActiveSessionCancelTarget,
} from "../session-control.js";
import { codexFileWrites, SessionTurnFiles } from "../session-files.js";
import {
  codexFoundryTools,
  codexSessionSecretsConfig,
  sessionDeviceNotes,
} from "../session-policy.js";
import { currentInput, sessionPrompt } from "../session-prompt.js";
import { codexRoleOptions, isUtilitySession } from "../session-roles.js";
import {
  activeCodexThreads,
  type AgentSessionRunResult,
  type CodexSDKThread,
  type SessionEventEmitter,
} from "../session-state.js";
import {
  prepareCodexSkillIsolation,
  validateWorkspaceSkillPrompt,
} from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import {
  codexTurnUsage,
  turnUsageMetadata,
  type TurnTokenUsage,
} from "../turn-usage.js";
import { resolveCodexCommand } from "../native-cli.js";
import {
  CodexTurnLiveness,
  livenessDuration,
  turnLivenessNoticeText,
  turnLivenessSettings,
} from "../watchdog.js";
import {
  activeRuntimeKey,
  cleanupActiveCodexThreads,
} from "./active-runtimes.js";
import {
  codexApprovalPolicy,
  codexProfileConfig,
  codexReasoningEffort,
  codexSandboxMode,
  codexSessionConfig,
  codexSessionEnvironment,
  codexSessionInput,
  codexSpeed,
} from "./codex-options.js";
import { runProfileCommandSession } from "./profile-command.js";
import { prepareTurnDirectory } from "./turn-directory.js";

export async function runCodexWorkspaceSession(
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  if (managedSkills) {
    validateWorkspaceSkillPrompt(currentInput(session).prompt, managedSkills);
    if (profile.command?.trim())
      throw new Error(
        "Custom runtime commands cannot enforce workspace skill isolation.",
      );
  }
  return runOnNativeSession(
    {
      provider: "codex",
      session,
      workspacePath,
      env: codexSessionEnvironment(workspacePath, profile, session),
      isolated: Boolean(managedSkills),
      emit: (label, detail, level) => emit(label, detail, level),
      reportNativeSessionId,
    },
    (prepared, _start, report) =>
      runCodexTurn(
        workspacePath,
        prepared,
        profile,
        emit,
        emitSetup,
        report,
        managedSkills,
      ),
  );
}

/** One Codex turn on the native thread the session was prepared with. */
async function runCodexTurn(
  workspacePath: string,
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  emitSetup: () => Promise<void>,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  const startedAt = Date.now();
  if (managedSkills) {
    managedSkills = await prepareCodexSkillIsolation(
      managedSkills,
      workspacePath,
      codexSessionEnvironment(workspacePath, profile, session),
    );
  }
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
  const files = SessionTurnFiles.forSession(
    workspacePath,
    executionSessionsRoot(workspacePath),
    session,
    emit,
    startedAt,
  );
  const eventsPath = resolve(sessionDir, "codex-sdk.events.jsonl");
  const stderrPath = resolve(sessionDir, "codex-sdk.stderr.log");
  const resultPath = resolve(sessionDir, "result.md");
  const packageName = "@openai/codex-sdk";
  let finalResult = "";
  let usage: TurnTokenUsage | undefined;

  try {
    const sdk = (await import(packageName)) as {
      Codex?: new (options?: Record<string, unknown>) => {
        startThread: (options?: Record<string, unknown>) => CodexSDKThread;
        resumeThread: (
          id: string,
          options?: Record<string, unknown>,
        ) => CodexSDKThread;
      };
    };
    if (typeof sdk.Codex !== "function") {
      throw new Error(`${packageName} does not export Codex`);
    }

    writeFileSync(eventsPath, "");
    writeFileSync(stderrPath, "");
    const codexCommand = resolveCodexCommand();
    // In the daemon the CLI leads a process group that dies with the worker.
    const codexPathOverride = codexAgentExecutable(codexCommand);
    const deviceNotes = sessionDeviceNotes(
      workspacePath,
      session,
      codexSessionEnvironment(workspacePath, profile, session).TMPDIR,
    );
    const role = codexRoleOptions(session);
    const threadOptions = {
      approvalPolicy: codexApprovalPolicy(session, profile),
      model: session.model?.trim() || profile.model?.trim() || undefined,
      modelReasoningEffort: codexReasoningEffort(session, profile),
      modelSpeed: codexSpeed(session, profile),
      sandboxMode: codexSandboxMode(session, profile),
      skipGitRepoCheck: true,
      workingDirectory: workspacePath,
      ...role?.thread,
    };
    const requestedNativeSessionId = session.nativeSessionId?.trim();
    cleanupActiveCodexThreads();
    const runtimeKey = activeRuntimeKey(
      "codex",
      workspacePath,
      session,
      profile,
      { ...threadOptions, ...codexSessionConfig(managedSkills, deviceNotes) },
    );
    const activeThread = activeCodexThreads.get(runtimeKey);
    let thread: CodexSDKThread;
    // This turn's thread: what the turn learns updates it, never a newer
    // thread that took the key meanwhile.
    let threadEntry = activeThread;
    // A thread in memory continues only the native session it holds.
    if (
      activeThread &&
      (!activeThread.nativeSessionId ||
        activeThread.nativeSessionId === (requestedNativeSessionId ?? ""))
    ) {
      thread = activeThread.thread;
      activeThread.lastUsed = Date.now();
      await emit(
        "Reused active Codex thread",
        activeThread.nativeSessionId || "in memory",
      );
    } else {
      await emitSetup();
      const secrets = codexSessionSecretsConfig();
      const codex = new sdk.Codex({
        codexPathOverride,
        baseUrl:
          profile.connectionType === "local_login" || profile.codexModelProvider
            ? undefined
            : profile.baseUrl,
        apiKey:
          profile.connectionType === "local_login" || profile.codexModelProvider
            ? undefined
            : codexSessionEnvironment(workspacePath, profile, session)
                .CODEX_API_KEY,
        env: codexSessionEnvironment(workspacePath, profile, session),
        config: {
          ...codexProfileConfig(profile),
          ...codexSessionConfig(managedSkills, deviceNotes),
          ...codexFoundryTools(session)?.config,
          ...secrets,
          ...role?.config,
          features: {
            ...secrets.features,
            ...(role?.config?.features as Record<string, boolean> | undefined),
          },
        },
      });
      await emit("Started Codex SDK", `${packageName} · ${codexCommand}`);
      thread = requestedNativeSessionId
        ? codex.resumeThread(requestedNativeSessionId, threadOptions)
        : codex.startThread(threadOptions);
      threadEntry = {
        key: runtimeKey,
        lastUsed: Date.now(),
        nativeSessionId: requestedNativeSessionId || thread.id || "",
        thread,
      };
      activeCodexThreads.set(runtimeKey, threadEntry);
    }
    let nativeSessionId = requestedNativeSessionId || thread.id || "";
    reportNativeSessionId(nativeSessionId);
    const prompt = sessionPrompt(session, profile);
    const input = codexSessionInput(session, prompt);
    // Codex reports no diffs: its changes are diffed against the work tree
    // as the turn started. Naming and other utility sessions write nothing.
    if (!isUtilitySession(session)) await files.snapshotWorkTree();
    // How full the thread's context is, from the log Codex keeps of it.
    const context = new CodexContextFollower([
      codexHome(codexSessionEnvironment(workspacePath, profile, session)),
    ]);
    if (nativeSessionId)
      await context.follow(nativeSessionId, { resumed: true });
    const reportContext = async () => {
      const reports = await context.read().catch(() => []);
      for (const contextUsage of reports)
        await emit(
          processLabels.modelRequestUsage,
          contextUsage.model ?? "",
          undefined,
          { contextUsage },
        );
    };

    if (typeof thread.runStreamed === "function") {
      const abortController = new AbortController();
      let canceled = false;
      const unregisterCancel = registerActiveSessionCancelTarget(session.id, {
        provider: "codex",
        cancel: () => {
          canceled = true;
          abortController.abort();
        },
      });
      // Quiet is not failure: Codex bounds its own stream and tools.
      let ceilingError: Error | undefined;
      const liveness = new CodexTurnLiveness({
        ...turnLivenessSettings(),
        startupTimeoutMs: undefined,
        onNotice: (notice) =>
          void emit(
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
      try {
        const streamed = await thread.runStreamed(input, {
          signal: abortController.signal,
        });
        const events = streamed.events[Symbol.asyncIterator]();
        let turnCompleted = false;
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
          if (next.done) {
            break;
          }
          const event = next.value;
          liveness.observe(event);
          appendFileSync(eventsPath, `${JSON.stringify(event ?? null)}\n`);
          const eventNativeSessionId = nativeSessionIdFromEvent(event);
          if (eventNativeSessionId) {
            nativeSessionId = eventNativeSessionId;
            reportNativeSessionId(nativeSessionId);
            await context.follow(nativeSessionId, { resumed: false });
            const runtime = threadEntry;
            if (runtime) {
              runtime.nativeSessionId = nativeSessionId;
              runtime.lastUsed = Date.now();
            }
          }
          const processEvent = sdkProcessEvent(event);
          if (processEvent) {
            await emit(
              processEvent.label,
              processEvent.detail,
              processEvent.level,
              undefined,
              processEvent.message,
            );
          }
          for (const write of codexFileWrites(event))
            await files.recordToolWrite(write);
          if ((event as { type?: unknown } | null)?.type === "item.completed")
            await reportContext();
          const text = sdkMessageText(event);
          if (text && text !== finalResult) {
            const message = sdkResponseMessage(event, text);
            if (message.kind === "commentary") {
              await emit(
                processLabels.commentary,
                text,
                undefined,
                undefined,
                message,
              );
            } else {
              finalResult = text;
              await emit(
                "Response stream",
                text,
                undefined,
                undefined,
                message,
              );
            }
          }
          if (event && typeof event === "object") {
            const eventType = (event as Record<string, unknown>).type;
            if (eventType === "turn.failed") {
              const error = (event as Record<string, unknown>).error;
              throw new Error(
                error &&
                  typeof error === "object" &&
                  typeof (error as Record<string, unknown>).message === "string"
                  ? String((error as Record<string, unknown>).message)
                  : "Codex turn failed",
              );
            }
            if (eventType === "turn.completed") {
              usage = codexTurnUsage(event);
              turnCompleted = true;
              // The log trails the stream a little: its last count is read
              // before the process stops.
              for (let wait = 0; ; wait += 1) {
                await reportContext();
                if (
                  !context.found ||
                  context.turnInputTokens >= (usage?.inputTokens ?? 0) ||
                  wait >= 10
                )
                  break;
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
              abortController.abort();
              break;
            }
          }
        }
        if (ceilingError) throw ceilingError;
        if (canceled) {
          throw new AgentSessionCanceledError();
        }
        if (turnCompleted && typeof events.return === "function") {
          void events.return().catch(() => undefined);
        }
      } finally {
        // The turn's process ends with it: one a failure left running would
        // write the thread alongside the next turn's.
        abortController.abort();
        liveness.close();
        unregisterCancel();
      }
    } else {
      const turn = await thread.run(input);
      appendFileSync(eventsPath, `${JSON.stringify(turn ?? null)}\n`);
      nativeSessionId = thread.id || nativeSessionId;
      reportNativeSessionId(nativeSessionId);
      finalResult = sdkMessageText(turn);
      usage = codexTurnUsage(turn);
    }

    const runtime = threadEntry;
    if (runtime) {
      runtime.nativeSessionId = nativeSessionId;
      runtime.lastUsed = Date.now();
    }
    const response =
      finalResult || "Codex SDK completed without a text response.";
    writeFileSync(resultPath, `${response}\n`);
    const fileReferences = await files.finish(finalResult);
    await emit("Codex SDK finished", resultPath, undefined, {
      ...turnUsageMetadata(usage, startedAt),
      ...(fileReferences.length > 0 ? { fileReferences } : {}),
    });
    return { nativeSessionId, response };
  } catch (error) {
    if (isAgentSessionCanceledError(error)) {
      throw error;
    }
    writeFileSync(
      stderrPath,
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    throw error;
  }
}

// --- Native session ID extraction ---

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
