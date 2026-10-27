/**
 * Reading a workspace's files and folders for people browsing it, and the
 * device's folders for choosing a workspace.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFileRead,
  WorkspaceTreeEntry,
  FileDownloadRequest,
} from "@bd777/foundry-protocol";
import type { ReadFilePayload } from "@bd777/foundry-protocol";
import { within } from "./paths.js";
import { readFilePrefix, utf8Prefix } from "./session-files.js";
import { safeID } from "./utils.js";
import { readFileDownloadChunk } from "./file-downloads.js";

/**
 * Resolves a path inside the workspace through symlinks and refuses anything
 * that lands outside it, so a link in the workspace cannot expose other files.
 */
function workspaceRealPath(
  workspacePath: string,
  path: string,
  outside: string,
): { root: string; target: string } {
  if (!within(workspacePath, resolve(workspacePath, path)))
    throw new Error(outside);
  const root = realpathSync(workspacePath);
  const target = realpathSync(resolve(root, path));
  if (!within(root, target)) throw new Error(outside);
  return { root, target };
}

// Git internals can hold credentials (remote URLs, config) and are never
// served to people who can only see the workspace.
function refuseGitInternals(root: string, target: string): void {
  if (relative(root, target).split(sep).includes(".git"))
    throw new Error("Git internals are not readable through Foundry");
}

export function readWorkspaceFileDownload(
  workspacePath: string,
  payload: ReadFilePayload & { download: FileDownloadRequest },
) {
  return {
    workspaceId: payload.workspaceId,
    path: payload.path,
    downloadChunk: readFileDownloadChunk(
      workspaceFileForRead(workspacePath, payload.path),
      payload.download,
    ),
  };
}

function workspaceFileForRead(workspacePath: string, path: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, path);
  const relativePath = relative(root, target);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    resolve(relativePath) === relativePath
  ) {
    throw new Error("requested file is outside the paired workspace");
  }
  const real = workspaceRealPath(
    root,
    relativePath,
    "requested file is outside the paired workspace",
  );
  refuseGitInternals(real.root, real.target);
  const stat = statSync(real.target);
  if (!stat.isFile()) {
    throw new Error("requested workspace path is not a file");
  }
  return real.target;
}

export function safeWorkspaceFileRead(
  workspacePath: string,
  payload: ReadFilePayload,
): WorkspaceFileRead {
  const target = workspaceFileForRead(workspacePath, payload.path);
  const maxBytes = 128 * 1024;
  // Only the shown part is read: a workspace can hold multi-GB files.
  const read = readFilePrefix(target, maxBytes);
  return {
    workspaceId: payload.workspaceId,
    path: payload.path,
    content: utf8Prefix(read.data),
    truncated: read.size > maxBytes,
  };
}

export function resolveLocalBrowserPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

export function safeDirectoryListing(path: string): WorkspaceDirectoryEntry[] {
  const target = resolveLocalBrowserPath(path);
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    throw new Error("selected path is not a directory");
  }

  return readdirSync(target, { withFileTypes: true })
    .flatMap((entry): WorkspaceDirectoryEntry[] => {
      const childPath = resolve(target, entry.name);
      let childStat;
      try {
        childStat = statSync(childPath);
      } catch {
        return [];
      }
      if (!childStat.isDirectory()) {
        return [];
      }
      return [
        {
          id: `dir_${safeID(childPath)}`,
          name: entry.name,
          path: childPath,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 200);
}

const TREE_IGNORED_NAMES = new Set([".DS_Store", ".git"]);

export function safeWorkspaceTreeListing(
  workspacePath: string,
  subPath = "",
): WorkspaceTreeEntry[] {
  const { root, target } = workspaceRealPath(
    workspacePath,
    subPath,
    "requested path is outside the workspace",
  );
  refuseGitInternals(root, target);
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    throw new Error("requested path is not a directory");
  }

  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => !TREE_IGNORED_NAMES.has(entry.name))
    .map((entry): WorkspaceTreeEntry => {
      const childPath = resolve(target, entry.name);
      const childRelPath = relative(root, childPath);
      const isDir = entry.isDirectory();
      let size: number | undefined;
      try {
        if (!isDir) {
          size = statSync(childPath).size;
        }
      } catch {
        // best-effort size
      }
      const extension = !isDir ? extname(entry.name).toLowerCase() : undefined;
      return {
        extension,
        id: `tree_${safeID(childRelPath)}`,
        isDirectory: isDir,
        name: entry.name,
        path: childRelPath,
        size,
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}
