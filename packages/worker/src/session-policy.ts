// Session launch policy — the single place that defines how Foundry launches
// a native agent runtime. Everything a launch depends on is assembled here
// once and consumed by the Claude Agent SDK launch:
//
//   - effective session (workspace-skill isolation can force a fresh native
//     context) and the effective prompt (managed slash-command rewrite)
//   - the spawn environment: endpoint, model and credential routing
//   - flag-tier `settings`, which take precedence over the user's local
//     ~/.claude/settings.json. Foundry-owned guarantees live here, e.g.
//     auto-compaction stays enabled so a resumed long session surfaces a
//     compaction boundary instead of a hard "Prompt is too long" rejection.
//   - native skill-isolation options/args
//   - preflight warnings (a custom connection that resolved no credential)
//
// The model never infers credentials: a missing credential is announced before
// the first request rather than surfacing as an opaque provider 401.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { writeJSON } from "./storage.js";
import type { AgentProfileLocalConfig } from "./profiles.js";
import { profileRuntimeEnvironment } from "./profiles.js";
import {
  foundryTokenEnvName,
  foundryToolsEndpoint,
  sessionEnvironment,
  usesSessionScratch,
} from "./session-ambient.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import {
  claudeManagedPrompt,
  isolateSkillSession,
  validateWorkspaceSkillPrompt,
  workspaceSkillInstructions,
} from "./skill-isolation.js";
import { currentInput, sessionPrompt } from "./session-prompt.js";
import { sessionResourceNotes } from "./resource-pool.js";
import { isUtilitySession } from "./utils.js";
import {
  claudeRoleOptions,
  clarificationFoundryTools,
  isClarificationSession,
} from "./session-roles.js";

/** Raised when a managed-skill session cannot be enforced by the runtime. */
export class ClaudePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudePolicyError";
  }
}

/**
 * SDK launch keys for what a session is told and which skills it sees: the
 * device notes for every workspace session, plus the managed skill catalog.
 * Only the skill listing is filtered; the device's own Claude settings,
 * project instructions and MCP servers load as in the person's terminal.
 */
export function claudeSessionOptions(
  managed: ManagedSkillRuntime | undefined,
  deviceNotes = "",
): Record<string, unknown> {
  const append = [
    deviceNotes,
    managed ? workspaceSkillInstructions(managed) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(managed
      ? {
          // Claude Code's own skills stay; device-installed ones do not.
          skills: [
            ...(managed.officialSkills ?? []).map((skill) => skill.name),
            ...managed.skills.map((skill) => `foundry-workspace:${skill.name}`),
          ],
          plugins: managed.skills.length
            ? [{ type: "local", path: managed.pluginDir }]
            : [],
        }
      : {}),
    ...(append
      ? { systemPrompt: { type: "preset", preset: "claude_code", append } }
      : {}),
  };
}

/**
 * Foundry-authoritative Claude settings, injected at the flag-settings tier
 * (the highest-priority user-controlled layer). Values here override the
 * device user's ~/.claude/settings.json.
 *
 * - `env` keeps the selected profile's endpoint/model/credential authoritative
 *   even when the local settings file pins a different provider.
 * - `autoCompactEnabled: true` guarantees long resumed sessions compact
 *   before they overflow the model window. A user-level `false` previously
 *   caused hard "Prompt is too long" failures on resume.
 */
export function foundryClaudeSettings(
  profile: AgentProfileLocalConfig,
  session: AgentSession,
  managed?: ManagedSkillRuntime,
): Record<string, unknown> {
  return {
    env: profileRuntimeEnvironment(profile, session),
    autoCompactEnabled: true,
  };
}

/**
 * Resolve the credential a launch will actually present, from the fully
 * assembled spawn environment. Returns "" for official logins and for custom
 * endpoints that intentionally authenticate themselves.
 */
export function resolvedClaudeCredential(env: NodeJS.ProcessEnv): string {
  return (
    env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim() || ""
  );
}

/**
 * Preflight a custom (anthropic_compatible) connection. The architecture
 * legitimately supports keyless internal gateways, so a missing credential is
 * a warning rather than a hard failure — but it must be announced up front,
 * because when the endpoint does require auth the run dies with a raw 401.
 */
function credentialWarnings(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  if (profile.connectionType !== "anthropic_compatible") {
    return [];
  }
  if (resolvedClaudeCredential(env)) {
    return [];
  }
  const label = profile.label?.trim() || profile.id || "connection";
  return [
    `Custom connection "${label}" resolved no credential: no API key is set on the connection and the daemon environment provides none. If ${profile.baseUrl?.trim() || "the endpoint"} requires authentication, this run fails with 401. Use the server-managed connection of the same name, set an API key on this connection, or restart the daemon with the credential in its environment.`,
  ];
}

/**
 * Client-side limit for one Foundry tool call. The server waits at most ten
 * minutes in a waiting call (create_session / send_message with wait,
 * wait_session); the client must outlast that, or it gives up on a call the
 * server is still answering.
 */
export const foundryToolTimeoutMs = 11 * 60 * 1000;

/** Claude permission rule covering every tool of the `foundry` MCP server. */
const foundryToolsPermission = "mcp__foundry";

export interface ClaudeLaunchPlan {
  session: AgentSession;
  /** Managed-slash-rewritten prompt for the SDK path. */
  prompt: string;
  env: NodeJS.ProcessEnv;
  settings: Record<string, unknown>;
  sdk: Record<string, unknown>;
  /**
   * MCP servers for this turn (the Foundry tools with this turn's token). Kept
   * out of `sdk`: a reused runtime receives them per turn, so the runtime
   * identity does not change with every dispatch.
   */
  mcpServers?: Record<string, unknown>;
  managedSkills?: ManagedSkillRuntime;
  /** True when legacy native context was dropped for a new policy. */
  reset: boolean;
  warnings: string[];
  recordNativeSession: (nativeSessionId: string) => void;
  validatePrompt: (text: string) => void;
}

/**
 * The Foundry tools for a Codex session: the server's HTTP MCP, authorized by
 * the session token Codex reads from its own environment. Codex takes it as
 * SDK config.
 */
export function codexFoundryTools(
  session: AgentSession,
): { config: Record<string, unknown> } | undefined {
  const tools = foundryToolsEndpoint(session);
  if (!tools) return undefined;
  // Pre-approved like Claude's allowedTools: Foundry grants these tools and
  // its server authorizes every call by the session token; a headless
  // session has nobody to approve a prompt.
  // A clarification sees only the tools that read other sessions.
  const enabledTools = isClarificationSession(session)
    ? clarificationFoundryTools
    : undefined;
  const server = {
    url: tools.url,
    bearer_token_env_var: foundryTokenEnvName,
    default_tools_approval_mode: "approve",
    tool_timeout_sec: foundryToolTimeoutMs / 1000,
    ...(enabledTools ? { enabled_tools: enabledTools } : {}),
  };
  return {
    config: { mcp_servers: { foundry: server } },
  };
}

/**
 * Assemble the complete launch configuration for one Claude workspace
 * session. Custom profile commands are rejected here when a managed catalog is
 * present, because they cannot enforce the native-runtime contract.
 */
export function buildClaudeLaunchPlan(input: {
  workspacePath: string;
  session: AgentSession;
  profile: AgentProfileLocalConfig;
  managedSkills?: ManagedSkillRuntime;
}): ClaudeLaunchPlan {
  const { workspacePath, profile } = input;
  const originalSession = input.session;
  let session = originalSession;
  const managedSkills = input.managedSkills;

  let receipt: ((nativeSessionId: string) => void) | undefined;
  let reset = false;
  if (managedSkills) {
    validateWorkspaceSkillPrompt(currentInput(session).prompt, managedSkills);
    if (profile.command?.trim()) {
      throw new ClaudePolicyError(
        "Custom runtime commands cannot enforce workspace skill isolation.",
      );
    }
    const isolation = isolateSkillSession(
      session,
      workspacePath,
      managedSkills,
    );
    session = isolation.session;
    reset = isolation.reset;
    receipt = isolation.record;
  }

  const env = sessionEnvironment(workspacePath, profile, session);
  const deviceNotes = isUtilitySession(session)
    ? ""
    : sessionResourceNotes(
        workspacePath,
        undefined,
        usesSessionScratch(session) ? session.id : undefined,
      );
  const settings = foundryClaudeSettings(profile, session, managedSkills);
  const role = claudeRoleOptions(session);
  const tools = foundryToolsEndpoint(session);
  const mcpServers = tools && {
    foundry: {
      type: "http",
      url: tools.url,
      headers: { Authorization: `Bearer ${tools.token}` },
      timeout: foundryToolTimeoutMs,
    },
  };

  return {
    session,
    prompt: claudeManagedPrompt(sessionPrompt(session, profile), managedSkills),
    env,
    settings,
    sdk: {
      ...claudeSessionOptions(managedSkills, deviceNotes),
      // Foundry grants these tools and its server authorizes every call by
      // the session token; a headless session has nobody to approve a prompt.
      ...(mcpServers ? { allowedTools: [foundryToolsPermission] } : {}),
      // A role names every tool it may use, the Foundry ones included.
      ...role?.sdk,
    },
    mcpServers,
    managedSkills,
    reset,
    warnings: credentialWarnings(profile, env),
    recordNativeSession: (nativeSessionId: string) => {
      if (nativeSessionId) receipt?.(nativeSessionId);
    },
    validatePrompt: (text: string) => {
      if (managedSkills) {
        validateWorkspaceSkillPrompt(text, managedSkills);
      }
    },
  };
}

/**
 * Claude Code reads its flag settings from a file here rather than inline:
 * inline they become a `--settings` argument, and a process's arguments are
 * readable by anyone on the machine, while these settings carry the
 * connection's key. The file is owner-only; a session's process reads it at
 * start, and no process outlives the worker that cleared these at start.
 */
// A sandboxed (Issue) session writes beside its own files: the worker's
// state directory may not exist or be writable there.
const claudeSettingsDir = () =>
  process.env.FOUNDRY_EXECUTION_SESSION_ROOT
    ? join(process.env.FOUNDRY_EXECUTION_SESSION_ROOT, "claude-settings")
    : foundryStatePath("claude-settings");

export function claudeSettingsFile(
  key: string,
  settings: Record<string, unknown>,
): string {
  const path = join(
    claudeSettingsDir(),
    `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`,
  );
  mkdirSync(claudeSettingsDir(), { recursive: true, mode: 0o700 });
  writeJSON(path, settings);
  return path;
}

/** Removes settings files left by sessions of an earlier worker process. */
export function clearClaudeSettingsFiles(): void {
  rmSync(claudeSettingsDir(), { recursive: true, force: true });
}

/**
 * The Foundry tools server for a new Claude process, with its token read
 * from the process environment (Claude Code expands `${VAR}` in headers)
 * instead of written into the `--mcp-config` argument. A process already
 * running gets the literal token over its input stream instead, which no
 * other process can read.
 */
export function claudeLaunchMcpServers(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const config = server as { headers?: Record<string, string> };
      return [
        name,
        config.headers?.Authorization
          ? {
              ...config,
              headers: {
                ...config.headers,
                Authorization: `Bearer \${${foundryTokenEnvName}}`,
              },
            }
          : config,
      ];
    }),
  );
}
