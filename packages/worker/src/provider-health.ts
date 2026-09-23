import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { claudeAccount, codexAccount } from "./native-account.js";
import { claudeCommandCandidates, codexCommandCandidates } from "./utils.js";
import type { ProviderHealth, WorkerRuntimeId } from "@foundry/protocol";

type LocalProviderId = Exclude<WorkerRuntimeId, "mock">;

const requireFromHere = createRequire(import.meta.url);
const claudeHealthCacheMs = 60_000;

let claudeLocalHealthCache:
  { expiresAt: number; value: ProviderHealth } | undefined;

/** Local readiness of each native runtime: can it run, and is it signed in. */
export function providerHealthData(): ProviderHealth[] {
  return [providerHealthFor("claude"), providerHealthFor("codex")];
}

function providerHealthFor(provider: LocalProviderId): ProviderHealth {
  // Sessions run through the SDK and fall back to the CLI, so either counts.
  const runnable = sdkInstalled(provider) || Boolean(executable(provider));
  const apiKey =
    provider === "claude"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

  if (provider === "claude" && !apiKey) {
    const localHealth = claudeLocalAuthHealth();
    if (!runnable) {
      return {
        provider,
        status:
          localHealth.authMode === "missing" ? "missing_auth" : "unavailable",
        authMode: localHealth.authMode,
        secretStored: "local",
        statusDetail:
          localHealth.statusDetail ?? "Claude CLI or SDK is not available.",
      };
    }
    return localHealth;
  }

  // Codex authentication is `auth.json`, not the presence of the binary: the
  // CLI reports "Not logged in" whenever that file is missing, and claiming
  // otherwise sent people to a device page that promised a working runtime.
  const codexLogin = provider === "codex" ? codexAccount() : undefined;
  const localAuth = provider === "codex" ? Boolean(codexLogin) : false;

  if (runnable && (apiKey || localAuth)) {
    return {
      provider,
      status: "healthy",
      accountLabel: apiKey ? undefined : codexLogin?.label,
      authMode: apiKey ? "env" : "local_config",
      secretStored: "local",
      statusDetail: apiKey ? "Environment key is configured." : undefined,
    };
  }

  return {
    provider,
    status: apiKey ? "unavailable" : "missing_auth",
    authMode: apiKey ? "env" : "missing",
    secretStored: "local",
    statusDetail: apiKey
      ? `${provider} credentials are configured, but neither its SDK nor its CLI was found.`
      : provider === "codex"
        ? "Codex is not signed in on this device. Run the official login here."
        : `${provider} credentials are not configured.`,
  };
}

function claudeLocalAuthHealth(): ProviderHealth {
  const now = Date.now();
  if (claudeLocalHealthCache && claudeLocalHealthCache.expiresAt > now) {
    return claudeLocalHealthCache.value;
  }
  const value = detectClaudeLocalAuthHealth();
  claudeLocalHealthCache = { expiresAt: now + claudeHealthCacheMs, value };
  return value;
}

function detectClaudeLocalAuthHealth(): ProviderHealth {
  if (!executable("claude")) {
    return {
      provider: "claude",
      status: "missing_auth",
      authMode: "missing",
      secretStored: "local",
      statusDetail: "Claude CLI was not found.",
    };
  }

  // Claude Code keeps credentials in the keychain, so the CLI stays the judge
  // of whether the session is live. The account beside them names the login.
  return {
    provider: "claude",
    status: "healthy",
    accountLabel: claudeAccount()?.label,
    authMode: "local_config",
    secretStored: "local",
  };
}

function sdkInstalled(provider: LocalProviderId): boolean {
  try {
    requireFromHere.resolve(
      provider === "claude"
        ? "@anthropic-ai/claude-agent-sdk"
        : "@openai/codex-sdk",
    );
    return true;
  } catch {
    return false;
  }
}

function executable(provider: LocalProviderId): string | undefined {
  const candidates =
    provider === "claude"
      ? claudeCommandCandidates()
      : codexCommandCandidates();
  return candidates.find((candidate) =>
    candidate === provider ? commandExists(candidate) : existsSync(candidate),
  );
}

function commandExists(command: string): boolean {
  return (
    spawnSync("sh", ["-lc", `command -v '${command}' >/dev/null 2>&1`], {
      stdio: "ignore",
    }).status === 0
  );
}
