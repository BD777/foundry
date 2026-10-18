import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { WorkSession } from "./supervisor.js";
import { processIdentity } from "../agent-processes.js";

export interface NativeSchedule {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring?: boolean;
  createdBySessionId?: string;
  createdByPid?: number;
  permanent?: boolean;
}
export function readNativeSchedules(directory: string): NativeSchedule[] {
  const path = join(directory, ".claude", "scheduled_tasks.json");
  if (!existsSync(path)) return [];
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (
    !data ||
    !Array.isArray(data.tasks) ||
    data.tasks.some(
      (t: NativeSchedule) =>
        !t ||
        typeof t.id !== "string" ||
        typeof t.cron !== "string" ||
        typeof t.prompt !== "string" ||
        !Number.isFinite(t.createdAt),
    )
  )
    throw new Error(
      "Unrecognized native scheduled_tasks.json schema; source left unchanged",
    );
  return data.tasks;
}

/** Retire exactly one known durable source, preserving unrelated jobs and a backup.
 * Never compete with another live native scheduler or overwrite a changed file. */
export function retireNativeSchedule(session: WorkSession, id: string): void {
  const directory = join(session.workspacePath, ".claude");
  const path = join(directory, "scheduled_tasks.json");
  if (!existsSync(path)) return;
  const before = readFileSync(path, "utf8");
  const tasks = readNativeSchedules(session.workspacePath);
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (
    !session.nativeSessionId ||
    task.createdBySessionId !== session.nativeSessionId
  )
    throw new Error("Native timer ownership could not be verified");
  if (task.createdByPid && processIdentity(task.createdByPid))
    throw new Error(
      "The native timer creator is still running; migration waits for its exit",
    );
  const lockPath = join(directory, "scheduled_tasks.lock");
  // Use the native scheduler's exclusive lock format. An existing lock is not
  // ours to break, even when it looks stale: leave the operation unconfirmed.
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    writeFileSync(
      lock,
      JSON.stringify({
        sessionId: `foundry-migration-${id}`,
        pid: process.pid,
        acquiredAt: Date.now(),
      }),
    );
    if (readFileSync(path, "utf8") !== before)
      throw new Error("Native task source changed during migration");
    const data = JSON.parse(before);
    data.tasks = data.tasks.filter((t: NativeSchedule) => t.id !== id);
    const suffix = /^[a-zA-Z0-9_-]{1,128}$/.test(id)
      ? id
      : createHash("sha256").update(id).digest("hex").slice(0, 32);
    const backup = join(directory, `scheduled_tasks.foundry-${suffix}.json`);
    if (!existsSync(backup))
      writeFileSync(backup, before, { flag: "wx", mode: 0o600 });
    const tmp = `${path}.foundry-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    if (readFileSync(path, "utf8") !== before) {
      unlinkSync(tmp);
      throw new Error("Native task source changed before commit");
    }
    renameSync(tmp, path);
    if (readNativeSchedules(session.workspacePath).some((t) => t.id === id))
      throw new Error("Native source retirement was not confirmed");
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
