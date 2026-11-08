/**
 * The manifest of a workspace migration (DEV-146): every directory, file
 * and link that moves, by root (the folder, a Claude or Codex home, the
 * execution root) and relative POSIX path, with its hash. The source keeps
 * it under <stateRoot>/migrations/<migrationId>/ for rescans and purging;
 * the target keeps the copy it received in its staging folder.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { NativeSessionRef } from "@bd777/foundry-protocol";
import { foundryStatePath } from "../../platform/state-root.js";
import { insidePath } from "../../platform/paths.js";
import { readJSONFile, writeJSON } from "../../platform/storage.js";
import { identifier } from "../../candidate-store/execution-storage.js";
import { nativeSessionHomes } from "../workspace-folders.js";

export type EntryType = "file" | "dir" | "symlink";

export interface ManifestEntry {
  root: string;
  path: string;
  type: EntryType;
  size: number;
  mode: number;
  mtimeMs: number;
  sha256?: string;
  /** A symlink's target, as it reads. */
  target?: string;
}

export type RootKind =
  "folder" | "claude" | "codex" | "execution" | "execution-meta";

/** Which of the device's homes a Claude or Codex home is. */
export type HomeRole =
  | { role: "default" }
  | { role: "env" }
  | { role: "home"; rel: string }
  | { role: "other" };

export interface ManifestRoot {
  kind: RootKind;
  /** The root on the source device (absolute). */
  path: string;
  role?: HomeRole;
  /**
   * Relative directories walked whole ("" for the root itself): a purge
   * looks for files added there since. Outside them only the listed
   * entries belong to the migration.
   */
  scopes: string[];
  /** The root folder's own mode (the workspace folder's). */
  mode?: number;
}

export interface ManifestHeader {
  version: 1;
  migrationId: string;
  workspaceId: string;
  /** The workspace folder on the source, as registered. */
  folder: string;
  /** The workspace's execution root on the source. */
  executionRoot: string;
  roots: Record<string, ManifestRoot>;
  nativeSessions: NativeSessionRef[];
  scannedAt: string;
  digest: string;
  entries: number;
  files: number;
  bytes: number;
}

const rootNamePattern =
  /^(folder|execution|execution-meta|(claude|codex):[A-Za-z0-9._-]{1,96})$/;

export function validRootName(root: unknown): root is string {
  return typeof root === "string" && rootNamePattern.test(root);
}

export function rootKind(root: string): RootKind {
  if (root.startsWith("claude:")) return "claude";
  if (root.startsWith("codex:")) return "codex";
  return root as RootKind;
}

/** A path inside a root: relative, POSIX, no empty, `.` or `..` segment. */
export function validRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0"))
    return false;
  if (Buffer.byteLength(path) > 4096) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  if (process.platform === "win32" && path.includes("\\")) return false;
  return path
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== "..");
}

const shaPattern = /^[a-f0-9]{64}$/;

/** Whether a received entry is well formed; refuses anything else. */
export function checkEntry(value: unknown): ManifestEntry {
  const entry = value as Partial<ManifestEntry> | null;
  if (!entry || typeof entry !== "object")
    throw new Error("Manifest entry is not an object");
  if (!validRootName(entry.root))
    throw new Error(`Manifest entry has an invalid root ${String(entry.root)}`);
  if (!validRelativePath(entry.path))
    throw new Error(`Manifest entry has an unsafe path ${String(entry.path)}`);
  if (entry.type !== "file" && entry.type !== "dir" && entry.type !== "symlink")
    throw new Error(`Manifest entry ${entry.path} has an unknown type`);
  const number = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) && field >= 0;
  if (!number(entry.size) || !number(entry.mode) || !number(entry.mtimeMs))
    throw new Error(`Manifest entry ${entry.path} has invalid metadata`);
  if (entry.type === "file" && !shaPattern.test(entry.sha256 ?? ""))
    throw new Error(`Manifest entry ${entry.path} has no sha256`);
  if (
    entry.type === "symlink" &&
    (typeof entry.target !== "string" ||
      entry.target === "" ||
      entry.target.includes("\0"))
  )
    throw new Error(`Manifest entry ${entry.path} has no link target`);
  return {
    root: entry.root,
    path: entry.path,
    type: entry.type,
    size: entry.size!,
    mode: entry.mode! & 0o7777,
    mtimeMs: entry.mtimeMs!,
    ...(entry.type === "file" ? { sha256: entry.sha256 } : {}),
    ...(entry.type === "symlink" ? { target: entry.target } : {}),
  };
}

export function entryKey(entry: Pick<ManifestEntry, "root" | "path">): string {
  return `${entry.root}\n${entry.path}`;
}

export function compareEntries(
  left: Pick<ManifestEntry, "root" | "path">,
  right: Pick<ManifestEntry, "root" | "path">,
): number {
  if (left.root !== right.root) return left.root < right.root ? -1 : 1;
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

/**
 * An entry as the digest sees it. A directory's time is left out: it moves
 * whenever something inside changes, which the entries themselves show.
 */
export function canonicalEntry(entry: ManifestEntry): string {
  return JSON.stringify([
    entry.root,
    entry.path,
    entry.type,
    entry.size,
    entry.mode,
    entry.type === "dir" ? 0 : Math.floor(entry.mtimeMs),
    entry.sha256 ?? "",
    entry.target ?? "",
  ]);
}

/** sha256 over the canonical entries in sorted order. */
export function manifestDigest(sorted: ManifestEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of sorted) hash.update(`${canonicalEntry(entry)}\n`);
  return hash.digest("hex");
}

export function manifestTotals(entries: ManifestEntry[]): {
  entries: number;
  files: number;
  bytes: number;
} {
  let files = 0;
  let bytes = 0;
  for (const entry of entries)
    if (entry.type === "file") {
      files += 1;
      bytes += entry.size;
    }
  return { entries: entries.length, files, bytes };
}

// --- Storage ---------------------------------------------------------------

/** A migration's own state on this device. */
export function migrationStateDir(migrationId: string): string {
  return foundryStatePath("migrations", identifier(migrationId));
}

export async function writeLines(
  path: string,
  lines: Iterable<string>,
): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  const out = createWriteStream(temporary, { mode: 0o600 });
  for (const line of lines)
    if (!out.write(`${line}\n`)) await once(out, "drain");
  out.end();
  await once(out, "close");
  await rename(temporary, path);
}

export async function* readLines(path: string): AsyncGenerator<string> {
  if (!existsSync(path)) return;
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) if (line.trim()) yield line;
}

export async function saveManifest(
  dir: string,
  header: ManifestHeader,
  entries: ManifestEntry[],
): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  await writeLines(
    join(dir, "manifest.jsonl"),
    (function* () {
      for (const entry of entries) yield JSON.stringify(entry);
    })(),
  );
  writeJSON(join(dir, "header.json"), header);
}

export interface StoredManifest {
  header: ManifestHeader;
  entries: ManifestEntry[];
}

export async function loadManifest(
  dir: string,
): Promise<StoredManifest | undefined> {
  const header = readJSONFile<ManifestHeader>(join(dir, "header.json"));
  if (!header || header.version !== 1) return undefined;
  const entries: ManifestEntry[] = [];
  for await (const line of readLines(join(dir, "manifest.jsonl")))
    entries.push(checkEntry(JSON.parse(line)));
  return { header, entries };
}

// --- Homes -----------------------------------------------------------------

export interface HomeSet {
  /** Where the runtime keeps its state by default (~/.claude, ~/.codex). */
  default: string;
  /** The worker's own CLAUDE_CONFIG_DIR / CODEX_HOME, when set. */
  env?: string;
  /** Every home on the device that holds sessions. */
  all: string[];
}

export interface HomeLocations {
  home: string;
  claude: HomeSet;
  codex: HomeSet;
}

export function deviceHomeLocations(): HomeLocations {
  const home = homedir();
  const homes = nativeSessionHomes();
  const env = (name: string) =>
    process.env[name]?.trim() ? resolve(process.env[name]!.trim()) : undefined;
  return {
    home,
    claude: {
      default: resolve(home, ".claude"),
      env: env("CLAUDE_CONFIG_DIR"),
      all: homes.claude,
    },
    codex: {
      default: resolve(home, ".codex"),
      env: env("CODEX_HOME"),
      all: homes.codex,
    },
  };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/** The root name and role of one of the source's homes. */
export function classifyHome(
  kind: "claude" | "codex",
  path: string,
  locations: HomeLocations,
): { root: string; role: HomeRole } {
  const set = locations[kind];
  const at = resolve(path);
  if (at === set.default)
    return { root: `${kind}:default`, role: { role: "default" } };
  if (set.env && at === set.env)
    return { root: `${kind}:env`, role: { role: "env" } };
  const inside = insidePath(locations.home, at);
  if (inside) {
    const rel = inside.split(sep).join("/");
    const name = rel.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
    return {
      root: `${kind}:home-${name}-${shortHash(rel)}`,
      role: { role: "home", rel },
    };
  }
  return { root: `${kind}:other-${shortHash(at)}`, role: { role: "other" } };
}

/**
 * The target's counterpart of a source home: the same role (default with
 * default, the worker's configured home with its own, the same folder under
 * the home directory when the target uses it); else the target's default.
 */
export function counterpartHome(
  kind: "claude" | "codex",
  role: HomeRole | undefined,
  locations: HomeLocations,
): string {
  const set = locations[kind];
  if (role?.role === "env" && set.env) return set.env;
  if (role?.role === "home" && validRelativePath(role.rel)) {
    const path = resolve(locations.home, ...role.rel.split("/"));
    if (set.all.includes(path) || path === set.env) return path;
  }
  return set.default;
}
