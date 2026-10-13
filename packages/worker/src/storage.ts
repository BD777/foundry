import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

export function hardenPrivateFile(path: string): void {
  const parent = dirname(path);
  if (existsSync(parent)) {
    chmodSync(parent, privateDirectoryMode);
  }
  if (existsSync(path)) {
    chmodSync(path, privateFileMode);
  }
}

/** The JSON at path; undefined when there is no file. Malformed JSON throws. */
export function readJSONFile<T>(path: string): T | undefined {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as T)
    : undefined;
}

/** The JSON at path; undefined when it is missing, unreadable or malformed. */
export function tryReadJSONFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export interface AtomicWriteOptions {
  /** The file's mode; owner-only by default. */
  mode?: number;
  /** The mode a missing parent folder is created with; owner-only by default. */
  directoryMode?: number;
  /**
   * Brings an existing parent folder to directoryMode too (default). Off for
   * folders written often or not Foundry's own to restrict.
   */
  hardenParent?: boolean;
  /** Flushes the file to disk before it replaces the old one (default). */
  fsync?: boolean;
  /** Keeps a file already at path. */
  exclusive?: boolean;
}

/**
 * Replaces path atomically: readers see the old or the new file, never half
 * of one. The defaults suit Foundry's private state.
 */
export function writeFileAtomic(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): void {
  const {
    mode = privateFileMode,
    directoryMode = privateDirectoryMode,
    hardenParent = true,
    fsync = true,
  } = options;
  const parent = dirname(path);
  mkdirSync(parent, { mode: directoryMode, recursive: true });
  if (hardenParent) chmodSync(parent, directoryMode);

  const target = resolve(path);
  const tempPath = resolve(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", mode);
    writeFileSync(descriptor, contents);
    if (fsync) fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (options.exclusive && existsSync(target)) {
      return;
    }
    renameSync(tempPath, target);
    chmodSync(target, mode);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(tempPath)) {
      rmSync(tempPath);
    }
  }
}

export function writePrivateJSONAtomic(
  path: string,
  value: unknown,
  options?: Omit<AtomicWriteOptions, "mode" | "directoryMode">,
): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

/** Alias for writePrivateJSONAtomic — writes owner-only JSON. */
export function writeJSON(path: string, value: unknown): void {
  writePrivateJSONAtomic(path, value);
}

export function writePublicTextIfMissing(
  path: string,
  contents: string,
  directoryMode = 0o755,
): void {
  if (existsSync(path)) {
    return;
  }
  writeFileAtomic(path, contents, {
    directoryMode,
    exclusive: true,
    mode: 0o644,
  });
}
