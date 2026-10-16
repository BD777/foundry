/** Foundry's execution configuration, separate from native login/history storage. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  readFileSync,
  realpathSync,
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
          ? createHash("sha256").update(auth.OPENAI_API_KEY).digest("hex")
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
): NodeJS.ProcessEnv {
  if (profile.command || env.FOUNDRY_RUNTIME_CONFIG_ISOLATED === "1")
    return env;
  const source = resolve(codexHome(env));
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        profile.connectionType === "local_login" ||
        profile.codexProviderConfig?.requires_openai_auth === true
          ? accountIdentity("codex", env)
          : undefined,
        source,
        profile.id,
        profile.connectionType,
        workspacePath,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const home = foundryStatePath("native-runtime", "codex", identity);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // History is data, not executable configuration. Keep native ids and the
  // original SQLite index working without copying or forking live transcripts.
  for (const name of ["sessions", "archived_sessions"]) {
    const target = resolve(source, name),
      link = resolve(home, name);
    historyLink(link, target);
  }
  // Untrusted disables project .codex/config.toml, not AGENTS.md instructions.
  // No model catalog, provider, hooks, MCP or features are imported from the CLI.
  writeFileAtomic(
    resolve(home, "config.toml"),
    `sqlite_home = ${JSON.stringify(source)}\n[projects.${JSON.stringify(projectPath(workspacePath))}]\ntrust_level = "untrusted"\n`,
    { hardenParent: false, fsync: false },
  );
  return {
    ...env,
    CODEX_HOME: home,
    FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
    ...(profile.connectionType === "local_login" ||
    profile.codexProviderConfig?.requires_openai_auth === true
      ? { FOUNDRY_CODEX_AUTH_SOURCE: source }
      : {}),
  };
}

/** Native secure storage owns token refresh; only execution settings move. */
export function isolatedClaudeEnvironment(
  profile: AgentProfileLocalConfig,
  env: NodeJS.ProcessEnv,
  workspacePath: string,
): NodeJS.ProcessEnv {
  if (profile.command || env.FOUNDRY_RUNTIME_CONFIG_ISOLATED === "1")
    return env;
  const source = resolve(claudeConfigDir(env));
  const sourceGlobal = claudeGlobalConfigDir(env);
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        profile.connectionType === "local_login"
          ? accountIdentity("claude", env)
          : undefined,
        source,
        profile.id,
        profile.connectionType,
        workspacePath,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  const home = foundryStatePath("native-runtime", "claude", identity);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const history = resolve(source, "projects"),
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
    JSON.stringify(own.oauthAccount ?? null) !== JSON.stringify(account ?? null)
  ) {
    if (account === undefined) delete own.oauthAccount;
    else own.oauthAccount = account;
    writeFileAtomic(metadata, JSON.stringify(own), {
      hardenParent: false,
      fsync: false,
    });
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_SECURESTORAGE_CONFIG_DIR:
      profile.connectionType === "local_login"
        ? env.CLAUDE_SECURESTORAGE_CONFIG_DIR || source
        : home,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    FOUNDRY_RUNTIME_CONFIG_ISOLATED: "1",
  };
}
