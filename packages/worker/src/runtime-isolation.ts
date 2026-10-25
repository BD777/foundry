import { markPrivateInputOwner } from "./private-input-owners.js";
import { processIdentity } from "./agent-processes.js";
/** Foundry's execution configuration, separate from native login/history storage. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
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

/**
 * What a trusted Codex project would read at the workspace root (an
 * override first). Foundry keeps the project untrusted, so its own
 * .codex/config.toml stays out, and Codex then skips these files too: the
 * session's generated Codex home carries them as its AGENTS.md instead.
 */
function codexWorkspaceInstructions(workspacePath: string): string {
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    try {
      const text = readFileSync(resolve(workspacePath, name), "utf8").trim();
      if (Buffer.byteLength(text) > 128 * 1024)
        throw new Error(`Workspace instruction ${name} exceeds 128 KiB.`);
      if (text) return `Workspace instructions (${name}):\n${text}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return "";
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
    // Untrusted keeps the project's .codex/config.toml out, and with it
    // Codex skips the project's AGENTS.md: this home's own AGENTS.md, which
    // Codex reads for any project, carries the workspace's instructions.
    // No model catalog, provider, hooks, MCP, plugins or features are
    // imported from the CLI; with plugins off Codex also stops cloning its
    // plugin marketplace (about 100 MB) into every generated home.
    writeFileAtomic(
      resolve(home, "config.toml"),
      `sqlite_home = ${JSON.stringify(resolve(sources.dataHome))}\ncli_auth_credentials_store = "ephemeral"\n[features]\nmemories = false\nplugins = false\n[projects.${JSON.stringify(projectPath(workspacePath))}]\ntrust_level = "untrusted"\n`,
      { hardenParent: false, fsync: false },
    );
    const instructions = codexWorkspaceInstructions(workspacePath);
    const agentsFile = resolve(home, "AGENTS.md");
    if (instructions)
      writeFileAtomic(agentsFile, `${instructions}\n`, {
        hardenParent: false,
        fsync: false,
      });
    else rmSync(agentsFile, { force: true });
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
    // Copy identity metadata only, never settings, MCP configuration or tokens.
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
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_SECURESTORAGE_CONFIG_DIR:
          profile.connectionType === "local_login"
            ? (sources.credentialNamespace ?? source)
            : home,
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
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
