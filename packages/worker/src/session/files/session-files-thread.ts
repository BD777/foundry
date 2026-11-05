/**
 * Runs the execution host's turn file records on a thread of their own.
 *
 * A file record reads and writes the workspace synchronously: it copies a
 * file before a write, records it after, and keeps the session's ledger and
 * diffs. In a workspace on a network share each of those waited on the share
 * on the thread that serves every session; a share that slowed down or
 * stopped answering blocked them all until the host was reclaimed (DEV-124).
 * Here only this thread waits. Asynchronous fs calls would not do: they wait
 * in libuv's small shared pool, where a hung share starves every other file
 * and DNS call of the process. The code that runs is TurnFilesCore, unchanged;
 * its events come back to the session's emitter in order.
 */
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type { SessionEventEmitter } from "../session-state.js";
import { errorMessage } from "../../platform/utils.js";
import {
  runTurnFilesOn,
  TurnFilesCore,
  type SessionTurnFilesOptions,
  type TurnFilesRunner,
  type TurnFilesWork,
} from "./session-files.js";

type Method = keyof TurnFilesWork;
type PlainOptions = Omit<SessionTurnFilesOptions, "emit">;

type ToThread =
  | { type: "open"; id: number; options: PlainOptions }
  | { type: "call"; id: number; call: number; method: Method; args: unknown[] }
  | { type: "close"; id: number };

type FromThread =
  | { type: "result"; call: number; value: unknown }
  | { type: "error"; call: number; message: string }
  | { type: "emit"; id: number; args: Parameters<SessionEventEmitter> };

/** One record's emitter, held by the record so the record can be collected. */
interface Opened extends TurnFilesWork {
  emit: SessionEventEmitter;
}

class TurnFilesThread implements TurnFilesRunner {
  private worker?: Worker;
  private generation = 0;
  private nextId = 1;
  private nextCall = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly opened = new Map<number, WeakRef<Opened>>();
  private readonly closer = new FinalizationRegistry<{
    id: number;
    generation: number;
  }>(({ id, generation }) => {
    this.opened.delete(id);
    if (generation === this.generation) this.post({ type: "close", id });
  });

  open(options: SessionTurnFilesOptions): TurnFilesWork {
    const { emit, ...plain } = options;
    this.ensureWorker();
    const id = this.nextId++;
    const generation = this.generation;
    this.post({ type: "open", id, options: plain });
    const call = (method: Method, args: unknown[]) =>
      this.call(id, generation, method, args);
    const record: Opened = {
      emit,
      captureBeforeWrite: (write) =>
        call("captureBeforeWrite", [write]) as Promise<void>,
      recordToolWrite: (write) =>
        call("recordToolWrite", [write]) as Promise<void>,
      snapshotWorkTree: () => call("snapshotWorkTree", []) as Promise<void>,
      finish: (answer) =>
        call("finish", [answer]) as ReturnType<TurnFilesWork["finish"]>,
    };
    this.opened.set(id, new WeakRef(record));
    this.closer.register(record, { id, generation });
    return record;
  }

  private ensureWorker(): void {
    if (this.worker) return;
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: [],
      workerData: { turnFilesThread: true },
    });
    worker.unref();
    worker.on("message", (message: FromThread) => this.receive(message));
    const stopped = (reason: string) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.generation++;
      this.opened.clear();
      const error = new Error(`Turn file record thread stopped: ${reason}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    };
    worker.once("error", (error) => stopped(errorMessage(error)));
    worker.once("exit", (code) => stopped(`exit code ${code}`));
    this.worker = worker;
  }

  private call(
    id: number,
    generation: number,
    method: Method,
    args: unknown[],
  ): Promise<unknown> {
    if (generation !== this.generation)
      return Promise.reject(
        new Error("Turn file record thread stopped; this record was lost"),
      );
    const call = this.nextCall++;
    return new Promise((resolve, reject) => {
      this.pending.set(call, { resolve, reject });
      this.post({ type: "call", id, call, method, args });
    });
  }

  private receive(message: FromThread): void {
    if (message.type === "emit") {
      void this.opened
        .get(message.id)
        ?.deref()
        ?.emit(...message.args)
        .catch((error) =>
          console.error(
            `Could not report a file record: ${errorMessage(error)}`,
          ),
        );
      return;
    }
    const waiting = this.pending.get(message.call);
    if (!waiting) return;
    this.pending.delete(message.call);
    if (message.type === "result") waiting.resolve(message.value);
    else waiting.reject(new Error(message.message));
  }

  private post(message: ToThread): void {
    this.worker?.postMessage(message);
  }

  /** Ends the thread; its records fail, and the next one starts another. */
  async stop(): Promise<void> {
    await this.worker?.terminate();
  }
}

/** Runs this process's turn file records on their own thread from now on. */
export function startTurnFilesThread(): { stop(): Promise<void> } {
  const thread = new TurnFilesThread();
  runTurnFilesOn(thread);
  return thread;
}

function serve(port: NonNullable<typeof parentPort>): void {
  const records = new Map<number, TurnFilesCore | Error>();
  const send = (message: FromThread) => port.postMessage(message);
  port.on("message", (message: ToThread) => {
    if (message.type === "open") {
      try {
        records.set(
          message.id,
          new TurnFilesCore({
            ...message.options,
            emit: async (...args) =>
              send({ type: "emit", id: message.id, args }),
          }),
        );
      } catch (error) {
        records.set(
          message.id,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
      return;
    }
    if (message.type === "close") {
      records.delete(message.id);
      return;
    }
    const record = records.get(message.id);
    const run = async () => {
      if (!record) throw new Error("Unknown turn file record");
      if (record instanceof Error) throw record;
      const method = record[message.method] as (
        ...args: unknown[]
      ) => Promise<unknown>;
      return method.apply(record, message.args);
    };
    run().then(
      (value) => send({ type: "result", call: message.call, value }),
      (error) =>
        send({
          type: "error",
          call: message.call,
          message: errorMessage(error),
        }),
    );
  });
}

if (
  !isMainThread &&
  parentPort &&
  (workerData as { turnFilesThread?: boolean } | null)?.turnFilesThread
)
  serve(parentPort);
