import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/** Called with the bytes received so far, and the total when known. */
export type DownloadProgress = (received: number, total?: number) => void;

/**
 * Downloads url (which must be under one of origins) to file through the
 * device's HTTP(S)_PROXY settings, refusing more than maxBytes.
 */
export async function downloadFile(
  url: string,
  file: string,
  options: { origins: string[]; maxBytes: number; onBytes?: DownloadProgress },
): Promise<void> {
  if (!options.origins.some((origin) => url.startsWith(`${origin}/`)))
    throw new Error(`refusing to download from ${new URL(url).origin}`);
  let response;
  try {
    response = await undiciFetch(url, {
      dispatcher: new EnvHttpProxyAgent(),
      signal: AbortSignal.timeout(8 * 60_000),
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    throw new Error(
      `could not download ${url}: ${cause?.message ?? (error as Error).message}`,
    );
  }
  if (!response.ok || !response.body)
    throw new Error(`could not download ${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  const total =
    Number.isFinite(declared) && declared > 0 ? declared : undefined;
  let size = 0;
  options.onBytes?.(0, total);
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      options.onBytes?.(size, total);
      done(
        size > options.maxBytes ? new Error("download is too large") : null,
        chunk,
      );
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as never),
    limit,
    createWriteStream(file, { mode: 0o600 }),
  );
}
