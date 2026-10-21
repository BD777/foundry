import { open, realpath, mkdir, symlink, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { findSessionLog } from "../native-usage.js";
import { nativeSourcePaths } from "../native-runtime-paths.js";
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
import { CodexAppServer } from "../agent-runtime/codex-client.js";
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

/** A collected execution home can leave Codex's index pointing at a dead
 * symlink. Recover only the same transcript in the selected native data source;
 * never start a replacement thread or rewrite the native database. */
export async function resumeCodexThread(
  client: Pick<CodexAppServer, "request">,
  params: Record<string, unknown> & { threadId: string },
  env: NodeJS.ProcessEnv,
) {
  try {
    return await client.request("thread/resume", params);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes(
        `no rollout found for thread id ${params.threadId}`,
      )
    )
      throw error;
    const home = nativeSourcePaths("codex", env).dataHome;
    const found = await findSessionLog("codex", params.threadId, [home]);
    if (!found) throw error;
    const path = await realpath(found);
    const inside = relative(await realpath(resolve(home, "sessions")), path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw error;
    const file = await open(path, "r");
    let header;
    try {
      const bytes = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      header = JSON.parse(
        bytes.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "",
      );
    } finally {
      await file.close();
    }
    if (
      header.type !== "session_meta" ||
      header.payload?.id !== params.threadId
    )
      throw error;
    // Paginated native threads reject changing their indexed rollout path.
    // Restore only the missing, generated history alias named by native metadata.
    // Configuration and credentials are never recreated in that retired home.
    if (env.FOUNDRY_RUNTIME_CONFIG_ISOLATED !== "1" || !env.CODEX_HOME)
      throw error;
    const metadata = await client.request("thread/read", {
      threadId: params.threadId,
      includeTurns: false,
    });
    if (
      metadata.thread?.id !== params.threadId ||
      typeof metadata.thread.path !== "string"
    )
      throw error;
    const parent = dirname(resolve(env.CODEX_HOME));
    const indexed = resolve(metadata.thread.path);
    const pieces = relative(parent, indexed).split(sep);
    if (
      pieces.length < 3 ||
      !/^[a-f0-9]{24}$/.test(pieces[0] ?? "") ||
      pieces[1] !== "sessions" ||
      resolve(home, ...pieces.slice(1)) !== path
    )
      throw error;
    if ((await lstat(parent)).isSymbolicLink()) throw error;
    const retired = resolve(parent, pieces[0]!);
    try {
      await lstat(retired);
      throw error;
    } catch (missing) {
      if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
    }
    await mkdir(retired, { mode: 0o700 });
    await symlink(
      resolve(home, "sessions"),
      resolve(retired, "sessions"),
      "dir",
    );
    const result = await client.request("thread/resume", params);
    if (result.thread?.id !== params.threadId)
      throw new Error("Codex resumed a different thread; no input was sent.");
    return result;
  }
}

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
        catalogArgs,
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
    const signal = options?.signal as AbortSignal | undefined;
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
        if (params.item.type === "userMessage") return;
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
          )
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
