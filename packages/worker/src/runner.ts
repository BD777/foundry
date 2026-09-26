import type { SessionEventEmitter } from "./session-state.js";
import { SessionOutputFiles } from "./session-output-files.js";
/**
 * Claude and Codex session runners — active runtime management,
 * SDK/CLI execution, and session option helpers.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type {
  AgentProfileProjection,
  AgentProjection,
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventMetadata,
  Issue,
} from "@foundry/protocol";
import {
  activeClaudeRuntimes,
  activeCodexThreads,
  activeSessionCancelTargets,
  activeSessionSteerTargets,
  emitOutOfBandSessionEvent,
  queuedSessionCancelRequests,
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
import type { ManagedSkillRuntime } from "./skill-materializer.js";

import {
  claudeManagedPrompt,
  workspaceProjectInstructions,
  isolateSkillSession,
  prepareCodexSkillIsolation,
  validateWorkspaceSkillPrompt,
  workspaceSkillInstructions,
} from "./skill-isolation.js";
import {
  buildClaudeLaunchPlan,
  claudeManagedSkillOptions,
  type ClaudeLaunchPlan,
} from "./session-policy.js";
import { sessionPrompt } from "./session-prompt.js";

// Re-exported for existing callers/tests; the launch-policy module now owns
// these definitions.
export { claudeManagedSkillOptions, sessionPrompt };

/** Discovery must be disabled: the SDK name allowlist does not restrict /name. */
export function tomlBasicString(value: string): string {
  return JSON.stringify(value);
}

export function codexManagedSkillConfig(
  managed: ManagedSkillRuntime | undefined,
): Record<string, unknown> {
  if (!managed) return {};
  if (!managed.hostSkillPaths)
    throw new Error("Codex skill inventory was not verified.");
  return {
    skills: {
      include_instructions: false,
      bundled: { enabled: false },
      config: managed.hostSkillPaths.map((path) => ({ enabled: false, path })),
    },
    developer_instructions: workspaceSkillInstructions(managed),
  };
}

export function codexManagedSkillArgs(
  managed: ManagedSkillRuntime | undefined,
): string[] {
  const config = codexManagedSkillConfig(managed);
  if (!managed) return [];
  const rows = managed.hostSkillPaths!.map(
    (path) => `{enabled=false,path=${tomlBasicString(path)}}`,
  );
  return [
    "-c",
    "skills.include_instructions=false",
    "-c",
    "skills.bundled.enabled=false",
    "-c",
    `skills.config=[${rows.join(",")}]`,
    "-c",
    `developer_instructions=${tomlBasicString(config.developer_instructions as string)}`,
  ];
}
import {
  ClaudeAgentTurnError,
  claudeAgentResultError,
  claudeApiErrorMessage,
  claudeContentBlockProcessEvent,
  claudeContentText,
  claudeExtractTouchedFiles,
  claudeMessageText,
  claudeNativeSessionId,
  claudePartialText,
  claudeProcessEvent,
  claudeStreamEventText,
  claudeSystemProcessEvent,
  claudeTaskLifecycleChange,
  claudeToolUseDetail,
  codexExtractTouchedFiles,
  friendlyClaudeCliError,
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
import { sessionEnvironment } from "./session-ambient.js";
import { readAgentRuntimeSettings } from "./device.js";

export function codexSandboxMode(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["codexSandboxMode"]> {
  if (isUtilitySession(session)) {
    return "read-only";
  }
  return (
    session.codexSandboxMode ?? profile.codexSandboxMode ?? "workspace-write"
  );
}

export function codexApprovalPolicy(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["codexApprovalPolicy"]> {
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

export function claudePermissionMode(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
): NonNullable<AgentProfileProjection["claudePermissionMode"]> {
  if (isUtilitySession(session)) {
    return "plan";
  }
  return (
    session.claudePermissionMode ??
    profile.claudePermissionMode ??
    "acceptEdits"
  );
}

export async function runProfileCommandSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
): Promise<AgentSessionRunResult> {
  const outputs = await SessionOutputFiles.start(workspacePath, emit);
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
  await outputs.reportChangedOnDisk();
  await emit("Custom profile command finished", resultPath);
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
  const images = (session.attachments ?? [])
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
  if (profile.connectionType !== "local_login" && env.OPENAI_API_KEY)
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
  const outputs = await SessionOutputFiles.start(workspacePath, emit);
  if (managedSkills) {
    validateWorkspaceSkillPrompt(session.prompt, managedSkills);
    if (profile.command?.trim())
      throw new Error(
        "Custom runtime commands cannot enforce workspace skill isolation.",
      );
    const isolation = isolateSkillSession(
      session,
      workspacePath,
      managedSkills,
    );
    session = isolation.session;
    const report = reportNativeSessionId;
    reportNativeSessionId = (id) => {
      isolation.record(id);
      report(id);
    };
    if (isolation.reset)
      await emit(
        "Restarted runtime for workspace skill isolation",
        "Previous native context predates this workspace skill policy; the Foundry transcript is preserved.",
      );
    managedSkills = await prepareCodexSkillIsolation(
      managedSkills,
      workspacePath,
      codexSessionEnvironment(workspacePath, profile, session),
    );
  }
  const sessionDir = process.env.FOUNDRY_EXECUTION_SESSION_ROOT
    ? resolve(process.env.FOUNDRY_EXECUTION_SESSION_ROOT, session.id)
    : resolve(workspacePath, ".foundry", "sessions", session.id);
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
  const eventsPath = resolve(sessionDir, "codex-sdk.events.jsonl");
  const stderrPath = resolve(sessionDir, "codex-sdk.stderr.log");
  const resultPath = resolve(sessionDir, "result.md");
  const packageName = "@openai/codex-sdk";
  let finalResult = "";

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
    const threadOptions = {
      approvalPolicy: codexApprovalPolicy(session, profile),
      model: session.model?.trim() || profile.model?.trim() || undefined,
      modelReasoningEffort: codexReasoningEffort(session, profile),
      modelSpeed: codexSpeed(session, profile),
      sandboxMode: codexSandboxMode(session, profile),
      skipGitRepoCheck: true,
      workingDirectory: workspacePath,
    };
    const requestedNativeSessionId = session.nativeSessionId?.trim();
    cleanupActiveCodexThreads();
    const runtimeSettings = readAgentRuntimeSettings();
    const runtimeKey = activeRuntimeKey(
      "codex",
      workspacePath,
      session,
      profile,
      { ...threadOptions, ...codexManagedSkillConfig(managedSkills) },
    );
    const activeThread = activeCodexThreads.get(runtimeKey);
    let thread: CodexSDKThread;
    if (
      activeThread &&
      (!requestedNativeSessionId ||
        !activeThread.nativeSessionId ||
        activeThread.nativeSessionId === requestedNativeSessionId)
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
          profile.connectionType === "local_login"
            ? undefined
            : profile.baseUrl,
        apiKey:
          profile.connectionType === "local_login"
            ? undefined
            : codexSessionEnvironment(workspacePath, profile, session)
                .CODEX_API_KEY,
        env: codexSessionEnvironment(workspacePath, profile, session),
        config: {
          ...codexProfileConfig(profile),
          ...codexManagedSkillConfig(managedSkills),
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
          await outputs.reportToolWrites(codexExtractTouchedFiles(event));
          const text = sdkMessageText(event);
          if (text && text !== finalResult) {
            const message = sdkResponseMessage(event, text);
            if (message.kind === "commentary") {
              await emit("过程", text, undefined, undefined, message);
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
    }

    const runtime = activeCodexThreads.get(runtimeKey);
    if (runtime) {
      runtime.nativeSessionId = nativeSessionId;
      runtime.lastUsed = Date.now();
    }
    const response =
      finalResult || "Codex SDK completed without a text response.";
    writeFileSync(resultPath, `${response}\n`);
    await outputs.reportChangedOnDisk();
    await emit("Codex SDK finished", resultPath);
    return { nativeSessionId, response };
  } catch (error) {
    if (isAgentSessionCanceledError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(
      stderrPath,
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    await emit("Codex SDK unavailable", message, "warning");
    await emitSetup();
    return runCodexCliSession(
      workspacePath,
      session,
      sessionDir,
      profile,
      emit,
      reportNativeSessionId,
      managedSkills,
    );
  }
}

export async function runCodexCliSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  reportNativeSessionId: (nativeSessionId: string) => void = () => {},
  managedSkills?: ManagedSkillRuntime,
): Promise<AgentSessionRunResult> {
  const outputs = await SessionOutputFiles.start(workspacePath, emit);
  const command = resolveCodexCommand();
  const stdoutPath = resolve(sessionDir, "codex-cli.stdout.log");
  const stderrPath = resolve(sessionDir, "codex-cli.stderr.log");
  const resultPath = resolve(sessionDir, "result.md");
  const prompt = sessionPrompt(session, profile);
  let nativeSessionId = session.nativeSessionId?.trim();
  const args = nativeSessionId
    ? [
        "exec",
        "resume",
        "--skip-git-repo-check",
        "--output-last-message",
        resultPath,
        nativeSessionId,
        "-",
      ]
    : [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        codexSandboxMode(session, profile),
        "-C",
        workspacePath,
        "--output-last-message",
        resultPath,
        "-",
      ];
  args.push("--json");
  args.push(...codexManagedSkillArgs(managedSkills));
  const model = session.model?.trim() || profile.model?.trim();
  if (model) {
    args.splice(1, 0, "--model", model);
  }
  const effort = codexReasoningEffort(session, profile);
  if (effort) {
    args.splice(1, 0, "-c", `model_reasoning_effort="${effort}"`);
  }
  const approval = codexApprovalPolicy(session, profile);
  if (approval) {
    args.splice(1, 0, "-c", `approval_policy="${approval}"`);
  }
  const speed = codexSpeed(session, profile);
  if (speed) {
    args.splice(1, 0, "-c", `model_speed="${speed}"`);
  }
  const imageAttachments = (session.attachments ?? []).filter(
    (attachment) => attachment.kind === "image",
  );
  for (const attachment of imageAttachments) {
    if (attachment.path.trim()) {
      args.splice(1, 0, "--image", attachment.path.trim());
    }
  }

  await emit("Started Codex CLI", command);
  for (const [key, value] of Object.entries(codexProfileConfig(profile))) {
    args.splice(1, 0, "-c", `${key}=${tomlBasicString(value as string)}`);
  }
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspacePath,
      env: codexSessionEnvironment(workspacePath, profile, session),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      killChildProcess(child);
    }, 180000);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let pendingLines = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
      pendingLines += chunk.toString("utf8");
      const lines = pendingLines.split("\n");
      pendingLines = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const id = nativeSessionIdFromEvent(JSON.parse(line));
          if (id) {
            nativeSessionId = id;
            reportNativeSessionId(id);
          }
        } catch {
          /* Non-JSON CLI diagnostics. */
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      writeFileSync(stdoutPath, Buffer.concat(stdout).toString("utf8"));
      writeFileSync(stderrPath, Buffer.concat(stderr).toString("utf8"));
      resolveRun({ code, signal });
    });
    sendPrompt(child, prompt);
  });

  if (result.code !== 0) {
    const stderr = existsSync(stderrPath)
      ? readFileSync(stderrPath, "utf8").trim()
      : "";
    throw new Error(
      `Codex CLI exited with ${result.signal ?? result.code}: ${stderr}`,
    );
  }

  const response = existsSync(resultPath)
    ? readFileSync(resultPath, "utf8").trim()
    : "Codex CLI completed without a text response.";
  await outputs.reportChangedOnDisk();
  await emit("Codex CLI finished", resultPath);
  return {
    nativeSessionId,
    response: response || "Codex CLI completed without a text response.",
  };
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
  // Assemble the full launch plan first: it performs fail-closed validation
  // (managed skills reject custom commands and unconfigured invocations)
  // before any directory or process work happens.
  const plan = buildClaudeLaunchPlan({
    workspacePath,
    session,
    profile,
    managedSkills,
  });
  session = plan.session;
  const sessionDir = process.env.FOUNDRY_EXECUTION_SESSION_ROOT
    ? resolve(process.env.FOUNDRY_EXECUTION_SESSION_ROOT, session.id)
    : resolve(workspacePath, ".foundry", "sessions", session.id);
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
  const outerReport = reportNativeSessionId;
  reportNativeSessionId = (id) => {
    plan.recordNativeSession(id);
    outerReport(id);
  };
  if (plan.reset) {
    await emit(
      "Restarted runtime for workspace skill isolation",
      "Previous native context predates this workspace skill policy; the Foundry transcript is preserved.",
    );
  }
  for (const warning of plan.warnings) {
    await emit("Connection credential missing", warning, "warning");
  }
  try {
    return await runClaudeAgentSdkSession(
      workspacePath,
      session,
      sessionDir,
      profile,
      emit,
      emitSetup,
      reportNativeSessionId,
      managedSkills,
      plan,
    );
  } catch (error) {
    if (error instanceof ClaudeAgentTurnError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await emit("Claude Agent SDK unavailable", message, "warning");
    await emitSetup();
    return runClaudeCliSession(
      workspacePath,
      session,
      sessionDir,
      profile,
      emit,
      reportNativeSessionId,
      managedSkills,
      plan,
    );
  }
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

export function cleanupActiveClaudeRuntimes(): void {
  const now = Date.now();
  const settings = readAgentRuntimeSettings();
  for (const [key, runtime] of activeClaudeRuntimes) {
    if (
      runtime.closed ||
      now - runtime.lastUsed > settings.activeRuntimeTtlMs
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
  // Session-scoped timers live in agent process memory and die with it;
  // publish the empty snapshot before tearing down event plumbing.
  runtime.timers?.close();
  turn?.watchdog.close();
  turn?.reject(reason);
  runtime.input.close();
  try {
    runtime.query?.close?.();
  } catch {
    // Best-effort cleanup only.
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
  if (!turn) {
    return;
  }
  turn.watchdog.touch();
  appendFileSync(turn.messagesPath, `${JSON.stringify(message ?? null)}\n`);
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
  await turn.outputs?.reportToolWrites(claudeExtractTouchedFiles(message));
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
  if (
    message &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "result"
  ) {
    const response =
      turn.finalResult || "Claude Agent SDK completed without a text response.";
    if (turn.openTaskIds.size > 0) {
      await turn.emit(
        "等待后台任务",
        `仍有 ${turn.openTaskIds.size} 个后台任务；当前结果是中间结果，Foundry 将等待主 agent 续跑。`,
      );
      // A result in streaming-input mode ends one model turn, not necessarily
      // the Foundry turn. Clear the text accumulator so the continuation's
      // final response replaces this provisional response instead of being
      // concatenated with it.
      turn.finalResult = "";
      turn.partialResult = "";
      return;
    }
    writeFileSync(turn.resultPath, `${response}\n`);
    await turn.outputs?.reportChangedOnDisk();
    await turn.emit("Claude Agent SDK finished", turn.resultPath);
    resolveActiveClaudeTurn(runtime, turn, {
      nativeSessionId: turn.nativeSessionId || runtime.nativeSessionId,
      response,
    });
    // If the SDK returned no text, the runtime is likely in a bad state
    // (e.g. orphaned background agents from a killed session). Close it so
    // the next session starts fresh instead of reusing the broken runtime.
    if (!turn.finalResult) {
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
): Promise<AgentSessionRunResult> {
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
  const permissionMode = claudeSdkPermissionMode(session, profile, env);
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
    ...(managedSkills ? { disableBundledSkills: true } : {}),
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
    settings: flagSettings,
    tools: { type: "preset", preset: "claude_code" },
    ...(plan?.sdk ?? claudeManagedSkillOptions(managedSkills, workspacePath)),
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
  reportNativeSessionId(requestedNativeSessionId);

  try {
    cleanupActiveClaudeRuntimes();
    let runtime = activeClaudeRuntimes.get(runtimeKey);
    let runtimeStartOptions: Record<string, unknown> | undefined;
    const canReuseRuntime =
      runtime &&
      !runtime.closed &&
      (!requestedNativeSessionId ||
        !runtime.nativeSessionId ||
        runtime.nativeSessionId === requestedNativeSessionId);
    if (!canReuseRuntime) {
      if (runtime) {
        closeActiveClaudeRuntime(runtime);
        activeClaudeRuntimes.delete(runtimeKey);
      }
      const options = { ...baseOptions };
      if (requestedNativeSessionId) {
        options.resume = requestedNativeSessionId;
      }
      if (plan?.mcpServers) options.mcpServers = plan.mcpServers;
      runtime = {
        closed: false,
        foundrySessionId: session.id,
        input: new AsyncInputQueue<unknown>(),
        key: runtimeKey,
        lastUsed: Date.now(),
        nativeSessionId: requestedNativeSessionId,
      };
      // Timer observation hooks must live for the whole process lifetime;
      // they are installed once, when the SDK query stream is created.
      runtime.timers = new ClaudeTimerTracker({
        emit: (event) => {
          const turn = runtime?.pending;
          if (turn && runtime && !runtime.closed) {
            void turn.emit(
              event.label,
              event.detail,
              event.level ?? "info",
              event.metadata,
              event.message,
            );
            return;
          }
          if (runtime) {
            emitOutOfBandSessionEvent(runtime.foundrySessionId, {
              detail: event.detail,
              level: event.level,
              message: event.message,
              metadata: event.metadata,
              label: event.label,
            });
          }
        },
        isActiveTurn: () => runtime?.pending !== undefined,
        sessionId: () => runtime?.foundrySessionId ?? session.id,
      });
      options.hooks = runtime.timers.hooks();
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
    const outputs = await SessionOutputFiles.start(workspacePath, emit);
    return await new Promise<AgentSessionRunResult>(
      (resolveTurn, rejectTurn) => {
        const unregisterSteer = registerActiveSessionSteerTarget(session.id, {
          provider: "claude",
          steer: async (message: string) => {
            if (activeRuntime.pending?.resultPath !== resultPath) {
              throw new Error(
                "Claude is not accepting steer input for this active turn.",
              );
            }
            const text = message.trim();
            if (plan) plan.validatePrompt(text);
            else if (managedSkills)
              validateWorkspaceSkillPrompt(text, managedSkills);
            if (!text) {
              throw new Error("Steer message is required.");
            }
            activeRuntime.input.push({
              message: { role: "user", content: text },
              parent_tool_use_id: null,
              priority: "next",
              type: "user",
            });
            await emit("Steered into active turn", text);
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
          outputs,
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
    if (
      requestedNativeSessionId &&
      /No conversation found with session ID/i.test(message)
    ) {
      // The native session ID is stale (e.g. daemon restarted and the CLI
      // session store was cleared). Close the broken runtime and retry
      // with a fresh session (no resume).
      await emit(
        "Native Claude session was unavailable; starting a fresh leg",
        "",
        "warning",
      );
      const staleRuntime = activeClaudeRuntimes.get(runtimeKey);
      if (staleRuntime) {
        closeActiveClaudeRuntime(staleRuntime);
        activeClaudeRuntimes.delete(runtimeKey);
      }
      // Retry with empty native session ID to start a fresh conversation.
      const freshSession = { ...session, nativeSessionId: "" };
      const retryManaged = plan ? plan.managedSkills : managedSkills;
      const freshPlan = plan
        ? buildClaudeLaunchPlan({
            workspacePath,
            session: freshSession,
            profile,
            managedSkills: retryManaged,
          })
        : undefined;
      return runClaudeAgentSdkSession(
        workspacePath,
        freshSession,
        sessionDir,
        profile,
        emit,
        emitSetup,
        reportNativeSessionId,
        retryManaged,
        freshPlan,
      );
    }
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

export function claudeSdkPermissionMode(
  session: AgentSession,
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
): NonNullable<AgentProfileProjection["claudePermissionMode"]> {
  if (
    !isUtilitySession(session) &&
    !session.claudePermissionMode &&
    !profile.claudePermissionMode &&
    env.FOUNDRY_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "1"
  ) {
    return "bypassPermissions";
  }
  return claudePermissionMode(session, profile);
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
export async function runClaudeCliSession(
  workspacePath: string,
  session: AgentSession,
  sessionDir: string,
  profile: AgentProfileLocalConfig,
  emit: SessionEventEmitter,
  reportNativeSessionId: (nativeSessionId: string) => void,
  managedSkills?: ManagedSkillRuntime,
  plan?: ClaudeLaunchPlan,
): Promise<AgentSessionRunResult> {
  const outputs = await SessionOutputFiles.start(workspacePath, emit);
  const command = resolveClaudeCommand();
  const stdoutPath = resolve(sessionDir, "claude-cli.stdout.log");
  const stderrPath = resolve(sessionDir, "claude-cli.stderr.log");
  const resultPath = resolve(sessionDir, "result.md");
  const basePrompt = plan?.cliPrompt ?? sessionPrompt(session, profile);
  const prompt = managedSkills
    ? `Use only the workspace skill catalog supplied in the system instructions.\n\n${basePrompt}`
    : basePrompt;
  const baseArgs = [
    "-p",
    "--add-dir",
    workspacePath,
    "--output-format",
    "text",
  ];
  const model = session.model?.trim() || profile.model?.trim();
  if (model) {
    baseArgs.push("--model", model);
  }
  const effort = claudeEffort(session, profile);
  if (effort) {
    baseArgs.push("--effort", effort);
  }

  const env = plan?.env ?? sessionEnvironment(workspacePath, profile, session);
  // Same precedence fix as the SDK path: the CLI also layers the user's
  // settings.json `env` over the spawned environment, so pin profile routing
  // and Foundry-owned guarantees (auto-compaction) through the
  // highest-priority flag-settings tier.
  const cliSettings = plan?.settings ?? {
    env: profileRuntimeEnvironment(profile, session),
    autoCompactEnabled: true,
    ...(managedSkills ? { disableBundledSkills: true } : {}),
  };
  baseArgs.push("--settings", JSON.stringify(cliSettings));
  if (plan) {
    baseArgs.push(...plan.cliArgs);
  } else if (managedSkills) {
    validateWorkspaceSkillPrompt(session.prompt, managedSkills);
    baseArgs.push(
      "--disable-slash-commands",
      "--setting-sources",
      "",
      "--append-system-prompt",
      [
        workspaceProjectInstructions(workspacePath),
        workspaceSkillInstructions(managedSkills),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  if (isUtilitySession(session)) {
    baseArgs.push(
      "--permission-mode",
      "plan",
      "--disallowedTools",
      "Write,Edit,Bash",
    );
  } else if (
    !session.claudePermissionMode &&
    !profile.claudePermissionMode &&
    env.FOUNDRY_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS === "1"
  ) {
    baseArgs.push("--dangerously-skip-permissions");
  } else {
    baseArgs.push("--permission-mode", claudePermissionMode(session, profile));
  }

  async function runClaude(args: string[]): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }> {
    await emit("Started Claude Code CLI", command);
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: workspacePath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timeoutMs = Number(
        process.env.FOUNDRY_SESSION_TIMEOUT_MS ??
          (isUtilitySession(session) ? 180000 : 900000),
      );
      const timeout = setTimeout(() => {
        killChildProcess(child);
      }, timeoutMs);

      // No-output watchdog: if the CLI produces no stdout/stderr for this
      // long, it is stuck (e.g. hanging on context compaction). Kill it so
      // the failure surfaces immediately instead of waiting for the full
      // session timeout.
      const noOutputTimeoutMs = Number(
        process.env.FOUNDRY_SESSION_NO_OUTPUT_TIMEOUT_MS ?? 300000,
      );
      let lastActivityAt = Date.now();
      const noOutputTimeout = setTimeout(() => {
        killChildProcess(child);
      }, noOutputTimeoutMs);
      const resetNoOutputTimeout = (): void => {
        lastActivityAt = Date.now();
        noOutputTimeout.refresh();
      };

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        resetNoOutputTimeout();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        resetNoOutputTimeout();
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        clearTimeout(noOutputTimeout);
        rejectRun(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        clearTimeout(noOutputTimeout);
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        writeFileSync(stdoutPath, stdoutText);
        writeFileSync(stderrPath, stderrText);
        writeFileSync(
          resultPath,
          `${stdoutText.trim() || "Claude Code CLI completed without a text response."}\n`,
        );
        resolveRun({ code, signal, stderr: stderrText.trim() });
      });
      sendPrompt(child, prompt);
    });
    return result;
  }

  let nativeSessionId =
    session.nativeSessionId?.trim() ||
    (isUtilitySession(session) ? "" : randomUUID());
  reportNativeSessionId(nativeSessionId);
  const sessionArgs = [...baseArgs];
  if (nativeSessionId) {
    sessionArgs.push(
      session.nativeSessionId?.trim() ? "--resume" : "--session-id",
      nativeSessionId,
    );
  }
  let result = await runClaude(sessionArgs);
  if (
    result.code !== 0 &&
    session.nativeSessionId?.trim() &&
    /No conversation found with session ID/i.test(result.stderr)
  ) {
    nativeSessionId = randomUUID();
    reportNativeSessionId(nativeSessionId);
    await emit(
      "Native Claude session was unavailable; starting a fresh leg",
      nativeSessionId,
      "warning",
    );
    result = await runClaude([...baseArgs, "--session-id", nativeSessionId]);
  }

  if (result.code !== 0) {
    throw new Error(
      `Claude Code CLI exited with ${result.signal ?? result.code}: ${friendlyClaudeCliError(result.stderr)}`,
    );
  }

  const response = existsSync(resultPath)
    ? readFileSync(resultPath, "utf8").trim()
    : "Claude Code CLI completed without a text response.";
  await outputs.reportChangedOnDisk();
  await emit("Claude Code CLI finished", resultPath);
  return {
    nativeSessionId,
    response: response || "Claude Code CLI completed without a text response.",
  };
}
