import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ConnectorExtensionMethods,
  ConnectorExtensionNotifications,
} from "@bd777/foundry-protocol";
import { connectorExtensionProtocol } from "@bd777/foundry-protocol";
import {
  findCommand,
  managedToolsBin,
  toolEnvironment,
} from "../../skills/managed-tools.js";
import { declarativeCall } from "./declarative.js";
import {
  extensionBaseEnvironment,
  findExtensionCommand,
} from "./process-environment.js";
import {
  digestOf,
  extensionDataDir,
  loadedExtensions,
  type LoadedExtension,
} from "./registry.js";

/**
 * Talking to installed connector extensions (docs/connector-extensions.md,
 * "协议"): one process per extension, started on the first request and
 * ended after it has been idle a while; JSON-RPC 2.0, one message per line
 * on stdin/stdout. The process gets an ordinary environment, never the
 * worker's credentials, and its stderr is not read (provider diagnostics
 * may hold credentials). Its files must still match the digest recorded
 * when it was installed, or it is not started.
 */

const idleMs = 10 * 60_000;
const maxLine = 1024 * 1024;
const initializeTimeoutMs = 20_000;

export class ExtensionUnavailableError extends Error {}

type Method = keyof ConnectorExtensionMethods;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ExtensionHostOptions {
  /** A connector's login changed outside a request. */
  onChanged?: (extensionId: string, kind: string) => void;
  log?: (message: string) => void;
  workerVersion?: string;
}

/** One running extension process. */
class ExtensionProcess {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private idleTimer?: NodeJS.Timeout;
  private ended = false;
  readonly ready: Promise<void>;
  progress?: (
    progress: ConnectorExtensionNotifications["connector.progress"],
  ) => void;

  constructor(
    readonly extension: LoadedExtension,
    private readonly child: ChildProcess,
    private readonly options: ExtensionHostOptions,
    private readonly onExit: () => void,
  ) {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.read(chunk));
    child.on("exit", () =>
      this.end(new ExtensionUnavailableError(`${this.id} stopped`)),
    );
    child.on("error", (error) =>
      this.end(
        new ExtensionUnavailableError(
          `${this.id} could not start: ${error.message}`,
        ),
      ),
    );
    child.stdin!.on("error", () => undefined);
    this.ready = this.call(
      "initialize",
      {
        protocolVersion: connectorExtensionProtocol,
        extensionId: extension.manifest.id,
        extensionDir: extension.installed.dir,
        dataDir: extensionDataDir(extension.manifest.id),
        worker: { version: options.workerVersion ?? "" },
      },
      initializeTimeoutMs,
    ).then((result) => {
      if (result.protocolVersion !== connectorExtensionProtocol)
        throw new ExtensionUnavailableError(
          `${this.id} answered protocol ${String(result.protocolVersion)}; this worker speaks ${connectorExtensionProtocol}`,
        );
    });
    this.ready.catch(() => this.stop());
  }

  get id(): string {
    return this.extension.manifest.id;
  }

  get alive(): boolean {
    return !this.ended;
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > maxLine && !this.buffer.includes("\n")) {
      this.options.log?.(
        `connector extension ${this.id} wrote a line over ${maxLine} bytes; stopping it`,
      );
      this.stop();
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.message(line);
    }
  }

  private message(line: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      message = JSON.parse(line);
    } catch {
      // Not protocol: an extension must keep stdout for messages only.
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(
            String(message.error.message ?? "the extension refused").slice(
              0,
              300,
            ),
          ),
        );
      else pending.resolve(message.result ?? {});
      this.touch();
      return;
    }
    if (
      message.method === "connector.changed" &&
      typeof message.params?.kind === "string"
    )
      this.options.onChanged?.(this.id, message.params.kind);
    if (
      message.method === "connector.progress" &&
      typeof message.params?.kind === "string"
    )
      this.progress?.(
        message.params as ConnectorExtensionNotifications["connector.progress"],
      );
  }

  call<M extends Method>(
    method: M,
    params: ConnectorExtensionMethods[M]["params"],
    timeoutMs: number,
  ): Promise<ConnectorExtensionMethods[M]["result"]> {
    if (this.ended)
      return Promise.reject(
        new ExtensionUnavailableError(`${this.id} is not running`),
      );
    clearTimeout(this.idleTimer);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${this.id} did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`,
          ),
        );
        this.touch();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  /** Starts the idle countdown once nothing is waiting. */
  private touch(): void {
    clearTimeout(this.idleTimer);
    if (this.pending.size > 0 || this.ended) return;
    this.idleTimer = setTimeout(() => this.stop(), idleMs);
    this.idleTimer.unref();
  }

  /** Asks the extension to end, then ends it. */
  stop(): void {
    if (this.ended) return;
    const child = this.child;
    try {
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown", params: {} })}\n`,
      );
      child.stdin!.end();
    } catch {
      // Already gone.
    }
    const kill = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 2_000);
    kill.unref();
    this.end(new ExtensionUnavailableError(`${this.id} stopped`));
  }

  private end(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.onExit();
  }
}

/** The program and arguments the manifest names, resolved on this device. */
export function resolveEntry(extension: LoadedExtension): {
  command: string;
  args: string[];
} {
  const dir = extension.installed.dir;
  const data = extensionDataDir(extension.manifest.id);
  const substitute = (value: string) =>
    value.replaceAll("${extensionDir}", dir).replaceAll("${dataDir}", data);
  const entry = extension.manifest.entry;
  if (!entry)
    throw new ExtensionUnavailableError(
      `${extension.manifest.name} is declarative and runs no program`,
    );
  const named = entry.command;
  let command: string | undefined;
  if (named === "node") command = process.execPath;
  else if (named.startsWith("${extensionDir}/")) command = substitute(named);
  else if (named.startsWith("/")) command = named;
  else command = findExtensionCommand(named);
  if (!command || !existsSync(command))
    throw new ExtensionUnavailableError(
      `${extension.manifest.name} needs ${named}, which is not on this device`,
    );
  return {
    command,
    args: (entry.args ?? []).map(substitute),
  };
}

/** The environment an extension's process starts with. */
function extensionEnvironment(
  extension: LoadedExtension,
  command: string,
): NodeJS.ProcessEnv {
  const env = extensionBaseEnvironment();
  env.FOUNDRY_EXTENSION_ID = extension.manifest.id;
  env.FOUNDRY_EXTENSION_DIR = extension.installed.dir;
  env.FOUNDRY_EXTENSION_DATA_DIR = extensionDataDir(extension.manifest.id);
  // The program the worker started, as resolved here (a runtime such as
  // bun or node), for a session helper the extension names.
  env.FOUNDRY_EXTENSION_COMMAND = command;
  // Where Foundry installs npm tools (a connector's tool.source "npm").
  env.FOUNDRY_TOOLS_BIN = managedToolsBin();
  return env;
}

/** The installed extensions' processes, one each. */
export class ExtensionHost {
  private readonly processes = new Map<string, ExtensionProcess>();
  private readonly verified = new Map<string, string>();

  constructor(private readonly options: ExtensionHostOptions = {}) {}

  /** The worker's version, told to extensions when they start. */
  set workerVersion(version: string) {
    this.options.workerVersion = version;
  }

  extension(id: string): LoadedExtension | undefined {
    return loadedExtensions(this.options.log).find(
      (item) => item.manifest.id === id,
    );
  }

  /** Checked once per installed copy: its files must be the ones added. */
  private verify(extension: LoadedExtension): void {
    const id = extension.manifest.id;
    if (this.verified.get(id) === extension.installed.sha256) return;
    if (digestOf(extension.installed.dir) !== extension.installed.sha256)
      throw new ExtensionUnavailableError(
        `${extension.manifest.name}'s files changed since it was installed; install it again with foundry-worker extension add`,
      );
    this.verified.set(id, extension.installed.sha256);
  }

  private start(
    extension: LoadedExtension,
    environment?: Record<string, string>,
  ): ExtensionProcess {
    const id = extension.manifest.id;
    this.verify(extension);
    const { command, args } = resolveEntry(extension);
    const data = extensionDataDir(id);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const child = spawn(command, args, {
      cwd: data,
      env: { ...extensionEnvironment(extension, command), ...environment },
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
    });
    const running = new ExtensionProcess(extension, child, this.options, () => {
      // A process started with its own environment is not the extension's
      // one process: the next request does not find it.
      if (!environment && this.processes.get(id) === running)
        this.processes.delete(id);
    });
    if (!environment) this.processes.set(id, running);
    return running;
  }

  private async process(id: string): Promise<ExtensionProcess> {
    const extension = this.extension(id);
    if (!extension)
      throw new ExtensionUnavailableError(
        `the extension ${id} is not installed on this device`,
      );
    let running = this.processes.get(id);
    // An update swaps the files: the next request starts the new copy.
    if (
      running &&
      running.extension.installed.sha256 !== extension.installed.sha256
    ) {
      running.stop();
      running = undefined;
    }
    if (!running?.alive) running = this.start(extension);
    await running.ready;
    return running;
  }

  /** One request to the extension, starting it when needed. */
  async call<M extends Method>(
    id: string,
    method: M,
    params: ConnectorExtensionMethods[M]["params"],
    timeoutMs: number,
    progress?: ExtensionProcess["progress"],
    environment?: Record<string, string>,
  ): Promise<ConnectorExtensionMethods[M]["result"]> {
    const declarative = this.extension(id);
    if (declarative && !declarative.manifest.entry) {
      // No program: the worker answers from the manifest's cli.
      this.verify(declarative);
      const cli = declarative.manifest.cli ?? {};
      return declarativeCall(
        declarative.manifest.connectors.flatMap((descriptor) =>
          cli[descriptor.kind]
            ? [{ descriptor, cli: cli[descriptor.kind]! }]
            : [],
        ),
        method,
        params,
        environment,
      );
    }
    if (environment) {
      // One request in a process of its own, with these variables added:
      // how the extension answers as a session that may not use the login.
      const extension = this.extension(id);
      if (!extension)
        throw new ExtensionUnavailableError(
          `the extension ${id} is not installed on this device`,
        );
      const alone = this.start(extension, environment);
      try {
        await alone.ready;
        return await alone.call(method, params, timeoutMs);
      } finally {
        alone.stop();
      }
    }
    const running = await this.process(id);
    running.progress = progress;
    try {
      return await running.call(method, params, timeoutMs);
    } finally {
      if (progress && running.progress === progress)
        running.progress = undefined;
    }
  }

  /** Ends every running extension (the worker is stopping). */
  stopAll(): void {
    for (const running of this.processes.values()) running.stop();
    this.processes.clear();
  }

  /** Ends extensions that are no longer installed. */
  prune(): void {
    const installed = new Set(
      loadedExtensions(this.options.log).map((item) => item.manifest.id),
    );
    for (const [id, running] of this.processes)
      if (!installed.has(id)) running.stop();
  }
}
