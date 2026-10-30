import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { nativeSourcePaths } from "../native-runtime-paths.js";
import { archiveCodexThread } from "../native-archive.js";
import { codexHistoryRequest } from "../codex-history.js";
import { CodexNativeWork } from "../agent-runtime/work/codex.js";
import { registerNativeWorkController } from "../agent-runtime/work/types.js";
import { nativeCli } from "../native-cli.js";
import { authenticateIsolatedCodex } from "../agent-runtime/codex-auth.js";
import { acquireRuntime } from "../agent-runtime/maintenance.js";
import { codexModelCatalogArguments } from "../agent-runtime/codex-model-catalog.js";
import {
  recordWorkToolStarting,
  recordWorkToolCompleted,
  workContext,
  recordNativeWork,
} from "../session-work/supervisor.js";
/** Codex threads backed by the shared native control client. */
import {
  CodexAppServer,
  type CodexRequestError,
} from "../agent-runtime/codex-client.js";
import { AsyncInputQueue, type CodexSDKThread } from "../session-state.js";
export { CodexAppServer } from "../agent-runtime/codex-client.js";
export type { CodexRpcTimeouts } from "../agent-runtime/codex-client.js";

/** Resume preserves native history, including its original developer instructions.
 * Refresh only Foundry's trusted current configuration before any new user turn.
 * A failure deliberately aborts startup instead of running with a stale catalog.
 */
export async function refreshCodexInstructions(
  client: Pick<CodexAppServer, "request">,
  threadId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const text = config.developer_instructions;
  if (typeof text !== "string" || !text.trim()) return;
  await client.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text }],
      },
    ],
  });
}

/** Boundary mapping: the rest of Foundry continues consuming its native-event shape. */
export function appServerItem(item: any): Record<string, unknown> {
  const types: Record<string, string> = {
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    webSearch: "web_search",
  };
  return {
    ...item,
    type: types[item.type] ?? item.type,
    ...(item.type === "commandExecution"
      ? { aggregated_output: item.aggregatedOutput, exit_code: item.exitCode }
      : {}),
    ...(item.type === "reasoning"
      ? { text: [...(item.summary ?? []), ...(item.content ?? [])].join("\n") }
      : {}),
    ...(item.type === "fileChange"
      ? {
          changes: (item.changes ?? []).map((change: any) => ({
            ...change,
            kind:
              typeof change.kind === "object" ? change.kind.type : change.kind,
          })),
        }
      : {}),
  };
}

export function appServerInput(input: unknown): unknown[] {
  return (
    typeof input === "string"
      ? [{ type: "text", text: input }]
      : (input as any[])
  ).map((part) =>
    part.type === "local_image"
      ? { type: "localImage", path: part.path }
      : { ...part, text_elements: [] },
  );
}

/** Foundry state authorizes a turn; restore an externally archived native copy first. */
export async function resumeCodexThread(
  client: Pick<CodexAppServer, "request">,
  params: Record<string, unknown> & { threadId: string },
  env: NodeJS.ProcessEnv,
  onRestored?: () => void,
) {
  const home = nativeSourcePaths("codex", env).dataHome;
  if (
    existsSync(
      resolve(
        home,
        "archived_sessions",
        ".foundry-archive",
        `${params.threadId}.lock`,
      ),
    ) ||
    existsSync(
      resolve(
        home,
        "archived_sessions",
        ".foundry-archive",
        `${params.threadId}.json`,
      ),
    )
  ) {
    await archiveCodexThread(
      client,
      params.threadId,
      "active",
      env,
      undefined,
      30_000,
    );
    onRestored?.();
  }
  try {
    return await codexHistoryRequest(client, params, env);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("is archived"))
      throw error;
    const restored = await archiveCodexThread(
      client,
      params.threadId,
      "active",
      env,
      undefined,
      30_000,
    );
    if (restored === "not_found")
      await codexHistoryRequest(
        client,
        { threadId: params.threadId },
        env,
        "thread/unarchive",
      );
    onRestored?.();
    return codexHistoryRequest(client, params, env);
  }
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(
        ([key, item]) =>
          `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlValue(item)}`,
      )
      .join(", ")}}`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** Provider fields that name and route an endpoint but hold no credential. */
const processProviderFields = [
  "name",
  "base_url",
  "wire_api",
  "env_key",
  "requires_openai_auth",
  "supports_websockets",
  "websocket_connect_timeout_ms",
  "request_max_retries",
  "stream_max_retries",
  "stream_idle_timeout_ms",
];

/**
 * Codex 0.166 rejects `turn/start` (modelProviderMismatch) unless the thread's
 * provider is the app-server's own: a provider chosen only in the
 * thread/start or thread/resume `config` leaves the process on `openai`.
 * The process therefore starts on the same provider. Its command line is
 * readable by other local users, so it declares the provider without
 * credentials (headers, query parameters, tokens, a URL's userinfo or query);
 * the complete definition still reaches Codex only in the thread `config`,
 * which takes precedence for requests.
 */
export function codexProviderArguments(
  config: Record<string, unknown>,
): string[] {
  const provider = config.model_provider;
  if (typeof provider !== "string" || !provider) return [];
  const definition = (
    config.model_providers as Record<string, unknown> | undefined
  )?.[provider] as Record<string, unknown> | undefined;
  const declared = Object.fromEntries(
    processProviderFields
      .filter((field) => definition?.[field] !== undefined)
      .map((field) => {
        const value = definition![field];
        if (field !== "base_url" || typeof value !== "string")
          return [field, value];
        try {
          const url = new URL(value);
          return [field, `${url.origin}${url.pathname}`];
        } catch {
          return [field, value];
        }
      }),
  );
  return [
    "-c",
    `model_provider=${tomlValue(provider)}`,
    ...(definition
      ? ["-c", `model_providers.${provider}=${tomlValue(declared)}`]
      : []),
  ];
}

/**
 * Codex 0.166 pins a thread to the provider it started on: resuming it under
 * another one is refused with one of these. A fork carries the history to the
 * current provider; older Codex resumed under the new provider in place.
 */
export function codexProviderChanged(error: unknown): boolean {
  const type = (error as CodexRequestError | undefined)?.codexErrorType;
  return (
    type === "modelProviderMismatch" || type === "modelProviderNotConfigured"
  );
}

export const codexProviderForkNotice =
  "This conversation's model provider changed. Codex keeps a thread on the provider it started with, so Foundry continued the conversation, with its history, in a new Codex thread.";

/** Codex 0.164 reports an endpoint's context-length refusal with this code. */
export function codexContextWindowExceeded(error: unknown): boolean {
  const value = error as
    { codexErrorInfo?: unknown; message?: unknown } | null | undefined;
  return (
    value?.codexErrorInfo === "contextWindowExceeded" ||
    (typeof value?.message === "string" &&
      value.message.includes("ran out of room in the model's context window"))
  );
}

export const codexCompactionNotice =
  "The model's context window is full. Foundry is compacting this thread with Codex's own compaction and will continue once.";

/**
 * The input of the one continuation after compaction. The person's message is
 * already in the thread (Codex records it before sampling and keeps it through
 * compaction), so it is not sent a second time.
 */
export const codexCompactionContinuation =
  "Foundry compacted this thread because the model's context window was full. Continue the most recent request from where it stopped.";

/** A thread handle keeps identity between turns; each turn has one native owner. */
export class CodexAppServerThread implements CodexSDKThread {
  id?: string;
  private starting = false;
  private active?: {
    client: CodexAppServer;
    turnId: string;
    terminal: boolean;
  };
  constructor(
    private readonly command: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly config: Record<string, unknown>,
    private readonly options: Record<string, any>,
    id?: string,
  ) {
    this.id = id;
  }

  async steer(input: unknown, inputId?: string): Promise<void> {
    const active = this.active;
    if (!active || active.terminal || !active.turnId)
      throw new Error("Codex is not accepting input for an active turn.");
    await active.client.request("turn/steer", {
      threadId: this.id,
      expectedTurnId: active.turnId,
      input: appServerInput(input),
      ...(inputId ? { clientUserMessageId: inputId } : {}),
    });
  }

  async run(): Promise<never> {
    throw new Error("Codex app-server requires event streaming.");
  }

  async runStreamed(
    input: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ events: AsyncIterable<unknown> }> {
    if (this.active || this.starting)
      throw new Error("A Codex turn is already running on this thread.");
    this.starting = true;
    let releaseRuntime = () => {};
    let client: CodexAppServer;
    try {
      // Runtime update validation already holds the maintenance gate.
      if (!this.options.runtimeGateHeld)
        releaseRuntime = await acquireRuntime(
          "codex",
          options?.signal as AbortSignal | undefined,
        );
      if (
        this.options.contextWindow &&
        this.options.contextWindow.model !== this.options.model
      )
        throw new Error(
          "Codex context window does not match the selected model.",
        );
      const catalogArgs = await codexModelCatalogArguments(
        this.command,
        this.env,
        this.options.workingDirectory,
        this.options.contextWindow,
        options?.signal as AbortSignal | undefined,
      );
      client = new CodexAppServer(
        this.command,
        this.env,
        this.options.workingDirectory,
        this.options.rpcTimeouts,
        [...catalogArgs, ...codexProviderArguments(this.config)],
      );
    } catch (error) {
      releaseRuntime();
      throw error;
    } finally {
      this.starting = false;
    }
    const active = { client, turnId: "", terminal: false };
    this.active = active;
    const startupNotice = setTimeout(() => {
      void Promise.resolve()
        .then(() =>
          (
            options?.onStartupWait as (() => void | Promise<void>) | undefined
          )?.(),
        )
        .catch(() => undefined);
    }, 30_000);
    const queue = new AsyncInputQueue<unknown>();
    let failure: Error | undefined;
    let usage: any;
    const items = new Map<string, any>();
    let nativeWork: CodexNativeWork | undefined;
    let unregisterWork = () => {};
    let lastCompactRefresh = 0;
    // Codex 0.164 neither compacts nor retries after the endpoint refuses a
    // request as too long, and its next turns skip pre-turn compaction too
    // (the refusal leaves its active-context estimate near zero). Compact
    // natively once and continue; never drop history (DEV-061).
    let recovery: "none" | "compacting" | "continuing" = "none";
    const signal = options?.signal as AbortSignal | undefined;
    const fail = (message: string) => {
      if (active.terminal) return;
      active.terminal = true;
      queue.push({ type: "turn.failed", error: { message } });
      queue.close();
    };
    const abort = () => {
      if (active.terminal) return;
      // Interrupt the exact turn; closing the process is the bounded fallback.
      if (active.turnId)
        void client
          .request("turn/interrupt", {
            threadId: this.id,
            turnId: active.turnId,
          })
          .catch(() => undefined);
      active.terminal = true;
      failure = new Error("Codex turn was interrupted.");
      queue.close();
      if (!active.turnId) void client.close().catch(() => {});
    };
    client.onFailure = (error) => {
      if (!active.terminal) failure = error;
      queue.close();
    };
    client.onNotification = (method, params) => {
      nativeWork?.observe(method, params);
      if (active.terminal) return;
      if (params.threadId && this.id && params.threadId !== this.id) return;
      if (method === "turn/started") active.turnId = params.turn.id;
      if (params.turnId && active.turnId && params.turnId !== active.turnId)
        return;
      if (
        method === "thread/compacted" ||
        (method === "item/completed" &&
          params.item?.type === "contextCompaction")
      ) {
        // The continuation turn carries the work context itself.
        if (recovery === "compacting") return;
        if (Date.now() - lastCompactRefresh < 1000) return;
        lastCompactRefresh = Date.now();
        const context = workContext(this.env.FOUNDRY_SESSION_ID || "");
        if (context && active.turnId)
          void client
            .request("turn/steer", {
              threadId: this.id,
              expectedTurnId: active.turnId,
              input: appServerInput(context),
            })
            .catch((error) => {
              if (active.terminal) return;
              // Refusal is visible; per-turn sessionPrompt remains the fallback.
              queue.push({
                type: "item.completed",
                item: {
                  id: "work_context_recovery",
                  type: "error",
                  message: `Persistent work context refresh failed: ${String(error)}`,
                },
              });
            });
      }
      if (method === "thread/tokenUsage/updated") {
        const last = params.tokenUsage?.last;
        if (last)
          usage = {
            input_tokens: last.inputTokens,
            cached_input_tokens: last.cachedInputTokens,
            output_tokens: last.outputTokens,
          };
      }
      if (method === "item/started" || method === "item/completed") {
        if (params.item.type === "commandExecution") {
          if (method === "item/started")
            recordWorkToolStarting(
              this.env.FOUNDRY_SESSION_ID || "",
              params.item.id,
            );
          else recordWorkToolCompleted(params.item.id);
        }
        // Foundry already records the person's input. Native echoes include
        // injected execution instructions and are not a second UI message.
        // The echo of a steered message says the model took it in (DEV-057).
        if (params.item.type === "userMessage") {
          if (method === "item/started" && params.item.clientId)
            queue.push({
              type: "foundry.input_consumed",
              clientId: params.item.clientId,
            });
          return;
        }
        const item = appServerItem(params.item);
        items.set(params.item.id, item);
        queue.push({
          type: method === "item/started" ? "item.started" : "item.completed",
          item,
        });
      }
      if (method === "item/agentMessage/delta") {
        const item = items.get(params.itemId) ?? {
          id: params.itemId,
          type: "agent_message",
          text: "",
        };
        item.text = String(item.text ?? "") + params.delta;
        items.set(params.itemId, item);
        queue.push({ type: "item.updated", item: { ...item } });
      }
      if (method === "turn/completed") {
        if (active.turnId && params.turn.id !== active.turnId) return;
        if (
          recovery === "none" &&
          params.turn.status === "failed" &&
          codexContextWindowExceeded(params.turn.error)
        ) {
          recovery = "compacting";
          active.turnId = "";
          queue.push({
            type: "item.completed",
            item: {
              id: "context_window_compaction",
              type: "agent_message",
              text: codexCompactionNotice,
              phase: "commentary",
            },
          });
          void client
            .request("thread/compact/start", { threadId: this.id })
            .catch((error) =>
              fail(
                `${params.turn.error?.message ?? "Codex ran out of room in the model's context window."} Compaction could not start: ${String(error)}`,
              ),
            );
          return;
        }
        if (recovery === "compacting") {
          if (params.turn.status !== "completed")
            return fail(
              `Codex ran out of room in the model's context window, and compacting the thread did not complete: ${params.turn.error?.message ?? params.turn.status}`,
            );
          recovery = "continuing";
          active.turnId = "";
          const context = workContext(this.env.FOUNDRY_SESSION_ID || "");
          void client
            .request("turn/start", {
              threadId: this.id,
              input: appServerInput(
                context
                  ? `${codexCompactionContinuation}\n\n${context}`
                  : codexCompactionContinuation,
              ),
              effort: this.options.modelReasoningEffort,
              ...(this.options.modelSpeed === "fast"
                ? { serviceTier: "fast" }
                : {}),
            })
            .then((result) => {
              if (!active.terminal && !active.turnId)
                active.turnId = result.turn.id;
            })
            .catch((error) =>
              fail(
                `Codex compacted the thread but could not continue: ${String(error)}`,
              ),
            );
          return;
        }
        active.terminal = true;
        queue.push(
          params.turn.status === "completed"
            ? { type: "turn.completed", usage }
            : {
                type: "turn.failed",
                error: {
                  message:
                    params.turn.error?.message ??
                    `Codex turn ${params.turn.status}`,
                },
              },
        );
        queue.close();
      }
    };
    const cleanup = async () => {
      active.terminal = true;
      clearTimeout(startupNotice);
      signal?.removeEventListener("abort", abort);
      // Keep ownership and the runtime pinned until shutdown is confirmed.
      // A failed close must not make this handle available for another turn.
      await client.close();
      nativeWork?.closedAfterExit();
      unregisterWork();
      releaseRuntime();
      if (this.active === active) this.active = undefined;
    };
    try {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted)
        throw new Error("Codex turn was interrupted before it started.");
      await authenticateIsolatedCodex(client, this.env, this.command);
      const params = {
        cwd: this.options.workingDirectory,
        model: this.options.model,
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.sandboxMode,
        config: this.config,
        ...(this.options.ephemeral ? { ephemeral: true } : {}),
      };
      const resumed = Boolean(this.id);
      const thread = this.id
        ? await resumeCodexThread(
            client,
            { ...params, threadId: this.id },
            this.env,
            () =>
              queue.push({
                type: "item.completed",
                item: {
                  id: "native_unarchive",
                  type: "agent_message",
                  text: "Codex had this thread archived; Foundry restored it.",
                  phase: "commentary",
                },
              }),
          ).catch(async (error) => {
            if (!codexProviderChanged(error)) throw error;
            const fork = await client.request("thread/fork", {
              ...params,
              threadId: this.id,
            });
            queue.push({
              type: "item.completed",
              item: {
                id: "native_provider_fork",
                type: "agent_message",
                text: codexProviderForkNotice,
                phase: "commentary",
              },
            });
            return fork;
          })
        : await client.request("thread/start", params);
      clearTimeout(startupNotice);
      this.id = thread.thread.id;
      if (resumed)
        await refreshCodexInstructions(client, this.id!, this.config);
      const foundrySessionId = this.options.workSessionId as string | undefined;
      if (foundrySessionId && this.id) {
        nativeWork = new CodexNativeWork(
          client,
          this.id,
          nativeCli("codex").version || "unknown",
          (task) => recordNativeWork(foundrySessionId, task),
          (message) => {
            // Closing the client rejects an inventory request still in flight.
            // Its late diagnostic must not write to the completed turn's queue.
            if (active.terminal) return;
            queue.push({
              type: "item.completed",
              item: { id: "native_work_discovery", type: "error", message },
            });
          },
        );
        unregisterWork = registerNativeWorkController(
          foundrySessionId,
          nativeWork,
        );
        nativeWork.start();
      }
      queue.push({ type: "thread.started", thread_id: this.id });
      if (signal?.aborted)
        throw new Error("Codex turn was interrupted before it started.");
      const result = await client.request("turn/start", {
        threadId: this.id,
        input: appServerInput(input),
        effort: this.options.modelReasoningEffort,
        ...(this.options.modelSpeed === "fast" ? { serviceTier: "fast" } : {}),
      });
      active.turnId = result.turn.id;
      return {
        events: (async function* () {
          try {
            for await (const event of queue) yield event;
            if (failure) throw failure;
          } finally {
            await cleanup();
          }
        })(),
      };
    } catch (error) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new Error(
          `${String(error)}; cleanup also failed: ${String(cleanupError)}`,
          {
            cause: error,
          },
        );
      }
      if (signal?.aborted) throw new Error("Codex turn was interrupted.");
      throw error;
    }
  }
}
