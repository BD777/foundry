/**
 * The runner proves its event loop runs, and never hangs on its way out.
 *
 * - heartbeat.json is rewritten every few seconds from the event loop; the
 *   connection service and the macOS watchdog read it to tell a wedged
 *   runner from a slow one.
 * - A fatal error ends the process with SIGKILL after it is recorded: a
 *   normal exit joins libuv's thread pool, and one blocked thread then keeps
 *   the process half-dead forever (2026-10-28, a macOS device: SIGTERM no longer
 *   worked). Its manager restarts it.
 * - A thread of its own watches the loop: blocked for longer than the limit,
 *   the stall is recorded and the process is ended the same way.
 */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { processIdentity } from "../agent-processes.js";
import { writePrivateJSONAtomic } from "../storage.js";

export const hostHeartbeatIntervalMs = 5000;
/** A loop blocked this long is not coming back; long sync work stays below. */
export const hostStallLimitMs = Number(
  process.env.FOUNDRY_EXECUTION_STALL_LIMIT_MS || 5 * 60_000,
);

/** Resolves once the watcher thread runs; it needs the loop to start. */
export function startHostLiveness(root: string, label?: string): Promise<void> {
  const heartbeat = resolve(root, "heartbeat.json");
  const crashLog = resolve(root, "fatal.log");
  const startTime = processIdentity(process.pid)?.startTime;
  const beat = () => {
    try {
      writePrivateJSONAtomic(heartbeat, {
        pid: process.pid,
        startTime,
        label,
        at: new Date().toISOString(),
      });
    } catch {}
  };
  beat();
  setInterval(beat, hostHeartbeatIntervalMs).unref();

  const fatal = (kind: string, error: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    try {
      appendFileSync(
        crashLog,
        `${new Date().toISOString()} pid ${process.pid} ${kind}: ${detail}\n`,
        { mode: 0o600 },
      );
    } catch {}
    console.error(`Execution host ${kind}; exiting: ${detail}`);
    process.kill(process.pid, "SIGKILL");
  };
  process.on("uncaughtException", (error) =>
    fatal("uncaught exception", error),
  );
  process.on("unhandledRejection", (error) =>
    fatal("unhandled rejection", error),
  );

  // The loop stamps shared memory; the watcher thread reads it.
  const shared = new Float64Array(new SharedArrayBuffer(8));
  shared[0] = Date.now();
  setInterval(() => {
    shared[0] = Date.now();
  }, 1000).unref();
  const watcher = new Worker(
    `const { workerData } = require("node:worker_threads");
     const { appendFileSync } = require("node:fs");
     const stamp = new Float64Array(workerData.buffer);
     setInterval(() => {
       const stalled = Date.now() - stamp[0];
       if (stalled < workerData.limit) return;
       try {
         appendFileSync(workerData.log, new Date().toISOString() + " pid " +
           workerData.pid + " event loop blocked for " + stalled + " ms; exiting\\n",
           { mode: 0o600 });
       } catch {}
       process.kill(workerData.pid, "SIGKILL");
     }, Math.min(5000, workerData.limit / 4));`,
    {
      eval: true,
      // Its own flags only: a parent's --input-type would make it ESM.
      execArgv: [],
      workerData: {
        buffer: shared.buffer,
        limit: hostStallLimitMs,
        pid: process.pid,
        log: crashLog,
      },
    },
  );
  watcher.unref();
  return new Promise((done) => {
    watcher.once("online", () => done());
    watcher.once("error", () => done());
  });
}
