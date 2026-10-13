import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProviderHealth } from "@bd777/foundry-protocol";
import {
  clearNativeCliCache,
  nativeCli,
  nativeCliInstallCommands,
  outdatedNote,
  resolveClaudeCommand,
  resolveCodexCommand,
} from "./native-cli.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { claudeConfigDir } from "./native-homes.js";

// `claude auth status` reports an account login as "claude.ai" (current CLIs)
// or "oauth_token"; API keys, key helpers and third-party gateways are not
// an official login.
const claudeAccountAuthMethods = new Set(["claude.ai", "oauth_token"]);

export function isNativeAccountStatus(
  runtime: "claude" | "codex",
  result: { status: number | null; stdout?: string; stderr?: string },
): boolean {
  if (result.status !== 0) return false;
  if (runtime === "codex")
    return /ChatGPT/i.test(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  try {
    const parsed = JSON.parse(result.stdout || "{}") as {
      loggedIn?: boolean;
      authMethod?: string;
    };
    return (
      parsed.loggedIn === true &&
      claudeAccountAuthMethods.has(parsed.authMethod ?? "")
    );
  } catch {
    return false;
  }
}

/** Claude Code renews a claude.ai access token this close to its expiry. */
export const claudeRenewalWindowMs = 5 * 60 * 1000;
// A CLI takes a moment to start; one checked just outside the window can be
// inside it by the time it reads the credentials.
const claudeStartupMarginMs = 60 * 1000;

export interface ClaudeStoredLogin {
  /** When the claude.ai access token expires, in epoch milliseconds. */
  expiresAt: number;
  renewable: boolean;
  subscriptionType?: string;
}

/**
 * The device's claude.ai login as the credentials file describes it: expiry
 * and plan only, never a token. Undefined where there is no such file (e.g.
 * macOS, which keeps the login in the keychain).
 */
export function claudeStoredLogin(
  configDir: string = claudeConfigDir(),
): ClaudeStoredLogin | undefined {
  let oauth: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(resolve(configDir, ".credentials.json"), "utf8"),
    );
    const value =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>).claudeAiOauth
        : undefined;
    oauth =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : undefined;
  } catch {
    return undefined;
  }
  if (!oauth || typeof oauth.expiresAt !== "number") return undefined;
  return {
    expiresAt: oauth.expiresAt,
    renewable: typeof oauth.refreshToken === "string" && !!oauth.refreshToken,
    ...(typeof oauth.subscriptionType === "string" && oauth.subscriptionType
      ? { subscriptionType: oauth.subscriptionType }
      : {}),
  };
}

/**
 * The stored login Claude Code would renew on start-up. It starts that
 * renewal without awaiting it, so a command that exits at once (`auth
 * status`, a session opened only to read its catalog) can end after the
 * provider rotated the refresh token but before the new one is saved,
 * signing the device out. Such commands are not run while this is set.
 */
export function claudeRenewalPending(
  now: number = Date.now(),
  login: ClaudeStoredLogin | undefined = claudeStoredLogin(),
): ClaudeStoredLogin | undefined {
  return login?.renewable &&
    login.expiresAt - now <= claudeRenewalWindowMs + claudeStartupMarginMs
    ? login
    : undefined;
}

const cache = new Map<string, { until: number; health: ProviderHealth }>();
export function clearNativeLoginHealth(): void {
  cache.clear();
  clearNativeCliCache();
}

/** Native CLI status only: no inference and no provider HTTP health probes. */
export function nativeLoginHealth(runtime: "claude" | "codex"): ProviderHealth {
  const cached = cache.get(runtime);
  if (cached && cached.until > Date.now()) return cached.health;
  const health = loginHealth(runtime);
  const cli = nativeCli(runtime);
  const note = outdatedNote(runtime, cli);
  const value: ProviderHealth = {
    ...health,
    cli,
    ...(note
      ? {
          statusDetail: health.statusDetail
            ? `${health.statusDetail} ${note}`
            : note,
        }
      : {}),
  };
  cache.set(runtime, { until: Date.now() + 60000, health: value });
  return value;
}

function loginHealth(runtime: "claude" | "codex"): ProviderHealth {
  let health: ProviderHealth = {
    provider: runtime,
    status: "missing_auth",
    authMode: "missing",
    secretStored: "local",
  };
  let command: string;
  try {
    command =
      runtime === "claude" ? resolveClaudeCommand() : resolveCodexCommand();
  } catch {
    // Not installed at all: say what to install, not that a check failed.
    health = {
      ...health,
      status: "unavailable",
      statusDetail: installHint(runtime),
    };
    return health;
  }
  if (runtime === "claude" && claudeRenewalPending())
    return {
      ...health,
      status: "healthy",
      authMode: "local_config",
      statusDetail:
        "Claude Code's stored login is due for renewal; it renews on its next request. Online account validity has not been verified.",
    };
  try {
    const result = spawnSync(
      command,
      runtime === "claude" ? ["auth", "status", "--json"] : ["login", "status"],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        env: { ...process.env, ...nativeLoginEnvironment(runtime) },
      },
    );
    if (result.error) {
      health = {
        ...health,
        status: "unavailable",
        statusDetail:
          (result.error as NodeJS.ErrnoException).code === "ENOENT"
            ? installHint(runtime)
            : "The native CLI status check did not complete. Retry after checking the device.",
      };
    } else {
      const signedIn = isNativeAccountStatus(runtime, result);
      health = {
        ...health,
        status: signedIn ? "healthy" : "missing_auth",
        authMode: signedIn ? "local_config" : "missing",
        accountLabel: undefined,
        statusDetail: signedIn
          ? "Native CLI reports a local login. Online account validity has not been verified."
          : `No official login in the worker's ${runtime === "codex" ? process.env.CODEX_HOME || "~/.codex" : process.env.CLAUDE_CONFIG_DIR || "~/.claude"} configuration. Other apps may use a different configuration.`,
      };
    }
  } catch {
    health = {
      ...health,
      status: "unavailable",
      statusDetail:
        "The native CLI could not report login status. Check its installation on this device.",
    };
  }
  return health;
}

/** How to install a runtime's native CLI on a device that lacks it. */
function installHint(runtime: "claude" | "codex"): string {
  return runtime === "claude"
    ? `Claude Code is not installed on this device. Install it from this device's page in Foundry, or run ${nativeCliInstallCommands.claude}; then sign in with \`claude\` and check again.`
    : `Codex is not installed on this device. Install it from this device's page in Foundry, or run ${nativeCliInstallCommands.codex}; then sign in with \`codex login\` and check again.`;
}
