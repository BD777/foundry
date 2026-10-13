import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** The UI registers existing folders; CLI init may deliberately create one. */
export function existingWorkspaceFolder(path: string): string {
  if (!isAbsolute(path))
    throw new Error("Enter an absolute folder path on this device.");
  const resolved = resolve(path);
  let directory = false;
  try {
    directory = statSync(resolved).isDirectory();
  } catch {
    /* Report a useful, bounded error. */
  }
  if (!directory)
    throw new Error(
      "That folder does not exist or is not accessible on this device. Choose an existing folder.",
    );
  return resolved;
}

/** Whether a workspace's folder is still there (a directory) on this device. */
export function workspaceFolderPresent(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** An operation on a workspace whose folder was moved, renamed or deleted. */
export class WorkspaceFolderMissingError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `The folder ${path} no longer exists on this device. Use "Locate folder…" or "Remove" for this workspace on the Workspaces page.`,
    );
    this.name = "WorkspaceFolderMissingError";
    this.path = path;
  }
}

/**
 * The workspace's folder, or a clear refusal when it is gone: nothing may
 * run in, read from or write under a folder that is not there (a write would
 * even create it again).
 */
export function requireWorkspaceFolder(path: string): string {
  if (!workspaceFolderPresent(path))
    throw new WorkspaceFolderMissingError(path);
  return path;
}
