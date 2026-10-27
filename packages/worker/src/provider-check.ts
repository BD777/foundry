import { selectedExternalConnection } from "./external-connection.js";
import {
  registeredExternalConnection,
  withExternalCheck,
} from "./external-connection-registry.js";
import { loadClaudeSdk } from "./agent-runtime/claude-sdk.js";
/**
 * Whether a provider found in the device's agent configuration really works.
 * Seeing an endpoint in a config file says nothing about it answering, so
 * each one is checked by a one-turn conversation through the agent's own SDK,
 * the way a chat would run it; never by calling the provider's API directly.
 * A result stands until the provider's configuration or the device's login
 * changes; a failure is retried after an hour.
 */
import { CodexAppServerThread } from "./runner/codex-app-server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderHealth } from "@bd777/foundry-protocol";
import { writeJSON } from "./storage.js";
import { resolveClaudeCommand, resolveCodexCommand } from "./native-cli.js";
import {
  profileID,
  profileRuntimeEnvironment,
  type AgentProfileLocalConfig,
} from "./profiles.js";
import {
  needsProviderCheck,
  providerCheckDue,
  providerCheckFingerprint,
  providerChecksPath,
  readProviderChecks,
  type ProviderCheck,
} from "./provider-check-state.js";
import {
  codexProfileConfig,
  codexSessionEnvironment,
} from "./runner/codex-options.js";
import { sessionEnvironment } from "./session-ambient.js";
import { acquireClaudeSettings } from "./session-policy.js";
import { errorMessage } from "./utils.js";
import { redactTranscriptText } from "./secret-redaction.js";

const checkTimeoutMs = 120_000;
const prompt = "Reply with the single word OK.";

function checkErrorMessage(error: unknown): string {
  const text = redactTranscriptText(errorMessage(error));
  return text.trim().slice(0, 500) || "The agent did not answer.";
}

async function runCodexTurn(
  profile: AgentProfileLocalConfig,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const env = codexSessionEnvironment(directory, profile);
  const thread = new CodexAppServerThread(
    resolveCodexCommand(),
    env,
    codexProfileConfig(profile, env),
    {
      workingDirectory: directory,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      model: profile.model?.trim() || undefined,
    },
  );
  // Codex retries a failing provider quietly; its last reported error is
  // what tells the user why the provider does not answer.
  let lastError = "";
  try {
    const { events } = await thread.runStreamed(prompt, { signal });
    for await (const value of events) {
      const event = value as CodexEvent;
      const message =
        event.type === "error"
          ? event.message
          : event.type === "turn.failed"
            ? event.error?.message
            : event.item?.type === "error"
              ? event.item.message
              : undefined;
      if (message) lastError = message;
      if (event.type === "turn.failed")
        throw new Error(lastError || "The turn failed.");
    }
  } catch (error) {
    if (lastError && signal.aborted)
      throw new Error(`No answer within two minutes. Last error: ${lastError}`);
    throw error;
  }
}

interface CodexEvent {
  type: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; message?: string };
}

async function runClaudeTurn(
  profile: AgentProfileLocalConfig,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const packageName = "@anthropic-ai/claude-agent-sdk";
  const sdk = (await loadClaudeSdk()) as {
    query: (input: {
      prompt: string;
      options: Record<string, unknown>;
    }) => AsyncIterable<{ type?: string; subtype?: string; result?: string }>;
  };
  const abortController = new AbortController();
  signal.addEventListener("abort", () => abortController.abort(), {
    once: true,
  });
  const model = profile.model?.trim();
  const settings = acquireClaudeSettings(
    `provider-check:${profileID(profile)}`,
    { env: profileRuntimeEnvironment(profile) },
  );
  try {
    for await (const message of sdk.query({
      prompt,
      options: {
        abortController,
        cwd: directory,
        env: sessionEnvironment(directory, profile),
        maxTurns: 1,
        pathToClaudeCodeExecutable: resolveClaudeCommand(),
        connectionAdapter: selectedExternalConnection(profile),
        permissionMode: "default",
        settings: settings.path,
        tools: [],
        ...(model ? { model } : {}),
      },
    })) {
      if (message.type === "result" && message.subtype !== "success")
        throw new Error(
          message.result || `Claude ended with ${message.subtype}.`,
        );
    }
  } finally {
    settings.release();
  }
}

/** Runs one check now and records it. */
export async function checkProvider(
  profile: AgentProfileLocalConfig,
  health: ProviderHealth[],
): Promise<ProviderCheck> {
  const directory = mkdtempSync(join(tmpdir(), "foundry-provider-check-"));
  const timeout = AbortSignal.timeout(checkTimeoutMs);
  let check: ProviderCheck;
  try {
    if (profile.runtime === "codex")
      await runCodexTurn(profile, directory, timeout);
    else await runClaudeTurn(profile, directory, timeout);
    check = {
      status: "passed",
      checkedAt: new Date().toISOString(),
      fingerprint: providerCheckFingerprint(profile, health),
    };
  } catch (error) {
    check = {
      status: "failed",
      checkedAt: new Date().toISOString(),
      message:
        timeout.aborted && !String(error).includes("Last error")
          ? "The agent did not answer within two minutes."
          : checkErrorMessage(error),
      fingerprint: providerCheckFingerprint(profile, health),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  writeJSON(providerChecksPath(), {
    ...readProviderChecks(),
    [profileID(profile)]: check,
  });
  return check;
}

/**
 * The explicit check of one registered external connection, as
 * `foundry-worker connection check` and the Devices page run it. One at a
 * time per connection: a second request while one runs is refused.
 */
export async function checkExternalConnection(
  id: string,
): Promise<ProviderCheck & { profileId: string }> {
  const profile = registeredExternalConnection(id);
  return withExternalCheck(id, profile.label ?? id, async () => ({
    profileId: id,
    ...(await checkProvider(profile, [])),
  }));
}

let running: Promise<void> | undefined;

/**
 * Checks every discovered provider whose result is missing, stale or a
 * failure due for retry. They run side by side, so one provider that never
 * answers does not hold back the others, and each result is handed to
 * `onChecked` as it lands for the caller to re-report the device's profiles.
 */
export function checkDueProviders(
  profiles: AgentProfileLocalConfig[],
  health: ProviderHealth[],
  onChecked: () => void,
): Promise<void> {
  running ??= (async () => {
    try {
      const checks = readProviderChecks();
      await Promise.all(
        profiles
          .filter((profile) => profile.connectionType !== "external")
          .filter(needsProviderCheck)
          .filter((profile) =>
            providerCheckDue(profileID(profile), profile, health, checks),
          )
          .map((profile) => checkProvider(profile, health).then(onChecked)),
      );
    } finally {
      running = undefined;
    }
  })();
  return running;
}
