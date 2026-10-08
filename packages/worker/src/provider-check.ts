/**
 * Whether a provider found in the device's agent configuration really works.
 * Seeing an endpoint in a config file says nothing about it answering, so
 * each one is checked by a one-turn conversation through the agent's own SDK,
 * the way a chat would run it; never by calling the provider's API directly.
 * A result stands until the provider's configuration or the device's login
 * changes; a failure is retried after an hour.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderHealth } from "@bd777/foundry-protocol";
import { writeJSON } from "./storage.js";
import { resolveClaudeCommand, resolveCodexCommand } from "./utils.js";
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
import { codexProfileConfig, codexSessionEnvironment } from "./runner.js";
import { sessionEnvironment } from "./session-ambient.js";
import { claudeSettingsFile } from "./session-policy.js";

const checkTimeoutMs = 120_000;
const prompt = "Reply with the single word OK.";

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.trim().slice(0, 500) || "The agent did not answer.";
}

async function runCodexTurn(
  profile: AgentProfileLocalConfig,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const packageName = "@openai/codex-sdk";
  const sdk = (await import(packageName)) as {
    Codex: new (options: Record<string, unknown>) => {
      startThread: (options: Record<string, unknown>) => {
        runStreamed: (
          input: string,
          options: Record<string, unknown>,
        ) => Promise<{ events: AsyncIterable<CodexEvent> }>;
      };
    };
  };
  const env = codexSessionEnvironment(directory, profile);
  const codex = new sdk.Codex({
    codexPathOverride: resolveCodexCommand(),
    baseUrl: profile.codexModelProvider ? undefined : profile.baseUrl,
    apiKey: profile.codexModelProvider ? undefined : env.CODEX_API_KEY,
    env,
    config: codexProfileConfig(profile),
  });
  const thread = codex.startThread({
    workingDirectory: directory,
    skipGitRepoCheck: true,
    sandboxMode: "read-only",
    approvalPolicy: "never",
    networkAccessEnabled: false,
    webSearchMode: "disabled",
    model: profile.model?.trim() || undefined,
  });
  // Codex retries a failing provider quietly; its last reported error is
  // what tells the user why the provider does not answer.
  let lastError = "";
  try {
    const { events } = await thread.runStreamed(prompt, { signal });
    for await (const event of events) {
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
  const sdk = (await import(packageName)) as {
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
  for await (const message of sdk.query({
    prompt,
    options: {
      abortController,
      cwd: directory,
      env: sessionEnvironment(directory, profile),
      maxTurns: 1,
      pathToClaudeCodeExecutable: resolveClaudeCommand(),
      permissionMode: "default",
      settings: claudeSettingsFile(`provider-check:${profileID(profile)}`, {
        env: profileRuntimeEnvironment(profile),
      }),
      tools: [],
      ...(model ? { model } : {}),
    },
  })) {
    if (message.type === "result" && message.subtype !== "success")
      throw new Error(
        message.result || `Claude ended with ${message.subtype}.`,
      );
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
          : errorMessage(error),
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
