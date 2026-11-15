/**
 * Reading a workspace's files and folders for people browsing it, and the
 * device's folders for choosing a workspace.
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import type {
  WorkspaceDirectoryEntry,
  WorkspaceFileRead,
  WorkspaceTreeEntry,
  FileDownloadRequest,
} from "@bd777/foundry-protocol";
import type { ReadFilePayload } from "@bd777/foundry-protocol";
import { within, insidePath } from "../../platform/paths.js";
import { readFilePrefix, utf8Prefix } from "./session-files.js";
import { safeID } from "../../platform/utils.js";
import { readFileDownloadChunk } from "./file-downloads.js";
import { foundryStatePath } from "../../platform/state-root.js";

/**
 * Resolves a path inside the workspace through symlinks and refuses anything
 * that lands outside it, so a link in the workspace cannot expose other files.
 * The one exception is a skill Foundry itself linked in (managedSkillDir):
 * its files are what the agent loads, so they are shown, read-only.
 */
function workspaceRealPath(
  workspacePath: string,
  path: string,
  outside: string,
): { root: string; target: string; foundryManaged: boolean } {
  if (!within(workspacePath, resolve(workspacePath, path)))
    throw new Error(outside);
  const root = realpathSync(workspacePath);
  const target = realpathSync(resolve(root, path));
  if (within(root, target)) return { root, target, foundryManaged: false };
  const skill = managedSkillDir(root, relative(root, resolve(root, path)));
  if (skill !== undefined && within(skill, target))
    return { root, target, foundryManaged: true };
  throw new Error(outside);
}

/**
 * Where Foundry links skills into a workspace: linkCodexSkills puts each
 * selected skill in `.agents/skills/<name>` as a link to its verified
 * snapshot under the state root's `skill-sets`.
 */
const managedSkillLinkFolder = [".agents", "skills"];

/**
 * The real skill folder when `relativePath` is in, or is, a link Foundry made
 * for a skill: a link directly in `.agents/skills` (itself a real folder of
 * the workspace) to a folder with a SKILL.md inside Foundry's skill
 * snapshots. Any other link that leaves the workspace stays refused.
 */
function managedSkillDir(
  root: string,
  relativePath: string,
): string | undefined {
  const parts = relativePath.split(sep);
  const depth = managedSkillLinkFolder.length;
  if (
    parts.length <= depth ||
    managedSkillLinkFolder.some((name, index) => parts[index] !== name)
  )
    return undefined;
  try {
    const folder = join(root, ...managedSkillLinkFolder);
    if (realpathSync(folder) !== folder) return undefined;
    const link = join(folder, parts[depth]!);
    if (!lstatSync(link).isSymbolicLink()) return undefined;
    const skill = realpathSync(link);
    const sets = realpathSync(foundryStatePath("skill-sets"));
    if (skill === sets || !within(sets, skill)) return undefined;
    if (!statSync(skill).isDirectory() || !existsSync(join(skill, "SKILL.md")))
      return undefined;
    return skill;
  } catch {
    return undefined;
  }
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
      workspaceFileForRead(workspacePath, payload.path).path,
      payload.download,
    ),
  };
}

function workspaceFileForRead(
  workspacePath: string,
  path: string,
): { path: string; realPath?: string; foundryManaged: boolean } {
  const root = resolve(workspacePath);
  const target = resolve(root, path);
  const relativePath = insidePath(root, target);
  if (relativePath === undefined) {
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
  const realPath = real.foundryManaged
    ? undefined
    : relative(real.root, real.target).split(sep).join("/");
  return {
    path: real.target,
    ...(realPath !== undefined && realPath !== relativePath
      ? { realPath }
      : {}),
    foundryManaged: real.foundryManaged,
  };
}

export function safeWorkspaceFileRead(
  workspacePath: string,
  payload: ReadFilePayload,
): WorkspaceFileRead {
  const target = workspaceFileForRead(workspacePath, payload.path);
  const maxBytes = 128 * 1024;
  // Only the shown part is read: a workspace can hold multi-GB files.
  const read = readFilePrefix(target.path, maxBytes);
  return {
    workspaceId: payload.workspaceId,
    path: payload.path,
    content: utf8Prefix(read.data),
    truncated: read.size > maxBytes,
    ...(target.realPath !== undefined ? { realPath: target.realPath } : {}),
    ...(target.foundryManaged ? { readOnly: true } : {}),
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
  const { root, target, foundryManaged } = workspaceRealPath(
    workspacePath,
    subPath,
    "requested path is outside the workspace",
  );
  refuseGitInternals(root, target);
  const stat = statSync(target);
  if (!stat.isDirectory()) {
    throw new Error("requested path is not a directory");
  }
  // Children keep their path through the workspace (and its links), so
  // opening one resolves the same way listing it did.
  const base = relative(root, resolve(root, subPath));

  return readdirSync(target, { withFileTypes: true })
    .filter((entry) => !TREE_IGNORED_NAMES.has(entry.name))
    .map((entry): WorkspaceTreeEntry => {
      const childRelPath = base ? join(base, entry.name) : entry.name;
      const kind = treeEntryKind(root, target, childRelPath, entry);
      const isDir = kind.isDirectory;
      const extension =
        !isDir && kind.link !== "outside" && kind.link !== "missing"
          ? extname(entry.name).toLowerCase()
          : undefined;
      const readOnly =
        foundryManaged ||
        (kind.link !== undefined && kind.link !== "workspace");
      return {
        extension,
        id: `tree_${safeID(childRelPath)}`,
        isDirectory: isDir,
        name: entry.name,
        path: childRelPath,
        size: kind.size,
        ...(kind.link ? { link: kind.link } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      };
    })
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

/**
 * What a listed entry is. A link shows as what it points to when that is in
 * the workspace (or is a skill Foundry linked in); a link leaving the
 * workspace or pointing nowhere is shown as such, never followed, and says
 * nothing about its target.
 */
function treeEntryKind(
  root: string,
  folder: string,
  relativePath: string,
  entry: Dirent,
): {
  isDirectory: boolean;
  size?: number;
  link?: NonNullable<WorkspaceTreeEntry["link"]>;
} {
  const path = join(folder, entry.name);
  if (!entry.isSymbolicLink()) {
    if (entry.isDirectory()) return { isDirectory: true };
    return { isDirectory: false, size: sizeOf(path) };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { isDirectory: false, link: "missing" };
  }
  let link: "workspace" | "foundry";
  if (within(root, real)) link = "workspace";
  else {
    const skill = managedSkillDir(root, relativePath);
    if (skill === undefined || !within(skill, real))
      return { isDirectory: false, link: "outside" };
    link = "foundry";
  }
  try {
    const target = statSync(real);
    return target.isDirectory()
      ? { isDirectory: true, link }
      : { isDirectory: false, size: target.size, link };
  } catch {
    return { isDirectory: false, link: "missing" };
  }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}
