/**
 * Which worker build this process is, and how the machine updates it. Kept
 * apart from worker-install so registration can report it without importing
 * the installer.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceWorker } from "@bd777/foundry-protocol";
import { workerPackagePath } from "../platform/package-root.js";
import { foundryStatePath } from "../platform/state-root.js";
import { isInside, tildePath } from "../platform/paths.js";

export interface PackageIdentity {
  name: string;
  version: string;
}

/** The package this CLI was run from. */
export function ownPackage(): PackageIdentity {
  const manifest = JSON.parse(
    readFileSync(workerPackagePath("package.json"), "utf8"),
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
    installed = isInside(realpathSync(runtimeRoot()), here);
  } catch {
    installed = false;
  }
  return installed && existsSync(workerShimPath())
    ? { version, command: tildePath(workerShimPath()) }
    : { version };
}
