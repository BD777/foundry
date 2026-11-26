import { createInterface } from "node:readline";
import { spawnProcessGroup } from "../../platform/process/process-group.js";
import { PendingReplies } from "../../platform/pending-replies.js";

type Params = Record<string, any>;
interface Handlers {
  acceptUpdate?(): boolean;
  update?(params: Params): void | Promise<void>;
  permission?(params: Params): Promise<unknown>;
}

/** ACP v1 over newline-delimited JSON-RPC. Server requests have their own id space. */
export class AcpClient {
  private readonly abort = new AbortController();
  private readonly pending = new PendingReplies<number>();
  private readonly child;
  private nextId = 0;
  private ended?: Error;
  private updates = Promise.resolve();

  constructor(
    invocation: { command: string; args: string[]; env: NodeJS.ProcessEnv },
    cwd: string,
    private readonly handlers: Handlers = {},
  ) {
    this.child = spawnProcessGroup(
      invocation.command,
      invocation.args,
      { cwd, env: invocation.env },
      this.abort.signal,
    );
    this.child.stderr.resume();
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) =>
      this.fail(new Error(`Antigravity ACP exited (${signal ?? code}).`)),
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {
        this.fail(new Error("Invalid Antigravity ACP response."));
      }
    });
  }

  private fail(error: Error) {
    if (this.ended) return;
    this.ended = error;
    this.pending.rejectAll(() => error);
    this.abort.abort();
  }

  private send(message: Params) {
    if (this.ended) throw this.ended;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }

  private receive(message: Params) {
    const { id, method, params } = message;
    if (method === "session/update" && id == null) {
      // Decide when the frame arrives, before asynchronous handlers drain.
      if (this.handlers.acceptUpdate?.() === false) return;
      this.updates = this.updates
        .then(() => this.handlers.update?.(params))
        .catch((error) => this.fail(error));
    } else if (method && id != null) {
      if (method !== "session/request_permission") {
        this.send({
          id,
          error: { code: -32601, message: "Method not supported" },
        });
        return;
      }
      const cancelled = { outcome: { outcome: "cancelled" } };
      void this.updates
        .then(() => this.handlers.permission?.(params) ?? cancelled)
        .catch(() => cancelled)
        .then((result) => {
          if (!this.ended) this.send({ id, result });
        })
        .catch((error) => this.fail(error));
    } else if (!method && typeof id === "number") {
      if (message.error)
        this.pending.reject(id, new Error(String(message.error.message)));
      else
        void this.updates.then(() => this.pending.resolve(id, message.result));
    }
  }

  request(method: string, params: Params): Promise<Params> {
    const id = ++this.nextId;
    this.send({ id, method, params });
    return this.pending.wait(
      id,
      method === "session/prompt"
        ? {}
        : {
            timeout: {
              ms: 60_000,
              error: () => new Error(`Antigravity timed out in ${method}`),
            },
          },
    );
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "Foundry", version: "1" },
    });
    if (result.protocolVersion !== 1)
      throw new Error("Antigravity requires a different ACP protocol version.");
    return result;
  }

  notify(method: string, params: Params) {
    this.send({ method, params });
  }

  close() {
    this.fail(new Error("Antigravity ACP connection closed."));
  }
}
