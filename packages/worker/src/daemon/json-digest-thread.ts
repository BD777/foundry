import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { errorMessage } from "../platform/utils.js";

interface JsonDigestJob {
  operation: "digest" | "gzip";
  value: unknown;
  length: number;
}

const gzipAsync = promisify(gzip);

/** Serializes and hashes unusually large daemon answers away from its loop. */
export function jsonDigestInThread(
  value: unknown,
  length = 32,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: [],
      workerData: {
        operation: "digest",
        value,
        length,
      } satisfies JsonDigestJob,
    });
    worker.once("message", (message: { digest?: string; error?: string }) => {
      if (message.error) reject(new Error(message.error));
      else resolve(message.digest ?? "");
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`JSON digest worker exited ${code}`));
    });
  });
}

/** Serializes and compresses an attachment preview away from its event loop. */
export function gzipJSONInThread(value: unknown): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: [],
      workerData: {
        operation: "gzip",
        value,
        length: 0,
      } satisfies JsonDigestJob,
    });
    worker.once(
      "message",
      (message: { data?: ArrayBuffer; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        else resolve(message.data ?? new ArrayBuffer(0));
      },
    );
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`JSON worker exited ${code}`));
    });
  });
}

async function runJob(job: JsonDigestJob): Promise<Record<string, unknown>> {
  if (job.operation === "gzip") {
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(job.value)));
    return {
      data: compressed.buffer.slice(
        compressed.byteOffset,
        compressed.byteOffset + compressed.byteLength,
      ),
    };
  }
  return {
    digest: createHash("sha256")
      .update(JSON.stringify(job.value))
      .digest("base64url")
      .slice(0, job.length),
  };
}

const workerPort = parentPort;
if (!isMainThread && workerPort && workerData?.operation) {
  void runJob(workerData as JsonDigestJob)
    .then((message) => workerPort.postMessage(message))
    .catch((error: unknown) =>
      workerPort.postMessage({ error: errorMessage(error) }),
    );
}
