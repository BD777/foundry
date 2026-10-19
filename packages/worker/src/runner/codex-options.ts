import { isolatedCodexEnvironment } from "../runtime-isolation.js";
import type {
  AgentProfileProjection,
  AgentSession,
} from "@bd777/foundry-protocol";
import { codexContextWindowConfig } from "../context-window.js";
import {
  codexTransportPlan,
  codexWebsocketConnectTimeoutMs,
} from "./codex-transport.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import { sessionEnvironment } from "../session-ambient.js";
import { currentInput } from "../session-prompt.js";
import { isClarificationSession, isUtilitySession } from "../session-roles.js";
import { workspaceSkillInstructions } from "../skill-isolation.js";
import type { ManagedSkillRuntime } from "../skill-materializer.js";

/** Codex's counterpart of defaultClaudePermissionMode (claude-options.ts). */
export const defaultCodexSandboxMode = "danger-full-access";

/**
 * The Codex SDK passes every config value as one `--config key=value`
 * argument, and Linux refuses to start a process with one argument over
 * 128 KiB (MAX_ARG_STRLEN: "spawn E2BIG"). Codex has no file form of
 * developer_instructions, so what a session is told stays bounded instead:
 * large bundles and a long catalog's tail are one entry each with an index
 * file (skillCatalog in skill-materializer.ts).
 */
export const codexArgumentLimit = 128 * 1024;

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
  // Room for the key and TOML quoting, which escapes quotes and newlines.
  const argument = JSON.stringify(instructions).length + 64;
  if (argument > codexArgumentLimit)
    throw new Error(
      `This Codex session's instructions take ${Math.ceil(argument / 1024)} KiB, more than the ${codexArgumentLimit / 1024} KiB one process argument may hold.`,
    );
  return {
    ...(managed?.skills.some((skill) => skill.draft) || managed?.excludedNames
      ? { features: { multi_agent: false } }
      : {}),
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
 * `openai_base_url`: the built-in one always opens the Responses WebSocket
 * first, which many compatible endpoints reject (five reconnects, then the
 * HTTPS fallback). Whether this one may is `websockets`, decided per
 * endpoint (codex-transport.ts); with it each handshake is bounded. The key
 * is read from CODEX_API_KEY; a keyless endpoint names none, since Codex
 * refuses to start when `env_key` names an unset variable.
 */
export function codexEndpointConfig(
  profile: AgentProfileLocalConfig,
  baseUrl: string,
  hasKey: boolean,
  websockets = false,
): Record<string, unknown> {
  const profileId = (profile.id ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  const id = profileId ? `foundry_${profileId}` : "foundry";
  return {
    model_provider: id,
    model_providers: {
      [id]: {
        ...profile.codexProviderConfig,
        name: profile.label?.trim() || id,
        base_url: baseUrl,
        wire_api: "responses",
        ...(hasKey ? { env_key: "CODEX_API_KEY" } : {}),
        supports_websockets: websockets,
        ...(websockets
          ? { websocket_connect_timeout_ms: codexWebsocketConnectTimeoutMs }
          : {}),
      },
    },
  };
}

export function codexProfileConfig(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  if (profile.connectionType === "local_login")
    return {
      model_provider: "openai",
      ...(profile.contextWindow
        ? codexContextWindowConfig(profile.contextWindow)
        : {}),
    };
  const baseUrl = profile.baseUrl?.trim();
  if (!baseUrl) return {};
  return {
    ...codexEndpointConfig(
      profile,
      baseUrl,
      Boolean(env.CODEX_API_KEY),
      codexTransportPlan(profile).websockets,
    ),
    ...(profile.contextWindow
      ? codexContextWindowConfig(profile.contextWindow)
      : {}),
  };
}

export function codexSessionEnvironment(
  workspacePath: string,
  profile: AgentProfileLocalConfig,
  session?: AgentSession,
  ownerId?: string,
): NodeJS.ProcessEnv {
  const env = sessionEnvironment(workspacePath, profile, session, ownerId);
  // The native CLI reads CODEX_API_KEY; the generic OpenAI alias alone is
  // insufficient for a server-dispatched compatible connection.
  if (profile.connectionType !== "local_login" && env.OPENAI_API_KEY)
    env.CODEX_API_KEY = env.OPENAI_API_KEY;
  return isolatedCodexEnvironment(profile, env, workspacePath, ownerId);
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
