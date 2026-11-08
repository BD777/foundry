/**
 * The target side of a workspace migration (DEV-146): checking the folder
 * to create, receiving into staging (resumable per file), verifying the
 * staging against its manifest, and dropping it on abort.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  statfsSync,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type {
  WorkspaceMigrationCheckedPayload,
  WorkspaceMigrationProgressPayload,
  WorkspaceMigrationVerifiedPayload,
} from "@bd777/foundry-protocol";
import { within } from "../../platform/paths.js";
import { foundryStateRoot } from "../../platform/state-root.js";
import { readRegistry } from "../../workspace/workspaces.js";
import { identifier } from "../../candidate-store/execution-storage.js";
import { FrameReader, frameKinds, jsonPayload, writeFrame } from "./framing.js";
import {
  checkEntry,
  entryKey,
  loadManifest,
  manifestDigest,
  readLines,
  rootKind,
  saveManifest,
  validRootName,
  type ManifestEntry,
  type ManifestHeader,
} from "./manifest.js";
import {
  placeUnder,
  removeTree,
  SafeDirectories,
  stagedRoot,
  stagingDir,
  walkTree,
} from "./staging.js";
import { hashFile } from "./scan.js";

export type TransferProgress = Pick<
  WorkspaceMigrationProgressPayload,
  "phase" | "files" | "bytes" | "totalFiles" | "totalBytes" | "manifestDigest"
>;

const gib = 1024 ** 3;
const maxMismatches = 50;

// --- Check -----------------------------------------------------------------

export function expandPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return trimmed;
}

/** Whether the target device can take the workspace at this folder. */
export function checkTarget(input: {
  path: string;
  bytes: number;
}): WorkspaceMigrationCheckedPayload {
  const expanded = expandPath(input.path ?? "");
  if (!expanded || !isAbsolute(expanded))
    return {
      ok: false,
      reason: "The path must be absolute",
      freeBytes: 0,
      path: expanded,
    };
  const path = resolve(expanded);
  const refuse = (reason: string, freeBytes = 0) => ({
    ok: false,
    reason,
    freeBytes,
    path,
  });
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return refuse(`${path} is a link`);
    if (!stat.isDirectory())
      return refuse(`${path} exists and is not a folder`);
    if (readdirSync(path).length > 0)
      return refuse(`${path} exists and is not empty`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return refuse(`${path} cannot be read: ${(error as Error).message}`);
  }
  let ancestor = dirname(path);
  for (;;) {
    try {
      if (!lstatSync(ancestor).isDirectory())
        return refuse(`${ancestor} is not a folder`);
      break;
    } catch {
      const up = dirname(ancestor);
      if (up === ancestor) return refuse("No existing parent folder");
      ancestor = up;
    }
  }
  try {
    accessSync(ancestor, constants.W_OK);
  } catch {
    return refuse(`${ancestor} is not writable`);
  }
  if (within(foundryStateRoot(), path))
    return refuse("The path is inside Foundry's own state folder");
  for (const entry of readRegistry())
    if (within(resolve(entry.path), path))
      return refuse(
        `The path is inside the workspace ${entry.name} (${entry.path})`,
      );
  const fs = statfsSync(ancestor);
  const freeBytes = Number(fs.bavail) * Number(fs.bsize);
  const needed = Math.ceil((input.bytes || 0) * 1.1) + gib;
  if (freeBytes < needed)
    return refuse(
      `Not enough free space: ${freeBytes} bytes free, ${needed} needed`,
      freeBytes,
    );
  return { ok: true, freeBytes, path };
}

// --- Receive ---------------------------------------------------------------

interface Received {
  size: number;
  sha256: string;
}

async function receivedFiles(staging: string): Promise<Map<string, Received>> {
  const map = new Map<string, Received>();
  for await (const line of readLines(join(staging, "received.jsonl"))) {
    try {
      const value = JSON.parse(line) as {
        root: string;
        path: string;
        size: number;
        sha256: string;
      };
      map.set(entryKey(value), { size: value.size, sha256: value.sha256 });
    } catch {
      /* A line cut by a crash names nothing. */
    }
  }
  return map;
}

/** Refuses a manifest that could write outside staging or through links. */
export function checkManifest(
  header: ManifestHeader,
  entries: ManifestEntry[],
): void {
  if (manifestDigest(entries) !== header.digest)
    throw new Error("The manifest does not match its digest");
  for (const [name, root] of Object.entries(header.roots ?? {})) {
    if (!validRootName(name) || rootKind(name) !== root.kind)
      throw new Error(`Invalid manifest root ${name}`);
  }
  const links = new Set<string>();
  const keys = new Set<string>();
  for (const entry of entries) {
    if (!header.roots[entry.root])
      throw new Error(`Manifest entry in unknown root ${entry.root}`);
    const key = entryKey(entry);
    if (keys.has(key)) throw new Error(`Manifest lists ${entry.path} twice`);
    keys.add(key);
    if (entry.type === "symlink") links.add(key);
  }
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1)
      if (links.has(`${entry.root}\n${parts.slice(0, depth).join("/")}`))
        throw new Error(`${entry.path} would be written through a link`);
  }
}

/** Folders above listed entries (a sidecar root's projects/, sessions/…). */
function ancestorDirs(entries: ManifestEntry[]): Set<string> {
  const ancestors = new Set<string>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let depth = 1; depth < parts.length; depth += 1)
      ancestors.add(`${entry.root}\n${parts.slice(0, depth).join("/")}`);
  }
  return ancestors;
}

/** Removes from staging whatever the manifest no longer lists. */
async function clearStale(
  staging: string,
  header: ManifestHeader,
  entries: ManifestEntry[],
): Promise<void> {
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]));
  const ancestors = ancestorDirs(entries);
  const roots = new Set(Object.keys(header.roots));
  // Root folders of roots that are not in this manifest.
  for (const kind of ["claude", "codex"] as const)
    for (const name of await readdir(join(staging, "sidecar", kind)).catch(
      () => [] as string[],
    ))
      if (!roots.has(`${kind}:${name}`))
        await removeTree(join(staging, "sidecar", kind, name));
  for (const root of ["execution", "execution-meta"])
    if (!roots.has(root)) await removeTree(stagedRoot(staging, root));
  for (const root of roots) {
    const base = stagedRoot(staging, root);
    const prune = new Set<string>();
    for await (const { rel, type } of walkTree(base, prune)) {
      const entry = byKey.get(`${root}\n${rel}`);
      const path = join(base, ...rel.split("/"));
      if (!entry && type === "dir" && ancestors.has(`${root}\n${rel}`))
        continue;
      if (!entry || entry.type !== type) {
        await removeTree(path);
        prune.add(rel);
      } else if (
        type === "symlink" &&
        (await readlink(path).catch(() => "")) !== entry.target
      )
        await unlink(path);
    }
  }
}

function mtime(entry: ManifestEntry): Date {
  return new Date(entry.mtimeMs);
}

async function applyFileMetadata(path: string, entry: ManifestEntry) {
  await chmod(path, entry.mode);
  await utimes(path, mtime(entry), mtime(entry));
}

/**
 * Runs the target half of the frame protocol: takes the manifest, asks for
 * the files staging does not hold yet, writes each to a part file and puts
 * it in place once its hash matches. Resolves after DONE and ACK.
 */
export async function runTarget(
  stream: Duplex,
  input: {
    migrationId: string;
    path: string;
    onProgress?: (progress: TransferProgress) => void;
  },
): Promise<{
  received: number;
  failed: number;
  bytes: number;
  digest: string;
}> {
  identifier(input.migrationId);
  const staging = stagingDir(input.path, input.migrationId);
  const reader = new FrameReader(stream);
  await writeFrame(stream, frameKinds.hello, {
    jobId: input.migrationId,
    role: "target",
  });
  const hello = jsonPayload(await reader.expect()) as {
    jobId?: string;
    role?: string;
  };
  if (hello.jobId !== input.migrationId || hello.role !== "source")
    throw new Error("The other end is not this migration's source");

  const entries: ManifestEntry[] = [];
  let header: ManifestHeader | undefined;
  let rest = "";
  for (;;) {
    const frame = await reader.expect();
    if (frame.kind === frameKinds.manifestEnd) {
      header = jsonPayload(frame) as ManifestHeader;
      break;
    }
    if (frame.kind !== frameKinds.manifest)
      throw new Error(`Expected MANIFEST, got frame kind ${frame.kind}`);
    const lines = (rest + frame.payload.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines)
      if (line.trim()) entries.push(checkEntry(JSON.parse(line)));
  }
  if (rest.trim()) entries.push(checkEntry(JSON.parse(rest)));
  if (
    !header ||
    header.version !== 1 ||
    header.migrationId !== input.migrationId ||
    typeof header.roots !== "object"
  )
    throw new Error("The manifest header is not this migration's");
  checkManifest(header, entries);

  const dirs = new SafeDirectories();
  await mkdir(dirname(staging), { recursive: true });
  await dirs.ensure(staging, staging);
  await removeTree(join(staging, "parts"));
  await clearStale(staging, header, entries);
  await saveManifest(staging, header, entries);
  await dirs.ensure(staging, join(staging, "parts"));

  const received = await receivedFiles(staging);
  const needed = new Set<number>();
  let present = 0;
  let presentBytes = 0;
  for (const [index, entry] of entries.entries()) {
    const base = stagedRoot(staging, entry.root);
    const path = placeUnder(base, entry.path);
    if (entry.type === "dir") {
      await dirs.ensure(staging, path);
      continue;
    }
    if (entry.type !== "file") continue;
    const got = received.get(entryKey(entry));
    let held = false;
    if (got && got.sha256 === entry.sha256 && got.size === entry.size) {
      const stat = await lstat(path).catch(() => undefined);
      held = !!stat?.isFile() && stat.size === entry.size;
    }
    if (held) {
      await applyFileMetadata(path, entry);
      present += 1;
      presentBytes += entry.size;
    } else needed.add(index);
  }
  const totalFiles = present + needed.size;
  const totalBytes =
    presentBytes +
    [...needed].reduce((sum, index) => sum + entries[index]!.size, 0);
  const ordered = [...needed];
  for (let start = 0; start < ordered.length; start += 20_000)
    await writeFrame(
      stream,
      frameKinds.need,
      ordered.slice(start, start + 20_000),
    );
  await writeFrame(stream, frameKinds.needEnd);

  const log = await open(join(staging, "received.jsonl"), "a", 0o600);
  // Lost lines (a crash) only mean those files are asked for again.
  let pendingLog: string[] = [];
  const flushLog = async () => {
    if (!pendingLog.length) return;
    const lines = pendingLog.join("");
    pendingLog = [];
    await log.write(lines);
  };
  let files = present;
  let bytes = presentBytes;
  let receivedCount = 0;
  let failed = 0;
  let current:
    | {
        index: number;
        handle: FileHandle;
        part: string;
        hash: ReturnType<typeof createHash>;
        size: number;
      }
    | undefined;
  const dropCurrent = async () => {
    if (!current) return;
    await current.handle.close().catch(() => undefined);
    await rm(current.part, { force: true });
    current = undefined;
  };
  try {
    for (;;) {
      const frame = await reader.expect();
      if (frame.kind === frameKinds.done) break;
      if (frame.kind === frameKinds.fileBegin) {
        await dropCurrent();
        const { index } = jsonPayload(frame) as { index: number };
        if (!needed.has(index))
          throw new Error(
            `The source sent entry ${index}, which was not asked for`,
          );
        const part = join(staging, "parts", `${index}.part`);
        current = {
          index,
          part,
          handle: await open(part, "w", 0o600),
          hash: createHash("sha256"),
          size: 0,
        };
        continue;
      }
      if (frame.kind === frameKinds.data) {
        if (!current) throw new Error("File data outside a file");
        current.hash.update(frame.payload);
        current.size += frame.payload.length;
        await current.handle.write(frame.payload);
        bytes += frame.payload.length;
        input.onProgress?.({
          phase: "transferring",
          files,
          bytes,
          totalFiles,
          totalBytes,
        });
        continue;
      }
      if (frame.kind === frameKinds.fileFail) {
        await dropCurrent();
        failed += 1;
        continue;
      }
      if (frame.kind === frameKinds.fileEnd) {
        if (!current) throw new Error("A file ended that did not begin");
        const { index, part, handle, hash, size } = current;
        current = undefined;
        const entry = entries[index]!;
        const sha256 = hash.digest("hex");
        needed.delete(index);
        if (sha256 !== entry.sha256 || size !== entry.size) {
          // Changed on the source since its scan: the rescan finds it.
          await handle.close();
          await rm(part, { force: true });
          bytes -= size;
          failed += 1;
          continue;
        }
        await handle.chmod(entry.mode);
        await handle.utimes(mtime(entry), mtime(entry));
        await handle.close();
        const base = stagedRoot(staging, entry.root);
        const path = placeUnder(base, entry.path);
        await dirs.ensure(staging, dirname(path));
        try {
          await rename(part, path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EISDIR" && code !== "ENOTEMPTY" && code !== "EEXIST")
            throw error;
          await removeTree(path);
          await rename(part, path);
        }
        pendingLog.push(
          `${JSON.stringify({ root: entry.root, path: entry.path, size, sha256 })}\n`,
        );
        if (pendingLog.length >= 256) await flushLog();
        files += 1;
        receivedCount += 1;
        input.onProgress?.({
          phase: "transferring",
          files,
          bytes,
          totalFiles,
          totalBytes,
        });
        continue;
      }
      throw new Error(`Unexpected frame kind ${frame.kind}`);
    }
  } finally {
    await dropCurrent();
    await flushLog().catch(() => undefined);
    await log.close();
  }

  // Links, then folder times and modes, deepest first.
  for (const entry of entries) {
    if (entry.type !== "symlink") continue;
    const base = stagedRoot(staging, entry.root);
    const path = placeUnder(base, entry.path);
    await dirs.ensure(staging, dirname(path));
    const there = await lstat(path).catch(() => undefined);
    if (there?.isSymbolicLink() && (await readlink(path)) === entry.target)
      continue;
    if (there) await removeTree(path);
    await symlink(entry.target!, path);
  }
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "dir") continue;
    const path = placeUnder(stagedRoot(staging, entry.root), entry.path);
    await utimes(path, mtime(entry), mtime(entry)).catch(() => undefined);
    await chmod(path, entry.mode).catch(() => undefined);
  }
  const folderMode = header.roots.folder?.mode;
  if (
    typeof folderMode === "number" &&
    existsSync(stagedRoot(staging, "folder"))
  )
    await chmod(stagedRoot(staging, "folder"), (folderMode & 0o7777) | 0o700);
  await writeFrame(stream, frameKinds.ack, {
    received: receivedCount,
    failed,
    bytes,
  });
  stream.end();
  input.onProgress?.({
    phase: "received",
    files,
    bytes,
    totalFiles,
    totalBytes,
    manifestDigest: header.digest,
  });
  return { received: receivedCount, failed, bytes, digest: header.digest };
}

// --- Verify and abort ------------------------------------------------------

/** Rehashes the staging against the manifest it received. */
export async function verifyStaging(input: {
  migrationId: string;
  path: string;
}): Promise<WorkspaceMigrationVerifiedPayload> {
  const staging = stagingDir(expandPath(input.path), input.migrationId);
  const manifest = await loadManifest(staging);
  if (!manifest) throw new Error("No staged transfer for this migration");
  const mismatches: string[] = [];
  const note = (entry: Pick<ManifestEntry, "root" | "path">, why: string) => {
    if (mismatches.length < maxMismatches)
      mismatches.push(`${entry.root}:${entry.path} (${why})`);
  };
  let bad = 0;
  const files: ManifestEntry[] = [];
  for (const entry of manifest.entries) {
    const path = placeUnder(stagedRoot(staging, entry.root), entry.path);
    const stat = await lstat(path).catch(() => undefined);
    if (!stat) {
      bad += 1;
      note(entry, "missing");
    } else if (entry.type === "dir" && !stat.isDirectory()) {
      bad += 1;
      note(entry, "not a folder");
    } else if (entry.type === "symlink") {
      if (!stat.isSymbolicLink() || (await readlink(path)) !== entry.target) {
        bad += 1;
        note(entry, "link differs");
      }
    } else if (entry.type === "file") {
      if (!stat.isFile() || stat.size !== entry.size) {
        bad += 1;
        note(entry, "size differs");
        if (stat.isFile()) await rm(path, { force: true });
      } else files.push(entry);
    }
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < files.length) {
        const entry = files[next++]!;
        const path = placeUnder(stagedRoot(staging, entry.root), entry.path);
        const { sha256 } = await hashFile(path).catch(() => ({ sha256: "" }));
        if (sha256 !== entry.sha256) {
          bad += 1;
          note(entry, "content differs");
          // The next transfer asks for it again.
          await rm(path, { force: true });
        }
      }
    }),
  );
  const listed = new Set(manifest.entries.map(entryKey));
  const ancestors = ancestorDirs(manifest.entries);
  for (const root of Object.keys(manifest.header.roots)) {
    const prune = new Set<string>();
    for await (const { rel, type } of walkTree(
      stagedRoot(staging, root),
      prune,
    ))
      if (type === "dir" && ancestors.has(`${root}\n${rel}`)) continue;
      else if (!listed.has(`${root}\n${rel}`)) {
        prune.add(rel);
        bad += 1;
        note({ root, path: rel }, "not in the manifest");
      }
  }
  return {
    ok: bad === 0,
    manifestDigest: manifest.header.digest,
    mismatches,
  };
}

/** Drops the staging of one migration, nothing else. */
export async function abortStaging(input: {
  migrationId: string;
  path: string;
}): Promise<void> {
  const staging = stagingDir(expandPath(input.path), input.migrationId);
  await removeTree(staging);
}
