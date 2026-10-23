/** Expanded packages authenticated by the server's revision content digest.
 * A disk marker, mtime or locally supplied manifest is never a trust root.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { SessionSkillRef } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";
import { writeFileAtomic } from "./storage.js";
import { unpackZip, type ZipEntry } from "./skill-zip.js";
import {
  fetchSkillPackage,
  type SkillPackageOptions,
} from "./skill-package-fetch.js";

const maxBytes = 256 * 1024 * 1024;
const maxFiles = 50_000;
const maxHeader = 16 * 1024 * 1024;
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Matches skillarchive.InspectStored (UTF-16 sort, path/NUL/size/NUL/bytes). */
export function skillContentDigest(files: ZipEntry[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  ))
    hash.update(`${file.path}\0${file.data.length}\0`).update(file.data);
  return hash.digest("hex");
}

function decode(bytes: Buffer, digest: string): ZipEntry[] {
  if (bytes.length < 4) throw new Error("Invalid expanded Skill cache.");
  const size = bytes.readUInt32LE(0);
  if (size > maxHeader || size + 4 > bytes.length)
    throw new Error("Invalid Skill cache header.");
  const header: unknown = JSON.parse(
    bytes.subarray(4, size + 4).toString("utf8"),
  );
  if (!Array.isArray(header) || header.length > maxFiles)
    throw new Error("Invalid Skill cache inventory.");
  let offset = size + 4;
  const names = new Set<string>();
  const files = header.map((entry): ZipEntry => {
    const { path, bytes: length } = entry ?? {};
    if (
      typeof path !== "string" ||
      /[\\\0:]/.test(path) ||
      path.split("/").some((p) => !p || p === "." || p === "..") ||
      names.has(path) ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      offset + length > bytes.length
    )
      throw new Error("Invalid Skill cache member.");
    names.add(path);
    const data = bytes.subarray(offset, offset + length);
    offset += length;
    return { path, data };
  });
  if (
    offset !== bytes.length ||
    offset - size - 4 > maxBytes ||
    !names.has("SKILL.md") ||
    skillContentDigest(files) !== digest
  )
    throw new Error("Skill cache contents changed.");
  return files;
}

function encode(files: ZipEntry[]): Buffer {
  const header = Buffer.from(
    JSON.stringify(files.map((f) => ({ path: f.path, bytes: f.data.length }))),
  );
  if (header.length > maxHeader)
    throw new Error("Skill cache inventory exceeds limit.");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.length);
  return Buffer.concat([size, header, ...files.map((f) => f.data)]);
}

export interface SkillContentOptions extends SkillPackageOptions {
  onDownload?: (ref: SessionSkillRef) => void | Promise<void>;
}

export interface PreparedSkillContent {
  files: ZipEntry[];
  source: "expanded-cache" | "archive-cache" | "download";
  verifyMs: number;
  downloadMs: number;
  unpackMs: number;
}

async function prepare(
  serverURL: string,
  ref: SessionSkillRef,
  options: SkillContentOptions,
): Promise<PreparedSkillContent> {
  options.signal?.throwIfAborted();
  if (
    !/^[a-f0-9]{64}$/.test(ref.checksum) ||
    !Number.isSafeInteger(ref.byteSize) ||
    ref.byteSize < 0 ||
    ref.byteSize > 64 * 1024 * 1024 ||
    (ref.sourceDigest && !/^[a-f0-9]{64}$/.test(ref.sourceDigest))
  )
    throw new Error(`invalid skill checksum or size for ${ref.skillId}`);
  const started = performance.now();
  const expanded = foundryStatePath("skill-content", `${ref.checksum}.bin`);
  if (ref.sourceDigest) {
    try {
      const stat = lstatSync(expanded);
      if (!stat.isFile() || stat.size > maxBytes + maxHeader + 4)
        throw new Error("Invalid Skill cache size.");
      const files = decode(readFileSync(expanded), ref.sourceDigest);
      return {
        files,
        source: "expanded-cache",
        verifyMs: performance.now() - started,
        downloadMs: 0,
        unpackMs: 0,
      };
    } catch {
      // A missing or corrupt derived cache is rebuilt from an authenticated ZIP.
    }
  }
  const archive = foundryStatePath("skill-archives", `${ref.checksum}.zip`);
  let zip: Buffer | undefined;
  try {
    const stat = lstatSync(archive);
    if (stat.isFile() && stat.size === ref.byteSize) {
      const bytes = readFileSync(archive);
      if (sha(bytes) === ref.checksum) zip = bytes;
    }
  } catch {
    /* First installation. */
  }
  const verifyMs = performance.now() - started;
  let downloadMs = 0;
  const source = zip ? "archive-cache" : "download";
  if (!zip) {
    const start = performance.now();
    await options.onDownload?.(ref);
    zip = await fetchSkillPackage(serverURL, ref, options);
    options.signal?.throwIfAborted();
    writeFileAtomic(archive, zip);
    downloadMs = performance.now() - start;
  }
  const unpackStart = performance.now();
  const files = unpackZip(zip, { allowLegacyCrc: true, maxBytes, maxFiles });
  if (!files.some((f) => f.path === "SKILL.md"))
    throw new Error(`promoted skill ${ref.skillId} is missing a root SKILL.md`);
  if (ref.sourceDigest) {
    if (skillContentDigest(files) !== ref.sourceDigest)
      throw new Error(`expanded content digest mismatch for ${ref.skillId}`);
    writeFileAtomic(expanded, encode(files));
  }
  return {
    files,
    source,
    verifyMs,
    downloadMs,
    unpackMs: performance.now() - unpackStart,
  };
}

interface Consumer {
  onRetry?: SkillPackageOptions["onRetry"];
  onDownload?: SkillContentOptions["onDownload"];
}
interface Job {
  controller: AbortController;
  consumers: Set<Consumer>;
  promise: Promise<PreparedSkillContent>;
}
const pending = new Map<string, Job>();

/** Join in-flight work; only the last consumer leaving cancels the download. */
export function prepareSkillContent(
  serverURL: string,
  ref: SessionSkillRef,
  options: SkillContentOptions = {},
): Promise<PreparedSkillContent> {
  options.signal?.throwIfAborted();
  const key = JSON.stringify([
    foundryStatePath("skill-content"),
    serverURL,
    ref.checksum,
    ref.byteSize,
    ref.sourceDigest,
  ]);
  let job = pending.get(key);
  if (!job) {
    const controller = new AbortController(),
      consumers = new Set<Consumer>();
    job = {
      controller,
      consumers,
      promise: Promise.resolve().then(() =>
        prepare(serverURL, ref, {
          signal: controller.signal,
          onDownload: async (ref) => {
            await Promise.allSettled(
              [...consumers].map((c) =>
                Promise.resolve().then(() => c.onDownload?.(ref)),
              ),
            );
          },
          onRetry: async (message) => {
            await Promise.allSettled(
              [...consumers].map((c) =>
                Promise.resolve().then(() => c.onRetry?.(message)),
              ),
            );
          },
        }),
      ),
    };
    pending.set(key, job);
    const created = job;
    void job.promise
      .finally(() => {
        if (pending.get(key) === created) pending.delete(key);
      })
      .catch(() => {});
  }
  const shared = job,
    consumer = { onRetry: options.onRetry, onDownload: options.onDownload };
  shared.consumers.add(consumer);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      shared.consumers.delete(consumer);
      if (!shared.consumers.size && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
    };
    const abort = () => {
      cleanup();
      reject(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    shared.promise.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
