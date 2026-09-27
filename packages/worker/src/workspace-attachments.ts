// Attachment files of a workspace live on its device. The server relays them
// over the daemon channel in chunks and never touches the device's disk; this
// module owns the bytes and the only paths it will read or write.

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  fsyncSync,
  chmodSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** A refusal the server maps to an HTTP status; `code` is part of the wire. */
export class AttachmentError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "too_large"
      | "unsupported"
      | "invalid_path"
      | "out_of_order",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Chunks stay well below the daemon channel's 2 MiB message limit. */
export const attachmentChunkBytes = 1024 * 1024;

const imageSignatures: {
  mimeType: string;
  matches: (head: Buffer) => boolean;
}[] = [
  {
    mimeType: "image/png",
    matches: (h) =>
      h
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mimeType: "image/jpeg",
    matches: (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  },
  {
    mimeType: "image/gif",
    matches: (h) =>
      h.subarray(0, 6).toString("latin1") === "GIF87a" ||
      h.subarray(0, 6).toString("latin1") === "GIF89a",
  },
  {
    mimeType: "image/webp",
    matches: (h) =>
      h.subarray(0, 4).toString("latin1") === "RIFF" &&
      h.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

function attachmentsRoot(workspacePath: string): string {
  return resolve(workspacePath, ".foundry", "attachments");
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path !== "" &&
    !path.startsWith(`..${sep}`) &&
    path !== ".." &&
    !isAbsolute(path)
  );
}

/**
 * Appends one chunk of an upload. The first chunk (offset 0) starts a fresh
 * part file; the final chunk publishes it under `relativePath` atomically.
 */
export function writeAttachmentChunk(input: {
  workspacePath: string;
  relativePath: string;
  offset: number;
  data: Buffer;
  final: boolean;
}): { path: string; size: number } {
  const root = attachmentsRoot(input.workspacePath);
  const target = resolve(root, input.relativePath);
  if (!inside(root, target) || input.relativePath.includes("\0")) {
    throw new AttachmentError(
      "invalid_path",
      "attachment path is outside the workspace attachments",
    );
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  // The directory itself must not lead outside through a link.
  const realRoot = realpathSync(root);
  const realDirectory = realpathSync(dirname(target));
  if (realDirectory !== realRoot && !inside(realRoot, realDirectory)) {
    throw new AttachmentError(
      "invalid_path",
      "attachment path is outside the workspace attachments",
    );
  }
  const part = `${target}.part`;
  if (input.offset === 0) rmSync(part, { force: true });
  const fd = openSync(part, input.offset === 0 ? "wx" : "r+", 0o600);
  try {
    const size = fstatSync(fd).size;
    if (size !== input.offset) {
      throw new AttachmentError(
        "out_of_order",
        `attachment chunk at ${input.offset} does not follow ${size} bytes`,
      );
    }
    writeSync(fd, input.data, 0, input.data.length, input.offset);
    if (input.final) fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(part, { force: true });
    throw error;
  }
  closeSync(fd);
  const written = input.offset + input.data.length;
  if (!input.final) return { path: target, size: written };
  renameSync(part, target);
  chmodSync(target, 0o600);
  return { path: target, size: written };
}

/** Drops an upload that will not be finished. */
export function abortAttachmentUpload(
  workspacePath: string,
  relativePath: string,
): void {
  const root = attachmentsRoot(workspacePath);
  const target = resolve(root, relativePath);
  if (inside(root, target)) rmSync(`${target}.part`, { force: true });
}

/**
 * Reads one chunk of an image attachment. Only regular files under the
 * workspace's attachments, after resolving links, and only images qualify.
 */
export function readAttachmentImageChunk(input: {
  workspacePath: string;
  path: string;
  offset: number;
  maxBytes: number;
}): { size: number; mimeType: string; data: Buffer } {
  const root = attachmentsRoot(input.workspacePath);
  if (!isAbsolute(input.path) || !existsSync(root) || !existsSync(input.path)) {
    throw new AttachmentError("not_found", "image not found");
  }
  const target = realpathSync(input.path);
  if (!inside(realpathSync(root), target) || !statSync(target).isFile()) {
    throw new AttachmentError("not_found", "image not found");
  }
  const fd = openSync(target, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > input.maxBytes)
      throw new AttachmentError("too_large", "image is too large");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, head.length, 0);
    const mimeType = imageSignatures.find((item) =>
      item.matches(head),
    )?.mimeType;
    if (!mimeType)
      throw new AttachmentError("unsupported", "not a supported image");
    const length = Math.max(
      0,
      Math.min(attachmentChunkBytes, size - input.offset),
    );
    const data = Buffer.alloc(length);
    readSync(fd, data, 0, length, input.offset);
    return { size, mimeType, data };
  } finally {
    closeSync(fd);
  }
}
