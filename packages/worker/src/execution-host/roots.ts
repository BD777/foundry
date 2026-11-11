/**
 * Where execution hosts live. A device runs one host per installed runtime:
 * the first at the original root (execution-host/), each newer one at its
 * own generation root (execution-hosts/<id>/), with its own socket, token,
 * service name, claims and outbox. The older ones drain beside the newest.
 */
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { processIdentity } from "../platform/process/agent-processes.js";
import { foundryStatePath } from "../platform/state-root.js";
import { executionHostPaths } from "./paths.js";

export interface HostIdentity {
  pid: number;
  startTime: string;
  entry?: string;
  runtimeStamp?: string;
  /** When the host wrote this identity (ms); hosts before rollover have none. */
  startedAt?: number;
}

const stoppedMarker = (root: string) => resolve(root, "stopped");

/**
 * Written by the daemon once it stopped the host's service: no service
 * manager will bring this host back, so its leftovers may be adopted. A host
 * that is merely dead (crashed, restarting) has no marker.
 */
export function markHostStopped(root: string): void {
  writeFileSync(stoppedMarker(root), new Date().toISOString(), {
    mode: 0o600,
  });
}
export function hostWasStopped(root: string): boolean {
  try {
    // A marker older than the identity is from before the host last started.
    return (
      statSync(stoppedMarker(root)).mtimeMs >=
      statSync(resolve(root, "identity.json")).mtimeMs
    );
  } catch {
    return false;
  }
}
/** A starting host is not stopped any more. */
export function clearHostStopped(root: string): void {
  rmSync(stoppedMarker(root), { force: true });
}

/**
 * Whether a live host precedes `self` in owning the device's shared work:
 * the one that started first (a host before rollover counts as first), the
 * root path deciding a tie. Hosts that start together cannot all wait.
 */
export function seniorHostLive(
  self: { root: string; startedAt: number },
  roots = knownHostRoots(),
): boolean {
  return roots.some((root) => {
    if (root === self.root || !liveHostIdentity(root)) return false;
    const startedAt = readHostIdentity(root)?.startedAt ?? 0;
    return (
      startedAt < self.startedAt ||
      (startedAt === self.startedAt && root < self.root)
    );
  });
}

export function generationsRoot(): string {
  return foundryStatePath("execution-hosts");
}

/** The root of the host that runs the runtime `stamp` (see runtimeStamp). */
export function generationRoot(
  stamp: string,
  base = generationsRoot(),
): string {
  return resolve(
    base,
    createHash("sha256").update(stamp).digest("hex").slice(0, 12),
  );
}

/** The original root and every generation root that exists. */
export function knownHostRoots(
  legacy = executionHostPaths().root,
  base = generationsRoot(),
): string[] {
  let generations: string[] = [];
  try {
    generations = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(base, entry.name))
      .sort();
  } catch {
    // No generation was ever started.
  }
  return [legacy, ...generations];
}

export function readHostIdentity(root: string): HostIdentity | undefined {
  try {
    const identity = JSON.parse(
      readFileSync(resolve(root, "identity.json"), "utf8"),
    );
    return typeof identity.pid === "number" &&
      typeof identity.startTime === "string"
      ? identity
      : undefined;
  } catch {
    return undefined;
  }
}

/** The host recorded at `root` if that very process still runs. */
export function liveHostIdentity(root: string): HostIdentity | undefined {
  const identity = readHostIdentity(root);
  return identity &&
    processIdentity(identity.pid)?.startTime === identity.startTime
    ? identity
    : undefined;
}

export function liveHostRoots(roots = knownHostRoots()): string[] {
  return roots.filter((root) => liveHostIdentity(root));
}

/** Runtime entries that live hosts run from: their folders must not be pruned. */
export function pinnedHostEntries(roots = knownHostRoots()): string[] {
  return roots.flatMap((root) => {
    try {
      const entry = JSON.parse(
        readFileSync(resolve(root, "identity.json"), "utf8"),
      ).entry;
      return typeof entry === "string" && entry ? [entry] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Whether a host that precedes `self` still counts as the owner of the
 * device's shared work: it runs, or it died without being stopped and its
 * service manager may bring it back (a crashed host before rollover has no
 * standby logic and would take the work again). `deadSince` remembers when
 * each such root was first seen dead.
 */
export function seniorHostPresent(
  self: { root: string; startedAt: number },
  deadSince: Map<string, number>,
  now = Date.now(),
  graceMs = 60_000,
  roots = knownHostRoots(),
): boolean {
  let present = false;
  for (const root of roots) {
    if (root === self.root) continue;
    const identity = readHostIdentity(root);
    if (!identity) {
      deadSince.delete(root);
      continue;
    }
    const startedAt = identity.startedAt ?? 0;
    const senior =
      startedAt < self.startedAt ||
      (startedAt === self.startedAt && root < self.root);
    if (!senior) continue;
    if (liveHostIdentity(root)) {
      deadSince.delete(root);
      present = true;
    } else if (!hostWasStopped(root)) {
      const since = deadSince.get(root) ?? now;
      deadSince.set(root, since);
      if (now - since < graceMs) present = true;
    }
  }
  return present;
}
