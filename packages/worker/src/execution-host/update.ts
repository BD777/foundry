import { executionServiceIsSeparate } from "./service.js";
/** First migration cannot transplant a live SDK out of its old worker. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentProcessRegistry,
  processIdentity,
  readAgentProcessRecords,
} from "../agent-processes.js";
import { daemonLockHolder } from "../device-pairing.js";
import { readDaemonConfig } from "../config.js";
import { readRegistry } from "../workspaces.js";
import { daemonRequestHeaders } from "../server-http.js";
import { holdSelfUpdateLock } from "../self-update-lock.js";
import { recordSelfUpdateStep } from "../self-update-status.js";
import { executionHostPaths } from "./paths.js";

function hostOwnsWorker(pid: number, startTime: string): boolean {
  try {
    const root = executionHostPaths().root;
    const host = JSON.parse(
      readFileSync(resolve(root, "identity.json"), "utf8"),
    );
    if (processIdentity(host.pid)?.startTime !== host.startTime) return false;
    if (executionServiceIsSeparate(host.pid, pid)) return true;
    const owner = JSON.parse(readFileSync(resolve(root, "owner.json"), "utf8"));
    return owner.pid === pid && owner.startTime === startTime;
  } catch {
    return false;
  }
}

/** Ignore only this updater's ancestor chain, never an agent or tool. */
function workerHasChildren(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,stat="], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0)
    throw new Error(
      "Cannot inspect the old worker's child processes; it was not restarted.",
    );
  const rows = result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
  const parents = new Map(
    rows.map(([id, parent]) => [Number(id), Number(parent)]),
  );
  const own = new Set<number>();
  let ancestor = process.pid;
  while (ancestor > 1 && ancestor !== pid && !own.has(ancestor)) {
    own.add(ancestor);
    ancestor = parents.get(ancestor) ?? 0;
  }
  return rows.some(
    ([id, parent, state]) =>
      Number(parent) === pid && !own.has(Number(id)) && !state?.startsWith("Z"),
  );
}

async function activeSessions(): Promise<string[]> {
  const serverURL = readDaemonConfig()?.serverURL;
  if (!serverURL)
    throw new Error(
      "Cannot confirm legacy execution state without the paired server.",
    );
  const active: string[] = [];
  for (const workspace of readRegistry()) {
    const response = await fetch(
      `${serverURL}/api/daemon/chats/running?workspaceId=${encodeURIComponent(workspace.id)}`,
      {
        headers: daemonRequestHeaders(false),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 404) continue; // A forgotten workspace cannot receive new dispatches.
    if (!response.ok)
      throw new Error(
        "Cannot confirm legacy executions with the server; the old worker was not restarted.",
      );
    const value = (await response.json()) as { activeSessionIds?: string[] };
    if (!Array.isArray(value.activeSessionIds))
      throw new Error(
        "Update the server before migrating a legacy execution worker.",
      );
    active.push(...value.activeSessionIds);
  }
  return active;
}

/** Returns a release function: a legacy worker stays paused across restart. */
export async function prepareWorkerRestart(
  version: string,
): Promise<() => void> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    return () => {};
  const deadline = Date.now() + 2 * 60 * 60_000;
  while (Date.now() < deadline) {
    const pid = daemonLockHolder();
    if (!pid || pid === process.pid) return () => {};
    const identity = processIdentity(pid);
    if (!identity) return () => {};
    const ownNative = readAgentProcessRecords(agentProcessRegistry()).some(
      (record) =>
        record.owner.pid === pid &&
        record.owner.startTime === identity.startTime &&
        processIdentity(record.pid)?.startTime === record.startTime,
    );
    if (!ownNative && hostOwnsWorker(pid, identity.startTime)) return () => {};
    const active = await activeSessions();
    if (!ownNative && !active.length && !workerHasChildren(pid)) {
      // Close the last-check/start race: while paused, a newly queued input
      // cannot start in the old process. The next worker can pick it up.
      if (processIdentity(pid)?.startTime !== identity.startTime) continue;
      process.kill(pid, "SIGSTOP");
      const release = () => {
        if (processIdentity(pid)?.startTime === identity.startTime)
          process.kill(pid, "SIGCONT");
      };
      try {
        if (!(await activeSessions()).length && !workerHasChildren(pid))
          return release;
      } catch (error) {
        release();
        throw error;
      }
      release();
    }
    recordSelfUpdateStep("waiting", {
      version,
      detail:
        "The old worker still owns execution or background work. It will be updated after that work ends; no running agent is stopped.",
    });
    holdSelfUpdateLock();
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(
    "Legacy execution did not become idle within two hours. It was left running; retry the update after its work ends.",
  );
}
