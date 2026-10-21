import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
} from "node:fs";
import { join } from "node:path";

export const instructionFileNames = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "README",
  "README.markdown",
  "README.txt",
]);
const cache = new Map<string, { stamp: string; revision: string }>();
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Content identity only; no instruction text leaves this device. Links are
 * identified without following them, and reads are bounded to 256 KiB. */
export function instructionFileRevision(
  root: string,
  name: string,
  refresh = false,
): string | undefined {
  if (!instructionFileNames.has(name)) return undefined;
  const path = join(root, name);
  try {
    const stat = lstatSync(path, { bigint: true });
    const stamp = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeNs,
      stat.ctimeNs,
      stat.mode,
    ].join(":");
    const known = cache.get(path);
    if (!refresh && known?.stamp === stamp) return known.revision;
    let revision: string;
    if (stat.isSymbolicLink()) revision = `link:${hash(readlinkSync(path))}`;
    else if (!stat.isFile()) revision = `nonfile:${stamp}`;
    else if (stat.size > 256n * 1024n) revision = `oversized:${stamp}`;
    else {
      const fd = openSync(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (
          !opened.isFile() ||
          opened.size > 256n * 1024n ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev
        )
          return "changed-during-read";
        const buffer = Buffer.alloc(256 * 1024 + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(
            fd,
            buffer,
            length,
            buffer.length - length,
            null,
          );
          if (!count) break;
          length += count;
        }
        revision =
          length > 256 * 1024
            ? `oversized:${stamp}`
            : `sha256:${hash(buffer.subarray(0, length))}`;
      } finally {
        closeSync(fd);
      }
    }
    cache.set(path, { stamp, revision });
    if (cache.size > 4096) cache.delete(cache.keys().next().value!);
    return revision;
  } catch (error) {
    cache.delete(path);
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : `unreadable:${code ?? "unknown"}`;
  }
}

export function instructionEntriesRevision(
  entries: readonly { path: string; revision?: string }[],
): string {
  return entries
    .filter((e) => instructionFileNames.has(e.path) && e.revision)
    .map((e) => `${e.path}=${e.revision}`)
    .sort()
    .join("\n");
}

export function workspaceInstructionRevision(root: string): string {
  return instructionEntriesRevision(
    [...instructionFileNames].map((path) => ({
      path,
      revision: instructionFileRevision(root, path, true),
    })),
  );
}
