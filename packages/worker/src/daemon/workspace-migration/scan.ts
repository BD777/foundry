/**
 * Scanning a workspace for a migration (DEV-146): its folder (everything,
 * .git and node_modules included, links never followed), its Claude
 * transcripts and project directory in every Claude home, its Codex
 * rollouts in every Codex home and its execution root. Contents are hashed
 * as streams; nothing is held in memory but the entries.
 */

import { createHash } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  NativeSessionRef,
  WorkspaceMigrationWarning,
} from "@bd777/foundry-protocol";
import { within } from "../../platform/paths.js";
import { foundryStatePath } from "../../platform/state-root.js";
import {
  ExecutionStore,
  identifier,
} from "../../candidate-store/execution-storage.js";
import { claudeProjectDirectoryName } from "../workspace-folders.js";
import { findSessionLog } from "../../session/usage/native-usage.js";
import {
  classifyHome,
  compareEntries,
  deviceHomeLocations,
  manifestDigest,
  manifestTotals,
  type HomeLocations,
  type ManifestEntry,
  type ManifestHeader,
  type ManifestRoot,
} from "./manifest.js";

export interface ScanInput {
  migrationId: string;
  workspaceId: string;
  path: string;
  nativeSessions: NativeSessionRef[];
  homes?: HomeLocations;
  store?: ExecutionStore;
  /** Foundry's skill snapshots: links into them are made, not moved. */
  skillSets?: string;
}

export interface ScanResult {
  header: ManifestHeader;
  /** Sorted by root and path. */
  entries: ManifestEntry[];
  warnings: WorkspaceMigrationWarning[];
}

const maxWarnings = 500;
const longPathBytes = 1000;
const hashConcurrency = 8;
const noFollow = constants.O_NOFOLLOW ?? 0;

function posix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Reads a file (never through a link) in chunks of at most maxChunk bytes,
 * sized to the file: a stream per small file would allocate its whole
 * high-water mark each time.
 */
export async function* readFileChunks(
  path: string,
  maxChunk = 1024 * 1024,
): AsyncGenerator<Buffer> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(size, maxChunk)));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

export async function hashFile(
  path: string,
): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of readFileChunks(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

class Scanner {
  readonly entries: ManifestEntry[] = [];
  readonly warnings: WorkspaceMigrationWarning[] = [];
  private readonly files: { entry: ManifestEntry; abs: string }[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly skillSets: string) {}

  warn(kind: WorkspaceMigrationWarning["kind"], path: string, detail?: string) {
    if (this.warnings.length < maxWarnings)
      this.warnings.push({ kind, path, ...(detail ? { detail } : {}) });
  }

  /** Adds one path of a root; returns whether it is a directory to walk. */
  async add(
    root: string,
    rootPath: string,
    rel: string,
    exclude?: (rel: string) => boolean,
  ): Promise<boolean> {
    const key = `${root}\n${rel}`;
    if (this.seen.has(key) || exclude?.(rel)) return false;
    this.seen.add(key);
    const abs = join(rootPath, ...rel.split("/"));
    if (Buffer.byteLength(rel) > longPathBytes) this.warn("long_path", abs);
    let stat: Stats;
    try {
      stat = await lstat(abs);
    } catch (error) {
      this.warn("unreadable", abs, (error as Error).message);
      return false;
    }
    const base = {
      root,
      path: rel,
      mode: stat.mode & 0o7777,
      mtimeMs: stat.mtimeMs,
    };
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(abs);
      } catch (error) {
        this.warn("unreadable", abs, (error as Error).message);
        return false;
      }
      const pointsAt = resolve(dirname(abs), target);
      if (
        root === "folder" &&
        /(^|\/)\.agents\/skills\/[^/]+$/.test(rel) &&
        within(this.skillSets, pointsAt)
      )
        return false; // Foundry links its skills again on the target.
      if (!within(rootPath, pointsAt))
        this.warn("external_symlink", abs, target);
      this.entries.push({ ...base, type: "symlink", size: 0, target });
      return false;
    }
    if (stat.isDirectory()) {
      this.entries.push({ ...base, type: "dir", size: 0 });
      return true;
    }
    if (stat.isFile()) {
      const entry: ManifestEntry = { ...base, type: "file", size: stat.size };
      this.entries.push(entry);
      this.files.push({ entry, abs });
      return false;
    }
    this.warn("special_file", abs);
    return false;
  }

  /** Walks a directory of a root ("" for the root itself), depth first. */
  async walk(
    root: string,
    rootPath: string,
    start: string,
    exclude?: (rel: string) => boolean,
  ): Promise<void> {
    if (start && !(await this.add(root, rootPath, start, exclude))) return;
    const pending = [start];
    while (pending.length) {
      const rel = pending.pop()!;
      const abs = rel ? join(rootPath, ...rel.split("/")) : rootPath;
      let names: string[];
      try {
        names = await readdir(abs);
      } catch (error) {
        this.warn("unreadable", abs, (error as Error).message);
        continue;
      }
      const folded = new Map<string, string>();
      for (const name of names) {
        const fold = name.normalize("NFC").toLowerCase();
        const other = folded.get(fold);
        if (other !== undefined)
          this.warn("case_conflict", join(abs, name), other);
        else folded.set(fold, name);
        const child = rel ? `${rel}/${name}` : name;
        if (await this.add(root, rootPath, child, exclude)) pending.push(child);
      }
    }
  }

  /** Hashes the files found; a file that cannot be read is left out. */
  async hash(): Promise<void> {
    const unreadable = new Set<ManifestEntry>();
    let next = 0;
    const work = async () => {
      while (next < this.files.length) {
        const { entry, abs } = this.files[next++]!;
        try {
          const { sha256, size } = await hashFile(abs);
          entry.sha256 = sha256;
          entry.size = size;
        } catch (error) {
          this.warn("unreadable", abs, (error as Error).message);
          unreadable.add(entry);
        }
      }
    };
    await Promise.all(Array.from({ length: hashConcurrency }, work));
    if (unreadable.size) {
      const kept = this.entries.filter((entry) => !unreadable.has(entry));
      this.entries.length = 0;
      this.entries.push(...kept);
    }
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The working directory a Codex rollout's session_meta names. */
export async function codexRolloutCwd(
  path: string,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const line = head.split("\n", 1)[0]!;
    try {
      const meta = JSON.parse(line) as {
        type?: string;
        payload?: { cwd?: unknown };
      };
      if (meta.type !== "session_meta") return undefined;
      return typeof meta.payload?.cwd === "string"
        ? resolve(meta.payload.cwd)
        : undefined;
    } catch {
      // A first line longer than the head: find its cwd field.
      if (!head.includes('"session_meta"')) return undefined;
      const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(head);
      return match ? resolve(JSON.parse(match[1]!) as string) : undefined;
    }
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

async function codexRollouts(
  home: string,
  belongs: (name: string, path: string) => Promise<boolean>,
): Promise<string[]> {
  const found: string[] = [];
  for (const base of ["sessions", "archived_sessions"]) {
    const pending: { rel: string; depth: number }[] = [{ rel: base, depth: 0 }];
    while (pending.length) {
      const { rel, depth } = pending.pop()!;
      let names: string[];
      try {
        names = await readdir(join(home, ...rel.split("/")));
      } catch {
        continue;
      }
      for (const name of names) {
        const child = `${rel}/${name}`;
        const abs = join(home, ...child.split("/"));
        if (name.endsWith(".jsonl")) {
          if (await belongs(name, abs)) found.push(child);
        } else if (depth < 4 && (await isDirectory(abs)))
          pending.push({ rel: child, depth: depth + 1 });
      }
    }
  }
  return found;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Scans what moves with a workspace and builds its manifest. */
export async function scanWorkspace(input: ScanInput): Promise<ScanResult> {
  identifier(input.migrationId);
  identifier(input.workspaceId);
  const folder = resolve(input.path);
  if (!(await isDirectory(folder)))
    throw new Error(`The workspace folder ${folder} is not there`);
  const folderReal = real(folder);
  const homes = input.homes ?? deviceHomeLocations();
  const store = input.store ?? new ExecutionStore();
  const scanner = new Scanner(
    resolve(input.skillSets ?? foundryStatePath("skill-sets")),
  );
  const roots: Record<string, ManifestRoot> = {
    folder: {
      kind: "folder",
      path: folderReal,
      scopes: [""],
      mode: (await lstat(folderReal)).mode & 0o7777,
    },
  };
  await scanner.walk("folder", folderReal, "");

  // Claude: the folder's project directory (sessions, memory) in every
  // home, and the given sessions wherever their transcript is.
  const slugs = new Set([
    claudeProjectDirectoryName(folder),
    folder.replace(/[^a-zA-Z0-9]/g, "-"),
  ]);
  const claudeIds = input.nativeSessions
    .filter((ref) => ref.provider === "claude")
    .map((ref) => ref.id?.trim() ?? "")
    .filter((id) => /^[\w-]{8,}$/.test(id));
  for (const home of homes.claude.all) {
    const { root, role } = classifyHome("claude", home, homes);
    if (roots[root]) continue;
    const scopes: string[] = [];
    for (const slug of slugs)
      for (const base of ["projects", "archived_sessions/projects"]) {
        const rel = `${base}/${slug}`;
        if (!(await isDirectory(join(home, ...rel.split("/"))))) continue;
        scopes.push(rel);
        await scanner.walk(root, home, rel);
      }
    for (const id of new Set(claudeIds)) {
      const found = await findSessionLog("claude", id, [home]);
      if (!found) continue;
      const rel = posix(relative(home, found));
      if (scopes.some((scope) => rel.startsWith(`${scope}/`))) continue;
      await scanner.add(root, home, rel);
      const sessionDir = rel.slice(0, -".jsonl".length);
      if (await isDirectory(join(home, ...sessionDir.split("/")))) {
        scopes.push(sessionDir);
        await scanner.walk(root, home, sessionDir);
      }
    }
    if (scanner.entries.some((entry) => entry.root === root))
      roots[root] = { kind: "claude", path: home, role, scopes };
  }

  // Codex: rollouts started in the folder, and the given sessions.
  const codexIds = new Set(
    input.nativeSessions
      .filter((ref) => ref.provider === "codex")
      .map((ref) => ref.id?.trim() ?? "")
      .filter((id) => /^[\w-]{8,}$/.test(id)),
  );
  for (const home of homes.codex.all) {
    const { root, role } = classifyHome("codex", home, homes);
    if (roots[root]) continue;
    const rollouts = await codexRollouts(home, async (name, abs) => {
      for (const id of codexIds) if (name.endsWith(`${id}.jsonl`)) return true;
      const cwd = await codexRolloutCwd(abs);
      return !!cwd && (within(folder, cwd) || within(folderReal, cwd));
    });
    for (const rel of rollouts) await scanner.add(root, home, rel);
    if (rollouts.length)
      roots[root] = { kind: "codex", path: home, role, scopes: [] };
  }

  // The execution root (Issue environments, evidence), without its locks.
  const noLocks = (rel: string) => rel === "locks" || rel.startsWith("locks/");
  const executionRoot = store.workspaceRoot(input.workspaceId);
  const metadata = store.metadata(input.workspaceId);
  if (await isDirectory(executionRoot)) {
    await scanner.walk("execution", executionRoot, "", noLocks);
    roots.execution = { kind: "execution", path: executionRoot, scopes: [""] };
  }
  if (metadata !== executionRoot && (await isDirectory(metadata))) {
    await scanner.walk("execution-meta", metadata, "", noLocks);
    roots["execution-meta"] = {
      kind: "execution-meta",
      path: metadata,
      scopes: [""],
    };
  }

  await scanner.hash();
  const entries = scanner.entries.sort(compareEntries);
  const header: ManifestHeader = {
    version: 1,
    migrationId: input.migrationId,
    workspaceId: input.workspaceId,
    folder,
    executionRoot,
    roots,
    nativeSessions: input.nativeSessions,
    scannedAt: new Date().toISOString(),
    digest: manifestDigest(entries),
    ...manifestTotals(entries),
  };
  return { header, entries, warnings: scanner.warnings };
}
