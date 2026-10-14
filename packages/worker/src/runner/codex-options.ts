import type {
  AgentProfileProjection,
  AgentSession,
} from "@bd777/foundry-protocol";
import { codexContextWindowConfig } from "../context-window.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import { sessionEnvironment } from "../session-ambient.js";
import { currentInput } from "../session-prompt.js";
import { isClarificationSession, isUtilitySession } from "../session-roles.js";
import { workspaceSkillInstructions } from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";

/** Codex's counterpart of defaultClaudePermissionMode (claude-options.ts). */
export const defaultCodexSandboxMode = "danger-full-access";

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
  if (isUtilitySession(session) || isClarificationSession(session))
    return "never";
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

/**
 * A compatible endpoint declared to Codex as its own
 * `[model_providers.<id>]`, not as the built-in `openai` provider with
 * `openai_base_url`: the built-in one opens the Responses WebSocket first,
 * which a compatible endpoint rejects (five reconnects, then the HTTPS
 * fallback); a declared provider speaks HTTPS only. The key is read from
 * CODEX_API_KEY; a keyless endpoint names none, since Codex refuses to start
 * when `env_key` names an unset variable.
 */
export function codexEndpointConfig(
  profile: AgentProfileLocalConfig,
  baseUrl: string,
  hasKey: boolean,
): Record<string, unknown> {
  const profileId = (profile.id ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  const id = profileId ? `foundry_${profileId}` : "foundry";
  return {
    model_provider: id,
    model_providers: {
      [id]: {
        name: profile.label?.trim() || id,
        base_url: baseUrl,
        wire_api: "responses",
        ...(hasKey ? { env_key: "CODEX_API_KEY" } : {}),
        supports_websockets: false,
      },
    },
  };
}

export function codexProfileConfig(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  if (profile.connectionType === "local_login")
    return { model_provider: "openai" };
  if (profile.codexModelProvider)
    return { model_provider: profile.codexModelProvider };
  const baseUrl = profile.baseUrl?.trim();
  if (!baseUrl) return {};
  return {
    ...codexEndpointConfig(profile, baseUrl, Boolean(env.CODEX_API_KEY)),
    ...(profile.contextWindow
      ? codexContextWindowConfig(profile.contextWindow)
      : {}),
  };
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
