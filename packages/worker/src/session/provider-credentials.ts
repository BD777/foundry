import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveClaudeCommand } from "../utils.js";

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

function deviceClaudeCredentials(): string {
  return resolve(
    process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"),
    ".credentials.json",
  );
}

function deviceCodexAuth(): string {
  return resolve(
    process.env.CODEX_HOME ?? resolve(homedir(), ".codex"),
    "auth.json",
  );
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
): CredentialCopy[] {
  const copies: CredentialCopy[] = [];
  const claude = env.CLAUDE_CONFIG_DIR
    ? resolve(env.CLAUDE_CONFIG_DIR, ".credentials.json")
    : undefined;
  if (claude && claude !== deviceClaudeCredentials())
    copies.push({
      device: deviceClaudeCredentials(),
      sandbox: claude,
      project: sandboxClaudeCredentials,
    });
  const codex = env.CODEX_HOME
    ? resolve(env.CODEX_HOME, "auth.json")
    : undefined;
  if (codex && codex !== deviceCodexAuth())
    copies.push({
      device: deviceCodexAuth(),
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
    const next = `${copy.sandbox}.${process.pid}.next`;
    writeFileSync(next, projected, { mode: 0o600 });
    renameSync(next, copy.sandbox);
  }
}

/** When the device's claude.ai access token expires, if it can be renewed. */
export function claudeLoginExpiry(): number | undefined {
  const text = readText(deviceClaudeCredentials());
  const oauth = text ? parse(text)?.claudeAiOauth : undefined;
  if (!oauth || typeof oauth !== "object") return undefined;
  const { refreshToken, expiresAt } = oauth as Record<string, unknown>;
  return typeof refreshToken === "string" &&
    refreshToken &&
    typeof expiresAt === "number"
    ? expiresAt
    : undefined;
}

let renewal: Promise<RenewalOutcome> | undefined;
/** The expiry a renewal was last tried for, and when: it is tried once. */
let triedFor: { expiry: number; at: number } | undefined;

type RenewalOutcome = "fresh" | "renewed" | "not_renewed" | "no_login";

/**
 * The device's own Claude Code renews its login the way it always does:
 * before a request, under its lock, with the token about to expire. A
 * one-word answer is the smallest request it makes; nothing is kept of it.
 * Only a login within that window is renewed: Claude Code renews none
 * earlier. Never where the login file cannot be written: the provider
 * would rotate the refresh token and the device could not keep the new one.
 */
export function ensureFreshClaudeLogin(
  options: Parameters<typeof renewClaudeLogin>[0] = {},
): Promise<RenewalOutcome> {
  renewal ??= renewClaudeLogin(options).finally(() => {
    renewal = undefined;
  });
  return renewal;
}

async function renewClaudeLogin(
  options: {
    now?: () => number;
    expiry?: () => number | undefined;
    run?: (command: string, args: string[], cwd: string) => Promise<void>;
    writable?: () => boolean;
  } = {},
): Promise<RenewalOutcome> {
  const expiry = (options.expiry ?? claudeLoginExpiry)();
  if (expiry === undefined) return "no_login";
  const now = options.now ?? Date.now;
  if (expiry - now() > claudeRefreshWindowMs) return "fresh";
  // A renewal that left this expiry is not repeated for every check.
  if (
    triedFor?.expiry === expiry &&
    now() - triedFor.at < claudeRefreshWindowMs
  )
    return "not_renewed";
  if (!(options.writable ?? claudeLoginWritable)()) return "not_renewed";
  triedFor = { expiry, at: now() };
  const cwd = mkdtempSync(join(tmpdir(), "foundry-claude-login-"));
  try {
    await (options.run ?? runClaude)(
      resolveClaudeCommand(),
      [
        "--print",
        "Reply with the single word OK.",
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "project",
        "--model",
        "haiku",
      ],
      cwd,
    );
  } catch {
    // Reported below by the login it left.
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const after = (options.expiry ?? claudeLoginExpiry)();
  return after !== undefined && after - now() > claudeRefreshWindowMs
    ? "renewed"
    : "not_renewed";
}

function claudeLoginWritable(): boolean {
  const file = deviceClaudeCredentials();
  try {
    accessSync(dirname(file), constants.W_OK);
    accessSync(file, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The device's login and nothing else: no Foundry, no other credential. */
function claudeLoginEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
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

function runClaude(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd,
      env: claudeLoginEnvironment(),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
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
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void renew()
      .catch(() => undefined)
      .then(() => writeSandboxCredentials(copies))
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, options.intervalMs ?? 30_000);
  timer.unref();
  return () => clearInterval(timer);
}
