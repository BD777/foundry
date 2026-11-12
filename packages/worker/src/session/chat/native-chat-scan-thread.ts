/**
 * Native chat logs are large JSONL files. Reading, parsing, adapting,
 * redacting, and fingerprinting them on the daemon's event loop competes with
 * the server heartbeat. This worker owns those steps and keeps the file cache
 * warm between sync rounds; the daemon receives only summaries plus the full
 * chats it is about to upload.
 */
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type {
  AgentProfileProjection,
  ChatThread,
  WorkspaceProjection,
} from "@bd777/foundry-protocol";
import { errorMessage } from "../../platform/utils.js";
import {
  invalidateNativeChatListings,
  nativeChatListingsRevision,
  nativeChatSnapshotForWorkspace,
  type NativeChatSnapshot,
} from "./native-chat.js";

export interface NativeChatScanInput {
  workspace: WorkspaceProjection;
  profiles: AgentProfileProjection[];
  limit?: number;
  includeIds?: string[];
  listingRevision?: number;
  environment?: Record<string, string | undefined>;
}

export interface NativeChatScanResult {
  /** Empty when the thread failed and the scan fell back to this thread. */
  scanId: string;
  chats: ChatThread[];
  fingerprints: Array<[string, string]>;
  transcriptMessages: Array<[string, number]>;
  parsedFiles: number;
  reusedFiles: number;
}

interface WorkerRequest {
  id: number;
  type: "scan" | "details";
  input: NativeChatScanInput;
  scanId?: string;
  ids?: string[];
}

type WorkerResponse =
  | { id: number; ok: true; result: NativeChatScanResult | ChatThread[] }
  | { id: number; ok: false; error: string };

interface PendingRequest {
  resolve(value: NativeChatScanResult | ChatThread[]): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const defaultTimeoutMs = 60_000;
const keptSnapshots = 64;
const workerSnapshots = new Map<string, ChatThread[]>();
let workerListingRevision = -1;
let nextScanId = 0;

const nativeChatEnvironmentKeys = [
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "FOUNDRY_STATE_ROOT",
  "FOUNDRY_STACK",
  "FOUNDRY_TOOLS_ROOT",
] as const;

function scanEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(
    nativeChatEnvironmentKeys.map((key) => [key, process.env[key]]),
  );
}

function applyScanEnvironment(
  environment: Record<string, string | undefined> | undefined,
): void {
  if (!environment) return;
  for (const key of nativeChatEnvironmentKeys) {
    const value = environment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function lightweight(chat: ChatThread): ChatThread {
  const { transcript: _transcript, ...summary } = chat;
  return summary;
}

function scanResult(
  scanId: string,
  snapshot: NativeChatSnapshot,
): NativeChatScanResult {
  return {
    scanId,
    chats: snapshot.chats.map(lightweight),
    fingerprints: [...snapshot.fingerprints],
    transcriptMessages: snapshot.chats.map((chat) => [
      chat.id,
      chat.transcript?.length ?? 0,
    ]),
    parsedFiles: snapshot.stats.parsedFiles,
    reusedFiles: snapshot.stats.reusedFiles,
  };
}

async function runWorkerRequest(
  request: WorkerRequest,
): Promise<NativeChatScanResult | ChatThread[]> {
  applyScanEnvironment(request.input.environment);
  const revision = request.input.listingRevision ?? 0;
  if (revision !== workerListingRevision) {
    invalidateNativeChatListings();
    workerListingRevision = revision;
  }
  if (request.type === "scan") {
    const snapshot = await nativeChatSnapshotForWorkspace(
      request.input.workspace,
      request.input.profiles,
      request.input.limit,
      new Set(request.input.includeIds ?? []),
    );
    const scanId = `native_scan_${process.pid}_${++nextScanId}`;
    workerSnapshots.delete(scanId);
    workerSnapshots.set(scanId, snapshot.chats);
    while (workerSnapshots.size > keptSnapshots) {
      workerSnapshots.delete(workerSnapshots.keys().next().value!);
    }
    return scanResult(scanId, snapshot);
  }

  const scanId = request.scanId ?? "";
  let chats = workerSnapshots.get(scanId);
  if (!chats) {
    chats = (
      await nativeChatSnapshotForWorkspace(
        request.input.workspace,
        request.input.profiles,
        request.input.limit,
        new Set(request.input.includeIds ?? []),
      )
    ).chats;
  }
  const ids = new Set(request.ids ?? []);
  return chats.filter((chat) => ids.has(chat.id));
}

export class NativeChatScanClient {
  readonly #createWorker: () => Worker;
  readonly #timeoutMs: number;
  #worker: Worker | undefined;
  #nextRequest = 0;
  #pending = new Map<number, PendingRequest>();

  constructor(
    options: {
      timeoutMs?: number;
      createWorker?: () => Worker;
    } = {},
  ) {
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#createWorker =
      options.createWorker ??
      (() =>
        new Worker(new URL(import.meta.url), {
          execArgv: [],
          workerData: { nativeChatScanner: true },
        }));
  }

  scan(input: NativeChatScanInput): Promise<NativeChatScanResult> {
    return this.#request({
      type: "scan",
      input: {
        ...input,
        listingRevision: nativeChatListingsRevision(),
        environment: scanEnvironment(),
      },
    }) as Promise<NativeChatScanResult>;
  }

  details(
    input: NativeChatScanInput,
    scanId: string,
    ids: readonly string[],
  ): Promise<ChatThread[]> {
    return this.#request({
      type: "details",
      input: {
        ...input,
        listingRevision: nativeChatListingsRevision(),
        environment: scanEnvironment(),
      },
      scanId,
      ids: [...ids],
    }) as Promise<ChatThread[]>;
  }

  stop(): void {
    const worker = this.#worker;
    this.#worker = undefined;
    this.#failAll(new Error("Native chat scan worker stopped"));
    if (worker) void worker.terminate();
  }

  #request(
    request: Omit<WorkerRequest, "id">,
  ): Promise<NativeChatScanResult | ChatThread[]> {
    const worker = this.#worker ?? this.#startWorker();
    const id = ++this.#nextRequest;
    worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(
          `native chat scan worker timed out after ${this.#timeoutMs} ms`,
        );
        this.#failAll(error);
        const stuck = this.#worker;
        this.#worker = undefined;
        if (stuck) void stuck.terminate();
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
      });
      try {
        worker.postMessage({ ...request, id } satisfies WorkerRequest);
      } catch (error) {
        const pending = this.#pending.get(id);
        if (pending) {
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          if (this.#pending.size === 0) worker.unref();
        }
      }
    });
  }

  #startWorker(): Worker {
    const worker = this.#createWorker();
    this.#worker = worker;
    worker.on("message", (message: WorkerResponse) => {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error));
      if (this.#pending.size === 0) worker.unref();
    });
    worker.on("error", (error) => this.#workerFailed(worker, error));
    worker.on("exit", (code) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      if (code !== 0 || this.#pending.size > 0) {
        this.#failAll(
          new Error(`native chat scan worker exited with code ${code}`),
        );
      }
    });
    return worker;
  }

  #workerFailed(worker: Worker, error: Error): void {
    if (this.#worker === worker) this.#worker = undefined;
    this.#failAll(error);
    void worker.terminate();
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

const sharedClient = new NativeChatScanClient();

export function scanNativeChatsInThread(
  input: NativeChatScanInput,
): Promise<NativeChatScanResult> {
  return sharedClient.scan(input);
}

export function nativeChatsFromThread(
  input: NativeChatScanInput,
  scanId: string,
  ids: readonly string[],
): Promise<ChatThread[]> {
  return sharedClient.details(input, scanId, ids);
}

export function stopNativeChatScanThread(): void {
  sharedClient.stop();
}

/** The daemon stays alive on a failed scan; parsing then degrades here. */
export async function scanNativeChatsForDaemon(
  input: NativeChatScanInput,
  options: {
    scanner?: Pick<NativeChatScanClient, "scan">;
    warn?: (message: string) => void;
  } = {},
): Promise<NativeChatScanResult> {
  try {
    return await (options.scanner ?? sharedClient).scan(input);
  } catch (error) {
    const detail = errorMessage(error);
    (options.warn ?? console.warn)(
      `Native chat scan worker failed (${detail}); scanning on the daemon thread`,
    );
    const snapshot = await nativeChatSnapshotForWorkspace(
      input.workspace,
      input.profiles,
      input.limit,
      new Set(input.includeIds ?? []),
    );
    return scanResult("", snapshot);
  }
}

const workerPort = parentPort;
if (!isMainThread && workerPort && workerData?.nativeChatScanner === true) {
  workerPort.on("message", (request: WorkerRequest) => {
    void runWorkerRequest(request)
      .then((result) =>
        workerPort.postMessage({
          id: request.id,
          ok: true,
          result,
        } satisfies WorkerResponse),
      )
      .catch((error: unknown) =>
        workerPort.postMessage({
          id: request.id,
          ok: false,
          error: errorMessage(error),
        } satisfies WorkerResponse),
      );
  });
}
