import { markPrivateInputOwner } from "./private-input-owners.js";
import { processIdentity } from "./agent-processes.js";
/** Foundry's execution configuration, separate from native login/history storage. */
import { createHash } from "node:crypto";
import { parse as parseTOML, stringify as stringifyTOML } from "smol-toml";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  codexHome,
  claudeConfigDir,
  claudeGlobalConfigDir,
} from "./native-homes.js";
import { foundryStatePath } from "./state-root.js";
import { writeFileAtomic } from "./storage.js";
import type { AgentProfileLocalConfig } from "./profiles.js";
import { privateConfigurationVersion } from "./agent-runtime/private-identity.js";
import {
  nativeSourcePaths,
  type NativeExecutionPaths,
} from "./native-runtime-paths.js";

const preparedPaths = new WeakMap<NodeJS.ProcessEnv, NativeExecutionPaths>();

/** Source/data/config locations of a prepared environment, without credentials. */
export function nativeExecutionPaths(
  env: NodeJS.ProcessEnv,
): NativeExecutionPaths | undefined {
  return preparedPaths.get(env);
}

function executionRoot(
  env: NodeJS.ProcessEnv,
  runtime: "claude" | "codex",
  identity: string,
): string {
  return env.FOUNDRY_EXECUTION_SESSION_ROOT
    ? resolve(
        env.FOUNDRY_EXECUTION_SESSION_ROOT,
        "native-runtime",
        runtime,
        identity,
      )
    : foundryStatePath("native-runtime", "owners", runtime, identity);
}

function recordPaths(
  env: NodeJS.ProcessEnv,
  paths: NativeExecutionPaths,
): NodeJS.ProcessEnv {
  preparedPaths.set(env, paths);
  markPrivateInputOwner(paths.configHome, "native-config");
  writeFileAtomic(
    resolve(paths.configHome, ".foundry-native-execution.json"),
    JSON.stringify(paths),
    { hardenParent: false, fsync: false },
  );
  return env;
}

function withGeneratedHome<T>(home: string, prepare: () => T): T {
  const existed = existsSync(home);
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    markPrivateInputOwner(home, "native-config");
    return prepare();
  } catch (error) {
    if (!existed) rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

function historyLink(link: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  try {
    symlinkSync(target, link, "dir");
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      readlinkSync(link) !== target
    )
      throw new Error("Managed native history path changed unexpectedly.");
  }
}
/**
 * The person's own configuration, linked into an execution home so the
 * native CLI reads it where it always does: their settings, instructions,
 * skills, agents, commands, rules, hooks and plugins. Credentials and
 * history are not among them (those have their own paths). A name the
 * source lacks is left out; a stale link Foundry made is replaced.
 */
function linkNativeConfiguration(
  home: string,
  source: string | undefined,
  names: readonly string[],
): void {
  if (!source || resolve(source) === resolve(home)) return;
  for (const name of names) {
    const target = resolve(source, name),
      link = resolve(home, name);
    let current: string | undefined;
    try {
      current = readlinkSync(link);
    } catch {
      /* Not a link: absent, or a file the CLI wrote itself. */
    }
    if (!existsSync(target)) {
      if (current !== undefined) rmSync(link, { force: true });
      continue;
    }
    if (current === target) continue;
    if (current !== undefined) rmSync(link, { force: true });
    else if (existsSync(link)) rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
}

/**
 * The person's own Claude configuration directory. A login's source is it;
 * an external connection's source is Foundry's credential store, so its
 * configuration is the person's default one (CLAUDE_CONFIG_DIR or ~/.claude).
 */
function personsClaudeConfiguration(
  source: string,
  env: NodeJS.ProcessEnv,
): string {
  const foundry = resolve(foundryStatePath());
  if (!resolve(source).startsWith(foundry)) return source;
  const own = env.CLAUDE_CONFIG_DIR?.trim();
  return own && !resolve(own).startsWith(foundry)
    ? own
    : resolve(env.HOME?.trim() || homedir(), ".claude");
}

/** What Claude Code reads from its configuration directory. */
const claudeConfigurationNames = [
  "settings.json",
  "CLAUDE.md",
  "rules",
  "skills",
  "agents",
  "commands",
  "output-styles",
  "plugins",
] as const;

/** What Codex reads from its home besides config.toml. */
const codexConfigurationNames = [
  "AGENTS.md",
  "AGENTS.override.md",
  "hooks.json",
  "prompts",
  "rules",
  "skills",
  "plugins",
  "memories",
] as const;

/**
 * The person's own config.toml, with the two keys an execution home needs:
 * its history index stays the native one and login tokens stay in memory.
 * The workspace counts as trusted (Foundry is where the person chose to
 * work there) unless they marked it otherwise.
 */
function codexConfiguration(
  source: string,
  dataHome: string,
  workspacePath: string,
): string {
  let config: Record<string, unknown> = {};
  try {
    config = parseTOML(readFileSync(resolve(source, "config.toml"), "utf8"));
  } catch {
    /* None, or not TOML: Codex would refuse it too; start from nothing. */
  }
  const projects = (
    config.projects && typeof config.projects === "object"
      ? config.projects
      : {}
  ) as Record<string, Record<string, unknown>>;
  const project = projectPath(workspacePath);
  if (!projects[project]?.trust_level)
    projects[project] = { ...projects[project], trust_level: "trusted" };
  return `${stringifyTOML({
    ...config,
    sqlite_home: resolve(dataHome),
    cli_auth_credentials_store: "ephemeral",
    projects,
  })}\n`;
}

function projectPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function accountIdentity(
  runtime: "codex" | "claude",
  env: NodeJS.ProcessEnv,
): unknown {
  try {
    if (runtime === "codex") {
      const auth = JSON.parse(
        readFileSync(resolve(codexHome(env), "auth.json"), "utf8"),
      );
      return [
        auth.auth_mode,
        auth.tokens?.account_id,
        auth.OPENAI_API_KEY
          ? privateConfigurationVersion(auth.OPENAI_API_KEY)
          : undefined,
      ];
    }
    const auth = JSON.parse(
      readFileSync(resolve(claudeGlobalConfigDir(env), ".claude.json"), "utf8"),
    ).oauthAccount;
    return [auth?.accountUuid, auth?.organizationUuid];
  } catch {
    return undefined;
  }
}

export function isolatedCodexEnvironment(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
  workspacePath: string,
  ownerId = env.FOUNDRY_SESSION_ID?.trim() || `metadata:${process.pid}`,
): NodeJS.ProcessEnv {
  if (profile.command) return env;
  const sources = nativeSourcePaths("codex", env);
  const source = resolve(sources.credentialHome);
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        ownerId,
        processIdentity(process.pid)?.startTime,
        process.pid,
        profile.connectionType === "local_login" ||
        profile.codexProviderConfig?.requires_openai_auth === true
          ? accountIdentity("codex", env)
          : undefined,
        source,
        sources.dataHome,
        profile.id,
        profile.connectionType,
        workspacePath,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const home = executionRoot(env, "codex", identity);
  return withGeneratedHome(home, () => {
    // History is data, not executable configuration. Keep native ids and the
    // original SQLite index working without copying or forking live transcripts.
    for (const name of ["sessions", "archived_sessions"]) {
      const target = resolve(sources.dataHome, name),
        link = resolve(home, name);
      historyLink(link, target);
    }
    // Codex reads the person's own configuration, as it does outside
    // Foundry; the session pins provider, model and window with -c and its
    // thread config, which take precedence.
    writeFileAtomic(
      resolve(home, "config.toml"),
      codexConfiguration(source, sources.dataHome, workspacePath),
      { hardenParent: false, fsync: false },
    );
    linkNativeConfiguration(home, source, codexConfigurationNames);
    const { FOUNDRY_CODEX_AUTH_SOURCE: _previousAuthSource, ...base } = env;
    return recordPaths(
      {
        ...base,
        CODEX_HOME: home,
        FOUNDRY_NATIVE_CODEX_SOURCE_HOME: source,
        FOUNDRY_NATIVE_CODEX_DATA_HOME: sources.dataHome,
        FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
        ...(profile.connectionType === "local_login" ||
        profile.codexProviderConfig?.requires_openai_auth === true
          ? { FOUNDRY_CODEX_AUTH_SOURCE: source }
          : {}),
      },
      {
        version: 1,
        runtime: "codex",
        ownerId,
        workspacePath,
        sources,
        configHome: home,
      },
    );
  });
}

/** Native secure storage owns token refresh; only execution settings move. */
export function isolatedClaudeEnvironment(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
  workspacePath: string,
  ownerId = env.FOUNDRY_SESSION_ID?.trim() || `metadata:${process.pid}`,
): NodeJS.ProcessEnv {
  if (profile.command) return env;
  if (
    profile.connectionType === "external" &&
    profile.preparedExternalConfigHome
  ) {
    const path = profile.preparedExternalConfigHome;
    const record = JSON.parse(
      readFileSync(resolve(path, ".foundry-native-execution.json"), "utf8"),
    ) as NativeExecutionPaths;
    if (
      env.CLAUDE_CONFIG_DIR !== path ||
      record.version !== 1 ||
      record.runtime !== "claude" ||
      record.configHome !== path ||
      record.ownerId !== ownerId ||
      record.workspacePath !== workspacePath
    )
      throw new Error(
        "Prepared external configuration does not belong to this execution.",
      );
    preparedPaths.set(env, record);
    return env;
  }
  const sources = nativeSourcePaths("claude", env);
  const source = resolve(sources.credentialHome);
  const sourceGlobal = sources.globalConfigHome;
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        ownerId,
        processIdentity(process.pid)?.startTime,
        process.pid,
        profile.connectionType === "local_login"
          ? accountIdentity("claude", env)
          : undefined,
        source,
        sources.dataHome,
        profile.id,
        profile.connectionType,
        workspacePath,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const home = executionRoot(env, "claude", identity);
  return withGeneratedHome(home, () => {
    const history = resolve(sources.dataHome, "projects"),
      link = resolve(home, "projects");
    historyLink(link, history);
    linkNativeConfiguration(
      home,
      personsClaudeConfiguration(
        sources.configurationSourceHome ?? source,
        env,
      ),
      claudeConfigurationNames,
    );
    // Copy identity metadata only, never MCP configuration or tokens.
    let account: unknown;
    if (profile.connectionType === "local_login") {
      try {
        account = JSON.parse(
          readFileSync(resolve(sourceGlobal, ".claude.json"), "utf8"),
        ).oauthAccount;
      } catch {}
    }
    const metadata = resolve(home, ".claude.json");
    let own: Record<string, unknown> = {};
    try {
      own = JSON.parse(readFileSync(metadata, "utf8"));
    } catch {}
    if (
      !existsSync(metadata) ||
      JSON.stringify(own.oauthAccount ?? null) !==
        JSON.stringify(account ?? null)
    ) {
      if (account === undefined) delete own.oauthAccount;
      else own.oauthAccount = account;
      writeFileAtomic(metadata, JSON.stringify(own), {
        hardenParent: false,
        fsync: false,
      });
    }
    return recordPaths(
      {
        ...env,
        CLAUDE_CONFIG_DIR: home,
        FOUNDRY_NATIVE_CLAUDE_SOURCE_HOME: source,
        FOUNDRY_NATIVE_CLAUDE_CONFIG_HOME: sources.configurationSourceHome,
        FOUNDRY_NATIVE_CLAUDE_CREDENTIAL_NAMESPACE:
          sources.credentialNamespace ?? source,
        FOUNDRY_NATIVE_CLAUDE_DATA_HOME: sources.dataHome,
        FOUNDRY_NATIVE_CLAUDE_GLOBAL_HOME: sourceGlobal,
        CLAUDE_SECURESTORAGE_CONFIG_DIR:
          profile.connectionType === "local_login"
            ? (sources.credentialNamespace ?? source)
            : home,
        FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
      },
      {
        version: 1,
        runtime: "claude",
        ownerId,
        workspacePath,
        sources,
        configHome: home,
      },
    );
  });
}
