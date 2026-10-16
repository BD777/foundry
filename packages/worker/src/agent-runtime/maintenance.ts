/** Cross-process runtime leases. Launch and activation share the same gate. */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { processIdentity } from "../agent-processes.js";
import { foundryToolsRoot } from "../state-root.js";
import { writePrivateJSONAtomic } from "../storage.js";

type Owner = { pid: number; startTime: string };
const pause = () => new Promise<void>((done) => setTimeout(done, 50));
function owner(): Owner {
  const startTime = processIdentity(process.pid)?.startTime;
  if (!startTime) throw new Error("Cannot identify runtime lease owner.");
  return { pid: process.pid, startTime };
}
function stale(path: string): boolean {
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as Owner;
    const identity = processIdentity(held.pid);
    if (identity) return identity.startTime !== held.startTime;
    try {
      process.kill(held.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}
function root(runtime: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(runtime)) throw new Error("Invalid runtime id");
  return resolve(foundryToolsRoot(), "agent-runtime-locks", runtime);
}
async function gate<T>(
  runtime: string,
  action: (dir: string) => T,
): Promise<T> {
  const dir = root(runtime);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = resolve(dir, "gate");
  const deadline = Date.now() + 65_000;
  for (;;) {
    if (Date.now() > deadline)
      throw new Error(
        "Cannot acquire the agent runtime maintenance gate; existing work was left running.",
      );
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (stale(resolve(lock, "owner.json")))
        rmSync(lock, { recursive: true, force: true });
      else {
        try {
          // A crash between mkdir and writing ownership leaves an empty gate.
          if (
            !readdirSync(lock).length &&
            Date.now() - statSync(lock).mtimeMs > 60_000
          )
            rmSync(lock, { recursive: true, force: true });
        } catch {
          /* The other owner released it. */
        }
        await pause();
      }
    }
  }
  try {
    writePrivateJSONAtomic(resolve(lock, "owner.json"), owner());
    for (const name of readdirSync(dir)) {
      if (
        (name.startsWith("reader-") || name === "writer.json") &&
        stale(resolve(dir, name))
      )
        rmSync(resolve(dir, name), { force: true });
    }
    return action(dir);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
const inheritedLeases = new Set<string>();
/** Only the trusted sandbox host calls this: its parent holds the lease until exit. */
export function inheritRuntimeLease(runtime: string): void {
  inheritedLeases.add(runtime);
}

export async function acquireRuntime(
  runtime: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (inheritedLeases.has(runtime)) return () => {};
  for (;;) {
    signal?.throwIfAborted();
    const release = await gate(runtime, (dir) => {
      if (readdirSync(dir).includes("writer.json")) return undefined;
      const path = resolve(dir, `reader-${randomUUID()}.json`);
      writePrivateJSONAtomic(path, owner());
      return () => rmSync(path, { force: true });
    });
    if (release) return release;
    await pause();
  }
}
/** No interruption: a busy runtime makes the update wait for the next tick. */
export function tryMaintainRuntime(
  runtime: string,
): Promise<(() => void) | undefined> {
  return gate(runtime, (dir) => {
    if (
      readdirSync(dir).some(
        (name) => name.startsWith("reader-") || name === "writer.json",
      )
    )
      return undefined;
    const path = resolve(dir, "writer.json");
    writePrivateJSONAtomic(path, owner());
    return () => rmSync(path, { force: true });
  });
}
