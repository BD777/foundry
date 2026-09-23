import { spawnSync } from "node:child_process";
import type { ProviderHealth } from "@foundry/protocol";
import { resolveClaudeCommand, resolveCodexCommand } from "./utils.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";

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

const cache = new Map<string, { until: number; health: ProviderHealth }>();
export function clearNativeLoginHealth(): void {
  cache.clear();
}

/** Native CLI status only: no inference and no provider HTTP health probes. */
export function nativeLoginHealth(runtime: "claude" | "codex"): ProviderHealth {
  const cached = cache.get(runtime);
  if (cached && cached.until > Date.now()) return cached.health;
  let health: ProviderHealth = {
    provider: runtime,
    status: "missing_auth",
    authMode: "missing",
    secretStored: "local",
  };
  try {
    const command =
      runtime === "claude" ? resolveClaudeCommand() : resolveCodexCommand();
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
            ? "Install the native agent CLI on this device."
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
  cache.set(runtime, { until: Date.now() + 60000, health });
  return health;
}
