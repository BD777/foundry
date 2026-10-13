import type { AgentSession } from "@bd777/foundry-protocol";
import { codexAgentExecutable } from "../agent-processes.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import {
  codexFoundryTools,
  codexSessionSecretsConfig,
  sessionDeviceNotes,
} from "../session-policy.js";
import { codexRoleOptions } from "../session-roles.js";
import {
  activeCodexThreads,
  type ActiveCodexThread,
  type CodexSDKThread,
  type SessionEventEmitter,
} from "../session-state.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { resolveCodexCommand } from "../native-cli.js";
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
  codexSpeed,
} from "./codex-options.js";

const codexSdkPackage = "@openai/codex-sdk";

export type CodexSdkClient = new (options?: Record<string, unknown>) => {
  startThread: (options?: Record<string, unknown>) => CodexSDKThread;
  resumeThread: (
    id: string,
    options?: Record<string, unknown>,
  ) => CodexSDKThread;
};

export async function loadCodexSdk(): Promise<CodexSdkClient> {
  const sdk = (await import(codexSdkPackage)) as { Codex?: CodexSdkClient };
  if (typeof sdk.Codex !== "function") {
    throw new Error(`${codexSdkPackage} does not export Codex`);
  }
  return sdk.Codex;
}

export interface CodexThreadRequest {
  workspacePath: string;
  session: AgentSession;
  profile: AgentProfileLocalConfig;
  /** The session's Codex environment (codexSessionEnvironment). */
  env: NodeJS.ProcessEnv;
  emit: SessionEventEmitter;
  emitSetup: () => Promise<void>;
  managedSkills?: ManagedSkillRuntime;
}

/**
 * The thread this turn runs on: the one in memory under the same runtime key
 * when it holds the requested native session, else a new or resumed one.
 */
export async function openCodexThread(
  Codex: CodexSdkClient,
  request: CodexThreadRequest,
): Promise<ActiveCodexThread> {
  const { workspacePath, session, profile, env, emit, managedSkills } = request;
  const codexCommand = resolveCodexCommand();
  // In the daemon the CLI leads a process group that dies with the worker.
  const codexPathOverride = codexAgentExecutable(codexCommand);
  const deviceNotes = sessionDeviceNotes(workspacePath, session, env.TMPDIR);
  const sessionConfig = codexSessionConfig(managedSkills, deviceNotes);
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
    { ...threadOptions, ...sessionConfig },
  );
  const activeThread = activeCodexThreads.get(runtimeKey);
  // A thread in memory continues only the native session it holds.
  if (
    activeThread &&
    (!activeThread.nativeSessionId ||
      activeThread.nativeSessionId === (requestedNativeSessionId ?? ""))
  ) {
    activeThread.lastUsed = Date.now();
    await emit(
      "Reused active Codex thread",
      activeThread.nativeSessionId || "in memory",
    );
    return activeThread;
  }
  await request.emitSetup();
  const secrets = codexSessionSecretsConfig();
  // A local login or a configured model provider brings its own endpoint
  // and credentials.
  const ownEndpoint =
    profile.connectionType === "local_login" || profile.codexModelProvider;
  const codex = new Codex({
    codexPathOverride,
    baseUrl: ownEndpoint ? undefined : profile.baseUrl,
    apiKey: ownEndpoint ? undefined : env.CODEX_API_KEY,
    env,
    config: {
      ...codexProfileConfig(profile),
      ...sessionConfig,
      ...codexFoundryTools(session)?.config,
      ...secrets,
      ...role?.config,
      features: {
        ...secrets.features,
        ...(role?.config?.features as Record<string, boolean> | undefined),
      },
    },
  });
  await emit("Started Codex SDK", `${codexSdkPackage} · ${codexCommand}`);
  const thread = requestedNativeSessionId
    ? codex.resumeThread(requestedNativeSessionId, threadOptions)
    : codex.startThread(threadOptions);
  const entry: ActiveCodexThread = {
    key: runtimeKey,
    lastUsed: Date.now(),
    nativeSessionId: requestedNativeSessionId || thread.id || "",
    thread,
  };
  activeCodexThreads.set(runtimeKey, entry);
  return entry;
}
