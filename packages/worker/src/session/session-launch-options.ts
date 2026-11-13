import { serverMcpURL } from "../platform/server-link/server-mcp-forwarder.js";
import {
  markPrivateInputOwner,
  reapPrivateInputOwners,
} from "../platform/process/private-input-owners.js";
import type { PreparedExecution } from "./preparation/index.js";
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
//   - the workspace skills plugin
//   - preflight warnings (a custom connection that resolved no credential)
//
// The model never infers credentials: a missing credential is announced before
// the first request rather than surfacing as an opaque provider 401.

import { createHash, randomUUID } from "node:crypto";
import { privateConfigurationVersion } from "../harness/agent-runtime/private-identity.js";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentSession } from "@bd777/foundry-protocol";
import { foundryStatePath } from "../platform/state-root.js";
import { writeJSON } from "../platform/storage.js";
import type { AgentProfileLocalConfig } from "../harness/profiles.js";
import { profileRuntimeEnvironment } from "../harness/profiles.js";
import {
  foundryTokenEnvName,
  foundryToolsEndpoint,
  sessionEnvironment,
  withoutSessionToken,
} from "./session-ambient.js";
import type { ManagedSkillRuntime } from "../skills/skill-materializer.js";
import { claudeManagedPrompt } from "../skills/skill-materializer.js";
import { currentInput, sessionPrompt } from "./session-prompt.js";
import {
  clarificationFoundryTools,
  claudeRoleOptions,
  isClarificationSession,
  isUtilitySession,
  isVerificationSession,
} from "./session-roles.js";
import { verificationNotes } from "./verification-session.js";

/**
 * SDK launch keys for a workspace session. Claude Code loads what it loads
 * outside Foundry: the person's and the project's settings, CLAUDE.md,
 * skills, agents, commands, hooks and MCP servers. Foundry adds the
 * workspace's selected skills as a plugin and, for a verifier, its notes
 * (sessionDeviceNotes). A utility
 * session (Foundry's own helper) keeps none of the person's configuration.
 */
export function claudeSessionOptions(
  managed: ManagedSkillRuntime | undefined,
  deviceNotes = "",
  utility = false,
): Record<string, unknown> {
  const append = deviceNotes;
  return {
    ...(utility
      ? { settingSources: [], strictMcpConfig: true, skills: [] }
      : {}),
    mcpServers: {},
    plugins:
      managed?.skills.length && !utility
        ? [{ type: "local", path: managed.pluginDir }]
        : [],
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
 * - `env` keeps the selected profile's model and window authoritative even
 *   when the local settings file pins others. Its credential is written to
 *   no file (acquireClaudeSettings): the process has it in its environment.
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

/** Variables Claude Code authenticates with (its subprocess scrub list). */
const claudeCredentialNames = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
]);
// `TOKENS` is a count (CLAUDE_CODE_MAX_OUTPUT_TOKENS), not a credential.
const credentialNamed =
  /TOKEN(?!S)|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTHORIZATION/i;

/**
 * The part of a launch environment a settings file may carry: no credential.
 * The process gets its credential in its environment; Claude Code ignores
 * credential and endpoint variables in settings files anyway when the host
 * manages the provider (CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
 * code.claude.com/docs/en/env-vars). A file is readable by every agent the
 * same OS user runs; the environment of a process is not in any file. A
 * value that embeds a credential (a header, a URL with a key) goes too.
 */
export function claudeSettingsEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const credentials = Object.entries(env)
    .filter(
      ([name, value]) =>
        (claudeCredentialNames.has(name) || credentialNamed.test(name)) &&
        typeof value === "string" &&
        value.trim().length >= 8,
    )
    .map(([, value]) => value!.trim());
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        !claudeCredentialNames.has(entry[0]) &&
        !credentialNamed.test(entry[0]) &&
        !credentials.some((secret) => entry[1]!.includes(secret)),
    ),
  );
}

/** Settings as written to a file: their env without credentials. */
function withoutCredentials(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const env = settings.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return settings;
  return {
    ...settings,
    env: claudeSettingsEnvironment(env as Record<string, string | undefined>),
  };
}

/**
 * What makes Claude Code treat a folder as a CLAUDE.md project, so that by
 * default it reads that instead of AGENTS.md (code.claude.com/docs/en/memory,
 * "When Claude Code reads AGENTS.md").
 */
const claudeProjectInstructionNames = [
  "CLAUDE.md",
  join(".claude", "CLAUDE.md"),
  "CLAUDE.local.md",
];
/** The built-in plugin that reads AGENTS.md; before v2.1.285 `agents-md@builtin`. */
const agentsMdPluginId = "cc-plugin-agents-md@builtin";
const agentsMdPluginIds = [agentsMdPluginId, "agents-md@builtin"];

/**
 * Keeps Claude Code reading the project's AGENTS.md where it would outside
 * Foundry. Natively, a CLAUDE.md on the path from the working directory up
 * stops AGENTS.md from loading, except the person's own `~/.claude/CLAUDE.md`.
 * Foundry runs Claude with its own configuration directory that links the
 * person's files, so their `~/.claude` no longer counts as theirs: its
 * CLAUDE.md is an ancestor `.claude/CLAUDE.md` of every workspace in their
 * home, and AGENTS.md is skipped. When that file is the only CLAUDE.md on
 * the path, this asks for the documented `claude-md-and-agents-md`, which
 * loads what the native run loads. A value the person set stays theirs.
 */
export function nativeInstructionFileSettings(
  workspacePath: string,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (!configDir) return {};
  const own = existingRealPath(join(configDir, "CLAUDE.md"));
  if (!own || personChoseInstructionFiles(configDir)) return {};
  let ownOnPath = false;
  for (let dir = resolve(workspacePath); ; dir = dirname(dir)) {
    for (const name of claudeProjectInstructionNames) {
      const file = existingRealPath(join(dir, name));
      if (file === undefined) continue;
      if (file !== own) return {};
      ownOnPath = true;
    }
    if (dirname(dir) === dir) break;
  }
  if (!ownOnPath) return {};
  return {
    pluginConfigs: {
      [agentsMdPluginId]: {
        options: { instructionFiles: "claude-md-and-agents-md" },
      },
    },
  };
}

function existingRealPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES")
      return undefined;
    throw error;
  }
}

/** Whether the person's settings already choose which instruction files load. */
function personChoseInstructionFiles(configDir: string): boolean {
  let settings: { pluginConfigs?: Record<string, { options?: object }> };
  try {
    settings = JSON.parse(
      readFileSync(join(configDir, "settings.json"), "utf8"),
    );
  } catch {
    // Absent or unreadable: Claude Code reports a malformed file itself.
    return false;
  }
  return agentsMdPluginIds.some((id) => {
    const options = settings?.pluginConfigs?.[id]?.options;
    return (
      !!options &&
      ("instructionFiles" in options || "projectInstructions" in options)
    );
  });
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
 * What a session is told beyond its prompt, appended to Claude's system
 * prompt and given to Codex as developer_instructions: a verifier's own
 * notes, nothing otherwise. How to use Foundry reaches a session as its MCP
 * server's instructions, what the device offers through list_resources,
 * and the workspace's instructions (the person's assistant's included,
 * personal-agent-files.ts) through the runtime's native AGENTS.md loading.
 * `temporaryDirectory` is the session's TMPDIR.
 */
export function sessionDeviceNotes(
  workspacePath: string,
  session: AgentSession,
  temporaryDirectory?: string,
): string {
  if (!isVerificationSession(session)) return "";
  return verificationNotes({
    workspacePath,
    sessionId: session.id,
    temporaryDirectory,
  });
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

  const env = withoutSessionToken(
    input.execution?.native.env ??
      sessionEnvironment(workspacePath, profile, session),
  );
  const deviceNotes = sessionDeviceNotes(workspacePath, session, env.TMPDIR);
  const settings = {
    ...foundryClaudeSettings(profile, session, managedSkills),
    ...nativeInstructionFileSettings(workspacePath, env),
  };
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
      ...claudeSessionOptions(
        managedSkills,
        deviceNotes,
        isUtilitySession(session),
      ),
      // Foundry grants these tools and its server authorizes every call by
      // the session token; a headless session has nobody to approve a prompt.
      ...(mcpServers ? { allowedTools: [foundryToolsPermission] } : {}),
      // A role names every tool it may use, the Foundry ones included.
      ...role?.sdk,
    },
    mcpServers,
    managedSkills,
    warnings: credentialWarnings(profile, env),
    // Any skill or command the agent knows natively may be invoked.
    validatePrompt: () => {},
  };
}

/**
 * Claude Code reads its flag settings from a file here rather than inline:
 * inline they become a `--settings` argument, which anyone on the machine
 * can read. The file never holds a credential either (withoutCredentials):
 * every agent the same OS user runs can read it. Each file is immutable,
 * owner-only and reference counted; one execution host never clears another
 * host's active inputs.
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
  flagSettings: Record<string, unknown>,
): { path: string; release: () => void } {
  const settings = withoutCredentials(flagSettings);
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
  removeCredentialsFromSettingsFiles();
}

/**
 * Earlier Workers wrote the connection's key into these files. A running
 * Claude process keeps its file: it has its key in its environment, and
 * ignores one in a settings file (claudeSettingsEnvironment), so the key is
 * taken out in place. Returns how many files changed.
 */
export function removeCredentialsFromSettingsFiles(
  root = claudeSettingsDir(),
): number {
  let changed = 0;
  let owners: string[];
  try {
    owners = readdirSync(root);
  } catch {
    return 0;
  }
  for (const owner of owners) {
    const directory = join(root, owner);
    let names: string[];
    try {
      if (!lstatSync(directory).isDirectory()) continue;
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
      const path = join(directory, name);
      let settings: Record<string, unknown>;
      try {
        if (!lstatSync(path).isFile()) continue;
        settings = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (!settings || typeof settings !== "object") continue;
      const cleaned = withoutCredentials(settings);
      if (JSON.stringify(cleaned) === JSON.stringify(settings)) continue;
      writeJSON(path, cleaned);
      changed++;
    }
  }
  return changed;
}

/**
 * Keeps Codex's shell from passing the session token on: Codex reads it for
 * the Foundry tools (bearer_token_env_var) from its own environment, which
 * its commands would otherwise inherit. Codex's default excludes cover
 * `*TOKEN*` names in some versions only, and its shell snapshot writes the
 * whole environment, excluded names included, to a file under CODEX_HOME
 * that every command sources, so the snapshot is off.
 *
 * Commands also run without a login shell: `bash -lc` rebuilds PATH from
 * /etc/profile (Debian and Ubuntu reset it), which drops the session's tool
 * folder, so pinned package CLIs (olk, ...) were not found.
 */
export function codexSessionSecretsConfig(): {
  shell_environment_policy: { exclude: string[] };
  allow_login_shell: boolean;
  features: Record<string, boolean>;
} {
  return {
    shell_environment_policy: { exclude: [foundryTokenEnvName] },
    allow_login_shell: false,
    features: { shell_snapshot: false },
  };
}
