/**
 * The source side of a workspace migration (DEV-146): scanning and keeping
 * the manifest, rescanning it for changes, and sending what the target
 * asks for over the migration stream.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import type {
  WorkspaceMigrationRescannedPayload,
  WorkspaceMigrationScannedPayload,
} from "@bd777/foundry-protocol";
import {
  FrameReader,
  frameKinds,
  jsonPayload,
  maxFramePayload,
  writeFrame,
} from "./framing.js";
import {
  canonicalEntry,
  entryKey,
  loadManifest,
  migrationStateDir,
  saveManifest,
  type ManifestEntry,
  type StoredManifest,
} from "./manifest.js";
import { readFileChunks, scanWorkspace, type ScanInput } from "./scan.js";
import type { TransferProgress } from "./target.js";

const maxChanges = 50;
const dataChunk = 256 * 1024;

export interface SourceOptions {
  /** Where the manifest is kept; the migration's state folder by default. */
  stateDir?: string;
}

function stateDirFor(input: ScanInput, options: SourceOptions): string {
  return options.stateDir ?? migrationStateDir(input.migrationId);
}

/** Scans the workspace and keeps the manifest for the transfer. */
export async function scanForMigration(
  input: ScanInput,
  options: SourceOptions = {},
): Promise<WorkspaceMigrationScannedPayload> {
  const scan = await scanWorkspace(input);
  await saveManifest(stateDirFor(input, options), scan.header, scan.entries);
  return {
    files: scan.header.files,
    bytes: scan.header.bytes,
    manifestDigest: scan.header.digest,
    warnings: scan.warnings,
  };
}

/**
 * Scans again and compares with the kept manifest; a changed workspace's
 * new manifest replaces it, so the next transfer sends the difference.
 */
export async function rescanForMigration(
  input: ScanInput,
  options: SourceOptions = {},
): Promise<WorkspaceMigrationRescannedPayload> {
  const dir = stateDirFor(input, options);
  const before = await loadManifest(dir);
  const scan = await scanWorkspace(input);
  const changed = before?.header.digest !== scan.header.digest;
  const changes: string[] = [];
  if (changed && before) {
    const earlier = new Map(
      before.entries.map((entry) => [entryKey(entry), canonicalEntry(entry)]),
    );
    for (const entry of scan.entries) {
      const key = entryKey(entry);
      if (
        earlier.get(key) !== canonicalEntry(entry) &&
        changes.length < maxChanges
      )
        changes.push(`${entry.root}:${entry.path}`);
      earlier.delete(key);
    }
    for (const key of earlier.keys()) {
      if (changes.length >= maxChanges) break;
      changes.push(key.replace("\n", ":"));
    }
  }
  if (changed) await saveManifest(dir, scan.header, scan.entries);
  return { manifestDigest: scan.header.digest, changed, changes };
}

/** The kept manifest, or a new scan when there is none for this folder. */
export async function manifestForTransfer(
  input: ScanInput,
  options: SourceOptions = {},
): Promise<StoredManifest> {
  const dir = stateDirFor(input, options);
  const kept = await loadManifest(dir);
  if (
    kept &&
    kept.header.workspaceId === input.workspaceId &&
    kept.header.folder === resolve(input.path)
  )
    return kept;
  const scan = await scanWorkspace(input);
  await saveManifest(dir, scan.header, scan.entries);
  return { header: scan.header, entries: scan.entries };
}

function entryPath(manifest: StoredManifest, entry: ManifestEntry): string {
  const root = manifest.header.roots[entry.root];
  if (!root) throw new Error(`Manifest root ${entry.root} is not recorded`);
  return join(root.path, ...entry.path.split("/"));
}

/**
 * Runs the source half of the frame protocol on a stream: HELLO, the
 * manifest, the files the target needs, DONE; resolves on the target's ACK.
 */
export async function runSource(
  stream: Duplex,
  manifest: StoredManifest,
  options: { onProgress?: (progress: TransferProgress) => void } = {},
): Promise<{ sent: number; bytes: number }> {
  const { header, entries } = manifest;
  const reader = new FrameReader(stream);
  await writeFrame(stream, frameKinds.hello, {
    jobId: header.migrationId,
    role: "source",
  });
  const hello = jsonPayload(await reader.expect()) as {
    jobId?: string;
    role?: string;
  };
  if (hello.jobId !== header.migrationId || hello.role !== "target")
    throw new Error("The other end is not this migration's target");

  options.onProgress?.({
    phase: "manifest",
    files: 0,
    bytes: 0,
    totalFiles: header.files,
    totalBytes: header.bytes,
  });
  let chunk: string[] = [];
  let chunkBytes = 0;
  const flush = async () => {
    if (!chunk.length) return;
    await writeFrame(stream, frameKinds.manifest, Buffer.from(chunk.join("")));
    chunk = [];
    chunkBytes = 0;
  };
  for (const entry of entries) {
    const line = `${JSON.stringify(entry)}\n`;
    const size = Buffer.byteLength(line);
    if (chunkBytes + size > maxFramePayload / 2) await flush();
    chunk.push(line);
    chunkBytes += size;
  }
  await flush();
  await writeFrame(stream, frameKinds.manifestEnd, header);

  const needed: number[] = [];
  for (;;) {
    const frame = await reader.expect();
    if (frame.kind === frameKinds.needEnd) break;
    if (frame.kind !== frameKinds.need)
      throw new Error(`Expected NEED, got frame kind ${frame.kind}`);
    for (const index of jsonPayload(frame) as unknown[]) {
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        entries[index]?.type !== "file"
      )
        throw new Error("The target asked for an entry that is not a file");
      needed.push(index);
    }
  }

  const totalFiles = needed.length;
  const totalBytes = needed.reduce(
    (sum, index) => sum + entries[index]!.size,
    0,
  );
  let sent = 0;
  let bytes = 0;
  for (const index of needed) {
    const entry = entries[index]!;
    const hash = createHash("sha256");
    let size = 0;
    let begun = false;
    try {
      for await (const data of readFileChunks(
        entryPath(manifest, entry),
        dataChunk,
      )) {
        if (!begun) {
          await writeFrame(stream, frameKinds.fileBegin, { index });
          begun = true;
        }
        hash.update(data);
        size += data.length;
        bytes += data.length;
        // The chunk's buffer is read into again: the frame copies it.
        await writeFrame(stream, frameKinds.data, data);
        options.onProgress?.({
          phase: "transferring",
          files: sent,
          bytes,
          totalFiles,
          totalBytes,
        });
      }
      if (!begun) {
        await writeFrame(stream, frameKinds.fileBegin, { index });
        begun = true;
      }
    } catch (error) {
      if (stream.destroyed) throw error;
      if (begun) bytes -= size;
      await writeFrame(stream, frameKinds.fileFail, {
        index,
        error: (error as Error).message,
      });
      continue;
    }
    if (!begun) continue;
    await writeFrame(stream, frameKinds.fileEnd, {
      index,
      sha256: hash.digest("hex"),
      size,
    });
    sent += 1;
  }
  await writeFrame(stream, frameKinds.done, { sent, bytes });
  const ack = await reader.expect();
  if (ack.kind !== frameKinds.ack)
    throw new Error(`Expected ACK, got frame kind ${ack.kind}`);
  stream.end();
  options.onProgress?.({
    phase: "sent",
    files: sent,
    bytes,
    totalFiles,
    totalBytes,
  });
  return { sent, bytes };
}
