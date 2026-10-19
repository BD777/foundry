/** Ownership records for generated inputs; unknown/legacy paths are never swept. */
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  processIdentity,
  agentProcessesSupervised,
  hasLiveAgentProcesses,
} from "./agent-processes.js";
import { writePrivateJSONAtomic } from "./storage.js";
const localIdentity = processIdentity(process.pid);
export const inputOwnerFile = ".foundry-input-owner.json";
interface InputOwner {
  version: 1;
  path: string;
  kind: string;
  pid: number;
  startTime: string;
  supervised: boolean;
  createdAt: number;
}
export function markPrivateInputOwner(
  path: string,
  kind: string,
  marker = join(path, inputOwnerFile),
): void {
  const identity = localIdentity;
  if (!identity) return;
  writePrivateJSONAtomic(marker, {
    version: 1,
    path: resolve(path),
    kind,
    pid: process.pid,
    startTime: identity.startTime,
    supervised: agentProcessesSupervised(),
    createdAt: Date.now(),
  });
}
function alive(owner: InputOwner): boolean {
  const current =
    owner.pid === process.pid ? localIdentity : processIdentity(owner.pid);
  if (current) return current.startTime === owner.startTime;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export function privateInputCanBeRemoved(
  path: string,
  kind: string,
  options: {
    marker?: string;
    now?: number;
    minAgeMs?: number;
    currentOwnerIdle?: boolean;
    allowUnsupervised?: boolean;
    ownerStateCache?: Map<string, boolean>;
  } = {},
): boolean {
  try {
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
      return false;
    const marker = options.marker ?? join(path, inputOwnerFile);
    if (!lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink())
      return false;
    const record = JSON.parse(readFileSync(marker, "utf8")) as InputOwner;
    if (
      record.version !== 1 ||
      record.path !== resolve(path) ||
      record.kind !== kind ||
      !Number.isSafeInteger(record.pid) ||
      record.pid <= 0 ||
      typeof record.startTime !== "string" ||
      !record.startTime ||
      !Number.isFinite(record.createdAt)
    )
      return false;
    if (!record.supervised && !options.allowUnsupervised) return false;
    if (
      (options.now ?? Date.now()) - record.createdAt <
      (options.minAgeMs ?? 60_000)
    )
      return false;
    const key = `${record.pid}:${record.startTime}:${Boolean(options.currentOwnerIdle)}`;
    const known = options.ownerStateCache?.get(key);
    if (known !== undefined) return known;
    const own =
      record.pid === process.pid &&
      localIdentity?.startTime === record.startTime;
    const removable =
      !(alive(record) && !(own && options.currentOwnerIdle)) &&
      !hasLiveAgentProcesses({ pid: record.pid, startTime: record.startTime });
    options.ownerStateCache?.set(key, removable);
    return removable;
  } catch {
    return false;
  }
}
export function reapPrivateInputOwners(
  root: string,
  kind: string,
  options: Parameters<typeof privateInputCanBeRemoved>[2] = {},
): number {
  let removed = 0;
  const sweep = { ...options, ownerStateCache: new Map<string, boolean>() };
  try {
    if (lstatSync(root).isSymbolicLink()) return 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const path = join(root, entry.name);
      if (privateInputCanBeRemoved(path, kind, sweep)) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    /* Missing or inaccessible roots are not cleanup authority. */
  }
  return removed;
}
