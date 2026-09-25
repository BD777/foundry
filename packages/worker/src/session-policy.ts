// Session launch policy — the single place that defines how Foundry launches
// a native agent runtime. Everything a launch depends on is assembled here
// once and consumed identically by every execution path (Claude SDK, Claude
// CLI fallback), so the two paths can no longer drift:
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

import type { AgentSession } from "@foundry/protocol";
import type { AgentProfileLocalConfig } from "./profiles.js";
import { profileRuntimeEnvironment } from "./profiles.js";
import { sessionEnvironment } from "./session-ambient.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";
import {
  claudeManagedPrompt,
  isolateSkillSession,
  validateWorkspaceSkillPrompt,
  workspaceProjectInstructions,
  workspaceSkillInstructions,
} from "./skill-isolation.js";
import { sessionPrompt } from "./session-prompt.js";

/** Raised when a managed-skill session cannot be enforced by the runtime. */
export class ClaudePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudePolicyError";
  }
}

/**
 * SDK-only launch keys for workspace skill isolation. Kept here so the
 * encapsulation owns the full managed surface; runner re-exports it for the
 * existing tests/script callers.
 */
export function claudeManagedSkillOptions(
  managed: ManagedSkillRuntime | undefined,
  workspacePath?: string,
): Record<string, unknown> {
  if (!managed) return {};
  return {
    settingSources: [],
    skills: managed.skills.map((skill) => `foundry-workspace:${skill.name}`),
    plugins: managed.skills.length
      ? [{ type: "local", path: managed.pluginDir }]
      : [],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: [
        workspacePath ? workspaceProjectInstructions(workspacePath) : "",
        workspaceSkillInstructions(managed),
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  };
}

/**
 * CLI-fallback-only flags for workspace skill isolation. The CLI cannot take
 * the SDK's structured `skills`/`plugins` options, so native slash skills are
 * disabled and the managed catalog is supplied through system instructions.
 */
export function claudeManagedCliArgs(
  managed: ManagedSkillRuntime | undefined,
  workspacePath: string,
): string[] {
  if (!managed) return [];
  return [
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--append-system-prompt",
    [
      workspaceProjectInstructions(workspacePath),
      workspaceSkillInstructions(managed),
    ]
      .filter(Boolean)
      .join("\n\n"),
  ];
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
 * - `disableBundledSkills` only applies under a managed workspace catalog.
 */
export function foundryClaudeSettings(
  profile: AgentProfileLocalConfig,
  session: AgentSession,
  managed?: ManagedSkillRuntime,
): Record<string, unknown> {
  return {
    env: profileRuntimeEnvironment(profile, session),
    autoCompactEnabled: true,
    ...(managed ? { disableBundledSkills: true } : {}),
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

export interface ClaudeLaunchPlan {
  session: AgentSession;
  /** Managed-slash-rewritten prompt for the SDK path. */
  prompt: string;
  /**
   * Unrewritten prompt for the CLI fallback: under managed skills the CLI has
   * slash dispatch disabled and reads the catalog from system instructions.
   */
  cliPrompt: string;
  env: NodeJS.ProcessEnv;
  settings: Record<string, unknown>;
  sdk: Record<string, unknown>;
  cliArgs: string[];
  managedSkills?: ManagedSkillRuntime;
  /** True when legacy native context was dropped for a new policy. */
  reset: boolean;
  warnings: string[];
  recordNativeSession: (nativeSessionId: string) => void;
  validatePrompt: (text: string) => void;
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
    validateWorkspaceSkillPrompt(session.prompt, managedSkills);
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
  const settings = foundryClaudeSettings(profile, session, managedSkills);

  return {
    session,
    prompt: claudeManagedPrompt(sessionPrompt(session, profile), managedSkills),
    cliPrompt: sessionPrompt(session, profile),
    env,
    settings,
    sdk: claudeManagedSkillOptions(managedSkills, workspacePath),
    cliArgs: claudeManagedCliArgs(managedSkills, workspacePath),
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
