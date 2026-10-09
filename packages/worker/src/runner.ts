import { processLabels } from "@bd777/foundry-protocol";
import type { SessionEventEmitter } from "./session-state.js";
import {
  claudeFileWriteHooks,
  codexFileWrites,
  mergeClaudeHooks,
  SessionTurnFiles,
} from "./session-files.js";
import {
  executionSessionsRoot,
  sessionInputDirectory,
} from "./session-artifacts.js";
/**
 * Claude and Codex session runners — active runtime management,
 * SDK/CLI execution, and session option helpers.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID, type UUID } from "node:crypto";
import { officialSkills, refreshOfficialSkills } from "./official-skills.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
  AgentBackgroundTaskOutput,
  AgentProfileProjection,
  AgentProjection,
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventMetadata,
  ChatAttachment,
  Issue,
} from "@bd777/foundry-protocol";
import {
  activeClaudeRuntimes,
  activeCodexThreads,
  activeSessionCancelTargets,
  activeSessionSteerTargets,
  emitOutOfBandSessionEvent,
  queuedSessionCancelRequests,
  type ActiveClaudeContinuation,
  type ActiveClaudeRuntime,
  type ActiveClaudeTurn,
  type ActiveCodexThread,
  type ActiveSessionCancelTarget,
  type ActiveSessionSteerTarget,
  type AgentSessionRunResult,
  type ClaudeSDKQuery,
  type CodexSDKThread,
  AsyncInputQueue,
} from "./session-state.js";
import { ClaudeTimerTracker } from "./agent-timers.js";
import {
  ClaudeBackgroundTaskTracker,
  readBackgroundTaskOutput,
} from "./agent-background-tasks.js";
import { redactSecrets } from "./secret-redaction.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";

import {
  claudeManagedPrompt,
  prepareCodexSkillIsolation,
  validateWorkspaceSkillPrompt,
  workspaceSkillInstructions,
} from "./skill-isolation.js";
import {
  codexFoundryTools,
  buildClaudeLaunchPlan,
  validateClaudeLaunch,
  claudeLaunchMcpServers,
  claudeSessionOptions,
  claudeSettingsFile,
  type ClaudeLaunchPlan,
} from "./session-policy.js";
import {
  currentInput,
  sessionPrompt,
  userMessageText,
} from "./session-prompt.js";
import {
  runOnNativeSession,
  type NativeSessionStart,
} from "./native-session.js";

// Re-exported for existing callers/tests; the launch-policy module now owns
// these definitions.
export { claudeSessionOptions, sessionPrompt };

/**
 * Codex launch config for what a session is told and which skills it sees:
 * the device notes for every workspace session, plus the managed catalog with
 * host skill discovery turned off.
 */
export function codexSessionConfig(
  managed: ManagedSkillRuntime | undefined,
  deviceNotes = "",
): Record<string, unknown> {
  if (managed && !managed.hostSkillPaths)
    throw new Error("Codex skill inventory was not verified.");
  const instructions = [
    deviceNotes,
    managed ? workspaceSkillInstructions(managed) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(managed
      ? {
          skills: {
            include_instructions: false,
            config: managed.hostSkillPaths!.map((path) => ({
              enabled: false,
              path,
            })),
          },
        }
      : {}),
    ...(instructions ? { developer_instructions: instructions } : {}),
  };
}

function codexDeviceNotes(
  workspacePath: string,
  session: AgentSession,
): string {
  return isUtilitySession(session)
    ? ""
    : sessionResourceNotes(
        workspacePath,
        undefined,
        usesSessionScratch(session) ? session.id : undefined,
      );
}

import {
  ClaudeAgentTurnError,
  claudeAgentResultError,
  claudeApiErrorMessage,
  claudeCommandLifecycle,
  claudeContentBlockProcessEvent,
  claudeContentText,
  claudeMessageText,
  claudeNativeSessionId,
  claudePartialText,
  claudeProcessEvent,
  claudeResultOrigin,
  claudeStreamEventText,
  claudeSystemProcessEvent,
  claudeTaskNotificationBookkeeping,
  claudeTaskLifecycleChange,
  claudeToolUseDetail,
  isForwardedClaudeSubagentMessage,
  safeJSONString,
  sdkCommandDetail,
  sdkFileChangeDetail,
  sdkMessageText,
  sdkProcessEvent,
  sdkResponseMessage,
  sdkString,
  sdkToolCallDetail,
  sdkTodoListDetail,
  truncateForEvent,
  type ClaudeProcessEvent,
} from "./sdk-messages.js";
import { ClaudeTurnWatchdog } from "./watchdog.js";
import {
  addTurnUsage,
  ClaudeRequestUsageTracker,
  claudeResultUsage,
  codexTurnUsage,
  turnUsageMetadata,
  type TurnTokenUsage,
} from "./turn-usage.js";
import {
  isUtilitySession,
  killChildProcess,
  sendPrompt,
  resolveClaudeCommand,
  resolveCodexCommand,
  sleep,
} from "./utils.js";
import {
  agentProfilesForWorkspace,
  maskCommand,
  profileConfigForSession,
  profileFingerprint,
  profileID,
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "./profiles.js";
import { sessionEnvironment, usesSessionScratch } from "./session-ambient.js";
import { codexRoleOptions, isClarificationSession } from "./session-roles.js";
import { readAgentRuntimeSettings } from "./device.js";
import {
  knownSessionScratchDirectory,
  sessionResourceNotes,
} from "./resource-pool.js";

export function codexSandboxMode(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["codexSandboxMode"]> {
  if (isUtilitySession(session) || isClarificationSession(session)) {
    return "read-only";
  }
  return (
    session.codexSandboxMode ??
    profile.codexSandboxMode ??
    defaultCodexSandboxMode
  );
}

export function codexApprovalPolicy(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["codexApprovalPolicy"]> {
  if (isClarificationSession(session)) return "never";
  return session.codexApprovalPolicy ?? profile.codexApprovalPolicy ?? "never";
}

export function codexReasoningEffort(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): AgentProfileProjection["codexReasoningEffort"] {
  return session.codexReasoningEffort ?? profile.codexReasoningEffort;
}

export function codexSpeed(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): AgentProfileProjection["codexSpeed"] {
  return session.codexSpeed ?? profile.codexSpeed;
}

export function claudeEffort(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): AgentProfileProjection["claudeEffort"] {
  return session.claudeEffort ?? profile.claudeEffort;
}

/**
 * A workspace session is the person's own agent on their own device, run
 * headless: nobody is there to answer a permission prompt, so an unanswered
 * prompt only blocks the device's own software. Unless the profile or session
 * chooses otherwise, it runs as the person's terminal agent would with
 * permissions granted. Utility sessions (titles, naming) stay read-only, and
 * an Issue's clarification runs only the tools its role allows.
 */
export const defaultClaudePermissionMode = "bypassPermissions";
export const defaultCodexSandboxMode = "danger-full-access";

export function claudePermissionMode(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["claudePermissionMode"]> {
  if (isUtilitySession(session)) {
    return "plan";
  }
  if (isClarificationSession(session)) return "dontAsk";
  return (
    session.claudePermissionMode ??
    profile.claudePermissionMode ??
    defaultClaudePermissionMode
  );
}

/**
 * Claude Code refuses bypassPermissions for root unless the environment says
 * it is a deliberate sandbox. Say so before the SDK fails with a bare
 * refusal.
 */
export function claudeRootBypassRefusal(
  permissionMode: string,
  uid = process.getuid?.(),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (permissionMode !== "bypassPermissions" || uid !== 0) return undefined;
  if (env.IS_SANDBOX === "1" || env.CLAUDE_CODE_BUBBLEWRAP) return undefined;
  return "Claude Code does not allow Bypass permissions while the worker runs as root. Run the worker as a regular user, or choose another permission mode for this chat or in the device's Claude Code defaults.";
}

export async function runProfileCommandSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
): Promise<AgentSessionRunResult> {
  const files = SessionTurnFiles.forSession(
    workspacePath,
    executionSessionsRoot(workspacePath),
    session,
    emit,
  );
  const command = profile.command?.trim();
  if (!command) {
    throw new Error(
      `${profile.label ?? profile.runtime} does not have a command configured`,
    );
  }
  const stdoutPath = resolve(sessionDir, `${profileID(profile)}.stdout.log`);
  const stderrPath = resolve(sessionDir, `${profileID(profile)}.stderr.log`);
  const resultPath = resolve(sessionDir, "result.md");
  const prompt = sessionPrompt(session, profile);
  await emit("Started custom profile command", maskCommand(command) ?? command);

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolveRun, rejectRun) => {
    const child = spawn("sh", ["-lc", command], {
      cwd: workspacePath,
      env: {
        ...sessionEnvironment(workspacePath, profile, session),
        FOUNDRY_RESULT_FILE: resultPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeoutMs = Number(
      process.env.FOUNDRY_SESSION_TIMEOUT_MS ??
        (isUtilitySession(session) ? 180000 : 900000),
    );
    const timeout = setTimeout(() => {
      killChildProcess(child);
    }, timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const stdoutText = Buffer.concat(stdout).toString("utf8");
      const stderrText = Buffer.concat(stderr).toString("utf8");
      writeFileSync(stdoutPath, stdoutText);
      writeFileSync(stderrPath, stderrText);
      resolveRun({ code, signal, stdout: stdoutText, stderr: stderrText });
    });
    sendPrompt(child, prompt);
  });

  if (result.code !== 0) {
    throw new Error(
      `${profile.label ?? profile.runtime} exited with ${result.signal ?? result.code}: ${result.stderr.trim()}`,
    );
  }

  const response = existsSync(resultPath)
    ? readFileSync(resultPath, "utf8").trim()
    : result.stdout.trim();
  writeFileSync(
    resultPath,
    `${response || "Profile command completed without a text response."}\n`,
  );
  const fileReferences = await files.finish(response);
  await emit(
    "Custom profile command finished",
    resultPath,
    undefined,
    fileReferences.length > 0 ? { fileReferences } : undefined,
  );
  return {
    response: response || "Profile command completed without a text response.",
  };
}

type CodexSDKInput =
  | string
  | Array<
      { type: "text"; text: string } | { type: "local_image"; path: string }
    >;

export function codexSessionInput(
  session: AgentSession,
  prompt: string,
): CodexSDKInput {
  const images = (currentInput(session).attachments ?? [])
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => attachment.path.trim())
    .filter(Boolean);
  if (images.length === 0) {
    return prompt;
  }
  return [
    { type: "text", text: prompt },
    ...images.map((path) => ({ type: "local_image" as const, path })),
  ];
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

export function codexProfileConfig(
  profile: AgentProfileLocalConfig,
): Record<string, unknown> {
  if (profile.connectionType === "local_login")
    return { model_provider: "openai" };
  if (profile.codexModelProvider)
    return { model_provider: profile.codexModelProvider };
  if (profile.baseUrl?.trim())
    return {
      model_provider: "openai",
      openai_base_url: profile.baseUrl.trim(),
    };
  return {};
}

export function codexSessionEnvironment(
  workspacePath: string,
  profile: AgentProfileLocalConfig,
  session?: AgentSession,
): NodeJS.ProcessEnv {
  const env = sessionEnvironment(workspacePath, profile, session);
  // The native CLI reads CODEX_API_KEY; the generic OpenAI alias alone is
  // insufficient for a server-dispatched compatible connection.
  if (
    profile.connectionType !== "local_login" &&
    !profile.codexModelProvider &&
    env.OPENAI_API_KEY
  )
    env.CODEX_API_KEY = env.OPENAI_API_KEY;
  return env;
}

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
  const sessionDir = sessionInputDirectory(
    executionSessionsRoot(workspacePath),
    session,
  );
  mkdirSync(sessionDir, { recursive: true });
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
    const codexPathOverride = resolveCodexCommand();
    const deviceNotes = codexDeviceNotes(workspacePath, session);
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
    const runtimeSettings = readAgentRuntimeSettings();
    const runtimeKey = activeRuntimeKey(
      "codex",
      workspacePath,
      session,
      profile,
      { ...threadOptions, ...codexSessionConfig(managedSkills, deviceNotes) },
    );
    const activeThread = activeCodexThreads.get(runtimeKey);
    let thread: CodexSDKThread;
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
          ...role?.config,
        },
      });
      await emit("Started Codex SDK", `${packageName} · ${codexPathOverride}`);
      thread = requestedNativeSessionId
        ? codex.resumeThread(requestedNativeSessionId, threadOptions)
        : codex.startThread(threadOptions);
      activeCodexThreads.set(runtimeKey, {
        key: runtimeKey,
        lastUsed: Date.now(),
        nativeSessionId: requestedNativeSessionId || thread.id || "",
        thread,
      });
    }
    let nativeSessionId = requestedNativeSessionId || thread.id || "";
    reportNativeSessionId(nativeSessionId);
    const prompt = sessionPrompt(session, profile);
    const input = codexSessionInput(session, prompt);

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
            if (canceled || abortController.signal.aborted) {
              throw new AgentSessionCanceledError();
            }
            throw error;
          }
          if (next.done) {
            break;
          }
          const event = next.value;
          appendFileSync(eventsPath, `${JSON.stringify(event ?? null)}\n`);
          const eventNativeSessionId = nativeSessionIdFromEvent(event);
          if (eventNativeSessionId) {
            nativeSessionId = eventNativeSessionId;
            reportNativeSessionId(nativeSessionId);
            const runtime = activeCodexThreads.get(runtimeKey);
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
              abortController.abort();
              break;
            }
          }
        }
        if (canceled) {
          throw new AgentSessionCanceledError();
        }
        if (turnCompleted && typeof events.return === "function") {
          void events.return().catch(() => undefined);
        }
      } finally {
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

    const runtime = activeCodexThreads.get(runtimeKey);
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
  const sessionDir = sessionInputDirectory(
    executionSessionsRoot(workspacePath),
    session,
  );
  mkdirSync(sessionDir, { recursive: true });
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
      env: sessionEnvironment(workspacePath, profile, session),
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

export function claudeActiveTurnTimeouts(session: AgentSession): {
  idleTimeoutMs: number;
} {
  const defaultIdleMs = isUtilitySession(session) ? 180000 : 600000;
  const configuredIdleTimeoutMs = Number(
    process.env.FOUNDRY_CLAUDE_ACTIVE_TURN_IDLE_TIMEOUT_MS ?? defaultIdleMs,
  );
  const idleTimeoutMs = Math.max(
    1000,
    Number.isFinite(configuredIdleTimeoutMs) && configuredIdleTimeoutMs > 0
      ? Math.round(configuredIdleTimeoutMs)
      : defaultIdleMs,
  );
  return { idleTimeoutMs };
}

export function claudeTurnTimeoutError(kind: "idle"): Error {
  return new ClaudeAgentTurnError(
    "idle_timeout",
    "Claude Agent SDK stopped producing events before the session idle timeout.",
  );
}

export function resolveActiveClaudeTurn(
  runtime: ActiveClaudeRuntime,
  turn: ActiveClaudeTurn,
  result: AgentSessionRunResult,
): void {
  if (runtime.pending !== turn) {
    return;
  }
  runtime.pending = undefined;
  turn.watchdog.close();
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

export function cleanupActiveClaudeRuntimes(): void {
  const now = Date.now();
  const settings = readAgentRuntimeSettings();
  for (const [key, runtime] of activeClaudeRuntimes) {
    // Silence is expected while only background work or timers remain:
    // Claude Code's keep-alives never reach the SDK stream.
    if (
      runtime.closed ||
      (now - runtime.lastUsed > settings.activeRuntimeTtlMs &&
        !claudeRuntimeHasLiveWork(runtime))
    ) {
      closeActiveClaudeRuntime(
        runtime,
        new Error("Claude active runtime expired while its turn was pending."),
      );
      activeClaudeRuntimes.delete(key);
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
  for (const [key, runtime] of activeClaudeRuntimes) {
    closeActiveClaudeRuntime(runtime, disconnectError);
    activeClaudeRuntimes.delete(key);
  }
  for (const [key] of activeCodexThreads) {
    // Codex threads don't have a close method — the AbortController is
    // local to the session execution and will be garbage collected.
    activeCodexThreads.delete(key);
  }
  activeSessionSteerTargets.clear();
  activeSessionCancelTargets.clear();
  queuedSessionCancelRequests.clear();
}

export function closeActiveClaudeRuntime(
  runtime: ActiveClaudeRuntime,
  reason: unknown = new Error(
    "Claude active runtime closed before the turn completed.",
  ),
): void {
  runtime.closed = true;
  const turn = runtime.pending;
  runtime.pending = undefined;
  // Session-scoped timers and background work live in the agent process and
  // die with it; publish that before tearing down event plumbing.
  runtime.timers?.close();
  runtime.background?.close();
  runtime.continuation = undefined;
  turn?.watchdog.close();
  turn?.reject(reason);
  runtime.input.close();
  try {
    runtime.query?.close?.();
  } catch {
    // Best-effort cleanup only.
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
  });
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

const taskLifecycleSubtypes = new Set([
  "task_started",
  "task_progress",
  "task_notification",
]);

/**
 * Claude's answer to its own follow-up (after a background task ended),
 * published once it is complete: a divider and the answer, like a timer's.
 * Turns a timer started are published by the timer tracker instead.
 */
async function finishClaudeContinuation(
  runtime: ActiveClaudeRuntime,
  result?: unknown,
): Promise<void> {
  const continuation = runtime.continuation;
  const notifications = runtime.notifications ?? [];
  runtime.continuation = undefined;
  runtime.notifications = [];
  if (runtime.pending) runtime.pending.behindContinuation = false;
  const origin = claudeResultOrigin(result);
  if (result && origin !== "task-notification" && notifications.length === 0)
    return;
  const error = result ? claudeAgentResultError(result) : undefined;
  const response = (
    continuation?.finalResult || (result ? claudeMessageText(result) : "")
  ).trim();
  if (!response && !error) return;
  const startedAt = continuation?.startedAt ?? Date.now();
  const usage = result ? claudeResultUsage(result) : undefined;
  const completedAt = new Date().toISOString();
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
        response: error ? error.message : response,
        startedAt: new Date(startedAt).toISOString(),
        completedAt,
      },
      ...turnUsageMetadata(usage, startedAt),
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
  if (!turn || !claudeTurnOwnsMessage(runtime, turn)) {
    // The process is alive; a waiting turn must not time out meanwhile.
    turn?.watchdog.touch();
    await handleClaudeContinuationMessage(runtime, message);
    return;
  }
  turn.watchdog.touch();
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
    activeClaudeRuntimes.delete(runtime.key);
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
  const resultUsage = claudeResultUsage(message);
  if (resultUsage) turn.usage = addTurnUsage(turn.usage, resultUsage);
  if (
    message &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "result"
  ) {
    const response =
      turn.finalResult || "Claude Agent SDK completed without a text response.";
    if (turn.waitForBackgroundTasks && turn.openTaskIds.size > 0) {
      await turn.emit(
        processLabels.waitingBackgroundTasks,
        `${turn.openTaskIds.size} background task(s) are still open; this result is intermediate, and Foundry waits for the main agent to continue.`,
      );
      // A result in streaming-input mode ends one model turn, not necessarily
      // the Foundry turn. Clear the text accumulator so the continuation's
      // final response replaces this provisional response instead of being
      // concatenated with it.
      turn.finalResult = "";
      turn.partialResult = "";
      // Nothing arrives until the background work ends; silence is not a
      // stall here. The next message re-arms the idle timeout.
      turn.watchdog.pause();
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
      activeClaudeRuntimes.delete(runtime.key);
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
      activeClaudeRuntimes.delete(runtime.key);
    }
  })();
}

/**
 * Parse a Claude Code CLI stderr blob into a user-friendly error message.
 * The CLI emits warnings and errors in a single stream; this extracts the
 * actionable part and adds context for known failure modes.
 */

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
  const env = plan?.env ?? sessionEnvironment(workspacePath, profile, session);
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
    if (!canReuseRuntime) {
      if (runtime) {
        closeActiveClaudeRuntime(runtime);
        activeClaudeRuntimes.delete(runtimeKey);
      }
      // A session's earlier runtime (another skill catalog, profile or
      // model) holds the same native session: one process writes it.
      for (const [key, other] of activeClaudeRuntimes) {
        if (other.foundrySessionId === session.id && !other.pending) {
          closeActiveClaudeRuntime(other);
          activeClaudeRuntimes.delete(key);
        }
      }
      const options = { ...baseOptions };
      if (start?.kind === "fork") {
        // The SDK copies the source into the id the server already claimed.
        options.resume = start.from;
        options.forkSession = true;
        options.sessionId = start.nativeSessionId;
      } else if (requestedNativeSessionId) {
        options.resume = requestedNativeSessionId;
      }
      if (plan?.mcpServers)
        options.mcpServers = claudeLaunchMcpServers(plan.mcpServers);
      runtime = {
        closed: false,
        foundrySessionId: session.id,
        input: new AsyncInputQueue<unknown>(),
        key: runtimeKey,
        lastUsed: Date.now(),
        nativeSessionId: requestedNativeSessionId,
      };
      const owner = runtime;
      // Timer and background-work observation hooks must live for the whole
      // process lifetime; they are installed once, when the SDK query stream
      // is created. Their events go to the turn the runtime serves, or out of
      // band between turns.
      runtime.timers = new ClaudeTimerTracker({
        emit: (event) => emitForClaudeRuntime(owner, event),
        isActiveTurn: () => owner.pending !== undefined,
        sessionId: () => owner.foundrySessionId,
      });
      runtime.background = new ClaudeBackgroundTaskTracker({
        emit: (event) => emitForClaudeRuntime(owner, event),
        sessionId: () => owner.foundrySessionId,
        sessionsRoot: () => executionSessionsRoot(workspacePath),
        scratchDirectory: () =>
          knownSessionScratchDirectory(owner.foundrySessionId),
      });
      runtime.background.attach();
      options.hooks = mergeClaudeHooks(
        runtime.timers.hooks(),
        runtime.background.hooks(),
        // A write belongs to the turn the runtime is serving.
        claudeFileWriteHooks((write) =>
          owner.pending?.files?.recordToolWrite(write),
        ),
      );
      activeClaudeRuntimes.set(runtimeKey, runtime);
      await emitSetup();
      await emit("Started Claude Agent SDK", `${packageName} · ${command}`);
      runtimeStartOptions = options;
    } else {
      const reusableRuntime = runtime;
      if (!reusableRuntime) {
        throw new Error("Claude active runtime was not initialized");
      }
      reusableRuntime.lastUsed = Date.now();
      // The long-lived thread may serve continued Foundry sessions; timer
      // events between turns belong to the session currently attached.
      reusableRuntime.foundrySessionId = session.id;
      reusableRuntime.background?.attach();
      // Each dispatch mints a new session token and revokes the previous
      // one, so the Foundry tools are re-pointed at this turn's identity.
      await reusableRuntime.query?.setMcpServers?.(plan?.mcpServers ?? {});
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
            closeActiveClaudeRuntime(
              activeRuntime,
              new AgentSessionCanceledError(),
            );
            activeClaudeRuntimes.delete(activeRuntime.key);
          },
        });
        const timeouts = claudeActiveTurnTimeouts(session);
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
          watchdog: new ClaudeTurnWatchdog(timeouts.idleTimeoutMs, () => {
            if (activeRuntime.pending !== turn) {
              return;
            }
            closeActiveClaudeRuntime(
              activeRuntime,
              claudeTurnTimeoutError("idle"),
            );
            activeClaudeRuntimes.delete(activeRuntime.key);
          }),
        };
        activeRuntime.pending = turn;
        try {
          activeRuntime.input.push({
            message: { role: "user", content: prompt },
            parent_tool_use_id: null,
            type: "user",
            // The Foundry input is Claude's user message: one identity.
            ...(session.input ? { uuid: session.input.id as UUID } : {}),
          });
          if (runtimeStartOptions) {
            startActiveClaudePump(
              activeRuntime,
              query({
                prompt: activeRuntime.input,
                options: runtimeStartOptions,
              }) as ClaudeSDKQuery,
            );
          }
        } catch (error) {
          closeActiveClaudeRuntime(activeRuntime, error);
          activeClaudeRuntimes.delete(activeRuntime.key);
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

export function claudeMaxTurns(session: AgentSession): number | undefined {
  if (isUtilitySession(session)) {
    return 3;
  }
  const configured = process.env.FOUNDRY_CLAUDE_MAX_TURNS?.trim();
  if (
    !configured ||
    configured === "0" ||
    configured.toLowerCase() === "unlimited"
  ) {
    return undefined;
  }
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.round(parsed))
    : undefined;
}

// --- Session steer/cancel targets ---

export function registerActiveSessionSteerTarget(
  sessionID: string,
  target: ActiveSessionSteerTarget,
): () => void {
  activeSessionSteerTargets.set(sessionID, target);
  return () => {
    if (activeSessionSteerTargets.get(sessionID) === target) {
      activeSessionSteerTargets.delete(sessionID);
    }
  };
}

export function registerActiveSessionCancelTarget(
  sessionID: string,
  target: ActiveSessionCancelTarget,
): () => void {
  activeSessionCancelTargets.set(sessionID, target);
  return () => {
    if (activeSessionCancelTargets.get(sessionID) === target) {
      activeSessionCancelTargets.delete(sessionID);
    }
  };
}

// --- Session cancellation ---

export class AgentSessionCanceledError extends Error {
  constructor() {
    super("Session was canceled.");
    this.name = "AgentSessionCanceledError";
  }
}

export function isAgentSessionCanceledError(error: unknown): boolean {
  return error instanceof AgentSessionCanceledError;
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
