/** Native Codex control transport. One process owns execution and controls. */
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import {
  spawnAgentProcess,
  stopAgentProcessAndWait,
  type AgentProcessContext,
} from "../../platform/process/agent-processes.js";

import { ControlOutcomeUnknownError } from "./control-error.js";
import { PendingReplies } from "../../platform/pending-replies.js";

/** A native refusal, keeping Codex's machine-readable `data.type`. */
export class CodexRequestError extends Error {
  constructor(
    message: string,
    readonly codexErrorType?: string,
  ) {
    super(message);
  }
}

/** A prompt handler's result for a request Codex resolved itself: no response. */
export const codexNoResponse = Symbol("codexNoResponse");

export interface CodexRpcTimeouts {
  initializeMs: number;
  startupMs: number;
  controlMs: number;
}

/** Requests have bounded acknowledgements; an executing turn has no idle timeout. */
export class CodexAppServer {
  private readonly child: ChildProcess;
  readonly pid: number | undefined;
  readonly whenClosed: Promise<void>;
  private readonly pending = new PendingReplies<number>();
  private sequence = 0;
  private ended = false;
  private failure?: Error;
  private readonly ready: Promise<unknown>;
  private readonly timeouts: CodexRpcTimeouts;
  onRequest?: (method: string, params: any) => Promise<unknown>;
  /**
   * Answers Codex's prompts (approvals, requestUserInput, elicitations):
   * undefined for a request it does not answer, which is refused.
   */
  onServerRequest?: (
    method: string,
    params: any,
    requestId: unknown,
  ) => Promise<unknown> | undefined;
  onNotification?: (method: string, params: any) => void;
  onFailure?: (error: Error) => void;

  constructor(
    command: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    timeouts: Partial<CodexRpcTimeouts> = {},
    args: string[] = [],
    context?: AgentProcessContext,
  ) {
    this.timeouts = {
      initializeMs: 60_000,
      startupMs: 180_000,
      controlMs: 30_000,
      ...timeouts,
    };
    this.child = spawnAgentProcess(
      command,
      ["app-server", "--listen", "stdio://", ...args],
      {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
      context,
    );
    this.pid = this.child.pid;
    this.whenClosed = new Promise((resolve) =>
      this.child.once("close", () => resolve()),
    );
    // Never let diagnostics fill the native process's pipe. The protocol's
    // errors carry failure details, without exposing credentials from stderr.
    this.child.stderr?.resume();
    this.child.stdin?.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code, signal) =>
      this.fail(
        new Error(
          `Codex app-server exited before completing the request (${signal ?? `exit ${code}`}).`,
        ),
      ),
    );
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method) {
        if (message.id !== undefined) {
          if (
            message.method === "account/chatgptAuthTokens/refresh" &&
            this.onRequest
          ) {
            void this.onRequest(message.method, message.params ?? {}).then(
              (result) => {
                if (!this.ended) this.write({ id: message.id, result });
              },
              () => {
                if (!this.ended)
                  this.write({
                    id: message.id,
                    error: {
                      code: -32000,
                      message:
                        "The selected native login could not be refreshed.",
                    },
                  });
              },
            );
            return;
          }
          // Never auto-approve a native request merely because it arrived
          // over this transport: only a prompt handler answers it.
          const answer = this.onServerRequest?.(
            message.method,
            message.params ?? {},
            message.id,
          );
          if (!answer) {
            this.write({
              id: message.id,
              error: {
                code: -32601,
                message: `Foundry cannot answer ${message.method} interactively.`,
              },
            });
            return;
          }
          void answer.then(
            (result) => {
              if (!this.ended && result !== codexNoResponse)
                this.write({ id: message.id, result });
            },
            (error) => {
              if (!this.ended)
                this.write({
                  id: message.id,
                  error: {
                    code: -32000,
                    message: `Foundry could not answer ${message.method}: ${error instanceof Error ? error.message : String(error)}`,
                  },
                });
            },
          );
        } else this.onNotification?.(message.method, message.params ?? {});
        return;
      }
      if (message.error)
        this.pending.reject(
          message.id,
          new CodexRequestError(
            message.error.message ?? "Codex request failed",
            typeof message.error.data?.type === "string"
              ? message.error.data.type
              : undefined,
          ),
        );
      else this.pending.resolve(message.id, message.result);
    });
    this.ready = this.call("initialize", {
      clientInfo: { name: "foundry", title: "Foundry", version: "1" },
      capabilities: { experimentalApi: true },
    }).then(() => this.write({ method: "initialized" }));
    // A process may fail before the caller begins its first request.
    void this.ready.catch(() => undefined);
  }

  async request(method: string, params: unknown): Promise<any> {
    await this.ready;
    return this.call(method, params);
  }

  close(): Promise<void> {
    this.fail(new Error("Codex app-server closed."));
    return stopAgentProcessAndWait(this.child);
  }

  private write(value: unknown): void {
    if (this.ended)
      throw this.failure ?? new Error("Codex app-server is closed.");
    this.child.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  private call(method: string, params: unknown): Promise<any> {
    if (this.ended) return Promise.reject(this.failure);
    const id = ++this.sequence;
    // Native startup loads configuration and integrations. It must not
    // inherit the short acknowledgement deadline of steer/interrupt.
    const timeoutMs =
      method === "initialize"
        ? this.timeouts.initializeMs
        : method === "thread/start" || method === "thread/resume"
          ? this.timeouts.startupMs
          : this.timeouts.controlMs;
    const reply = this.pending.wait(id, {
      label: method,
      timeout: {
        ms: timeoutMs,
        error: () =>
          new ControlOutcomeUnknownError(
            `${method} did not acknowledge within ${timeoutMs / 1000}s; outcome unknown.`,
          ),
      },
    });
    try {
      this.write({ id, method, params });
    } catch (error) {
      this.fail(error as Error);
    }
    return reply;
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.pending.rejectAll(
      (method) =>
        new ControlOutcomeUnknownError(
          `${method} acknowledgement lost; outcome unknown. ${error.message}`,
        ),
    );
    this.onFailure?.(error);
  }
}
