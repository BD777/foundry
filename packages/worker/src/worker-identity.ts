/**
 * Which worker build this process is, and how the machine updates it. Kept
 * apart from worker-install so registration can report it without importing
 * the installer.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceWorker } from "@bd777/foundry-protocol";
import { foundryStatePath } from "./state-root.js";

export interface PackageIdentity {
  name: string;
  version: string;
}

/** The package this CLI was run from. */
export function ownPackage(): PackageIdentity {
  const manifest = JSON.parse(
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
      "utf8",
    ),
  ) as PackageIdentity;
  return { name: manifest.name, version: manifest.version };
}

export function runtimeRoot(): string {
  return foundryStatePath("runtime");
}

/** `<state root>/bin/foundry-worker`: this machine's worker command. */
export function workerShimPath(): string {
  return foundryStatePath("bin", "foundry-worker");
}

/** A path as a person types it on that machine: `~/…` under the home. */
export function homeRelative(path: string): string {
  return path.startsWith(homedir() + sep)
    ? `~${path.slice(homedir().length)}`
    : path;
}

/**
 * The build this worker runs and, when `install` put it in the runtime
 * directory, the command that checks and updates it on this machine. A worker
 * run from a source checkout has no such command; it updates with git.
 */
export function runningWorker(): DeviceWorker {
  const { version } = ownPackage();
  let installed = false;
  try {
    const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
    installed = here.startsWith(realpathSync(runtimeRoot()) + sep);
  } catch {
    installed = false;
  }
  return installed && existsSync(workerShimPath())
    ? { version, command: homeRelative(workerShimPath()) }
    : { version };
}
