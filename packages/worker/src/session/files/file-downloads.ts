/** Bounded raw reads. Callers validate the path using their existing read policy. */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type {
  FileDownloadChunk,
  FileDownloadRequest,
} from "@bd777/foundry-protocol";

export class FileDownloadError extends Error {
  constructor(
    readonly code: "invalid_offset" | "too_large" | "changed" | "not_found",
    message: string,
  ) {
    super(message);
  }
}
export function fileDownloadErrorCode(error: unknown): string {
  return error instanceof FileDownloadError ? error.code : "not_found";
}

export const fileDownloadChunkBytes = 64 * 1024;
export const maxFileDownloadBytes = 100 * 1024 * 1024;

export function readFileDownloadChunk(
  path: string,
  request: FileDownloadRequest,
): FileDownloadChunk {
  if (!Number.isSafeInteger(request.offset) || request.offset < 0)
    throw new FileDownloadError("invalid_offset", "invalid file offset");
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile())
      throw new FileDownloadError("not_found", "not a regular file");
    if (stat.size > maxFileDownloadBytes)
      throw new FileDownloadError(
        "too_large",
        "file exceeds the 100 MiB download limit",
      );
    if (request.offset > stat.size)
      throw new FileDownloadError(
        "invalid_offset",
        "file offset is past its end",
      );
    const revision = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (request.revision && request.revision !== revision)
      throw new FileDownloadError(
        "changed",
        "file changed during download; retry",
      );
    const data = Buffer.alloc(
      Math.min(fileDownloadChunkBytes, stat.size - request.offset),
    );
    let count = 0;
    while (count < data.length) {
      const read = readSync(
        fd,
        data,
        count,
        data.length - count,
        request.offset + count,
      );
      if (read === 0)
        throw new FileDownloadError(
          "changed",
          "file ended during download; retry",
        );
      count += read;
    }
    return {
      offset: request.offset,
      size: stat.size,
      revision,
      dataBase64: data.toString("base64"),
    };
  } finally {
    closeSync(fd);
  }
}
