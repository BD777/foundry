/**
 * write_file: the person replaces one text file of a workspace from the Web
 * (a channel workspace's AGENTS.md). The file is written whole and
 * atomically, only inside the workspace, never inside `.git`, never through
 * a link that leaves it, and only over the content the person last saw.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  FileManagedPayload,
  FileWrittenPayload,
  ManageFilePayload,
  WriteFilePayload,
} from "@bd777/foundry-protocol";
import { within } from "../../platform/paths.js";
import { writeFileAtomic } from "../../platform/storage.js";

/** The most write_file writes. */
export const maxWorkspaceFileWriteBytes = 512 * 1024;

export type WorkspaceFileWriteErrorCode =
  "conflict" | "invalid_path" | "too_large" | "exists" | "missing";

export class WorkspaceFileWriteError extends Error {
  constructor(
    readonly code: WorkspaceFileWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const invalid = (message: string) =>
  new WorkspaceFileWriteError("invalid_path", message);

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function isGitInternal(root: string, path: string): boolean {
  return relative(root, path)
    .split(sep)
    .some((part) => part.toLowerCase() === ".git");
}

/** The path's segments, refused unless a plain relative path. */
function segments(path: unknown): string[] {
  if (typeof path !== "string" || !path.trim())
    throw invalid("the request needs a path");
  if (
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path)
  )
    throw invalid("the path must be relative to the workspace");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw invalid("the path must not contain empty, '.' or '..' parts");
  if (parts.some((part) => part.toLowerCase() === ".git"))
    throw invalid("Git internals are not writable through Foundry");
  return parts;
}

/** A path inside the workspace, followed through links, or refused. */
function realInside(root: string, path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw invalid("the path leads to a missing link target");
  }
  if (!within(root, real)) throw invalid("the path leaves the workspace");
  if (isGitInternal(root, real))
    throw invalid("Git internals are not writable through Foundry");
  return real;
}

/**
 * The real folder the file goes into, following the folders that exist;
 * undefined when one is missing (then `create` makes them).
 */
function parentFolder(
  root: string,
  folders: string[],
  create: boolean,
): string | undefined {
  let current = root;
  for (const folder of folders) {
    const next = join(current, folder);
    let stat: Stats | undefined;
    try {
      stat = lstatSync(next);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      if (!create) return undefined;
      mkdirSync(next, { mode: 0o755 });
      current = next;
      continue;
    }
    current = realInside(root, next);
    if (!statSync(current).isDirectory())
      throw invalid(`${folder} is not a folder`);
  }
  return current;
}

/** The file to replace (a link inside the workspace is followed), if any. */
function existingTarget(
  root: string,
  parent: string,
  name: string,
): { path: string; stat?: Stats } {
  const path = join(parent, name);
  let link: Stats;
  try {
    link = lstatSync(path);
  } catch {
    return { path };
  }
  const real = link.isSymbolicLink() ? realInside(root, path) : path;
  const stat = statSync(real);
  if (!stat.isFile()) throw invalid("the path is not a file");
  return { path: real, stat };
}

export function writeWorkspaceFile(
  workspacePath: string,
  payload: WriteFilePayload,
): FileWrittenPayload {
  const parts = segments(payload.path);
  if (typeof payload.content !== "string")
    throw new WorkspaceFileWriteError(
      "invalid_path",
      "write_file needs text content",
    );
  const data = Buffer.from(payload.content, "utf8");
  if (data.byteLength > maxWorkspaceFileWriteBytes)
    throw new WorkspaceFileWriteError(
      "too_large",
      `the file is larger than ${maxWorkspaceFileWriteBytes / 1024} KiB`,
    );
  const root = realpathSync(workspacePath);
  const name = parts[parts.length - 1]!;
  const folders = parts.slice(0, -1);
  const known = parentFolder(root, folders, false);
  const target = known ? existingTarget(root, known, name) : undefined;
  const expected = payload.expectedSha256;
  if (expected !== undefined) {
    const current = target?.stat ? sha256(readFileSync(target.path)) : "";
    if (current !== expected.trim().toLowerCase())
      throw new WorkspaceFileWriteError(
        "conflict",
        expected
          ? "the file changed since it was read"
          : "the file already exists",
      );
  }
  const path =
    target?.path ?? join(parentFolder(root, folders, true) ?? root, name);
  writeFileAtomic(path, data, {
    mode: target?.stat ? target.stat.mode & 0o777 : 0o644,
    hardenParent: false,
    createParent: false,
  });
  return {
    workspaceId: payload.workspaceId,
    path: payload.path,
    sha256: sha256(data),
    bytes: data.byteLength,
  };
}

/** The regular file at `path` (never a link), refused unless there. */
function plainFile(root: string, parts: string[]): string {
  const parent = parentFolder(root, parts.slice(0, -1), false);
  const path = parent ? join(parent, parts[parts.length - 1]!) : undefined;
  let stat: Stats | undefined;
  try {
    stat = path ? lstatSync(path) : undefined;
  } catch {
    stat = undefined;
  }
  if (!path || !stat)
    throw new WorkspaceFileWriteError("missing", "the file does not exist");
  if (stat.isSymbolicLink())
    throw invalid("links are not renamed or deleted through Foundry");
  if (!stat.isFile()) throw invalid("only files are renamed or deleted");
  return path;
}

/**
 * manage_file: one file of a workspace renamed or deleted from the Web,
 * under write_file's path rules and only over the content the person last
 * saw.
 */
export function manageWorkspaceFile(
  workspacePath: string,
  payload: ManageFilePayload,
): FileManagedPayload {
  if (payload.op !== "rename" && payload.op !== "delete")
    throw invalid("manage_file renames or deletes");
  const root = realpathSync(workspacePath);
  const source = plainFile(root, segments(payload.path));
  const expected = payload.expectedSha256;
  if (
    expected !== undefined &&
    sha256(readFileSync(source)) !== expected.trim().toLowerCase()
  )
    throw new WorkspaceFileWriteError(
      "conflict",
      "the file changed since it was read",
    );
  if (payload.op === "delete") {
    unlinkSync(source);
    return {
      workspaceId: payload.workspaceId,
      op: "delete",
      path: payload.path,
    };
  }
  const parts = segments(payload.toPath);
  const known = parentFolder(root, parts.slice(0, -1), false);
  if (known) {
    let exists = true;
    try {
      lstatSync(join(known, parts[parts.length - 1]!));
    } catch {
      exists = false;
    }
    if (exists)
      throw new WorkspaceFileWriteError(
        "exists",
        "a file or folder with that name already exists",
      );
  }
  const parent = known ?? parentFolder(root, parts.slice(0, -1), true) ?? root;
  renameSync(source, join(parent, parts[parts.length - 1]!));
  return {
    workspaceId: payload.workspaceId,
    op: "rename",
    path: payload.path,
    toPath: payload.toPath,
  };
}
