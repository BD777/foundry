import { lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  SetupWorkspaceCreate,
  SetupWorkspaceFile,
} from "@bd777/foundry-protocol";
import { git } from "./execution-git.js";
import { canonical, relativeInside } from "./paths.js";
import { managedRoots } from "./personal-agent-settings.js";

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

/** How long a clone for a new project may take. */
const cloneTimeoutMs = 10 * 60 * 1000;

function pathTaken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The managed root a new project's folder resolves into (strictly inside,
 * symbolic links followed), or a refusal.
 */
function managedRootFor(path: string, roots: readonly string[]): string {
  const target = canonical(path);
  const root = roots.find((candidate) =>
    relativeInside(relative(candidate, target)),
  );
  if (!root)
    throw new Error(
      roots.length
        ? `New projects go inside ${roots.join(" or ")} on this device; ${path} is not inside one.`
        : "This device does not let the assistant create projects (no managed folders are set).",
    );
  return root;
}

/**
 * The "/"-separated segments of a file create writes into the new folder,
 * or a refusal: never absolute, never "." or "..", never into .git, never a
 * NUL or a backslash (a separator on Windows).
 */
function newFileSegments(file: SetupWorkspaceFile): string[] {
  const path = typeof file?.path === "string" ? file.path : "";
  const segments = path.split("/");
  if (
    !path ||
    typeof file.content !== "string" ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.toLowerCase() === ".git",
    )
  )
    throw new Error(
      `A new project's file must be a relative path inside it with text content; ${JSON.stringify(path)} is not.`,
    );
  return segments;
}

/**
 * Writes create's files into the new folder target: parents created, each
 * file new (never over anything, never through a symbolic link), and its
 * folder checked to resolve inside target.
 */
function writeNewFiles(target: string, files: SetupWorkspaceFile[]): void {
  const inside = canonical(target);
  for (const file of files) {
    const path = resolve(target, ...newFileSegments(file));
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true });
    const resolved = canonical(parent);
    if (resolved !== inside && !relativeInside(relative(inside, resolved)))
      throw new Error(`${file.path} leads out of the new project's folder.`);
    writeFileSync(path, file.content, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });
  }
}

/**
 * Makes a new project's folder (setup_workspace's create): an empty folder,
 * optionally with Git and the files create names, or a clone. Only inside one of the device owner's
 * managed roots (personal-agent-settings.ts), never over anything already
 * there, and never through a symbolic link that leads out of the root.
 * Registering it is left to the caller, as for an existing folder.
 */
export async function createWorkspaceFolder(
  path: string,
  create: SetupWorkspaceCreate,
  roots: readonly string[] = managedRoots(),
): Promise<string> {
  if (!isAbsolute(path))
    throw new Error("Enter an absolute folder path on this device.");
  const target = resolve(path);
  if (create.kind === "clone" && !create.url?.trim())
    throw new Error("Cloning a project needs the repository's URL.");
  if (create.kind !== "clone" && create.kind !== "empty")
    throw new Error(`Unknown kind of new project folder: ${create.kind}.`);
  const files = create.files ?? [];
  if (!Array.isArray(files))
    throw new Error("A new project's files must be a list.");
  if (files.length && create.kind !== "empty")
    throw new Error("Only a new empty project folder takes files.");
  for (const file of files) newFileSegments(file);
  const root = managedRootFor(target, roots);
  if (pathTaken(target))
    throw new Error(`${target} already exists; choose a new folder name.`);
  const parent = dirname(target);
  mkdirSync(parent, { recursive: true });
  // The parent now exists: check again that nothing on the way led out.
  managedRootFor(target, [root]);
  if (create.kind === "clone") {
    await git(
      parent,
      [
        "-c",
        "protocol.ext.allow=never",
        "clone",
        "--quiet",
        "--",
        create.url!.trim(),
        target,
      ],
      { timeout: cloneTimeoutMs },
    );
  } else {
    // Not recursive: a folder that appeared meanwhile is not taken over.
    mkdirSync(target);
    try {
      if (create.gitInit) await git(target, ["init", "-b", "main"]);
      writeNewFiles(target, files);
    } catch (error) {
      rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }
  return existingWorkspaceFolder(target);
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
