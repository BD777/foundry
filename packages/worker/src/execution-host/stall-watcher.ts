/**
 * The execution host's watcher thread. The host's event loop stamps the time
 * into shared memory every second; this thread reads it.
 *
 * - Blocked past the report threshold, the stall is written to stalls.log
 *   once, with the activities the loop marked (stall-monitor.ts) and the
 *   process's native stack, while it is still blocked. The connection service
 *   reclaims a host whose heartbeat is a minute old, so a stall it ends
 *   leaves this record; when the loop comes back, how long it was blocked.
 * - Blocked past the limit, the stall is recorded and the process is killed.
 */
import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { readSharedActivities } from "../platform/stall-monitor.js";

export interface StallWatch {
  /** Float64: when the event loop last ran. */
  stamp: SharedArrayBuffer;
  /** The loop's activities (shareActivities). */
  activities: SharedArrayBuffer;
  pid: number;
  /** The execution host's folder: stalls.log, stalls/ and fatal.log. */
  root: string;
  reportMs: number;
  limitMs: number;
}

const keptSamples = 5;
const logLimitBytes = 1024 * 1024;

export function startStallWatcher(watch: StallWatch): Worker {
  return new Worker(new URL(import.meta.url), {
    // Its own flags only: a parent's --input-type would apply to it too.
    execArgv: [],
    workerData: { stallWatch: watch },
  });
}

function append(path: string, line: string): void {
  try {
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > logLimitBytes)
      renameSync(path, `${path}.1`);
  } catch {}
  try {
    appendFileSync(path, `${new Date().toISOString()} ${line}\n`, {
      mode: 0o600,
    });
  } catch {}
}

/** Where the blocked thread is: a sample on macOS, its kernel state on Linux. */
function captureStack(
  pid: number,
  root: string,
  done: (where: string) => void,
) {
  if (process.platform === "darwin") {
    const folder = resolve(root, "stalls");
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const old = readdirSync(folder).sort();
      for (const name of old.slice(
        0,
        Math.max(0, old.length - keptSamples + 1),
      ))
        rmSync(resolve(folder, name), { force: true });
    } catch {}
    const file = resolve(
      folder,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${pid}.sample.txt`,
    );
    execFile(
      "/usr/bin/sample",
      [String(pid), "1", "-mayDie", "-file", file],
      { timeout: 30_000 },
      (error) =>
        done(error ? `no sample (${error.message})` : `sample ${file}`),
    );
    return;
  }
  if (process.platform === "linux") {
    const task = `/proc/${pid}/task/${pid}`;
    const read = (name: string) => {
      try {
        return readFileSync(`${task}/${name}`, "utf8").trim();
      } catch {
        return "?";
      }
    };
    const state = read("stat")
      .replace(/^.*\) /, "")
      .split(" ")[0];
    done(`state ${state}, wchan ${read("wchan")}, syscall ${read("syscall")}`);
    return;
  }
  done("no stack on this platform");
}

function watch(config: StallWatch): void {
  const stamp = new Float64Array(config.stamp);
  const log = resolve(config.root, "stalls.log");
  // The stamp of the stall already reported, until the loop runs again.
  let reported = 0;
  setInterval(() => {
    const last = stamp[0] ?? 0;
    const stalled = Date.now() - last;
    if (reported && last !== reported) {
      append(
        log,
        `pid ${config.pid} event loop ran again, about ${Math.round((last - reported) / 1000)} s after its last tick`,
      );
      reported = 0;
    }
    if (stalled >= config.limitMs) {
      const line = `pid ${config.pid} event loop blocked for ${stalled} ms; exiting`;
      append(log, line);
      append(resolve(config.root, "fatal.log"), line);
      process.kill(config.pid, "SIGKILL");
      return;
    }
    if (stalled < config.reportMs || reported) return;
    reported = last;
    const doing =
      readSharedActivities(config.activities) || "no marked activity";
    captureStack(config.pid, config.root, (where) =>
      append(
        log,
        `pid ${config.pid} event loop blocked for ${stalled} ms during ${doing}; ${where}`,
      ),
    );
  }, 1000);
}

const config = (workerData as { stallWatch?: StallWatch } | null)?.stallWatch;
if (!isMainThread && config) watch(config);
