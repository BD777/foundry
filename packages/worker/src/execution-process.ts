import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { fileURLToPath } from "node:url";

const active = new Map<string, AbortController>();
const pending = new Set<string>();
export function beginIssueExecution(issueId: string): AbortController {
  if (active.has(issueId))
    throw new Error("Issue already has an active execution");
  const control = new AbortController();
  active.set(issueId, control);
  if (pending.delete(issueId))
    control.abort(new Error("Issue execution canceled"));
  return control;
}
export function finishIssueExecution(issueId: string): void {
  active.delete(issueId);
  pending.delete(issueId);
}
export function cancelIssueExecution(issueId: string): void {
  const control = active.get(issueId);
  if (control) control.abort(new Error("Issue execution canceled"));
  else pending.add(issueId);
}
export function executionActive(issueId: string): boolean {
  return active.has(issueId);
}

export function spawnExecution(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
  signal?: AbortSignal,
  timeoutMs = 900_000,
): ChildProcessWithoutNullStreams {
  signal?.throwIfAborted();
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./execution-process-child.js", import.meta.url)),
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
  const timer = setTimeout(stop, timeoutMs);
  timer.unref();
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
