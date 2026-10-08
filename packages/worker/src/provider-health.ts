import { claudeAccount, codexAccount } from "./native-account.js";
import { nativeCli, outdatedNote } from "./native-cli.js";
import { officialSkills } from "./official-skills.js";
import type { ProviderHealth, WorkerRuntimeId } from "@bd777/foundry-protocol";

type LocalProviderId = Exclude<WorkerRuntimeId, "mock">;

const claudeHealthCacheMs = 60_000;

let claudeLocalHealthCache:
  { expiresAt: number; value: ProviderHealth } | undefined;

/** Local readiness of each native runtime: can it run, and is it signed in. */
export function providerHealthData(): ProviderHealth[] {
  return (["claude", "codex"] as const).map((provider) => {
    const cli = nativeCli(provider);
    const health = providerHealthFor(provider, cli.installed);
    const note = outdatedNote(provider, cli);
    const official = officialSkills(provider);
    return {
      ...health,
      cli,
      ...(official
        ? {
            officialSkills: official.map(({ name, description }) => ({
              name,
              description,
            })),
          }
        : {}),
      ...(note
        ? {
            statusDetail: health.statusDetail
              ? `${health.statusDetail} ${note}`
              : note,
          }
        : {}),
    };
  });
}

function providerHealthFor(
  provider: LocalProviderId,
  // Foundry runs the device's program, never a copy of its own.
  runnable: boolean,
): ProviderHealth {
  const apiKey =
    provider === "claude"
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;

  if (provider === "claude" && !apiKey) {
    const localHealth = claudeLocalAuthHealth();
    if (!runnable) {
      return {
        provider,
        status: "unavailable",
        authMode: localHealth.authMode,
        secretStored: "local",
        statusDetail:
          localHealth.statusDetail ??
          "Claude Code is not installed on this device.",
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
      ? `${provider} credentials are configured, but ${provider === "claude" ? "Claude Code" : "Codex"} is not installed on this device.`
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
  if (!nativeCli("claude").installed) {
    return {
      provider: "claude",
      status: "missing_auth",
      authMode: "missing",
      secretStored: "local",
      statusDetail: "Claude Code is not installed on this device.",
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
