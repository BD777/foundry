/**
 * The connection service's own account of whether it came online, read by
 * an update that restarted it: connected to the server, and its session
 * runner answering (or explicitly being reclaimed).
 */
import { processIdentity } from "./agent-processes.js";
import { foundryStatePath } from "./state-root.js";
import { tryReadJSONFile, writePrivateJSONAtomic } from "./storage.js";
import { ownPackage } from "./worker-identity.js";

export type RunnerHealth = "ready" | "reclaiming" | "unavailable" | "starting";

export interface DaemonHealth {
  pid: number;
  startTime?: string;
  version: string;
  startedAt: string;
  /** When it last registered with the server. */
  connectedAt?: string;
  /** Absent: no separate runner (a platform without one). */
  runner?: RunnerHealth;
  runnerDetail?: string;
  at: string;
}

export const daemonHealthPath = () => foundryStatePath("daemon-health.json");

let health: DaemonHealth | undefined;

export function noteDaemonHealth(
  patch: Partial<Pick<DaemonHealth, "connectedAt" | "runner" | "runnerDetail">>,
): void {
  const now = new Date().toISOString();
  health ??= {
    pid: process.pid,
    startTime: processIdentity(process.pid)?.startTime,
    version: ownPackage().version,
    startedAt: now,
    at: now,
  };
  const next = { ...health, ...patch, at: now };
  if (
    next.connectedAt === health.connectedAt &&
    next.runner === health.runner &&
    next.runnerDetail === health.runnerDetail &&
    health.at !== health.startedAt
  )
    return;
  health = next;
  try {
    writePrivateJSONAtomic(daemonHealthPath(), health);
  } catch (error) {
    console.error(
      `Could not record the worker's health: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readDaemonHealth(): DaemonHealth | undefined {
  return tryReadJSONFile<DaemonHealth>(daemonHealthPath());
}

/**
 * Whether the restarted worker of `version` came online: a live process of
 * that version registered with the server after `since`, with its runner
 * answering or being reclaimed. Otherwise why not, for the update's record.
 */
export function daemonCameOnline(
  version: string,
  since: number,
  value = readDaemonHealth(),
): { ok: true } | { ok: false; reason: string } {
  if (!value || Date.parse(value.startedAt) < since)
    return { ok: false, reason: "the new worker has not started" };
  if (value.version !== version)
    return {
      ok: false,
      reason: `the worker that started runs ${value.version}, not ${version}`,
    };
  if (processIdentity(value.pid)?.startTime !== value.startTime)
    return { ok: false, reason: "the new worker exited after starting" };
  if (!value.connectedAt)
    return {
      ok: false,
      reason: "the new worker has not connected to the server",
    };
  if (value.runner && value.runner !== "ready" && value.runner !== "reclaiming")
    return {
      ok: false,
      reason: `its session runner is ${value.runner}${value.runnerDetail ? ` (${value.runnerDetail})` : ""}`,
    };
  return { ok: true };
}
