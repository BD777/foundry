/** Read-only native control APIs. No prompt, inference, auth copying or provider HTTP. */
import { spawn, execFile } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentModelOption,
  NativeAccountInspection,
} from "@foundry/protocol";
import { nativeLoginEnvironment } from "./native-login-environment.js";
import { resolveClaudeCommand, resolveCodexCommand } from "./utils.js";
import { isNativeAccountStatus } from "./native-login.js";
import { parse as parseTOML } from "smol-toml";

const exec = promisify(execFile);
export function nativeSources(runtime: "codex" | "claude"): string[] {
  const primary =
    runtime === "codex"
      ? resolve(process.env.CODEX_HOME || resolve(homedir(), ".codex"))
      : resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"));
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
  runtime?: { cwd: string; env: NodeJS.ProcessEnv; args?: string[] },
): Promise<T> {
  const child = spawn(
    resolveCodexCommand(),
    [
      "app-server",
      "--stdio",
      ...(runtime?.args ?? ["-c", 'model_provider="openai"']),
    ],
    {
      cwd: runtime?.cwd ?? homedir(),
      env: runtime?.env ?? {
        ...process.env,
        ...nativeLoginEnvironment("codex"),
        CODEX_HOME: source,
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let sequence = 0;
  let buffer = "";
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  let closed = false;
  const fail = () => {
    closed = true;
    for (const item of pending.values())
      item.reject(new Error("Native Codex check did not complete."));
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      fail();
      child.kill();
      return;
    }
    let boundary: number;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      try {
        const response = JSON.parse(line);
        const item = pending.get(response.id);
        if (!item) continue;
        pending.delete(response.id);
        // Do not forward raw CLI errors: they can contain credential-bearing URLs.
        if (response.error)
          item.reject(
            new Error(
              "Native Codex could not complete this read. Check login, connectivity or account access.",
            ),
          );
        else item.resolve(response.result);
      } catch {
        /* Native diagnostics are not protocol responses. */
      }
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolveCall, reject) => {
      if (closed) {
        reject(new Error("Native Codex check did not complete."));
        return;
      }
      const id = ++sequence;
      pending.set(id, { resolve: resolveCall, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const timer = setTimeout(() => {
    fail();
    child.kill();
  }, 25000);
  try {
    await call("initialize", {
      clientInfo: { name: "foundry_account_check", version: "1.0.0" },
    });
    child.stdin.write('{"method":"initialized"}\n');
    return await read(call);
  } finally {
    clearTimeout(timer);
    child.kill();
    fail();
  }
}

export async function readClaudeCatalog(): Promise<AgentModelOption[]> {
  let release!: () => void;
  const closed = new Promise<void>((resolveClose) => {
    release = resolveClose;
  });
  async function* noPrompt(): AsyncGenerator<never> {
    await closed;
  }
  const session = query({
    prompt: noPrompt(),
    options: {
      cwd: homedir(),
      pathToClaudeCodeExecutable: resolveClaudeCommand(),
      env: { ...process.env, ...nativeLoginEnvironment("claude") },
      settingSources: [],
      persistSession: false,
      mcpServers: {},
      tools: [],
    },
  });
  const timeout = setTimeout(() => {
    session.close();
    release();
  }, 45000);
  try {
    return (await session.supportedModels()).map((model) => ({
      id: model.value,
      label: model.displayName,
    }));
  } catch {
    throw new Error(
      "Claude Code could not return its official model catalog. Retry after checking the native CLI.",
    );
  } finally {
    clearTimeout(timeout);
    session.close();
    release();
  }
}

export async function readOfficialCodexCatalog(): Promise<AgentModelOption[]> {
  const source = nativeSources("codex")[0]!;
  let hasCustomCatalog = false;
  try {
    const config = parseTOML(
      readFileSync(resolve(source, "config.toml"), "utf8"),
    );
    hasCustomCatalog = Boolean(config.model_catalog_json);
  } catch {
    /* A missing config uses native defaults. */
  }
  // Native model/list owns remote discovery and its offline fallback. A custom
  // catalog belongs to a gateway, so it must never appear as official options.
  if (!hasCustomCatalog) {
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
  const result = await exec(
    resolveCodexCommand(),
    ["debug", "models", "--bundled", "-c", 'model_provider="openai"'],
    {
      env: { ...process.env, ...nativeLoginEnvironment("codex") },
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
    .filter((row) => row.slug && (!row.visibility || row.visibility === "list"))
    .map((row) => ({ id: row.slug, label: row.display_name }));
}

export async function inspectNativeAccount(
  runtime: "claude" | "codex",
  requestedSource?: string,
): Promise<NativeAccountInspection> {
  const sources = nativeSources(runtime);
  const source = requestedSource || sources[0]!;
  const base: NativeAccountInspection = {
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
      const result = await exec(
        resolveClaudeCommand(),
        ["auth", "status", "--json"],
        {
          env: { ...process.env, ...nativeLoginEnvironment(runtime) },
          timeout: 15000,
          maxBuffer: 65536,
        },
      ).then((result) => ({ ...result, status: 0 }));
      const parsed = JSON.parse(result.stdout) as { loggedIn?: boolean };
      if (typeof parsed.loggedIn !== "boolean") return base;
      const signedIn = isNativeAccountStatus(runtime, result);
      return {
        ...base,
        status: signedIn ? "local_login" : "not_signed_in",
        message: signedIn
          ? "Claude Code reports local OAuth credentials. Its SDK does not expose an account quota read; online validity and remaining usage are not verified."
          : "Claude Code reports no official login in this configuration.",
      };
    }
    return await withCodexControl(source, async (call) => {
      const { account } = await call("account/read", { refreshToken: false });
      if (account?.type !== "chatgpt")
        return {
          ...base,
          status: "not_signed_in",
          message:
            account?.type === "apiKey"
              ? "This configuration uses an API key, not a ChatGPT account."
              : "No ChatGPT login in this configuration.",
        };
      const local: NativeAccountInspection = {
        ...base,
        status: "local_login",
        accountLabel: account.email ?? undefined,
        plan: account.planType,
        message: "ChatGPT login found; online usage could not be verified.",
      };
      try {
        const result = await call("account/rateLimits/read", {});
        const limits = result.rateLimits;
        if (!limits || typeof limits !== "object") return local;
        return {
          ...local,
          status: "verified",
          message:
            "Verified by Codex's native account usage read. This is not a model request.",
          usage: [limits?.primary, limits?.secondary]
            .filter(Boolean)
            .map((window) => ({
              usedPercent: window.usedPercent,
              windowMinutes: window.windowDurationMins,
              resetsAt: window.resetsAt,
            })),
        };
      } catch {
        return local;
      }
    });
  } catch {
    return base;
  }
}
