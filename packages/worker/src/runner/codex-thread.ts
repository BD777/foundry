import type { AgentSession } from "@bd777/foundry-protocol";
import { CodexAppServerThread } from "./codex-app-server.js";
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
import { codexTransportPlan } from "./codex-transport.js";

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
  request: CodexThreadRequest,
): Promise<ActiveCodexThread> {
  const { workspacePath, session, profile, env, emit, managedSkills } = request;
  const codexCommand = resolveCodexCommand();
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
  const profileConfig = codexProfileConfig(profile, env);
  cleanupActiveCodexThreads();
  const runtimeKey = activeRuntimeKey(
    "codex",
    workspacePath,
    session,
    profile,
    // A transport learned since the thread started starts a new Codex.
    {
      ...threadOptions,
      ...sessionConfig,
      profileConfig,
      configurationHome: env.CODEX_HOME,
      transport: codexTransportPlan(profile),
    },
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
  const clientOptions = {
    config: {
      ...profileConfig,
      ...sessionConfig,
      ...codexFoundryTools(session)?.config,
      ...secrets,
      ...role?.config,
      features: {
        ...secrets.features,
        ...(role?.config?.features as Record<string, boolean> | undefined),
      },
    },
  };
  await emit("Started Codex", `native app-server · ${codexCommand}`);
  await emit(
    "Execution configuration",
    `Foundry-managed configuration: ${env.CODEX_HOME}. Native user/project settings are not inherited.`,
  );
  const thread = new CodexAppServerThread(
    codexCommand,
    env,
    clientOptions.config,
    threadOptions,
    requestedNativeSessionId,
  );
  const entry: ActiveCodexThread = {
    key: runtimeKey,
    lastUsed: Date.now(),
    nativeSessionId: requestedNativeSessionId || thread.id || "",
    thread,
  };
  activeCodexThreads.set(runtimeKey, entry);
  return entry;
}
