import { codexQuotaWindows } from "./native-quota.js";
import { readClaudeQuota } from "./native-claude-quota.js";
import { nativeSourcePaths } from "./native-runtime-paths.js";
import { prepareNativeOperation } from "./native-operation.js";
import { authenticateIsolatedCodex } from "./agent-runtime/codex-auth.js";
import { acquireRuntime } from "./agent-runtime/maintenance.js";
import { loadClaudeSdk } from "./agent-runtime/claude-sdk.js";
/** Read-only native control APIs. No prompt, inference, auth copying or provider HTTP. */
import { execFile } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AgentModelOption,
  NativeAccountInspection,
} from "@bd777/foundry-protocol";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import {
  nativeCli,
  resolveClaudeCommand,
  resolveCodexCommand,
} from "./native-cli.js";
import { claudeAccount, codexAccount } from "./native-account.js";
import { claudeConfigDir, codexHome } from "./native-homes.js";
import { claudeRenewalPending, isNativeAccountStatus } from "./native-login.js";
import { CodexAppServer } from "./agent-runtime/codex-client.js";

const exec = promisify(execFile);
export function nativeSources(runtime: "codex" | "claude"): string[] {
  const primary =
    runtime === "codex"
      ? resolve(codexHome())
      : resolve(
          nativeSourcePaths("claude", process.env).configurationSourceHome ??
            claudeConfigDir(),
        );
  if (runtime === "claude") return [primary];
  // Configuration directories only; never enumerate credential contents.
  const others = readdirSync(homedir(), { withFileTypes: true })
    .filter((row) => row.isDirectory() && row.name.startsWith(".codex"))
    .map((row) => resolve(homedir(), row.name))
    .filter(
      (path) => path !== primary && existsSync(resolve(path, "auth.json")),
    );
  return [primary, ...others];
}

export async function withCodexControl<T>(
  source: string,
  read: (call: (method: string, params: unknown) => Promise<any>) => Promise<T>,
  runtime?: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
    signal?: AbortSignal;
    allowRefresh?: boolean;
  },
): Promise<T> {
  const releaseRuntime = await acquireRuntime("codex", runtime?.signal);
  let client: CodexAppServer | undefined;
  let operation: ReturnType<typeof prepareNativeOperation> | undefined;
  const abort = () => {
    void client?.close().catch(() => {});
  };
  runtime?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const env =
      runtime?.env ??
      (operation = prepareNativeOperation(
        {
          runtime: "codex",
          id: "official-inspection",
          connectionType: "local_login",
        },
        {
          ...process.env,
          ...nativeLoginEnvironment("codex"),
          CODEX_HOME: source,
          FOUNDRY_NATIVE_CODEX_SOURCE_HOME: source,
        },
        homedir(),
      )).env;
    const command = resolveCodexCommand();
    client = new CodexAppServer(
      command,
      env,
      runtime?.cwd ?? homedir(),
      { initializeMs: 25000, controlMs: 25000 },
      runtime?.args ?? ["-c", 'model_provider="openai"'],
    );
    runtime?.signal?.throwIfAborted();
    await authenticateIsolatedCodex(
      client,
      env,
      command,
      runtime?.allowRefresh ?? true,
    );
    return await read((method, params) => client!.request(method, params));
  } catch {
    // Native errors may include credential-bearing URLs.
    throw new Error(
      "Native Codex could not complete this read. Check login, connectivity or account access.",
    );
  } finally {
    runtime?.signal?.removeEventListener("abort", abort);
    await client?.close();
    operation?.dispose();
    releaseRuntime();
  }
}

export async function readClaudeCatalog(): Promise<AgentModelOption[]> {
  if (claudeRenewalPending())
    throw new Error(
      "Claude Code's login is due for renewal, so its model catalog is not read now. Retry in a few minutes.",
    );
  let release!: () => void;
  const closed = new Promise<void>((resolveClose) => {
    release = resolveClose;
  });
  async function* noPrompt(): AsyncGenerator<never> {
    await closed;
  }
  // Loaded on use: the SDK is installed beside the worker's runtime, not
  // with the npx bootstrap that runs install/doctor.
  const { query } = await loadClaudeSdk();
  const operation = prepareNativeOperation(
    {
      runtime: "claude",
      id: "official-inspection",
      connectionType: "local_login",
    },
    { ...process.env, ...nativeLoginEnvironment("claude") },
    homedir(),
  );
  let session: any;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
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
      },
    });
    timeout = setTimeout(() => {
      session.close();
      release();
    }, 45000);
    return (await session.supportedModels()).map(
      (model: { value: string; displayName?: string }) => ({
        id: model.value,
        label: model.displayName,
      }),
    );
  } catch {
    throw new Error(
      "Claude Code could not return its official model catalog. Retry after checking the native CLI.",
    );
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

export async function readOfficialCodexCatalog(): Promise<AgentModelOption[]> {
  return readNativeCodexCatalog();
}

async function readNativeCodexCatalog(): Promise<AgentModelOption[]> {
  const source = nativeSources("codex")[0]!;
  // Official discovery uses the same isolated configuration as execution.
  {
    try {
      const models = await withCodexControl(source, async (call) => {
        const options: AgentModelOption[] = [];
        let cursor: string | null = null;
        do {
          const page = await call("model/list", {
            cursor,
            limit: 100,
            includeHidden: false,
          });
          if (!Array.isArray(page.data))
            throw new Error("Invalid native catalog.");
          options.push(
            ...page.data
              .filter(
                (row: { hidden?: boolean; model?: string }) =>
                  !row.hidden && row.model,
              )
              .map((row: { model: string; displayName?: string }) => ({
                id: row.model,
                label: row.displayName,
              })),
          );
          cursor = page.nextCursor ?? null;
        } while (cursor);
        return options;
      });
      if (models.length) return models;
    } catch {
      /* CLI versions without model/list use their bundled catalog. */
    }
  }
  // Explicitly exclude gateway catalog files; not an account entitlement claim.
  const operation = prepareNativeOperation(
    {
      runtime: "codex",
      id: "official-inspection",
      connectionType: "local_login",
    },
    {
      ...process.env,
      ...nativeLoginEnvironment("codex"),
      CODEX_HOME: source,
      FOUNDRY_NATIVE_CODEX_SOURCE_HOME: source,
    },
    homedir(),
  );
  try {
    const result = await exec(
      resolveCodexCommand(),
      ["debug", "models", "--bundled", "-c", 'model_provider="openai"'],
      {
        env: operation.env,
        timeout: 20000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const body = JSON.parse(result.stdout) as {
      models?: Array<{
        slug: string;
        display_name?: string;
        visibility?: string;
      }>;
    };
    return (body.models ?? [])
      .filter(
        (row) => row.slug && (!row.visibility || row.visibility === "list"),
      )
      .map((row) => ({ id: row.slug, label: row.display_name }));
  } finally {
    operation.dispose();
  }
}

export async function inspectNativeAccount(
  runtime: "claude" | "codex",
  requestedSource?: string,
): Promise<NativeAccountInspection> {
  const sources = nativeSources(runtime);
  const source = requestedSource || sources[0]!;
  const base: NativeAccountInspection = {
    runtimeGeneration: nativeCli(runtime).generation,
    authMode:
      runtime === "codex" && source === sources[0]
        ? codexAccount()?.mode === "login"
          ? "subscription"
          : codexAccount()?.mode === "api_key"
            ? "api_key"
            : "unknown"
        : "unknown",
    quotaStatus: "unavailable",
    quotaReason: "native_read_failed",
    runtime,
    source,
    sources,
    executionSource: sources[0]!,
    checkedAt: new Date().toISOString(),
    status: "unavailable",
    message: "The native account check did not complete.",
    usage: [],
  };
  // A source the user inspected earlier can disappear (e.g. another app's CODEX_HOME
  // was removed). Report it structurally so the UI can explain and offer the
  // configuration Foundry actually executes with; never silently switch to it.
  if (!sources.includes(source))
    return {
      ...base,
      message:
        "This configuration is no longer present on the device, so its account cannot be checked.",
    };
  try {
    if (runtime === "claude") {
      const pending = claudeRenewalPending();
      if (pending) {
        const account = claudeAccount()?.label;
        return {
          ...base,
          ...(account ? { accountLabel: account } : {}),
          ...(pending.subscriptionType
            ? { plan: pending.subscriptionType }
            : {}),
          status: "local_login",
          authMode: "subscription",
          quotaReason: "renewal_pending",
          message:
            "Claude Code's stored login is due for renewal; it renews on its next request. Read from the selected native credential store without running the CLI; online validity and remaining usage are not verified.",
        };
      }
      const operation = prepareNativeOperation(
        {
          runtime: "claude",
          id: "account-status",
          connectionType: "local_login",
        },
        { ...process.env, ...nativeLoginEnvironment(runtime) },
        homedir(),
      );
      const result = await (async () => {
        try {
          return await exec(
            resolveClaudeCommand(),
            ["auth", "status", "--json"],
            {
              env: operation.env,
              timeout: 15000,
              maxBuffer: 65536,
            },
          ).then((result) => ({ ...result, status: 0 }));
        } finally {
          operation.dispose();
        }
      })();
      const parsed = JSON.parse(result.stdout) as {
        loggedIn?: boolean;
        email?: string;
        orgName?: string;
        subscriptionType?: string;
      };
      if (typeof parsed.loggedIn !== "boolean") return base;
      const signedIn = isNativeAccountStatus(runtime, result);
      // The account Claude Code itself reports for this login; read locally.
      const account = [parsed.email, parsed.orgName]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(" · ");
      const local: NativeAccountInspection = {
        ...base,
        authMode: signedIn ? "subscription" : "none",
        ...(signedIn && account ? { accountLabel: account } : {}),
        ...(signedIn && parsed.subscriptionType
          ? { plan: parsed.subscriptionType }
          : {}),
        status: signedIn ? "local_login" : "not_signed_in",
        message: signedIn
          ? "Claude Code reports local OAuth credentials; remaining usage has not been verified."
          : "Claude Code reports no official login in this configuration.",
      };
      return signedIn ? readClaudeQuota(local) : local;
    }
    return await withCodexControl(
      source,
      async (call) => {
        const { account } = await call("account/read", { refreshToken: false });
        if (account?.type !== "chatgpt")
          return {
            ...base,
            status: "not_signed_in",
            authMode: account?.type === "apiKey" ? "api_key" : "none",
            message:
              account?.type === "apiKey"
                ? "This configuration uses an API key, not a ChatGPT account."
                : "No ChatGPT login in this configuration.",
          };
        const local: NativeAccountInspection = {
          ...base,
          status: "local_login",
          authMode: "subscription",
          accountLabel: account.email ?? undefined,
          plan: account.planType,
          message: "ChatGPT login found; online usage could not be verified.",
        };
        try {
          const result = await call("account/rateLimits/read", {});
          const usage = codexQuotaWindows(result);
          return {
            ...local,
            checkedAt: new Date().toISOString(),
            status: "verified",
            quotaStatus: usage.length ? "supported" : "unknown",
            quotaReason: undefined,
            message:
              "Verified by Codex's native account usage read. This is not a model request.",
            usage,
          };
        } catch {
          return local;
        }
      },
      { cwd: homedir(), allowRefresh: false },
    );
  } catch {
    return base;
  }
}
