import { resolve } from "node:path";
import { claudeRunModel } from "../context-window.js";
import type { AgentSession } from "@bd777/foundry-protocol";
import type { NativeSessionStart } from "../native-session.js";
import {
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "../profiles.js";
import { sessionEnvironment, withoutSessionToken } from "../session-ambient.js";
import {
  claudeSessionOptions,
  claudeSettingsFile,
  type ClaudeLaunchPlan,
} from "../session-policy.js";
import { sessionPrompt } from "../session-prompt.js";
import type { SessionEventEmitter } from "../session-state.js";
import { claudeManagedPrompt } from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";
import { isPromptOnlySession, isUtilitySession } from "../session-roles.js";
import { resolveClaudeCommand } from "../native-cli.js";
import {
  claudeOperationBounds,
  type ClaudeOperationBounds,
} from "../watchdog.js";
import { activeRuntimeKey } from "./active-runtimes.js";
import {
  claudeEffort,
  claudeMaxTurns,
  claudePermissionMode,
} from "./claude-options.js";

export const claudeAgentSdkPackage = "@anthropic-ai/claude-agent-sdk";

export type ClaudeQueryFunction = (input: {
  options?: Record<string, unknown>;
  prompt: string | AsyncIterable<unknown>;
}) => AsyncIterable<unknown>;

export interface ClaudeTurnRequest {
  workspacePath: string;
  session: AgentSession;
  sessionDir: string;
  profile: AgentProfileLocalConfig;
  emit: SessionEventEmitter;
  emitSetup: () => Promise<void>;
  reportNativeSessionId: (nativeSessionId: string) => void;
  managedSkills?: ManagedSkillRuntime;
  plan?: ClaudeLaunchPlan;
  start?: NativeSessionStart;
}

/** One Claude turn as assembled before any runtime work: what every phase reads. */
export interface ClaudeTurnRun extends ClaudeTurnRequest {
  startedAt: number;
  command: string;
  messagesPath: string;
  stderrPath: string;
  resultPath: string;
  prompt: string;
  query: ClaudeQueryFunction;
  /** The flag-settings layer the process gets (see claudeTurnOptions). */
  flagSettings: Record<string, unknown>;
  /** Options shared by every process this turn's runtime key identifies. */
  baseOptions: Record<string, unknown>;
  runtimeKey: string;
  requestedNativeSessionId: string;
}

export async function prepareClaudeTurnRun(
  request: ClaudeTurnRequest,
): Promise<ClaudeTurnRun> {
  const startedAt = Date.now();
  const { workspacePath, session, sessionDir, profile, managedSkills, plan } =
    request;
  const command = resolveClaudeCommand();
  const prompt =
    plan?.prompt ??
    claudeManagedPrompt(sessionPrompt(session, profile), managedSkills);
  const query = await loadClaudeQuery();
  const { flagSettings, baseOptions } = claudeTurnOptions(request, command);
  return {
    ...request,
    startedAt,
    command,
    messagesPath: resolve(sessionDir, "claude-sdk.messages.jsonl"),
    stderrPath: resolve(sessionDir, "claude-sdk.stderr.log"),
    resultPath: resolve(sessionDir, "result.md"),
    prompt,
    query,
    flagSettings,
    baseOptions,
    runtimeKey: activeRuntimeKey(
      "claude",
      workspacePath,
      session,
      profile,
      baseOptions,
    ),
    requestedNativeSessionId: session.nativeSessionId?.trim() ?? "",
  };
}

async function loadClaudeQuery(): Promise<ClaudeQueryFunction> {
  const sdk = (await import(claudeAgentSdkPackage)) as {
    query?: ClaudeQueryFunction;
  };
  if (typeof sdk.query !== "function") {
    throw new Error(`${claudeAgentSdkPackage} does not export query()`);
  }
  return sdk.query;
}

function claudeTurnOptions(
  request: ClaudeTurnRequest,
  command: string,
): {
  flagSettings: Record<string, unknown>;
  baseOptions: Record<string, unknown>;
} {
  const { workspacePath, session, profile, managedSkills, plan } = request;
  const env =
    plan?.env ??
    withoutSessionToken(sessionEnvironment(workspacePath, profile, session));
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
  const flagSettings = plan?.settings ?? {
    env: profileRuntimeEnvironment(profile, session),
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
  if (maxTurns !== undefined) baseOptions.maxTurns = maxTurns;
  if (model) baseOptions.model = claudeRunModel(profile, model);
  if (effort) baseOptions.effort = effort;
  if (permissionMode === "bypassPermissions") {
    baseOptions.allowDangerouslySkipPermissions = true;
  }
  if (isUtilitySession(session)) {
    baseOptions.disallowedTools = ["Write", "Edit", "Bash"];
  }
  if (isPromptOnlySession(session)) baseOptions.tools = [];
  return { flagSettings, baseOptions };
}

/** Options for a new process: the base options, resuming or forking the native session. */
export function claudeProcessOptions(
  run: ClaudeTurnRun,
): Record<string, unknown> {
  const options = { ...run.baseOptions };
  if (run.start?.kind === "fork") {
    // The SDK copies the source into the id the server already claimed.
    options.resume = run.start.from;
    options.forkSession = true;
    options.sessionId = run.start.nativeSessionId;
  } else if (run.requestedNativeSessionId) {
    options.resume = run.requestedNativeSessionId;
  }
  return options;
}

/** Claude Code's own bounds, from the environment its process gets. */
export function claudeTurnOperationBounds(
  run: Pick<ClaudeTurnRun, "baseOptions" | "flagSettings">,
): ClaudeOperationBounds {
  const settingsEnv = (run.flagSettings as { env?: unknown }).env;
  return claudeOperationBounds({
    ...(run.baseOptions.env as Record<string, string | undefined>),
    ...(settingsEnv && typeof settingsEnv === "object"
      ? (settingsEnv as Record<string, string | undefined>)
      : {}),
  });
}
