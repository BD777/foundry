/**
 * What the worker leaves on disk that nothing reads any more, removed on an
 * hourly timer (see ControlConnection): each rule names what goes and when.
 *
 * - A session's SDK logs (inputs/<input>/claude-sdk.messages.jsonl,
 *   codex-sdk.events.jsonl, *.stderr.log): debugging copies of a turn, also
 *   read for its subagent transcripts. They go once the session has had no
 *   new input for two weeks; its results and completion records stay.
 * - Verifier sandboxes unused for a week, in every workspace (a verifier's
 *   start pruned only its own workspace's, so others kept theirs for good).
 * - Folders of features that no longer exist (skill-revisions,
 *   skill-isolation).
 */
import { readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { foundryStatePath } from "../platform/state-root.js";
import { errorMessage } from "../platform/utils.js";
import { ExecutionStore } from "../candidate-store/execution-storage.js";
import { verifierRetentionMs } from "../session/verification-session.js";

export const sessionLogIdleMs = 14 * 24 * 60 * 60 * 1000;
const sdkLogNames = new Set([
  "claude-sdk.messages.jsonl",
  "codex-sdk.events.jsonl",
]);
/** Written in a session folder once its logs went: the inputs it covered. */
const prunedMarker = ".sdk-logs-removed";
const retiredStateFolders = ["skill-revisions", "skill-isolation"];

export interface RetentionReport {
  sessions: number;
  files: number;
  bytes: number;
}

const isSdkLog = (name: string) =>
  sdkLogNames.has(name) || name.endsWith(".stderr.log");

/**
 * Removes the SDK logs of a workspace's sessions that have had no new input
 * for idleMs, except the active ones. A session's inputs folder gains an
 * entry with every input, so its time is the session's last input; the
 * marker's time says which inputs were already cleared.
 */
export async function pruneSessionLogs(
  workspaceFolder: string,
  activeSessionIds: ReadonlySet<string>,
  now = Date.now(),
  idleMs = sessionLogIdleMs,
): Promise<RetentionReport> {
  const report: RetentionReport = { sessions: 0, files: 0, bytes: 0 };
  const root = resolve(workspaceFolder, ".foundry", "sessions");
  const sessions = await readdir(root).catch(() => [] as string[]);
  for (const session of sessions) {
    if (activeSessionIds.has(session)) continue;
    const inputs = join(root, session, "inputs");
    const lastInput = (await stat(inputs).catch(() => undefined))?.mtimeMs;
    if (lastInput === undefined || now - lastInput < idleMs) continue;
    const marker = join(root, session, prunedMarker);
    const cleared = (await stat(marker).catch(() => undefined))?.mtimeMs;
    if (cleared !== undefined && cleared >= lastInput) continue;
    let removed = 0;
    for (const input of await readdir(inputs).catch(() => [] as string[])) {
      const folder = join(inputs, input);
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (!isSdkLog(name)) continue;
        const path = join(folder, name);
        const size = (await stat(path).catch(() => undefined))?.size ?? 0;
        await rm(path, { force: true });
        removed += 1;
        report.bytes += size;
      }
    }
    report.files += removed;
    if (removed) report.sessions += 1;
    const at = new Date(now);
    await writeFile(marker, "")
      .then(() => utimes(marker, at, at))
      .catch(() => undefined);
  }
  return report;
}

/** Removes verifier sandboxes not used for a week, in every workspace. */
export async function pruneIdleVerifiers(
  executionRoot: string,
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const workspace of await readdir(executionRoot).catch(
    () => [] as string[],
  )) {
    const root = join(executionRoot, workspace, "verifications");
    for (const verifier of await readdir(root).catch(() => [] as string[])) {
      const path = join(root, verifier);
      const used = (await stat(path).catch(() => undefined))?.mtimeMs;
      if (used === undefined || now - used < verifierRetentionMs) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

/** One retention pass over the device; failures are logged, never thrown. */
export async function runDiskRetention(input: {
  workspaceFolders: readonly string[];
  activeSessionIds: ReadonlySet<string>;
  now?: number;
}): Promise<RetentionReport> {
  const total: RetentionReport = { sessions: 0, files: 0, bytes: 0 };
  for (const folder of new Set(input.workspaceFolders)) {
    try {
      const report = await pruneSessionLogs(
        folder,
        input.activeSessionIds,
        input.now,
      );
      total.sessions += report.sessions;
      total.files += report.files;
      total.bytes += report.bytes;
    } catch (error) {
      console.warn(
        `Removing old session logs in ${folder} failed: ${errorMessage(error)}`,
      );
    }
  }
  try {
    await pruneIdleVerifiers(new ExecutionStore().executionRoot, input.now);
  } catch (error) {
    console.warn(`Removing idle verifiers failed: ${errorMessage(error)}`);
  }
  for (const name of retiredStateFolders)
    await rm(foundryStatePath(name), { recursive: true, force: true }).catch(
      () => undefined,
    );
  return total;
}
