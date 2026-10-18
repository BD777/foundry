import { withNativeSourceOverrides } from "../native-runtime-paths.js";
import type { AgentProfileLocalConfig } from "../profiles.js";
import { loadClaudeSdk } from "../agent-runtime/claude-sdk.js";
import { isolatedClaudeEnvironment } from "../runtime-isolation.js";
import { nativeLoginEnvironment } from "../native-login-environment.js";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claudeConfigDir, codexHome } from "../native-homes.js";
import { writeFileAtomic } from "../storage.js";
import { resolveClaudeCommand } from "../native-cli.js";

/**
 * The provider logins a sandboxed agent (an Issue's execution, clarification,
 * verifier) works with. Claude and Codex rotate refresh tokens: a refresh
 * inside a sandbox would leave the device holding a dead one and sign it out.
 * So a sandbox gets the device's access token only, never a refresh token,
 * and nothing it writes reaches the device's files. The device keeps its
 * login fresh with its own CLI; the copy follows it one way, device to
 * sandbox, while the sandbox runs.
 */

/** Claude Code refreshes an access token only this close to its expiry. */
export const claudeRefreshWindowMs = 5 * 60 * 1000;

interface CredentialCopy {
  device: string;
  sandbox: string;
  /** The sandbox's version of the device's file, or undefined for none. */
  project: (device: string) => string | undefined;
}

function deviceClaudeCredentials(env = process.env): string {
  return resolve(claudeConfigDir(env), ".credentials.json");
}

function deviceCodexAuth(env = process.env): string {
  return resolve(codexHome(env), "auth.json");
}

function parse(text: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The device's Claude login without what renews it: the claude.ai access
 * token and its expiry. Other entries (MCP servers' OAuth tokens) stay
 * behind.
 */
export function sandboxClaudeCredentials(device: string): string | undefined {
  const oauth = parse(device)?.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return undefined;
  const {
    refreshToken: _refresh,
    refreshTokenExpiresAt: _refreshExpiry,
    ...access
  } = oauth as Record<string, unknown>;
  return `${JSON.stringify({ claudeAiOauth: access }, null, 2)}\n`;
}

/**
 * The device's Codex login without its refresh token. Codex's ChatGPT
 * access tokens last ten days; an API key login passes through unchanged.
 */
export function sandboxCodexAuth(device: string): string | undefined {
  const auth = parse(device);
  if (!auth) return undefined;
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  const copy =
    tokens && typeof tokens === "object"
      ? { ...auth, tokens: { ...tokens, refresh_token: "" } }
      : auth;
  return `${JSON.stringify(copy, null, 2)}\n`;
}

/** The sandbox's copies of the device's provider logins, by its environment. */
export function sandboxCredentialCopies(
  env: NodeJS.ProcessEnv,
  profile?: AgentProfileLocalConfig,
): CredentialCopy[] {
  if (profile?.command) return [];
  const sourceEnv = withNativeSourceOverrides(process.env, profile?.env);
  const claudeSource = deviceClaudeCredentials(sourceEnv);
  const codexSource = deviceCodexAuth(sourceEnv);
  const copies: CredentialCopy[] = [];
  const claude = env.CLAUDE_CONFIG_DIR
    ? resolve(env.CLAUDE_CONFIG_DIR, ".credentials.json")
    : undefined;
  if (
    claude &&
    claude !== claudeSource &&
    (!profile ||
      (profile.runtime === "claude" &&
        profile.connectionType === "local_login"))
  )
    copies.push({
      device: claudeSource,
      sandbox: claude,
      project: sandboxClaudeCredentials,
    });
  const codex = env.CODEX_HOME
    ? resolve(env.CODEX_HOME, "auth.json")
    : undefined;
  if (
    codex &&
    codex !== codexSource &&
    (!profile ||
      (profile.runtime === "codex" &&
        (profile.connectionType === "local_login" ||
          profile.codexProviderConfig?.requires_openai_auth === true)))
  )
    copies.push({
      device: codexSource,
      sandbox: codex,
      project: sandboxCodexAuth,
    });
  return copies;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Brings the sandbox's copies up to the device's logins. A file is replaced
 * whole (written beside it, then renamed), so the agent never reads half of
 * one; one the device does not have is removed.
 */
export function writeSandboxCredentials(copies: CredentialCopy[]): void {
  for (const copy of copies) {
    const device = readText(copy.device);
    const projected = device === undefined ? undefined : copy.project(device);
    if (projected === undefined) {
      rmSync(copy.sandbox, { force: true });
      continue;
    }
    if (readText(copy.sandbox) === projected) continue;
    writeFileAtomic(copy.sandbox, projected, {
      hardenParent: false,
      fsync: false,
    });
  }
}

/** When the device's claude.ai access token expires, if it can be renewed. */
export function claudeLoginExpiry(env = process.env): number | undefined {
  const text = readText(deviceClaudeCredentials(env));
  const oauth = text ? parse(text)?.claudeAiOauth : undefined;
  if (!oauth || typeof oauth !== "object") return undefined;
  const { refreshToken, expiresAt } = oauth as Record<string, unknown>;
  return typeof refreshToken === "string" &&
    refreshToken &&
    typeof expiresAt === "number"
    ? expiresAt
    : undefined;
}

const renewals = new Map<string, Promise<RenewalOutcome>>();
/** The expiry a renewal was last tried for, and when: it is tried once. */
const attempted = new Map<string, { expiry: number; at: number }>();

type RenewalOutcome = "fresh" | "renewed" | "not_renewed" | "no_login";

/**
 * The device's own Claude Code renews its login the way it always does:
 * through a no-prompt native SDK account read. No model request is made.
 * Only a login within that window is checked; whether it was renewed is
 * determined from the original credential store, never assumed. Never where the login file cannot be written: the provider
 * would rotate the refresh token and the device could not keep the new one.
 */
export function ensureFreshClaudeLogin(
  options: Parameters<typeof renewClaudeLogin>[0] = {},
): Promise<RenewalOutcome> {
  const source = deviceClaudeCredentials(options.env);
  let renewal = renewals.get(source);
  if (!renewal) {
    renewal = renewClaudeLogin(options).finally(() => {
      renewals.delete(source);
    });
    renewals.set(source, renewal);
  }
  return renewal;
}

async function renewClaudeLogin(
  options: {
    env?: NodeJS.ProcessEnv;
    now?: () => number;
    expiry?: () => number | undefined;
    run?: (args: string[], cwd: string) => Promise<void>;
    writable?: () => boolean;
  } = {},
): Promise<RenewalOutcome> {
  const sourceEnv = options.env ?? process.env;
  const readExpiry = options.expiry ?? (() => claudeLoginExpiry(sourceEnv));
  const source = deviceClaudeCredentials(sourceEnv);
  const triedFor = attempted.get(source);
  const expiry = readExpiry();
  if (expiry === undefined) return "no_login";
  const now = options.now ?? Date.now;
  if (expiry - now() > claudeRefreshWindowMs) return "fresh";
  // A renewal that left this expiry is not repeated for every check.
  if (
    triedFor?.expiry === expiry &&
    now() - triedFor.at < claudeRefreshWindowMs
  )
    return "not_renewed";
  if (!(options.writable ?? (() => claudeLoginWritable(sourceEnv)))())
    return "not_renewed";
  attempted.set(source, { expiry, at: now() });
  const cwd = mkdtempSync(join(tmpdir(), "foundry-claude-login-"));
  try {
    await (
      options.run ??
      ((args, directory) => runClaude(args, directory, sourceEnv))
    )(["native-account-metadata"], cwd);
  } catch {
    // Reported below by the login it left.
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const after = readExpiry();
  return after !== undefined && after - now() > claudeRefreshWindowMs
    ? "renewed"
    : "not_renewed";
}

function claudeLoginWritable(env = process.env): boolean {
  const file = deviceClaudeCredentials(env);
  try {
    accessSync(dirname(file), constants.W_OK);
    accessSync(file, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The device's login and nothing else: no Foundry, no other credential. */
function claudeLoginEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sourceEnv,
    CLAUDE_CONFIG_DIR: claudeConfigDir(sourceEnv),
  };
  for (const key of Object.keys(env))
    if (
      key.startsWith("FOUNDRY_") ||
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDECODE",
      ].includes(key)
    )
      delete env[key];
  return env;
}

async function runClaude(
  _args: string[],
  cwd: string,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const { query } = await loadClaudeSdk();
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* noPrompt(): AsyncGenerator<never> {
    await closed;
  }
  const env = isolatedClaudeEnvironment(
    {
      runtime: "claude",
      id: "credential-maintenance",
      connectionType: "local_login",
    },
    {
      ...claudeLoginEnvironment(sourceEnv),
      ...nativeLoginEnvironment("claude"),
    },
    claudeConfigDir(sourceEnv),
  );
  const session = query({
    prompt: noPrompt(),
    options: {
      cwd,
      env,
      pathToClaudeCodeExecutable: resolveClaudeCommand(),
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      tools: [],
      skills: [],
      plugins: [],
      persistSession: false,
    },
  });
  const timer = setTimeout(() => {
    session.close();
    release();
  }, 30000);
  try {
    await session.accountInfo();
  } finally {
    clearTimeout(timer);
    session.close();
    release();
  }
}

/**
 * Keeps a running sandbox's copies current: the device renews its Claude
 * login as it nears expiry, and the copies follow. Claude Code in the
 * sandbox notices its credentials file changed before its next request.
 * Returns the stop function.
 */
export function keepSandboxCredentialsCurrent(
  copies: CredentialCopy[],
  options: {
    intervalMs?: number;
    renewClaude?: () => Promise<unknown>;
  } = {},
): () => void {
  if (copies.length === 0) return () => {};
  const renew = options.renewClaude ?? (() => ensureFreshClaudeLogin());
  let busy = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void renew()
      .catch(() => undefined)
      .then(() => {
        if (!stopped) writeSandboxCredentials(copies);
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs ?? 30_000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const copy of copies) rmSync(copy.sandbox, { force: true });
  };
}
