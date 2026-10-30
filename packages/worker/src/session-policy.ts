import { serverMcpURL } from "./server-mcp-forwarder.js";
import {
  markPrivateInputOwner,
  reapPrivateInputOwners,
} from "./private-input-owners.js";
import { claudeWorkspaceInstructions } from "./workspace-instructions.js";
import type { PreparedExecution } from "./session/preparation/index.js";
export { claudeWorkspaceInstructions } from "./workspace-instructions.js";
// Session launch policy — the single place that defines how Foundry launches
// a native agent runtime. Everything a launch depends on is assembled here
// once and consumed by the Claude Agent SDK launch:
//
//   - the effective prompt (managed slash-command rewrite); which native
//     session the turn runs in is decided before, by native-session.ts
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

import { createHash, randomUUID } from "node:crypto";
import { privateConfigurationVersion } from "./agent-runtime/private-identity.js";
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
  withoutSessionToken,
  usesSessionScratch,
} from "./session-ambient.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import {
  claudeManagedPrompt,
  validateWorkspaceSkillPrompt,
  workspaceSkillInstructions,
} from "./skill-isolation.js";
import { currentInput, sessionPrompt } from "./session-prompt.js";
import { sessionResourceNotes } from "./resource-pool.js";
import { sessionConnectorNote } from "./connectors/index.js";
import {
  clarificationFoundryTools,
  claudeRoleOptions,
  isClarificationSession,
  isUtilitySession,
  isVerificationSession,
} from "./session-roles.js";
import { verificationNotes } from "./verification-session.js";

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
 * Settings and integrations come from Foundry only. Workspace instruction
 * documents are supplied separately, without loading their settings files.
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
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    skills: [],
    plugins: [],
    ...(managed?.skills.some((skill) => skill.draft) || managed?.excludedNames
      ? { disallowedTools: ["Agent", "Task"] }
      : {}),
    ...(managed
      ? {
          // Claude Code's own skills stay; device-installed ones do not.
          skills: [
            ...(managed.officialSkills ?? [])
              .filter((skill) => !managed.excludedNames?.includes(skill.name))
              .map((skill) => skill.name),
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
    env: {
      ...profileRuntimeEnvironment(profile, session),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
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
 * minutes in a waiting call (feishu_events, acquire_resource); the client
 * must outlast that, or it gives up on a call the
 * server is still answering.
 */
export const foundryToolTimeoutMs = 11 * 60 * 1000;

/** Claude permission rule covering every tool of the `foundry` MCP server. */
const foundryToolsPermission = "mcp__foundry";

export interface ClaudeLaunchPlan {
  execution?: PreparedExecution;
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
  warnings: string[];
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
    url: serverMcpURL(tools.url),
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
 * Fail-closed checks before any directory or process work: a managed
 * catalog rejects custom profile commands, which cannot enforce the
 * native-runtime contract, and prompts invoking skills it does not hold.
 */
export function validateClaudeLaunch(input: {
  session: AgentSession;
  profile: AgentProfileLocalConfig;
  managedSkills?: ManagedSkillRuntime;
}): void {
  if (!input.managedSkills) return;
  validateWorkspaceSkillPrompt(
    currentInput(input.session).prompt,
    input.managedSkills,
  );
  if (input.profile.command?.trim()) {
    throw new ClaudePolicyError(
      "Custom runtime commands cannot enforce workspace skill isolation.",
    );
  }
}

/** Each personal_agent session's latest assistant section, by session id. */
const personalAgentInstructionsBySession = new Map<
  string,
  { workspaceId: string; text: string }
>();

/**
 * Keeps a personal_agent session's assistant section (run_session's
 * personalAgentInstructions, docs/personal-agent.md §12) for every runtime
 * the session starts. The server sends it with each run; a run without it
 * keeps the last one, so a runtime started then (a timer's turn, a
 * continuation) is still the assistant, and its runtime key, which includes
 * the section, does not change for want of it. Memory only: the section
 * holds what the person may ask the assistant to forget, and the next run
 * brings the server's current one. Any other session's is ignored.
 */
export function keepPersonalAgentInstructions(
  session: AgentSession,
  instructions: string | undefined,
): void {
  const text = instructions?.trim();
  if (session.role !== "personal_agent" || !session.id || !text) return;
  personalAgentInstructionsBySession.set(session.id, {
    workspaceId: session.workspaceId,
    text,
  });
}

/** Drops the sections kept for a workspace's sessions (it was forgotten). */
export function forgetPersonalAgentInstructions(workspaceId: string): void {
  for (const [sessionId, kept] of personalAgentInstructionsBySession)
    if (kept.workspaceId === workspaceId)
      personalAgentInstructionsBySession.delete(sessionId);
}

/**
 * What a workspace session is told beyond its prompt, appended to Claude's
 * system prompt and given to Codex as developer_instructions: none for a
 * utility session, a verifier's own notes for a verifier; otherwise a
 * personal_agent session's assistant section first (a stable prefix), then
 * the Resource Pool's and the connectors' notes about the device it runs
 * on. `temporaryDirectory` is the session's TMPDIR.
 */
export function sessionDeviceNotes(
  workspacePath: string,
  session: AgentSession,
  temporaryDirectory?: string,
): string {
  if (isUtilitySession(session)) return "";
  if (isVerificationSession(session))
    return verificationNotes({
      workspacePath,
      sessionId: session.id,
      temporaryDirectory,
    });
  return [
    (session.role === "personal_agent" &&
      personalAgentInstructionsBySession.get(session.id)?.text) ||
      "",
    sessionResourceNotes(
      workspacePath,
      undefined,
      usesSessionScratch(session) ? session.id : undefined,
      session.id,
    ),
    sessionConnectorNote(session.id),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Assemble the complete launch configuration for one Claude workspace
 * session turn, on the native session it was prepared with.
 */
export function buildClaudeLaunchPlan(input: {
  workspacePath: string;
  session: AgentSession;
  profile: AgentProfileLocalConfig;
  managedSkills?: ManagedSkillRuntime;
  execution?: PreparedExecution;
}): ClaudeLaunchPlan {
  const { workspacePath, profile, session } = input;
  const managedSkills = input.managedSkills;
  validateClaudeLaunch(input);

  const env = withoutSessionToken(
    input.execution?.native.env ??
      sessionEnvironment(workspacePath, profile, session),
  );
  const deviceNotes = [
    sessionDeviceNotes(workspacePath, session, env.TMPDIR),
    isUtilitySession(session) || isVerificationSession(session)
      ? ""
      : claudeWorkspaceInstructions(workspacePath),
  ]
    .filter(Boolean)
    .join("\n\n");
  const settings = foundryClaudeSettings(profile, session, managedSkills);
  const role = claudeRoleOptions(session);
  const tools = foundryToolsEndpoint(session);
  const mcpServers = tools && {
    foundry: {
      type: "http",
      url: serverMcpURL(tools.url),
      headers: { Authorization: `Bearer ${tools.token}` },
      timeout: foundryToolTimeoutMs,
    },
  };

  return {
    execution: input.execution,
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
    warnings: credentialWarnings(profile, env),
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
 * connection's key. Each file is immutable, owner-only and reference counted;
 * one execution host never clears another host's active inputs.
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
  const lease = acquireClaudeSettings(key, settings);
  unleasedSettings.add(lease.release);
  return lease.path;
}

const settingsOwner = `${process.pid}-${randomUUID()}`;
const settingsLeases = new Map<string, number>();
const unleasedSettings = new Set<() => void>();

/** An immutable private settings file, held until every native owner releases it. */
export function acquireClaudeSettings(
  key: string,
  settings: Record<string, unknown>,
): { path: string; release: () => void } {
  const version = privateConfigurationVersion(settings);
  const directory = join(claudeSettingsDir(), settingsOwner);
  const path = join(
    directory,
    `${createHash("sha256")
      .update(key + ":" + version)
      .digest("hex")}.json`,
  );
  if (!settingsLeases.has(path)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    markPrivateInputOwner(directory, "claude-settings");
    writeJSON(path, settings);
  }
  settingsLeases.set(path, (settingsLeases.get(path) ?? 0) + 1);
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      const references = (settingsLeases.get(path) ?? 1) - 1;
      if (references > 0) settingsLeases.set(path, references);
      else {
        settingsLeases.delete(path);
        rmSync(path, { force: true });
      }
    },
  };
}

/** Legacy callers release only their own files, never another execution host's. */
export function clearClaudeSettingsFiles(): void {
  for (const release of unleasedSettings) release();
  unleasedSettings.clear();
  reapPrivateInputOwners(claudeSettingsDir(), "claude-settings");
}

/**
 * Keeps Codex's shell from passing the session token on: Codex reads it for
 * the Foundry tools (bearer_token_env_var) from its own environment, which
 * its commands would otherwise inherit. Codex's default excludes cover
 * `*TOKEN*` names in some versions only, and its shell snapshot writes the
 * whole environment, excluded names included, to a file under CODEX_HOME
 * that every command sources, so the snapshot is off.
 */
export function codexSessionSecretsConfig(): {
  shell_environment_policy: { exclude: string[] };
  features: Record<string, boolean>;
} {
  return {
    shell_environment_policy: { exclude: [foundryTokenEnvName] },
    features: { shell_snapshot: false },
  };
}
