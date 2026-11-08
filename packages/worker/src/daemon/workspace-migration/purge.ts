/**
 * The source after a migration (DEV-146): retiring the workspace (no
 * longer served, every file kept) and later purging its old copy. A purge
 * removes only what the kept manifest lists, under the roots it recorded,
 * and only while it is unchanged; whatever changed or was added since is
 * kept and listed unless the person asks to remove it too.
 */

import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { chmod, lstat, readlink, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  WorkspaceMigrationPurgedPayload,
  WorkspaceMigrationPurgePayload,
  WorkspaceMigrationRetirePayload,
} from "@bd777/foundry-protocol";
import {
  foundryStatePath,
  foundryStateRoot,
} from "../../platform/state-root.js";
import { within } from "../../platform/paths.js";
import { writeJSON } from "../../platform/storage.js";
import { identifier } from "../../candidate-store/execution-storage.js";
import {
  forgetWorkspaceRegistration,
  readRegistry,
} from "../../workspace/workspaces.js";
import {
  entryKey,
  loadManifest,
  migrationStateDir,
  type ManifestEntry,
  type ManifestRoot,
} from "./manifest.js";
import { placeUnder, removeTree, walkTree } from "./staging.js";
import { hashFile } from "./scan.js";

const maxListed = 200;

/**
 * Stops serving a migrated workspace here: out of the registry, into the
 * forgotten list with where it went. Deletes nothing; the manifest stays
 * for a later purge. Returns the folder it was served from.
 */
export function retireMigratedWorkspace(
  input: WorkspaceMigrationRetirePayload,
  options: { stateDir?: string; path?: string } = {},
): string {
  identifier(input.migrationId);
  identifier(input.workspaceId);
  const stateDir = options.stateDir ?? migrationStateDir(input.migrationId);
  const retiredPath = join(stateDir, "retired.json");
  // A repeated retire (the server retries after a lost reply) keeps the
  // folder the first one recorded: the registry no longer names it.
  try {
    const retired = JSON.parse(readFileSync(retiredPath, "utf8")) as {
      path?: string;
    };
    if (typeof retired.path === "string") return retired.path;
  } catch {
    /* Not retired yet. */
  }
  const path =
    options.path ||
    readRegistry().find((entry) => entry.id === input.workspaceId)?.path ||
    "";
  forgetWorkspaceRegistration(input.workspaceId, path, {
    migratedTo: input.targetDeviceId,
    migrationId: input.migrationId,
  });
  writeJSON(retiredPath, {
    targetDeviceId: input.targetDeviceId,
    path,
    retiredAt: new Date().toISOString(),
  });
  return path;
}

function checkRoot(name: string, root: ManifestRoot): void {
  const path = root.path;
  if (
    !path ||
    !isAbsolute(path) ||
    resolve(path) === resolve("/") ||
    resolve(path) === resolve(homedir()) ||
    within(resolve(path), foundryStateRoot())
  )
    throw new Error(
      `Refusing to purge from the recorded root ${name} (${path})`,
    );
}

/** Whether every folder between a root and a path is a real folder. */
async function throughFolders(base: string, path: string): Promise<boolean> {
  let current = dirname(path);
  while (current !== base && within(base, current)) {
    const stat = await lstat(current).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return false;
    current = dirname(current);
  }
  return true;
}

/** Leftovers of Foundry's own that a purge removes without asking. */
function ownLeftover(
  root: ManifestRoot,
  rel: string,
  type: string,
  path: string,
): boolean {
  if (root.kind === "execution" || root.kind === "execution-meta")
    return rel === "locks" || rel.startsWith("locks/");
  if (root.kind === "folder" && type === "symlink")
    return (
      /(^|\/)\.agents\/skills\/[^/]+$/.test(rel) && path.includes("skill-sets")
    );
  return false;
}

function forgetChatUploads(workspaceId: string, dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        workspaceId?: string;
      };
      if (value.workspaceId === workspaceId) unlinkSync(join(dir, name));
    } catch {
      /* Not an upload record of this workspace. */
    }
  }
}

export async function purgeMigratedSource(
  input: WorkspaceMigrationPurgePayload,
  options: {
    stateDir?: string;
    chatUploadsDir?: string;
    sessionWork?: { forgetWorkspace(workspaceId: string): void };
  } = {},
): Promise<WorkspaceMigrationPurgedPayload> {
  identifier(input.migrationId);
  identifier(input.workspaceId);
  const stateDir = options.stateDir ?? migrationStateDir(input.migrationId);
  const manifest = await loadManifest(stateDir);
  if (!manifest) throw new Error("This device has no record of the migration");
  const { header, entries } = manifest;
  if (header.workspaceId !== input.workspaceId)
    throw new Error("The migration record is another workspace's");
  if (
    readRegistry().some(
      (entry) =>
        entry.id === input.workspaceId || resolve(entry.path) === header.folder,
    )
  )
    throw new Error("The workspace is still served on this device");
  for (const [name, root] of Object.entries(header.roots))
    checkRoot(name, root);

  const confirm = input.confirm === true;
  const includeChanged = input.includeChanged === true;
  const changed: string[] = [];
  let changedCount = 0;
  const noteChanged = (path: string) => {
    changedCount += 1;
    if (changed.length < maxListed) changed.push(path);
  };
  const unchanged: { entry: ManifestEntry; path: string }[] = [];
  const changedPaths: string[] = [];
  const leftovers: string[] = [];
  let bytes = 0;

  for (const entry of entries) {
    const root = header.roots[entry.root];
    if (!root) continue;
    const path = placeUnder(root.path, entry.path);
    const stat = await lstat(path).catch(() => undefined);
    if (!stat) continue;
    let same = await throughFolders(root.path, path);
    if (same && entry.type === "dir")
      same = stat.isDirectory() && !stat.isSymbolicLink();
    else if (same && entry.type === "symlink")
      same = stat.isSymbolicLink() && (await readlink(path)) === entry.target;
    else if (same && entry.type === "file") {
      same = stat.isFile() && stat.size === entry.size;
      if (same && Math.floor(stat.mtimeMs) !== Math.floor(entry.mtimeMs))
        same =
          (await hashFile(path).catch(() => ({ sha256: "" }))).sha256 ===
          entry.sha256;
    }
    if (same) unchanged.push({ entry, path });
    else if (entry.type !== "dir") {
      noteChanged(path);
      changedPaths.push(path);
    }
  }

  // What was added since, where the manifest covered a whole folder.
  const listed = new Set(entries.map(entryKey));
  for (const [name, root] of Object.entries(header.roots))
    for (const scope of root.scopes) {
      const base = scope ? placeUnder(root.path, scope) : root.path;
      const prune = new Set<string>();
      for await (const { rel, type } of walkTree(base, prune)) {
        const full = scope ? `${scope}/${rel}` : rel;
        if (listed.has(`${name}\n${full}`)) continue;
        prune.add(rel);
        const path = join(base, ...rel.split("/"));
        const linkTarget =
          type === "symlink" ? await readlink(path).catch(() => "") : "";
        if (ownLeftover(root, full, type, linkTarget)) leftovers.push(path);
        else {
          noteChanged(path);
          changedPaths.push(path);
        }
      }
    }

  for (const { entry } of unchanged)
    if (entry.type === "file") bytes += entry.size;
  const removed: string[] = [];
  const list = (path: string) => {
    if (removed.length < maxListed) removed.push(path);
  };
  for (const [, root] of Object.entries(header.roots)) {
    if (root.kind === "codex" || root.kind === "claude") {
      for (const scope of root.scopes) list(placeUnder(root.path, scope));
      if (root.kind === "codex")
        for (const { entry, path } of unchanged)
          if (header.roots[entry.root] === root) list(path);
    } else list(root.path);
  }

  if (!confirm) return { removed, changed, bytes, done: false };

  // Folders writable first, so their entries can go.
  for (const { entry, path } of unchanged)
    if (entry.type === "dir")
      await chmod(path, entry.mode | 0o700).catch(() => undefined);
  for (const root of Object.values(header.roots))
    if (root.kind !== "claude" && root.kind !== "codex") {
      const stat = await lstat(root.path).catch(() => undefined);
      if (stat?.isDirectory())
        await chmod(root.path, (stat.mode & 0o7777) | 0o700).catch(
          () => undefined,
        );
    }
  for (const { entry, path } of unchanged)
    if (entry.type !== "dir") await unlink(path).catch(() => undefined);
  for (const path of leftovers) await removeTree(path);
  if (includeChanged) for (const path of changedPaths) await removeTree(path);
  for (const { entry, path } of [...unchanged].reverse())
    if (entry.type === "dir") await rmdir(path).catch(() => undefined);
  for (const root of Object.values(header.roots))
    if (root.kind !== "claude" && root.kind !== "codex")
      await rmdir(root.path).catch(() => undefined);

  const kept = includeChanged ? 0 : changedCount;
  const done = kept === 0;
  if (done) {
    forgetChatUploads(
      input.workspaceId,
      options.chatUploadsDir ?? foundryStatePath("chat-uploads"),
    );
    options.sessionWork?.forgetWorkspace(input.workspaceId);
    await removeTree(stateDir);
  }
  return { removed, changed: includeChanged ? [] : changed, bytes, done };
}
