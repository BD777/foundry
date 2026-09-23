import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { git } from "./execution-git.js";
import type { SessionEventEmitter } from "./session-state.js";

const privateRoots = new Set([".git", ".foundry"]);

/**
 * A workspace-relative path for a file a tool named, or undefined when it
 * points outside the workspace or into Foundry's and Git's own folders.
 */
export function workspaceOutputPath(
  workspacePath: string,
  path: string,
): string | undefined {
  const relativePath = relative(workspacePath, resolve(workspacePath, path));
  if (
    !relativePath ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath) ||
    privateRoots.has(relativePath.split(sep)[0]!)
  )
    return undefined;
  return relativePath;
}

/**
 * The files one run produced in its workspace, each reported once: files its
 * tools write as they happen, then whatever else changed on disk during the
 * run. Files already modified before the run started are not attributed to it
 * unless the run changed them again.
 */
export class SessionOutputFiles {
  private readonly reported = new Set<string>();

  /**
   * Snapshots what is already modified before the agent starts. File
   * timestamps are coarser than the clock, so "changed during the run" is
   * judged against this snapshot, never against a start time.
   */
  static async start(
    workspacePath: string,
    emit: SessionEventEmitter,
  ): Promise<SessionOutputFiles> {
    return new SessionOutputFiles(
      workspacePath,
      emit,
      await changedFiles(workspacePath),
    );
  }

  private constructor(
    private readonly workspacePath: string,
    private readonly emit: SessionEventEmitter,
    private readonly before: Map<string, number>,
  ) {}

  async reportToolWrites(paths: string[]): Promise<void> {
    for (const path of paths) {
      const relativePath = workspaceOutputPath(this.workspacePath, path);
      if (relativePath) await this.report(relativePath);
    }
  }

  /** Reports files Git sees as modified or new that the run touched. */
  async reportChangedOnDisk(): Promise<void> {
    for (const [path, modifiedAt] of await changedFiles(this.workspacePath)) {
      if (this.before.get(path) !== modifiedAt) await this.report(path);
    }
  }

  private async report(relativePath: string): Promise<void> {
    if (this.reported.has(relativePath)) return;
    this.reported.add(relativePath);
    await this.emit("Produced output file", relativePath, "info", {
      outputFile: relativePath,
    });
  }
}

/** Modified and untracked files, with their modification times. */
async function changedFiles(
  workspacePath: string,
): Promise<Map<string, number>> {
  const listing = await git(
    workspacePath,
    ["ls-files", "-z", "--modified", "--others", "--exclude-standard"],
    { optional: true },
  );
  const files = new Map<string, number>();
  for (const path of listing.split("\0").filter(Boolean)) {
    const relativePath = workspaceOutputPath(workspacePath, path);
    if (!relativePath) continue;
    try {
      const stat = statSync(resolve(workspacePath, relativePath));
      if (stat.isFile()) files.set(relativePath, stat.mtimeMs);
    } catch {
      // deleted
    }
  }
  return files;
}
