/** Consume bytes incrementally so a slow original has visible progress. */
export type ReadProgress = { received: number; total?: number };
export async function readResponseBlob(
  response: Response,
  signal: AbortSignal,
  progress: (value: ReadProgress) => void,
): Promise<Blob> {
  const size = Number(response.headers?.get("Content-Length"));
  const total =
    size > 0 && !response.headers?.get("Content-Encoding") ? size : undefined;
  if (!response.body?.getReader) {
    const blob = await response.blob();
    signal.throwIfAborted();
    progress({ received: blob.size, total });
    return blob;
  }
  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let received = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      parts.push(Uint8Array.from(chunk.value).buffer);
      received += chunk.value.byteLength;
      progress({ received, total });
    }
    signal.throwIfAborted();
    return new Blob(parts, {
      type: response.headers?.get("Content-Type") || "application/octet-stream",
    });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
