import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EnvHttpProxyAgent, fetch as undiciFetch, type Response } from "undici";

/** Called with the bytes received so far, and the total when known. */
export type DownloadProgress = (received: number, total?: number) => void;

const connectAttempts = 3;

/**
 * fetch through the device's HTTP(S)_PROXY settings, trying the connection
 * again when it fails before any answer (a connect timeout on a flaky route);
 * an HTTP answer, whatever its status, is returned as it is.
 */
export async function fetchRetrying(
  url: string,
  init: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    redirect?: "follow" | "manual";
  } = {},
  attempts = connectAttempts,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await undiciFetch(url, {
        ...init,
        dispatcher: new EnvHttpProxyAgent(),
      });
    } catch (error) {
      if (attempt >= attempts || init.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
}

/** The network's reason for a failed fetch. */
export function failureText(error: unknown): string {
  const cause = (error as { cause?: { message?: string } }).cause;
  return cause?.message ?? (error as Error).message;
}

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
    response = await fetchRetrying(url, {
      signal: AbortSignal.timeout(8 * 60_000),
    });
  } catch (error) {
    throw new Error(`could not download ${url}: ${failureText(error)}`);
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
