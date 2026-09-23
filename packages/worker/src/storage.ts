import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
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

export function writePrivateJSONAtomic(path: string, value: unknown): void {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, {
    directoryMode: privateDirectoryMode,
    fileMode: privateFileMode,
  });
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
  writeTextAtomic(path, contents, {
    directoryMode,
    exclusive: true,
    fileMode: 0o644,
  });
}

interface WriteTextOptions {
  directoryMode: number;
  exclusive?: boolean;
  fileMode: number;
}

function writeTextAtomic(
  path: string,
  contents: string,
  options: WriteTextOptions,
): void {
  const parent = dirname(path);
  mkdirSync(parent, { mode: options.directoryMode, recursive: true });
  chmodSync(parent, options.directoryMode);

  const target = resolve(path);
  const tempPath = resolve(
    parent,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(tempPath, "wx", options.fileMode);
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (options.exclusive && existsSync(target)) {
      return;
    }
    renameSync(tempPath, target);
    chmodSync(target, options.fileMode);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(tempPath)) {
      rmSync(tempPath);
    }
  }
}
