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

export interface CoalescedJSONWriterOptions extends AtomicWriteOptions {
  /** How long changes accumulate before one write (default 50 ms). */
  delayMs?: number;
  /** Reconciles external changes immediately before each snapshot. */
  prepare?: () => void;
  /** Tests may observe or replace the asynchronous atomic write. */
  write?: (
    path: string,
    contents: string,
    options: AtomicWriteOptions,
  ) => Promise<void>;
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

/**
 * Coalesces rapid changes into one compact, atomic JSON write. A flush is a
 * barrier: it does not resolve until a snapshot containing every change made
 * before the call is durable.
 */
export class CoalescedJSONWriter<T> {
  private readonly delayMs: number;
  private readonly write: NonNullable<CoalescedJSONWriterOptions["write"]>;
  private readonly waiters = new Set<{
    target: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  private revision = 0;
  private persistedRevision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private failure?: unknown;

  constructor(
    private readonly path: string,
    private readonly snapshot: () => T,
    private readonly options: CoalescedJSONWriterOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 50;
    this.write = options.write ?? writeFileAtomicAsync;
    process.once("exit", () => {
      try {
        this.flushSync();
      } catch {
        // Exit cannot report a write failure; normal barriers still do.
      }
    });
  }

  /** Marks the snapshot changed and resolves after this revision is durable. */
  change(): Promise<void> {
    this.revision++;
    this.schedule();
    return this.waitFor(this.revision);
  }

  /** Waits for every change made before the call to become durable. */
  flush(): Promise<void> {
    if (!this.timer && this.revision > this.persistedRevision)
      this.ensureRunning();
    return this.waitFor(this.revision);
  }

  /**
   * Last-resort exit path. It writes the newest in-memory snapshot with the
   * same file fsync used by normal atomic writes.
   */
  flushSync(): void {
    if (this.revision <= this.persistedRevision) return;
    this.options.prepare?.();
    writeFileAtomic(
      this.path,
      `${JSON.stringify(this.snapshot())}\n`,
      this.options,
    );
    this.persistedRevision = this.revision;
    this.resolveWaiters(this.revision);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.revision > this.persistedRevision) this.ensureRunning();
    }, this.delayMs);
  }

  private ensureRunning(): void {
    if (this.running) return;
    this.running = this.drain()
      .catch((error: unknown) => {
        this.failure = error;
        this.rejectWaiters(error);
      })
      .finally(() => {
        this.running = undefined;
        if (this.revision > this.persistedRevision && !this.failure)
          this.ensureRunning();
      });
  }

  private async drain(): Promise<void> {
    while (this.revision > this.persistedRevision) {
      const target = this.revision;
      this.options.prepare?.();
      await this.write(
        this.path,
        `${JSON.stringify(this.snapshot())}\n`,
        this.options,
      );
      this.persistedRevision = target;
      this.resolveWaiters(target);
    }
  }

  private waitFor(target: number): Promise<void> {
    if (this.persistedRevision >= target) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiters.add({ target, resolve, reject });
    });
  }

  private resolveWaiters(target: number): void {
    for (const waiter of [...this.waiters])
      if (waiter.target <= target) {
        this.waiters.delete(waiter);
        waiter.resolve();
      }
  }

  private rejectWaiters(error: unknown): void {
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter);
      waiter.reject(error);
    }
  }
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
