import { homedir } from "node:os";
import type { NativeAccountInspection } from "@bd777/foundry-protocol";
import { loadClaudeSdk } from "./agent-runtime/claude-sdk.js";
import { resolveClaudeCommand } from "./native-cli.js";
import { claudeRenewalPending } from "./native-login.js";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { prepareNativeOperation } from "./native-operation.js";
import { claudeQuotaWindows } from "./native-quota.js";

/** SDK 0.3.201 / CLI 2.1.295 control API. No prompt is yielded to the SDK. */
export async function readClaudeQuota(
  local: NativeAccountInspection,
): Promise<NativeAccountInspection> {
  if (claudeRenewalPending())
    return { ...local, quotaReason: "renewal_pending" };
  const operation = prepareNativeOperation(
    { runtime: "claude", id: "account-usage", connectionType: "local_login" },
    { ...process.env, ...nativeLoginEnvironment("claude") },
    homedir(),
  );
  let release!: () => void;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* noPrompt(): AsyncGenerator<never> {
    await closed;
  }
  let session: any;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const { query } = await loadClaudeSdk();
    session = query({
      prompt: noPrompt(),
      options: {
        cwd: homedir(),
        pathToClaudeCodeExecutable: resolveClaudeCommand(),
        env: operation.env,
        settingSources: [],
        strictMcpConfig: true,
        skills: [],
        plugins: [],
        persistSession: false,
        mcpServers: {},
        tools: [],
        extraArgs: { "safe-mode": null },
        stderr: () => {},
      },
    });
    const result = await Promise.race([
      session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Quota read timed out")),
          18000,
        );
      }),
    ]);
    const usage = claudeQuotaWindows(result);
    // Only forward native quota fields, never session costs, transcripts or behaviors.
    if (result?.rate_limits_available !== true || !result?.rate_limits)
      return {
        ...local,
        quotaStatus: "unavailable",
        quotaReason:
          result?.rate_limits_available === true
            ? "native_read_failed"
            : "not_exposed",
      };
    return {
      ...local,
      // get_usage can return seeded/last-known limits without their original
      // timestamp. A successful control read does not prove online freshness.
      quotaMayBeCached: true,
      checkedAt: new Date().toISOString(),
      plan:
        typeof result.subscription_type === "string"
          ? result.subscription_type
          : local.plan,
      quotaStatus: usage.length ? "supported" : "unknown",
      quotaReason: undefined,
      message:
        "Read from Claude Code's native usage control API; these limits may be a cached observation. This is not a model request.",
      usage,
    };
  } catch (error) {
    const unsupported =
      /does not support|unknown.*(?:request|subtype)|not a function/i.test(
        String(error),
      );
    return {
      ...local,
      quotaStatus: unsupported ? "unsupported" : "error",
      quotaReason: unsupported ? "not_exposed" : "native_read_failed",
    };
  } finally {
    clearTimeout(timeout);
    release();
    try {
      await session?.dispose();
    } finally {
      operation.dispose();
    }
  }
}
