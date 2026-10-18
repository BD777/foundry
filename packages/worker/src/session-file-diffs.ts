// What a session's own writes changed, file by file and turn by turn.
//
// Claude: PreToolUse keeps a copy of the file before the session's first
// write in a turn, PostToolUse one after each write; the diff runs from the
// first to the last, so other agents' edits to other files never show.
// Codex reports no diffs: a turn in a Git work tree starts with a snapshot
// of the workspace folder written through Foundry's own index (the user's
// index is never touched), and the diff runs from that snapshot, which may
// include other edits.
//
// Copies are content-addressed under
// `<sessions>/<id>/inputs/<inputId>/baselines/`, beside a `changes.json`
// manifest; files over 1 MB and binaries are recorded by state only.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, gitBytes, type GitError } from "./execution-git.js";
import { sessionArtifactDirectories } from "./session-artifacts.js";
import { writeFileAtomic, writePrivateJSONAtomic } from "./storage.js";
import { errorMessage } from "./utils.js";

/** Files larger than this keep no copy: their diff shows as too large. */
export const maxBaselineBytes = 1024 * 1024;

/** A file's state at one moment, with a copy when it is text. */
export type FileSnapshot =
  | { kind: "text"; sha256: string; bytes: number }
  | { kind: "absent" }
  | { kind: "binary"; bytes: number }
  | { kind: "tooLarge"; bytes: number }
  /** The state could not be read (no PreToolUse, unreadable file). */
  | { kind: "unknown" };

export interface TurnFileChange {
  before: FileSnapshot;
  /** After the session's latest write in the turn. */
  after?: FileSnapshot;
  /** Something else wrote the file between two of the session's writes. */
  otherEdits?: boolean;
}

/** A Git tree of the work tree at one moment. */
export interface GitSnapshot {
  repoRoot: string;
  tree: string;
  /**
   * The folder the tree covers (the workspace) and its path in the
   * repository; files elsewhere have no "before". Older snapshots cover the
   * whole repository.
   */
  scope?: { path: string; prefix: string };
}

export interface TurnChanges {
  version: 1;
  source: "hook" | "git-snapshot";
  /** Codex: the turn-start tree, in the work tree's repository. */
  gitSnapshot?: GitSnapshot;
  /** By absolute path. */
  files: Record<string, TurnFileChange>;
}

export function turnDirectory(
  sessionsRoot: string,
  sessionId: string,
  inputId?: string,
): string {
  const sessionDir = resolve(sessionsRoot, sessionId);
  return inputId ? resolve(sessionDir, "inputs", inputId) : sessionDir;
}

function manifestPath(directory: string): string {
  return resolve(directory, "changes.json");
}

function blobPath(directory: string, sha256: string): string {
  return resolve(directory, "baselines", sha256);
}

export function readTurnChanges(directory: string): TurnChanges | undefined {
  try {
    const value = JSON.parse(
      readFileSync(manifestPath(directory), "utf8"),
    ) as TurnChanges;
    return value && typeof value.files === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Whether bytes look like a binary file: a NUL in the first 8 KB. */
function binaryBytes(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

export function sameSnapshot(
  left?: FileSnapshot,
  right?: FileSnapshot,
): boolean {
  if (!left || !right || left.kind === "unknown" || right.kind === "unknown")
    return true;
  if (left.kind !== right.kind) return false;
  if (left.kind === "text" && right.kind === "text")
    return left.sha256 === right.sha256;
  if (left.kind === "absent") return true;
  return (
    (left as { bytes: number }).bytes === (right as { bytes: number }).bytes
  );
}

/** The text a snapshot kept, when it kept one. */
export function snapshotText(
  directory: string,
  snapshot: FileSnapshot | undefined,
): string | undefined {
  if (snapshot?.kind === "absent") return "";
  if (snapshot?.kind !== "text") return undefined;
  try {
    return readFileSync(blobPath(directory, snapshot.sha256), "utf8");
  } catch {
    return undefined;
  }
}

/** Reads a file's state now; keeps a copy of its text under `directory`. */
export function captureFile(
  path: string,
  directory: string | undefined,
): FileSnapshot {
  let bytes: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { kind: "unknown" };
    bytes = stat.size;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unknown" };
  }
  if (bytes > maxBaselineBytes) return { kind: "tooLarge", bytes };
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch {
    return { kind: "unknown" };
  }
  if (data.length > maxBaselineBytes)
    return { kind: "tooLarge", bytes: data.length };
  if (binaryBytes(data)) return { kind: "binary", bytes: data.length };
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (directory) {
    const blob = blobPath(directory, sha256);
    if (!existsSync(blob))
      writeFileAtomic(blob, data, { hardenParent: false, fsync: false });
  }
  return { kind: "text", sha256, bytes: data.length };
}

/**
 * One turn's copies. Calls are serialized by the caller (the turn's write
 * queue), so a PreToolUse always sees the previous write's PostToolUse.
 */
export class TurnFileChanges {
  readonly directory: string;
  private changes: TurnChanges;

  constructor(directory: string) {
    this.directory = directory;
    this.changes = readTurnChanges(directory) ?? {
      version: 1,
      source: "hook",
      files: {},
    };
  }

  get source(): TurnChanges["source"] {
    return this.changes.source;
  }

  get gitSnapshot(): TurnChanges["gitSnapshot"] {
    return this.changes.gitSnapshot;
  }

  entry(path: string): TurnFileChange | undefined {
    return this.changes.files[path];
  }

  private save(): void {
    writePrivateJSONAtomic(manifestPath(this.directory), this.changes);
  }

  /** Before a write tool runs: the file as the session found it. */
  captureBefore(path: string): void {
    const known = this.changes.files[path];
    const now = captureFile(path, this.directory);
    if (!known) {
      this.changes.files[path] = { before: now };
      this.save();
      return;
    }
    // The file should be as the session's previous write left it.
    if (!sameSnapshot(known.after ?? known.before, now) && !known.otherEdits) {
      known.otherEdits = true;
      this.save();
    }
  }

  /** After a write succeeded: the file as the session left it. */
  captureAfter(path: string): void {
    const after = captureFile(path, this.directory);
    const known = this.changes.files[path];
    if (known) known.after = after;
    else
      this.changes.files[path] = {
        // No PreToolUse (Codex): the turn-start snapshot is the before.
        before: { kind: "unknown" },
        after,
      };
    this.save();
  }

  /**
   * Codex: the workspace folder's state at the turn start, as a Git tree.
   * `sessionDirectory` keeps the snapshot's index between turns, so a later
   * turn hashes only what changed since; a session whose snapshot ran out
   * of time stops taking them instead of delaying every turn.
   */
  async snapshotGitWorkTree(
    workspacePath: string,
    sessionDirectory?: string,
  ): Promise<void> {
    const skipped = sessionDirectory
      ? resolve(sessionDirectory, "git-snapshot.skipped")
      : undefined;
    if (skipped && existsSync(skipped)) return;
    // Foundry's own session files are not the user's work.
    const snapshot = await gitWorkTreeSnapshot(workspacePath, {
      exclude: [
        resolve(workspacePath, ".foundry"),
        this.directory,
        ...(sessionDirectory ? [sessionDirectory] : []),
      ],
      index: sessionDirectory
        ? resolve(sessionDirectory, "git-snapshot.index")
        : undefined,
    });
    if (snapshot === "timedOut") {
      if (skipped)
        writeFileAtomic(skipped, `${new Date().toISOString()}\n`, {
          hardenParent: false,
          fsync: false,
        });
      return;
    }
    if (!snapshot) return;
    this.changes = {
      ...this.changes,
      source: "git-snapshot",
      gitSnapshot: snapshot,
    };
    this.save();
  }

  /** Drops copies of intermediate writes nothing refers to any more. */
  pruneCopies(): void {
    const kept = new Set<string>();
    for (const change of Object.values(this.changes.files))
      for (const snapshot of [change.before, change.after])
        if (snapshot?.kind === "text") kept.add(snapshot.sha256);
    let names: string[];
    try {
      names = readdirSync(resolve(this.directory, "baselines"));
    } catch {
      return;
    }
    for (const name of names)
      if (!kept.has(name))
        rmSync(resolve(this.directory, "baselines", name), { force: true });
  }
}

/** Snapshot reads: bounded by the largest copy kept, never long. */
const snapshotGit = { maxBuffer: 4 * maxBaselineBytes, timeout: 30_000 };

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `path` relative to `base`, with `/`; undefined when it is not inside. */
function inside(base: string, path: string): string | undefined {
  const relativePath = relative(base, path);
  if (relativePath.startsWith("..") || isAbsolute(relativePath))
    return undefined;
  return relativePath.split(sep).join("/");
}

/**
 * Writes the workspace folder as a Git tree object without touching the
 * user's index: `git add -A` stages into `index` (seeded from a copy of the
 * user's), or into a temporary copy without one. The index keeps `add` from
 * re-hashing unchanged files, so it is kept between turns. Only the
 * workspace folder is staged: a workspace inside a much larger repository
 * would otherwise hash all of it. Nested repositories and worktrees are
 * recorded as their commit, never entered. Files Git cannot read are left
 * out rather than failing the snapshot. The objects land in the
 * repository's object store, where `git gc` collects them.
 * `exclude`: folders left out, such as Foundry's session files.
 * "timedOut": staging ran out of time.
 */
export async function gitWorkTreeSnapshot(
  workspacePath: string,
  options: { exclude?: string[]; index?: string } = {},
): Promise<GitSnapshot | "timedOut" | undefined> {
  let repoRoot: string;
  let prefix: string;
  try {
    // The prefix comes from Git, so a workspace reached through a symlink
    // still finds its place in the repository.
    [repoRoot = "", prefix = ""] = (
      await git(
        workspacePath,
        ["rev-parse", "--show-toplevel", "--show-prefix"],
        snapshotGit,
      )
    ).split("\n");
  } catch {
    return undefined;
  }
  if (!repoRoot) return undefined;
  const inWorkspace = (options.exclude ?? [])
    .map((path) => inside(workspacePath, path))
    .filter((path): path is string => Boolean(path));
  // Only the outermost of nested paths: git (2.39) fails `add` when an
  // exclude names a folder inside one that is already ignored, such as a
  // session folder under `.foundry/`, which Foundry adds to info/exclude.
  const excluded = inWorkspace
    .filter(
      (path) =>
        !inWorkspace.some(
          (other) => other !== path && path.startsWith(`${other}/`),
        ),
    )
    .map((path) => `:(exclude)${path}`);
  const temporaryFolder = options.index
    ? undefined
    : mkdtempSync(join(tmpdir(), "foundry-snapshot-"));
  const index = options.index ?? join(temporaryFolder!, "index");
  try {
    if (!existsSync(index)) {
      const realIndex = resolve(
        repoRoot,
        await git(repoRoot, ["rev-parse", "--git-path", "index"], snapshotGit),
      );
      mkdirSync(dirname(index), { recursive: true });
      if (existsSync(realIndex)) copyFileSync(realIndex, index);
    }
    const withIndex = { ...snapshotGit, env: { GIT_INDEX_FILE: index } };
    try {
      await git(
        workspacePath,
        [
          "add",
          "-A",
          "--ignore-errors",
          "--no-warn-embedded-repo",
          "--",
          ".",
          ...excluded,
        ],
        withIndex,
      );
    } catch (error) {
      const failure = error as GitError;
      if (failure.timedOut) {
        console.error(
          `Snapshotting ${workspacePath} for diffs took over ${snapshotGit.timeout / 1000} s; this session's Codex turns go without one`,
        );
        return "timedOut";
      }
      // 1: some files could not be read; the rest are staged.
      if (failure.exitCode !== 1) throw error;
    }
    const tree = await git(repoRoot, ["write-tree"], withIndex);
    return /^[0-9a-f]{40,64}$/.test(tree)
      ? { repoRoot, tree, scope: { path: workspacePath, prefix } }
      : undefined;
  } catch (error) {
    console.error(
      `Could not snapshot ${workspacePath} for diffs: ${errorMessage(error)}`,
    );
    return undefined;
  } finally {
    if (temporaryFolder)
      rmSync(temporaryFolder, { recursive: true, force: true });
  }
}

/** Where a file sits in a snapshot's tree; undefined outside what it covers. */
function snapshotObjectPath(
  snapshot: GitSnapshot,
  path: string,
): string | undefined {
  if (!snapshot.scope) {
    const relativePath = inside(snapshot.repoRoot, path);
    return relativePath || undefined;
  }
  const { path: folder, prefix } = snapshot.scope;
  const relativePath =
    inside(folder, path) ?? inside(realpathOrSelf(folder), path);
  return relativePath ? `${prefix}${relativePath}` : undefined;
}

/** A file's state in a snapshot tree; the text when it is small text. */
export async function gitSnapshotFile(
  snapshot: GitSnapshot,
  path: string,
): Promise<{ snapshot: FileSnapshot; text?: string }> {
  const relativePath = snapshotObjectPath(snapshot, path);
  if (!relativePath) return { snapshot: { kind: "unknown" } };
  const object = `${snapshot.tree}:${relativePath}`;
  let bytes: number;
  try {
    bytes = Number(
      await git(snapshot.repoRoot, ["cat-file", "-s", object], snapshotGit),
    );
  } catch {
    // Not in the tree: the file did not exist, unless Git ignores it or it
    // belongs to a nested repository (the tree holds only its commit).
    const owner = await git(
      dirname(path),
      ["rev-parse", "--show-toplevel"],
      snapshotGit,
    ).catch(() => undefined);
    if (owner !== snapshot.repoRoot) return { snapshot: { kind: "unknown" } };
    const ignored = await git(
      snapshot.repoRoot,
      ["check-ignore", "-q", "--no-index", "--", relativePath],
      snapshotGit,
    ).then(
      () => true,
      () => false,
    );
    return ignored
      ? { snapshot: { kind: "unknown" } }
      : { snapshot: { kind: "absent" }, text: "" };
  }
  if (!Number.isFinite(bytes)) return { snapshot: { kind: "unknown" } };
  if (bytes > maxBaselineBytes)
    return { snapshot: { kind: "tooLarge", bytes } };
  const data = await gitBytes(snapshot.repoRoot, ["cat-file", "blob", object], {
    maxBuffer: 2 * maxBaselineBytes,
    timeout: 30_000,
  });
  if (binaryBytes(data)) return { snapshot: { kind: "binary", bytes } };
  return {
    snapshot: {
      kind: "text",
      sha256: createHash("sha256").update(data).digest("hex"),
      bytes,
    },
    text: data.toString("utf8"),
  };
}

function lines(text: string): string[] {
  if (!text) return [];
  const split = text.split("\n");
  if (split[split.length - 1] === "") split.pop();
  return split;
}

/**
 * Lines added and removed by a minimal line diff (Myers), the counts a
 * unified diff shows. Undefined when the texts differ too much to count
 * quickly.
 */
export function lineChangeCounts(
  before: string,
  after: string,
  budget = 20_000_000,
): { added: number; removed: number } | undefined {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start])
    start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const n = endA - start;
  const m = endB - start;
  if (n === 0 || m === 0) return { added: m, removed: n };
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  let work = 0;
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x += 1;
        y += 1;
        work += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m)
        return { added: (d + m - n) / 2, removed: (d - m + n) / 2 };
      work += 1;
      if (work > budget) return undefined;
    }
  }
  return undefined;
}

/** A file's state now, with its text when it is small text. */
export function currentFile(path: string): {
  snapshot: FileSnapshot;
  text?: string;
} {
  const snapshot = captureFile(path, undefined);
  if (snapshot.kind !== "text") return { snapshot };
  try {
    return { snapshot, text: readFileSync(path, "utf8") };
  } catch {
    return { snapshot: { kind: "unknown" } };
  }
}

interface FileChangeStep {
  directory: string;
  manifest: TurnChanges;
  change: TurnFileChange;
}

/** The turns that wrote the file, oldest first; one turn's with `inputId`. */
function fileChangeSteps(
  sessionsRoot: string,
  sessionId: string,
  path: string,
  inputId?: string,
): FileChangeStep[] {
  const directories = inputId
    ? [turnDirectory(sessionsRoot, sessionId, inputId)]
    : sessionArtifactDirectories(sessionsRoot, sessionId);
  const steps: FileChangeStep[] = [];
  for (const directory of directories) {
    const manifest = readTurnChanges(directory);
    const change = manifest?.files[path];
    if (manifest && change) steps.push({ directory, manifest, change });
  }
  return steps;
}

async function stepBefore(
  step: FileChangeStep,
  path: string,
): Promise<{ snapshot: FileSnapshot; text?: string }> {
  const before = step.change.before;
  if (before.kind !== "unknown")
    return { snapshot: before, text: snapshotText(step.directory, before) };
  if (step.manifest.gitSnapshot)
    return gitSnapshotFile(step.manifest.gitSnapshot, path).catch(() => ({
      snapshot: { kind: "unknown" } as FileSnapshot,
    }));
  return { snapshot: { kind: "unknown" } };
}

/** What the session's writes did to one file: one turn, or all of them. */
export interface SessionFileChange {
  source: TurnChanges["source"];
  before: { snapshot: FileSnapshot; text?: string };
  /** Absent when no write's result was kept. */
  after?: { snapshot: FileSnapshot; text?: string };
  /** Something else also wrote the file while the session edited it. */
  otherEdits: boolean;
}

export async function sessionFileChange(
  sessionsRoot: string,
  sessionId: string,
  path: string,
  inputId?: string,
): Promise<SessionFileChange | undefined> {
  const steps = fileChangeSteps(sessionsRoot, sessionId, path, inputId);
  if (steps.length === 0) return undefined;
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const before = await stepBefore(first, path);
  const source = steps.some((step) => step.manifest.source === "git-snapshot")
    ? "git-snapshot"
    : "hook";
  let otherEdits =
    source === "git-snapshot" || steps.some((step) => step.change.otherEdits);
  // Between turns: each turn should find the file as the last one left it.
  for (let index = 1; index < steps.length && !otherEdits; index += 1) {
    const previous = steps[index - 1]!.change.after;
    const next = (await stepBefore(steps[index]!, path)).snapshot;
    if (!sameSnapshot(previous, next)) otherEdits = true;
  }
  const after = last.change.after
    ? {
        snapshot: last.change.after,
        text: snapshotText(last.directory, last.change.after),
      }
    : undefined;
  return { source, before, after, otherEdits };
}
