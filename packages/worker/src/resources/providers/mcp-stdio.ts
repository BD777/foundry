// A minimal MCP client over a child process's stdio: newline-delimited
// JSON-RPC 2.0 (initialize → notifications/initialized → tools/list →
// tools/call). Calls are bounded by a timeout and an AbortSignal; the
// process is killed on close, and its stderr is kept (bounded) to explain
// a failure.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const mcpProtocolVersion = "2025-06-18";

export interface McpTool {
  name: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content?: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpStdioOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Bytes of stderr kept (the latest). */
  stderrBytes?: number;
  /** The longest a single response line may be. */
  maxLineBytes?: number;
  clientName?: string;
  clientVersion?: string;
}

export class McpError extends Error {
  constructor(
    readonly code: "timeout" | "aborted" | "exited" | "rpc" | "protocol",
    message: string,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const defaultStderrBytes = 16 * 1024;
const defaultMaxLineBytes = 64 * 1024 * 1024;

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private stderrTail = "";
  private exitError: McpError | undefined;
  private exited = false;
  tools = new Map<string, McpTool>();

  constructor(private readonly options: McpStdioOptions) {}

  get alive(): boolean {
    return this.child !== undefined && this.exitError === undefined;
  }

  /** The latest stderr lines, for error messages. */
  get stderr(): string {
    return this.stderrTail.trim();
  }

  /** Spawns the server, initializes and reads its tools. */
  async start(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const child = spawn(this.options.command, this.options.args ?? [], {
      env: this.options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const stderrLimit = this.options.stderrBytes ?? defaultStderrBytes;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(
        -stderrLimit,
      );
    });
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    child.stdin.on("error", () => {
      // EPIPE once the process is gone; the exit handler reports it.
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      this.exited = true;
      this.fail(
        new McpError(
          "exited",
          error.code === "ENOENT"
            ? `${this.options.command} was not found`
            : `could not start ${this.options.command}: ${error.message}`,
        ),
      );
    });
    child.once("exit", (code, signalName) => {
      this.exited = true;
      this.fail(
        new McpError(
          "exited",
          `${this.options.command} exited (${signalName ?? `code ${code}`})${this.stderr ? `: ${this.stderr.split("\n").slice(-3).join(" ")}` : ""}`,
        ),
      );
    });
    await this.request(
      "initialize",
      {
        protocolVersion: mcpProtocolVersion,
        capabilities: {},
        clientInfo: {
          name: this.options.clientName ?? "foundry-worker",
          version: this.options.clientVersion ?? "1",
        },
      },
      timeoutMs,
      signal,
    );
    this.notify("notifications/initialized");
    const listed = (await this.request("tools/list", {}, timeoutMs, signal)) as
      { tools?: McpTool[] } | undefined;
    this.tools = new Map(
      (listed?.tools ?? [])
        .filter((tool) => typeof tool?.name === "string")
        .map((tool) => [tool.name, tool]),
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const result = (await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs,
      signal,
    )) as McpToolResult | undefined;
    return result ?? {};
  }

  /** Ends the process: stdin closed, then SIGTERM, then SIGKILL. */
  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.fail(new McpError("exited", "the MCP session was closed"));
    if (this.exited) return;
    const exited = new Promise<void>((resolveExit) =>
      child.once("exit", () => resolveExit()),
    );
    try {
      child.stdin.end();
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 2000);
    timer.unref();
    await exited;
    clearTimeout(timer);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.exitError) return Promise.reject(this.exitError);
    if (signal?.aborted)
      return Promise.reject(new McpError("aborted", abortMessage(signal)));
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const cancel = (error: McpError): void => {
        cleanup();
        this.notify("notifications/cancelled", {
          requestId: id,
          reason: error.message,
        });
        rejectRequest(error);
      };
      const timer = setTimeout(
        () =>
          cancel(
            new McpError("timeout", `${method} timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      );
      timer.unref();
      const onAbort = (): void =>
        cancel(new McpError("aborted", abortMessage(signal!)));
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolveRequest(value);
        },
        reject: (error) => {
          cleanup();
          rejectRequest(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private write(message: unknown): void {
    const child = this.child;
    if (!child || this.exitError || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: Buffer): void {
    let start = 0;
    for (
      let index = chunk.indexOf(10);
      index !== -1;
      index = chunk.indexOf(10, start)
    ) {
      this.buffered.push(chunk.subarray(start, index));
      const line = Buffer.concat(this.buffered).toString("utf8");
      this.buffered = [];
      this.bufferedBytes = 0;
      start = index + 1;
      this.handleLine(line);
    }
    if (start < chunk.length) {
      this.buffered.push(chunk.subarray(start));
      this.bufferedBytes += chunk.length - start;
      if (
        this.bufferedBytes > (this.options.maxLineBytes ?? defaultMaxLineBytes)
      ) {
        this.fail(new McpError("protocol", "an MCP message was too large"));
        this.child?.kill("SIGKILL");
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: {
      id?: number | string;
      method?: string;
      result?: unknown;
      error?: { code?: number; message?: string };
    };
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // Not JSON-RPC (a stray log line).
    }
    if (message.method !== undefined) {
      // A request from the server: answer the ones that need it.
      if (message.id === undefined) return;
      if (message.method === "ping")
        this.write({ jsonrpc: "2.0", id: message.id, result: {} });
      else
        this.write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32601,
            message: `${message.method} is not supported`,
          },
        });
      return;
    }
    if (typeof message.id !== "number") return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    if (message.error)
      waiting.reject(
        new McpError(
          "rpc",
          message.error.message ?? `error ${message.error.code ?? "unknown"}`,
        ),
      );
    else waiting.resolve(message.result);
  }

  private fail(error: McpError): void {
    if (!this.exitError) this.exitError = error;
    for (const waiting of [...this.pending.values()]) waiting.reject(error);
    this.pending.clear();
  }
}

function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : "aborted";
}
