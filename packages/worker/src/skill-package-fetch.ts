import { serverFetch } from "./server-proxy.js";
/** Fixed-revision Skill archives only. Never retries model or mutation requests. */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionSkillRef } from "@bd777/foundry-protocol";
import { daemonRequestHeaders } from "./server-http.js";

export interface SkillPackageOptions {
  signal?: AbortSignal;
  onRetry?: (message: string) => void | Promise<void>;
}

const connectionCodes = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

// Keep classification, not arbitrary messages that can contain auth headers.
function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      code?: unknown;
      name?: unknown;
      cause?: unknown;
    };
    if (
      typeof value.code === "string" &&
      /^[A-Z][A-Z0-9_]{1,63}$/.test(value.code)
    )
      codes.push(value.code);
    if (value.name === "AbortError" || value.name === "TimeoutError")
      codes.push(value.name);
    current = value.cause;
  }
  return codes;
}

export async function fetchSkillPackage(
  serverURL: string,
  ref: SessionSkillRef,
  options: SkillPackageOptions = {},
): Promise<Buffer> {
  const path = `/api/skills/catalog/${encodeURIComponent(ref.skillId)}/revisions/${ref.revision}/package`;
  const url = new URL(`${serverURL}${path}`);
  const safeURL = new URL(url);
  safeURL.username = safeURL.password = safeURL.search = safeURL.hash = "";
  const target = `GET ${safeURL.href} (Skill ${ref.skillId}, revision ${ref.revision})`;
  let response!: Response;
  let buffer!: Buffer;
  for (let attempt = 1; attempt <= 2; attempt++) {
    options.signal?.throwIfAborted();
    try {
      response = await serverFetch(url, {
        headers: daemonRequestHeaders(false),
        signal: options.signal,
      });
      if (response.ok) buffer = Buffer.from(await response.arrayBuffer());
      break;
    } catch (cause) {
      options.signal?.throwIfAborted();
      const codes = errorCodes(cause);
      const detail =
        codes.join(" <- ") ||
        (cause instanceof TypeError ? "TypeError" : "network error");
      const failure = new Error(
        `Skill preparation before agent startup: ${target} failed on attempt ${attempt}/2 (${detail}).`,
        { cause },
      );
      const retryable =
        !codes.some(
          (code) => code === "AbortError" || code === "TimeoutError",
        ) && codes.some((code) => connectionCodes.has(code));
      if (attempt === 2 || !retryable) throw failure;
      await (options.onRetry ?? console.warn)(
        `${failure.message} Retrying this read-only package download once.`,
      );
      await delay(250, undefined, { signal: options.signal });
    }
  }
  options.signal?.throwIfAborted();
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Skill preparation before agent startup: ${target} returned HTTP ${response.status}; not retried.`,
    );
  }
  const checksumHeader = response.headers.get("X-Foundry-Skill-Checksum") ?? "";
  const actual = createHash("sha256").update(buffer).digest("hex");
  if (checksumHeader && checksumHeader !== ref.checksum)
    throw new Error(`skill checksum disagreement for ${ref.skillId}`);
  if (actual !== ref.checksum)
    throw new Error(`skill package checksum mismatch for ${ref.skillId}`);
  if (buffer.length !== ref.byteSize)
    throw new Error(`skill package size mismatch for ${ref.skillId}`);
  return buffer;
}
