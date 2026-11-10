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
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
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
  /**
   * Also flushes the folder after the rename, so the new name itself
   * survives a crash (records that must not be lost, such as evidence).
   */
  fsyncDirectory?: boolean;
  /** Creates a missing parent folder (default); off when it must exist. */
  createParent?: boolean;
  /**
   * The temporary file to write first, for callers that journal its name
   * to clean up after a crash; a unique name beside path by default.
   */
  tempPath?: string;
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
    createParent = true,
  } = options;
  const parent = dirname(path);
  if (createParent) mkdirSync(parent, { mode: directoryMode, recursive: true });
  if (hardenParent) chmodSync(parent, directoryMode);

  const target = resolve(path);
  const tempPath = resolve(
    parent,
    options.tempPath ??
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
    if (options.fsyncDirectory) {
      descriptor = openSync(parent, "r");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    }
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(tempPath)) {
      rmSync(tempPath);
    }
  }
}

/**
 * Asynchronous form of writeFileAtomic for hot, recoverable state. The
 * temporary write and sync happen off the event loop; rename remains atomic.
 */
export async function writeFileAtomicAsync(
  path: string,
  contents: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const {
    mode = privateFileMode,
    directoryMode = privateDirectoryMode,
    hardenParent = true,
    fsync = true,
    fsyncDirectory = false,
    createParent = true,
  } = options;
  const parent = dirname(path);
  if (createParent)
    await mkdir(parent, { mode: directoryMode, recursive: true });
  if (hardenParent) await chmod(parent, directoryMode);

  const target = resolve(path);
  const tempPath = resolve(
    parent,
    options.tempPath ??
      `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let descriptor: Awaited<ReturnType<typeof open>> | undefined;
  try {
    descriptor = await open(tempPath, "wx", mode);
    await descriptor.writeFile(contents);
    if (fsync) await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    if (options.exclusive && existsSync(target)) return;
    await rename(tempPath, target);
    await chmod(target, mode);
    if (fsyncDirectory) {
      descriptor = await open(parent, "r");
      await descriptor.sync();
      await descriptor.close();
      descriptor = undefined;
    }
  } finally {
    if (descriptor) await descriptor.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function writePrivateJSONAtomic(
  path: string,
  value: unknown,
  options?: Omit<AtomicWriteOptions, "mode" | "directoryMode">,
): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writePrivateJSONAtomicAsync(
  path: string,
  value: unknown,
  options?: Omit<AtomicWriteOptions, "mode" | "directoryMode">,
): Promise<void> {
  await writeFileAtomicAsync(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    options,
  );
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
