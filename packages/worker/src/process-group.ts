import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Run a command as the leader of its own process group, so stopping it stops
 * every tool it started. A helper parent watches the worker: if the worker
 * dies, the group is killed. Stops on abort, on timeout when one is given,
 * and when the command exits.
 */
export function spawnProcessGroup(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  signal?: AbortSignal,
  timeoutMs?: number,
): ChildProcessWithoutNullStreams {
  signal?.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./process-group-child.js", import.meta.url)),
      command,
      ...args,
    ],
    { ...options, detached: true, stdio: ["pipe", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;
  const kill = (kind: NodeJS.Signals): void => {
    if (child.pid)
      try {
        process.kill(-child.pid, kind);
      } catch {
        /* Process group already exited. */
      }
  };
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    kill("SIGTERM");
    force ??= setTimeout(() => kill("SIGKILL"), 1500);
    force.unref();
  };
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(stop, timeoutMs);
  timer?.unref();
  signal?.addEventListener("abort", stop, { once: true });
  child.once("exit", stop);
  child.once("close", () => {
    clearTimeout(timer);
    if (force) clearTimeout(force);
    kill("SIGKILL");
    signal?.removeEventListener("abort", stop);
  });
  child.once("error", () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  });
  return child;
}
