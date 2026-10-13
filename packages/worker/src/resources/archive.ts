// Unpacking an uploaded tar (optionally gzipped) or zip into a folder, for
// compute's put_files. Read here rather than by a system tar or unzip so
// every entry is checked before it touches the disk, the same on every
// platform: no absolute paths, no "..", nothing written through a link that
// leaves the folder, links only to places inside it, no device files, and
// bounded sizes (an archive bomb stops at the limit).

import { gunzipSync, inflateRawSync } from "node:zlib";
import {
  lstat,
  mkdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, sep } from "node:path";

export type ArchiveFormat = "tar" | "tar.gz" | "zip";

export interface ArchiveLimits {
  /** Total bytes the entries may unpack to. */
  maxBytes: number;
  maxEntries: number;
}

export const defaultArchiveLimits: ArchiveLimits = {
  maxBytes: 1024 ** 3,
  maxEntries: 200_000,
};

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

interface Entry {
  name: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  data?: Buffer;
  linkTarget?: string;
}

/** Unpacks archive into dest (which must exist); answers files written. */
export async function unpackArchive(
  archive: Buffer,
  format: ArchiveFormat,
  dest: string,
  limits: ArchiveLimits = defaultArchiveLimits,
): Promise<number> {
  const entries =
    format === "zip"
      ? zipEntries(archive, limits)
      : tarEntries(
          format === "tar.gz" || isGzip(archive)
            ? gunzipSync(archive, { maxOutputLength: limits.maxBytes })
            : archive,
          limits,
        );
  const root = await realpath(dest);
  let files = 0;
  for (const entry of entries) {
    const target = entryTarget(root, entry.name);
    if (target === root) continue;
    await ensureFolder(root, dirname(target), entry.name);
    const existing = await lstat(target).catch(() => undefined);
    if (entry.kind === "directory") {
      if (existing?.isSymbolicLink()) await unlink(target);
      if (!existing?.isDirectory()) await mkdir(target, { recursive: true });
      continue;
    }
    if (existing?.isDirectory())
      throw new ArchiveError(`${entry.name} is a folder on the device`);
    if (existing) await unlink(target);
    if (entry.kind === "symlink") {
      const link = entry.linkTarget ?? "";
      if (!link || isAbsolute(link) || isAbsolute(posix.normalize(link)))
        throw new ArchiveError(`${entry.name} links to an absolute path`);
      const resolved = resolve(dirname(target), link);
      if (resolved !== root && !resolved.startsWith(root + sep))
        throw new ArchiveError(`${entry.name} links outside the folder`);
      await symlink(link, target);
      continue;
    }
    await writeFile(target, entry.data ?? Buffer.alloc(0), {
      mode: entry.mode & 0o111 ? 0o755 : 0o644,
    });
    files++;
  }
  return files;
}

function isGzip(data: Buffer): boolean {
  return data.length > 2 && data[0] === 0x1f && data[1] === 0x8b;
}

/** Where an entry goes; refuses names that leave the folder. */
function entryTarget(root: string, name: string): string {
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized))
    throw new ArchiveError(`${name} is an absolute path`);
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (parts.includes(".."))
    throw new ArchiveError(`${name} goes up out of the folder`);
  return resolve(root, ...parts);
}

/**
 * Creates folder under root, refusing first when its nearest existing
 * ancestor is a link out of root, so nothing is created outside.
 */
async function ensureFolder(
  root: string,
  folder: string,
  name: string,
): Promise<void> {
  let existing = folder;
  for (;;) {
    const real = await realpath(existing).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    if (real !== undefined) {
      if (real !== root && !real.startsWith(root + sep))
        throw new ArchiveError(`${name} would be written outside the folder`);
      break;
    }
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  await mkdir(folder, { recursive: true });
}

// --- tar ----------------------------------------------------------------

function tarEntries(data: Buffer, limits: ArchiveLimits): Entry[] {
  const entries: Entry[] = [];
  let offset = 0;
  let total = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarNumber(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]!);
    const body = offset + 512;
    if (body + size > data.length)
      throw new ArchiveError("the tar archive is cut short");
    const content = data.subarray(body, body + size);
    offset = body + Math.ceil(size / 512) * 512;
    switch (type) {
      case "x":
        pax = parsePax(content);
        continue;
      case "g":
        continue;
      case "L":
        longName = cString(content);
        continue;
      case "K":
        longLink = cString(content);
        continue;
    }
    const prefix = cString(header.subarray(345, 500));
    const shortName = cString(header.subarray(0, 100));
    const name =
      pax.path ?? longName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const linkTarget =
      pax.linkpath ?? longLink ?? cString(header.subarray(157, 257));
    pax = {};
    longName = longLink = undefined;
    const mode = tarNumber(header.subarray(100, 108));
    if (++total > limits.maxEntries)
      throw new ArchiveError(`more than ${limits.maxEntries} entries`);
    switch (type) {
      case "0":
      case "\0":
      case "7":
        entries.push({ name, kind: "file", mode, data: Buffer.from(content) });
        break;
      case "5":
        entries.push({ name, kind: "directory", mode });
        break;
      case "2":
        entries.push({ name, kind: "symlink", mode, linkTarget });
        break;
      case "1":
        throw new ArchiveError(
          `${name} is a hard link; pack the file itself instead`,
        );
      default:
      // Devices, fifos and vendor entries are skipped.
    }
  }
  return entries;
}

/** A tar number field: octal text, or base-256 when its top bit is set. */
function tarNumber(field: Buffer): number {
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = cString(field).trim();
  return text ? parseInt(text, 8) : 0;
}

function cString(field: Buffer): string {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

/** Pax records: "<length> <key>=<value>\n". */
function parsePax(content: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(content.subarray(offset, space).toString(), 10);
    if (!length) break;
    const record = content
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

// --- zip ----------------------------------------------------------------

function zipEntries(data: Buffer, limits: ArchiveLimits): Entry[] {
  const end = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new ArchiveError("zip64 archives are not supported; use tar.gz");
  if (count > limits.maxEntries)
    throw new ArchiveError(`more than ${limits.maxEntries} entries`);
  const entries: Entry[] = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50)
      throw new ArchiveError("the zip archive's directory is damaged");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const attributes = data.readUInt32LE(offset + 38);
    const local = data.readUInt32LE(offset + 42);
    const name = data
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString("utf8");
    offset += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new ArchiveError(`${name} is encrypted`);
    const unixMode = attributes >>> 16;
    if (name.endsWith("/")) {
      entries.push({ name, kind: "directory", mode: unixMode & 0o777 });
      continue;
    }
    total += size;
    if (total > limits.maxBytes)
      throw new ArchiveError(
        `it unpacks to more than ${limits.maxBytes} bytes`,
      );
    if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50)
      throw new ArchiveError(`${name}: the zip archive is damaged`);
    const start =
      local +
      30 +
      data.readUInt16LE(local + 26) +
      data.readUInt16LE(local + 28);
    const stored = data.subarray(start, start + compressedSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(stored);
    else if (method === 8)
      content = inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) });
    else
      throw new ArchiveError(`${name} uses zip method ${method}; use deflate`);
    if (content.length !== size)
      throw new ArchiveError(`${name}: the zip archive is damaged`);
    if ((unixMode & 0o170000) === 0o120000)
      entries.push({
        name,
        kind: "symlink",
        mode: 0,
        linkTarget: content.toString("utf8"),
      });
    else
      entries.push({
        name,
        kind: "file",
        mode: unixMode & 0o777,
        data: content,
      });
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer): number {
  const lowest = Math.max(0, data.length - 22 - 0xffff);
  for (let offset = data.length - 22; offset >= lowest; offset--)
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  throw new ArchiveError("not a zip archive");
}
