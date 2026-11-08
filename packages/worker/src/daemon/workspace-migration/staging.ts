/**
 * The target's staging folder of a migration (DEV-146):
 * `<parent>/.<name>.foundry-incoming-<migrationId>/` beside the folder to
 * create (same filesystem, so activating is a rename), holding folder/,
 * sidecar/{claude,codex}/<home>/, sidecar/execution/, the manifest it
 * received and received.jsonl. Every write into it goes through these
 * checks: no path leaves its root, nothing is written through a link.
 */

import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { within } from "../../platform/paths.js";
import { identifier } from "../../candidate-store/execution-storage.js";
import {
  rootKind,
  validRelativePath,
  validRootName,
  type ManifestEntry,
} from "./manifest.js";

export function stagingDir(path: string, migrationId: string): string {
  const target = resolve(path);
  return join(
    dirname(target),
    `.${basename(target)}.foundry-incoming-${identifier(migrationId)}`,
  );
}

/** Where a root's entries are staged. */
export function stagedRoot(staging: string, root: string): string {
  if (!validRootName(root)) throw new Error(`Invalid manifest root ${root}`);
  const kind = rootKind(root);
  if (kind === "folder") return join(staging, "folder");
  if (kind === "claude" || kind === "codex")
    return join(staging, "sidecar", kind, root.slice(kind.length + 1));
  return join(staging, "sidecar", kind);
}

/** The roots a staging folder can hold, by their folder in it. */
export function stagedRootDirs(staging: string): string[] {
  return [
    join(staging, "folder"),
    join(staging, "sidecar", "execution"),
    join(staging, "sidecar", "execution-meta"),
    join(staging, "sidecar", "claude"),
    join(staging, "sidecar", "codex"),
  ];
}

/** An entry's place under a base, refusing any path that leaves it. */
export function placeUnder(base: string, rel: string): string {
  if (!validRelativePath(rel)) throw new Error(`Unsafe path ${rel}`);
  const path = join(base, ...rel.split("/"));
  if (path === base || !within(base, path))
    throw new Error(`${rel} leaves its folder`);
  return path;
}

/**
 * Directories made under a base without ever passing through a link: each
 * component is checked (or made) in turn and remembered once checked.
 * Directories are kept writable by their owner while files arrive; their
 * own modes are applied at the end.
 */
export class SafeDirectories {
  private readonly checked = new Set<string>();

  async ensure(base: string, dir: string): Promise<void> {
    if (this.checked.has(dir)) return;
    if (!within(base, dir)) throw new Error(`${dir} leaves ${base}`);
    const parts = relative(base, dir).split(sep).filter(Boolean);
    let current = base;
    for (const part of ["", ...parts]) {
      current = part ? join(current, part) : current;
      if (this.checked.has(current)) continue;
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
          throw new Error(
            `${current} is a link; nothing is written through it`,
          );
        if (!stat.isDirectory()) throw new Error(`${current} is not a folder`);
        if ((stat.mode & 0o700) !== 0o700)
          await chmod(current, (stat.mode & 0o7777) | 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 });
      }
      this.checked.add(current);
    }
  }

  forget(dir: string): void {
    for (const path of [...this.checked])
      if (within(dir, path)) this.checked.delete(path);
  }
}

/** Removes a tree, first making its folders writable (no links followed). */
export async function removeTree(path: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    const pending = [path];
    while (pending.length) {
      const dir = pending.pop()!;
      try {
        const info = await lstat(dir);
        if ((info.mode & 0o700) !== 0o700)
          await chmod(dir, (info.mode & 0o7777) | 0o700);
        for (const entry of await readdir(dir, { withFileTypes: true }))
          if (entry.isDirectory()) pending.push(join(dir, entry.name));
      } catch {
        /* rm reports what it cannot remove. */
      }
    }
  }
  await rm(path, { recursive: true, force: true });
}

/**
 * Every entry an existing tree holds (relative POSIX path and type), links
 * never followed. Used to find what a staging folder or a purged root has
 * beyond its manifest. A folder the consumer adds to `prune` while it holds
 * the entry is not entered.
 */
export async function* walkTree(
  base: string,
  prune: Set<string> = new Set(),
): AsyncGenerator<{ rel: string; type: ManifestEntry["type"] | "other" }> {
  const pending = [""];
  while (pending.length) {
    const rel = pending.pop()!;
    let entries;
    try {
      entries = await readdir(rel ? join(base, ...rel.split("/")) : base, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      const type = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "dir"
          : entry.isFile()
            ? "file"
            : "other";
      yield { rel: child, type };
      if (type === "dir" && !prune.has(child)) pending.push(child);
    }
  }
}
