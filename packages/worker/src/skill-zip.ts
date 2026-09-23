/**
 * Minimal, dependency-free ZIP handling for promoted skills.
 *
 * Writing uses built-in deflate compression for text-heavy skill trees.
 * Reading supports both store and deflate; old packages remain compatible.
 */

import { inflateRawSync, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Archive-relative path, always with forward slashes. */
  path: string;
  data: Buffer;
}

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i] ?? 0;
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Compatibility only for already SHA-256-verified historical revisions.
function legacyCrc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer)
    crc = (CRC_TABLE[(crc ^ byte) >>> 0] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Serialize a deterministic single-disk ZIP, compressing when smaller. */
export function packZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  if (entries.length > 0xffff)
    throw new Error("ZIP entry count exceeds ZIP32 capacity");
  for (const entry of entries) {
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const payload =
      compressed.length < entry.data.length ? compressed : entry.data;
    const method = payload === compressed ? 8 : 0;
    const name = Buffer.from(entry.path, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_HEADER, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs (regular file)
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const chunk of centralChunks) centralSize += chunk.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);

  return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

export interface UnzipOptions {
  /** Enable only after verifying the archive against a trusted SHA-256. */
  allowLegacyCrc?: boolean;
  maxBytes: number;
  maxFiles: number;
}

/**
 * Parse a zip via its central directory and validate every entry against
 * extraction safety rules before returning bytes. Nothing is written to disk.
 */
export function unpackZip(zip: Buffer, options: UnzipOptions): ZipEntry[] {
  if (zip.length > options.maxBytes * 4) {
    throw new Error("skill package exceeds size bound");
  }
  const eocd = findEndOfCentralDirectory(zip);
  let cursor = eocd.centralOffset;
  const entries: ZipEntry[] = [];
  let totalBytes = 0;

  for (let i = 0; i < eocd.entryCount; i++) {
    if (
      cursor + 46 > zip.length ||
      zip.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_HEADER
    ) {
      throw new Error("malformed skill package: bad central directory entry");
    }
    const method = zip.readUInt16LE(cursor + 10);
    const expectedCrc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const externalAttributes = zip.readUInt32LE(cursor + 38);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue; // directory marker
    assertSafeEntryPath(name);
    // Unix mode lives in the high 16 bits; reject symlinks/special files.
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    if (unixMode !== 0 && (unixMode & 0xf000) !== 0x8000) {
      throw new Error(`skill package contains a non-regular file: ${name}`);
    }
    if (uncompressedSize > options.maxBytes - totalBytes) {
      throw new Error("skill package member exceeds size bound");
    }

    if (localOffset + 30 > zip.length) {
      throw new Error("malformed skill package: bad local header offset");
    }
    if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new Error("malformed skill package: missing local header");
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else if (method === 8) {
      data = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, options.maxBytes - totalBytes),
      });
    } else {
      throw new Error(`skill package uses unsupported compression ${method}`);
    }
    if (data.length !== uncompressedSize) {
      throw new Error(`skill package member length mismatch: ${name}`);
    }
    if (
      crc32(data) !== expectedCrc &&
      !(options.allowLegacyCrc && legacyCrc32(data) === expectedCrc)
    ) {
      throw new Error(`skill package checksum mismatch: ${name}`);
    }
    totalBytes += data.length;
    entries.push({ path: name, data });
    if (entries.length > options.maxFiles) {
      throw new Error("skill package exceeds file count bound");
    }
  }

  const total = entries.reduce((sum, entry) => sum + entry.data.length, 0);
  if (total > options.maxBytes) {
    throw new Error("skill package exceeds total size bound");
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer): {
  centralOffset: number;
  entryCount: number;
} {
  // The EOCD record has a 22-byte fixed tail and at most 65535 comment bytes.
  const maxStart = Math.max(0, zip.length - 22 - 0xffff);
  for (let pos = zip.length - 22; pos >= maxStart; pos--) {
    if (zip.readUInt32LE(pos) === END_OF_CENTRAL_DIRECTORY) {
      return {
        entryCount: zip.readUInt16LE(pos + 10),
        centralOffset: zip.readUInt32LE(pos + 16),
      };
    }
  }
  throw new Error("malformed skill package: no end of central directory");
}

/** Reject absolute paths, drive letters, backslashes and `..` traversal. */
export function assertSafeEntryPath(name: string): void {
  if (name.includes("\\")) {
    throw new Error(`skill package uses backslash paths: ${name}`);
  }
  if (name.startsWith("/") || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`skill package contains an absolute path: ${name}`);
  }
  const parts = name.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`skill package escapes its root: ${name}`);
  }
}
