import { authenticateIsolatedCodex } from "../agent-runtime/codex-auth.js";
import { acquireRuntime } from "../agent-runtime/maintenance.js";
/** Codex threads backed by the shared native control client. */
import { CodexAppServer } from "../agent-runtime/codex-client.js";
import { AsyncInputQueue, type CodexSDKThread } from "../session-state.js";
export { CodexAppServer } from "../agent-runtime/codex-client.js";
export type { CodexRpcTimeouts } from "../agent-runtime/codex-client.js";

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

/** A thread handle keeps identity between turns; each turn has one native owner. */
export class CodexAppServerThread implements CodexSDKThread {
  id?: string;
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
    if (this.active)
      throw new Error("A Codex turn is already running on this thread.");
    const releaseRuntime = await acquireRuntime(
      "codex",
      options?.signal as AbortSignal | undefined,
    );
    let client: CodexAppServer;
    try {
      client = new CodexAppServer(
        this.command,
        this.env,
        this.options.workingDirectory,
        this.options.rpcTimeouts,
      );
    } catch (error) {
      releaseRuntime();
      throw error;
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
      if (!active.turnId) client.close();
    };
    client.onFailure = (error) => {
      if (!active.terminal) failure = error;
      queue.close();
    };
    client.onNotification = (method, params) => {
      if (active.terminal) return;
      if (params.threadId && this.id && params.threadId !== this.id) return;
      if (method === "turn/started") active.turnId = params.turn.id;
      if (params.turnId && active.turnId && params.turnId !== active.turnId)
        return;
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
    const cleanup = () => {
      clearTimeout(startupNotice);
      signal?.removeEventListener("abort", abort);
      client.close();
      releaseRuntime();
      if (this.active === active) this.active = undefined;
    };
    try {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted)
        throw new Error("Codex turn was interrupted before it started.");
      await authenticateIsolatedCodex(client, this.env, this.command);
      const thread = await client.request(
        this.id ? "thread/resume" : "thread/start",
        {
          ...(this.id ? { threadId: this.id } : {}),
          cwd: this.options.workingDirectory,
          model: this.options.model,
          approvalPolicy: this.options.approvalPolicy,
          sandbox: this.options.sandboxMode,
          config: this.config,
          ...(this.options.ephemeral ? { ephemeral: true } : {}),
        },
      );
      clearTimeout(startupNotice);
      this.id = thread.thread.id;
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
            cleanup();
          }
        })(),
      };
    } catch (error) {
      cleanup();
      if (signal?.aborted) throw new Error("Codex turn was interrupted.");
      throw error;
    }
  }
}
