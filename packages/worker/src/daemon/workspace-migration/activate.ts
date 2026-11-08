/**
 * Activating a migrated workspace on the target (DEV-146): the staged
 * folder becomes the workspace folder (a rename on the same filesystem),
 * its identity file names the same id at the new path, its native sessions
 * go into this device's Claude and Codex homes, its execution root into
 * this device's, with paths and Git worktree links following, and the
 * registry serves it. Idempotent per migration: a second call finishes or
 * repeats what the first one did.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  NativeSessionRef,
  WorkspaceNativeSessionsMoved,
} from "@bd777/foundry-protocol";
import { readJSONFile, writeJSON } from "../../platform/storage.js";
import { canonical } from "../../platform/paths.js";
import { errorMessage } from "../../platform/utils.js";
import {
  ExecutionStore,
  identifier,
} from "../../candidate-store/execution-storage.js";
import {
  claudeProjectDirectoryName,
  relocateExecutionRegistration,
} from "../workspace-folders.js";
import {
  readRegistry,
  upsertRegistry,
  workspaceFilePath,
  type WorkspaceFile,
} from "../../workspace/workspaces.js";
import {
  counterpartHome,
  deviceHomeLocations,
  loadManifest,
  migrationStateDir,
  rootKind,
  type HomeLocations,
  type ManifestEntry,
} from "./manifest.js";
import {
  placeUnder,
  removeTree,
  SafeDirectories,
  stagedRoot,
  stagingDir,
} from "./staging.js";
import { expandPath } from "./target.js";

const run = promisify(execFile);

export interface ActivateInput {
  migrationId: string;
  workspaceId: string;
  name: string;
  path: string;
  previousPath: string;
  nativeSessions: NativeSessionRef[];
}

export interface ActivateOptions {
  homes?: HomeLocations;
  store?: ExecutionStore;
  /** This migration's state folder on the target. */
  stateDir?: string;
  /** Session work kept per workspace path on this device. */
  sessionWork?: { relocateWorkspace(workspaceId: string, path: string): void };
}

export interface Activated {
  workspace: WorkspaceFile;
  nativeSessions: WorkspaceNativeSessionsMoved;
  executionRoot: string;
  previousExecutionRoot: string;
}

/** Files of the execution metadata a combined root holds beside the rest. */
const metadataNames = new Set([
  "registration.local.json",
  "environment-locations",
]);

async function exists(path: string): Promise<boolean> {
  return !!(await lstat(path).catch(() => undefined));
}

/**
 * Moves one staged entry into place. A file there stays unless overwrite;
 * across filesystems it is copied, keeping its mode and times.
 */
async function moveInto(
  from: string,
  to: string,
  overwrite: boolean,
): Promise<"moved" | "kept" | "gone"> {
  if (!(await exists(from))) return (await exists(to)) ? "kept" : "gone";
  const there = await lstat(to).catch(() => undefined);
  if (there && !overwrite) return "kept";
  if (there?.isDirectory()) await removeTree(to);
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await cp(from, to, {
      force: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
  return "moved";
}

/** A Claude path with the source folder's project directory renamed. */
function claudePath(path: string, slug: string): string {
  const parts = path.split("/");
  if (parts[0] === "projects" && parts.length >= 2) parts[1] = slug;
  else if (
    parts[0] === "archived_sessions" &&
    parts[1] === "projects" &&
    parts.length >= 3
  )
    parts[2] = slug;
  return parts.join("/");
}

function realHome(path: string): string {
  return existsSync(path) ? realpathSync(path) : canonical(path);
}

type PathMap = [from: string, to: string][];

function mapPath(map: PathMap, value: string): string {
  for (const [from, to] of map) {
    if (value === from) return to;
    if (value.startsWith(`${from}/`)) return to + value.slice(from.length);
  }
  return value;
}

function mapStrings(map: PathMap, value: unknown): unknown {
  if (typeof value === "string") return mapPath(map, value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(map, item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(map, item)]),
    );
  return value;
}

interface Placed {
  entry: ManifestEntry;
  /** Where the entry is on this device now. */
  path: string;
}

/**
 * Points the moved Issue environments' Git worktrees and the folder's
 * repositories at each other again: the worktrees' `.git` files and the
 * repositories' worktrees/<name>/gitdir files are rewritten, then
 * `git worktree repair` checks both directions.
 */
async function repairWorktrees(map: PathMap, placed: Placed[]): Promise<void> {
  const worktrees = new Map<string, string[]>();
  for (const { entry, path } of placed) {
    if (entry.type !== "file" || entry.size > 4096) continue;
    if (basename(entry.path) === ".git") {
      const content = await readFile(path, "utf8").catch(() => "");
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(content);
      if (!match) continue;
      const gitdir = mapPath(map, match[1]!);
      if (gitdir !== match[1])
        await writeFile(path, content.replace(match[1]!, gitdir));
      const absolute = isAbsolute(gitdir)
        ? gitdir
        : resolve(dirname(path), gitdir);
      const at = absolute.lastIndexOf("/worktrees/");
      if (at < 0) continue;
      const common = absolute.slice(0, at);
      worktrees.set(common, [...(worktrees.get(common) ?? []), dirname(path)]);
    } else if (
      /(^|\/)\.git\/(.+\/)?worktrees\/[^/]+\/gitdir$/.test(entry.path)
    ) {
      const content = (await readFile(path, "utf8").catch(() => "")).trim();
      const mapped = mapPath(map, content);
      if (content && mapped !== content) await writeFile(path, `${mapped}\n`);
    }
  }
  for (const [common, paths] of worktrees) {
    if (!existsSync(common)) continue;
    const repository = basename(common) === ".git" ? dirname(common) : common;
    try {
      await run("git", ["-C", repository, "worktree", "repair", ...paths], {
        timeout: 60_000,
      });
    } catch (error) {
      console.error(
        `Repairing the worktrees of ${common} failed: ${errorMessage(error)}`,
      );
    }
  }
}

/** Rewrites the moved execution state's paths (registration, environments). */
async function rewriteJSON(map: PathMap, placed: Placed[]): Promise<void> {
  for (const { entry, path } of placed) {
    if (
      entry.type !== "file" ||
      !entry.path.endsWith(".json") ||
      entry.size > 8 * 1024 * 1024
    )
      continue;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const mapped = mapStrings(map, value);
    if (JSON.stringify(mapped) !== JSON.stringify(value))
      writeJSON(path, mapped);
  }
}

function emptyDirectory(path: string): boolean {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

export async function activateMigration(
  input: ActivateInput,
  options: ActivateOptions = {},
): Promise<Activated> {
  identifier(input.migrationId);
  identifier(input.workspaceId);
  const expanded = expandPath(input.path ?? "");
  if (!isAbsolute(expanded))
    throw new Error("workspace_migration_activate requires an absolute path");
  const path = resolve(expanded);
  const stateDir = options.stateDir ?? migrationStateDir(input.migrationId);
  const markerPath = join(stateDir, "activated.json");
  const store = options.store ?? new ExecutionStore();
  const registered = () =>
    readRegistry().find((entry) => entry.id === input.workspaceId);

  const done = readJSONFile<Activated>(markerPath);
  if (done && done.workspace.path === path) {
    upsertRegistry({
      id: done.workspace.id,
      name: done.workspace.name,
      path,
      baseline: done.workspace.baseline,
      registeredAt: registered()?.registeredAt ?? new Date().toISOString(),
    });
    await removeTree(stagingDir(path, input.migrationId));
    return done;
  }

  const staging = stagingDir(path, input.migrationId);
  const manifest = await loadManifest(staging);
  if (!manifest) throw new Error("No staged transfer for this migration");
  const { header, entries } = manifest;
  if (header.workspaceId !== input.workspaceId)
    throw new Error("The staged transfer is another workspace's");

  // The folder.
  const stagedFolder = join(staging, "folder");
  if (await exists(stagedFolder)) {
    const there = await lstat(path).catch(() => undefined);
    if (there) {
      if (
        !there.isDirectory() ||
        there.isSymbolicLink() ||
        !emptyDirectory(path)
      )
        throw new Error(`${path} exists and is not empty`);
      await rmdir(path);
    }
    await rename(stagedFolder, path);
  } else {
    const file = readJSONFile<WorkspaceFile>(workspaceFilePath(path));
    if (file?.id !== input.workspaceId)
      throw new Error(
        `The staged folder is gone and ${path} is not this workspace`,
      );
  }
  const earlier = readJSONFile<Partial<WorkspaceFile>>(workspaceFilePath(path));
  const now = new Date().toISOString();
  const workspace: WorkspaceFile = {
    id: input.workspaceId,
    name: input.name?.trim() || basename(path),
    path,
    baseline: earlier?.baseline || "main",
    createdAt: earlier?.createdAt || now,
    schemaVersion: 1,
  };
  writeJSON(workspaceFilePath(path), workspace);
  const folderReal = realpathSync(path);

  // Native sessions, never over a file this device has.
  const homes = options.homes ?? deviceHomeLocations();
  const slug = claudeProjectDirectoryName(path);
  const claudeIds = new Set(
    input.nativeSessions
      .filter((r) => r.provider === "claude")
      .map((r) => r.id),
  );
  const codexIds = new Set(
    input.nativeSessions.filter((r) => r.provider === "codex").map((r) => r.id),
  );
  const outcome = new Map<string, "moved" | "kept">();
  const dirs = new SafeDirectories();
  for (const entry of entries) {
    const kind = rootKind(entry.root);
    if (kind !== "claude" && kind !== "codex") continue;
    const home = realHome(
      counterpartHome(kind, header.roots[entry.root]?.role, homes),
    );
    await mkdir(home, { recursive: true, mode: 0o700 });
    const rel = kind === "claude" ? claudePath(entry.path, slug) : entry.path;
    const to = placeUnder(home, rel);
    if (entry.type === "dir") {
      await dirs.ensure(home, to);
      continue;
    }
    await dirs.ensure(home, dirname(to));
    const from = placeUnder(stagedRoot(staging, entry.root), entry.path);
    const result = await moveInto(from, to, false);
    if (entry.type !== "file" || result === "gone") continue;
    const name = basename(entry.path);
    if (
      kind === "claude" &&
      /^(archived_sessions\/)?projects\/[^/]+\/[^/]+\.jsonl$/.test(entry.path)
    ) {
      const id = name.slice(0, -".jsonl".length);
      if (claudeIds.has(id)) outcome.set(`claude:${id}`, result);
    } else if (kind === "codex")
      for (const id of codexIds)
        if (name.endsWith(`${id}.jsonl`)) outcome.set(`codex:${id}`, result);
  }
  const nativeSessions: WorkspaceNativeSessionsMoved = {
    copied: 0,
    alreadyThere: 0,
    notFound: 0,
  };
  for (const ref of input.nativeSessions) {
    const result = outcome.get(`${ref.provider}:${ref.id}`);
    if (result === "moved") nativeSessions.copied += 1;
    else if (result === "kept") nativeSessions.alreadyThere += 1;
    else nativeSessions.notFound += 1;
  }

  // The execution root, the migrated state taking precedence.
  const executionRoot = store.workspaceRoot(input.workspaceId);
  const metadata = store.metadata(input.workspaceId);
  const split = !!header.roots["execution-meta"];
  const destination = (entry: ManifestEntry): string => {
    if (entry.root === "execution-meta") return metadata;
    if (!split && metadataNames.has(entry.path.split("/")[0]!)) return metadata;
    return executionRoot;
  };
  const placed: Placed[] = [];
  const executionDirs: Placed[] = [];
  for (const entry of entries) {
    if (entry.root !== "execution" && entry.root !== "execution-meta") continue;
    const base = destination(entry);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const to = placeUnder(base, entry.path);
    if (entry.type === "dir") {
      await dirs.ensure(base, to);
      executionDirs.push({ entry, path: to });
      continue;
    }
    await dirs.ensure(base, dirname(to));
    await moveInto(
      placeUnder(stagedRoot(staging, entry.root), entry.path),
      to,
      true,
    );
    placed.push({ entry, path: to });
  }
  for (const { entry, path: dir } of executionDirs.reverse())
    await chmod(dir, entry.mode).catch(() => undefined);

  const rewrittenPath = join(stateDir, "rewritten.json");
  if (!existsSync(rewrittenPath)) {
    const map: PathMap = [
      [header.folder, path],
      [header.roots.folder?.path ?? header.folder, folderReal],
      [header.roots.execution?.path ?? header.executionRoot, executionRoot],
      ...(header.roots["execution-meta"]
        ? ([[header.roots["execution-meta"].path, metadata]] as PathMap)
        : []),
    ];
    map.sort((left, right) => right[0].length - left[0].length);
    await rewriteJSON(map, placed);
    const folderEntries: Placed[] = entries
      .filter((entry) => entry.root === "folder")
      .map((entry) => ({ entry, path: placeUnder(path, entry.path) }));
    await repairWorktrees(map, [...placed, ...folderEntries]);
    writeJSON(rewrittenPath, { at: new Date().toISOString() });
  }
  await relocateExecutionRegistration(input.workspaceId, path, store);
  options.sessionWork?.relocateWorkspace(input.workspaceId, path);

  upsertRegistry({
    id: workspace.id,
    name: workspace.name,
    path,
    baseline: workspace.baseline,
    registeredAt: registered()?.registeredAt ?? now,
  });
  const activated: Activated = {
    workspace,
    nativeSessions,
    executionRoot,
    previousExecutionRoot: header.executionRoot,
  };
  writeJSON(markerPath, activated);
  await removeTree(staging);
  return activated;
}
