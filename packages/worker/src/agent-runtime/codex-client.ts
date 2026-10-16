/** Native Codex control transport. One process owns execution and controls. */
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import { spawnAgentProcess, stopAgentProcess } from "../agent-processes.js";

import { ControlOutcomeUnknownError } from "./control-error.js";

interface RpcPending {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface CodexRpcTimeouts {
  initializeMs: number;
  startupMs: number;
  controlMs: number;
}

/** Requests have bounded acknowledgements; an executing turn has no idle timeout. */
export class CodexAppServer {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, RpcPending>();
  private sequence = 0;
  private ended = false;
  private failure?: Error;
  private readonly ready: Promise<unknown>;
  private readonly timeouts: CodexRpcTimeouts;
  onRequest?: (method: string, params: any) => Promise<unknown>;
  onNotification?: (method: string, params: any) => void;
  onFailure?: (error: Error) => void;

  constructor(
    command: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    timeouts: Partial<CodexRpcTimeouts> = {},
    args: string[] = [],
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
          // Foundry has no interactive approval UI yet. Never auto-approve
          // a native request merely because it arrived over this transport.
          this.write({
            id: message.id,
            error: {
              code: -32601,
              message: `Foundry cannot answer ${message.method} interactively.`,
            },
          });
        } else this.onNotification?.(message.method, message.params ?? {});
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(message.error.message ?? "Codex request failed"),
        );
      else pending.resolve(message.result);
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

  close(): void {
    this.fail(new Error("Codex app-server closed."));
    stopAgentProcess(this.child);
  }

  private write(value: unknown): void {
    if (this.ended)
      throw this.failure ?? new Error("Codex app-server is closed.");
    this.child.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  private call(method: string, params: unknown): Promise<any> {
    if (this.ended) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      // Native startup loads configuration and integrations. It must not
      // inherit the short acknowledgement deadline of steer/interrupt.
      const timeoutMs =
        method === "initialize"
          ? this.timeouts.initializeMs
          : method === "thread/start" || method === "thread/resume"
            ? this.timeouts.startupMs
            : this.timeouts.controlMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ControlOutcomeUnknownError(
            `${method} did not acknowledge within ${timeoutMs / 1000}s; outcome unknown.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new ControlOutcomeUnknownError(
          `${pending.method} acknowledgement lost; outcome unknown. ${error.message}`,
        ),
      );
    }
    this.pending.clear();
    this.onFailure?.(error);
  }
}
