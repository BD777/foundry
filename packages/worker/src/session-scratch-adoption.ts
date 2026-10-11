// Scratch directories that sessions got before the worker recorded them.
// Each worker run before records were kept gave a running session a new
// TMPDIR and forgot it, so a long session left one directory per run, never
// removed. A directory is adopted into its session's record only on proof
// written by this worker under the session's records: the session's
// background task record names it (its TMPDIR, or a task log inside it), or
// it holds the Claude task files of a native session that one of the
// session's completed inputs ran. Anything else is left alone: other workers
// on the device make theirs under the same prefix.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readPersistedBackgroundTasks } from "./agent-background-tasks.js";
import {
  adoptSessionScratchDirectories,
  unrecordedScratchDirectories,
} from "./resource-pool.js";
import { sessionArtifactDirectories } from "./session-artifacts.js";

export interface AdoptedSessionScratch {
  sessionId: string;
  /** The directory the session uses from now on. */
  directory: string;
  adopted: string[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function list(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function changedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** The scratch directory a path lies in, when it is one of candidates. */
function candidateOf(
  path: unknown,
  candidates: ReadonlySet<string>,
): string | undefined {
  if (typeof path !== "string") return undefined;
  const resolved = resolve(path);
  for (const candidate of candidates)
    if (resolved === candidate || resolved.startsWith(`${candidate}${sep}`))
      return candidate;
  return undefined;
}

/**
 * The native Claude sessions whose task files a scratch directory holds:
 * <scratch>/claude-<uid>/<project>/<native session id>/.
 */
function nativeSessionsIn(scratch: string): string[] {
  const found: string[] = [];
  for (const user of list(scratch).filter((name) => /^claude-\d+$/.test(name)))
    for (const project of list(join(scratch, user)))
      for (const native of list(join(scratch, user, project)))
        if (uuid.test(native)) found.push(native.toLowerCase());
  return found;
}

interface Completion {
  sessionId?: unknown;
  nativeSessionId?: unknown;
  completedAt?: unknown;
}

/**
 * Adopts the unrecorded scratch directories the sessions of these
 * workspaces provably had. Runs once as the worker starts, before its first
 * sweep.
 */
export function adoptEarlierSessionScratch(
  workspacePaths: readonly string[],
): AdoptedSessionScratch[] {
  const candidates = new Set(unrecordedScratchDirectories());
  if (candidates.size === 0) return [];
  // A native session resumed by several worker runs left files in each.
  const nativeOwners = new Map<string, string[]>();
  for (const candidate of candidates)
    for (const native of nativeSessionsIn(candidate))
      nativeOwners.set(native, [
        ...(nativeOwners.get(native) ?? []),
        candidate,
      ]);

  const proven = new Map<string, Set<string>>();
  const lastUsed = new Map<string, number>();
  const prove = (sessionId: string, directory: string, usedAt: number) => {
    const directories = proven.get(sessionId) ?? new Set<string>();
    directories.add(directory);
    proven.set(sessionId, directories);
    lastUsed.set(
      sessionId,
      Math.max(lastUsed.get(sessionId) ?? 0, usedAt, changedAt(directory)),
    );
  };

  for (const workspacePath of new Set(workspacePaths)) {
    const sessionsRoot = resolve(workspacePath, ".foundry", "sessions");
    for (const sessionId of list(sessionsRoot)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) continue;
      const tasks = readPersistedBackgroundTasks(sessionsRoot, sessionId);
      if (tasks && tasks.sessionId === sessionId)
        for (const path of [
          tasks.scratchDirectory,
          ...tasks.tasks.map((task) => task.outputPath),
        ]) {
          const directory = candidateOf(path, candidates);
          if (directory) prove(sessionId, directory, 0);
        }
      if (nativeOwners.size === 0) continue;
      for (const directory of sessionArtifactDirectories(
        sessionsRoot,
        sessionId,
      )) {
        let completion: Completion;
        try {
          completion = JSON.parse(
            readFileSync(join(directory, "completion.json"), "utf8"),
          ) as Completion;
        } catch {
          continue;
        }
        if (
          completion.sessionId !== sessionId ||
          typeof completion.nativeSessionId !== "string"
        )
          continue;
        const scratches = nativeOwners.get(
          completion.nativeSessionId.toLowerCase(),
        );
        if (!scratches) continue;
        const completedAt =
          typeof completion.completedAt === "string"
            ? Date.parse(completion.completedAt) || 0
            : 0;
        for (const scratch of scratches) prove(sessionId, scratch, completedAt);
      }
    }
  }

  // A directory two sessions claim proves neither.
  const claims = new Map<string, number>();
  for (const directories of proven.values())
    for (const directory of directories)
      claims.set(directory, (claims.get(directory) ?? 0) + 1);
  const adopted: AdoptedSessionScratch[] = [];
  for (const [sessionId, directories] of proven) {
    const own = [...directories].filter(
      (directory) => claims.get(directory) === 1,
    );
    if (own.length === 0) continue;
    try {
      const directory = adoptSessionScratchDirectories(
        sessionId,
        own,
        lastUsed.get(sessionId) ?? Date.now(),
      );
      if (directory) adopted.push({ sessionId, directory, adopted: own });
    } catch (error) {
      console.warn(
        `Could not adopt the earlier scratch directories of session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return adopted;
}
