import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "../paths.js";
import {
  defaultStateRoot,
  foundryStateRoot,
  stackStateParent,
} from "../state-root.js";

/**
 * Install prefixes of the Node runtime and of the launched executable. Tool
 * managers (nvm, ~/.local, npm-global) keep them outside the system roots,
 * so without these the sandbox cannot even exec the agent CLI. A prefix that
 * is the home directory or overlaps private control state is never exposed.
 */
export function executableReadRoots(
  command: string,
  controlPaths: string[],
): string[] {
  const home = canonical(homedir());
  const roots = new Set<string>();
  for (const file of [process.execPath, command]) {
    if (!isAbsolute(file) || !existsSync(file)) continue;
    const directory = dirname(realpathSync(file));
    roots.add(
      canonical(basename(directory) === "bin" ? dirname(directory) : directory),
    );
  }
  return [...roots].filter(
    (root) =>
      root !== "/" &&
      root !== home &&
      !controlPaths.some(
        (control) =>
          control === root ||
          control.startsWith(`${root}/`) ||
          root.startsWith(`${control}/`),
      ),
  );
}

/**
 * Install prefixes of the runtime and of `command`, resolved through PATH when
 * it is a bare name, so the process can load the executable it was given.
 */
export function commandReadRoots(command: string): string[] {
  const file = isAbsolute(command)
    ? command
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((root) => resolve(root, command))
        .find(existsSync);
  return executableReadRoots(file ?? command, protectedHostPaths());
}

/**
 * Foundry's own governance state: device credential, daemon config, other
 * Issues' candidates and evidence, and every parallel stack's state. No
 * sandboxed process may read it, whatever else it is allowed to see.
 */
export function governanceStatePaths(): string[] {
  return [defaultStateRoot, stackStateParent, foundryStateRoot()]
    .filter(existsSync)
    .map(canonical)
    .filter((path, index, all) => all.indexOf(path) === index);
}

/**
 * The user's own configuration and credentials. Hidden unless the profile
 * lets the process use the user's files.
 */
export function userSecretPaths(): string[] {
  return [
    resolve(homedir(), ".config"),
    resolve(homedir(), "Library"),
    resolve(homedir(), ".ssh"),
  ]
    .filter(existsSync)
    .map(canonical);
}

/** Everything a sandboxed process without the user's files may not read. */
export function protectedHostPaths(): string[] {
  return [...governanceStatePaths(), ...userSecretPaths()];
}

/** The runtime's server data (database, secret key); never readable. */
export function runtimeServerData(runtime: string): string[] {
  return [".data", "apps/server/.data"].map((path) => resolve(runtime, path));
}

/** The Foundry installation the worker runs from (repository root in development). */
export function runtimeRoot(): string {
  return canonical(fileURLToPath(new URL("../../../../", import.meta.url)));
}

/** System roots a confined process with host-wide reads may use. */
export function writableTreeSystemRoots(): string[] {
  return [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/opt/homebrew",
    "/Applications",
  ].filter(existsSync);
}

export function offlineCommandSystemRoots(): string[] {
  return [
    "/usr",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/System",
    "/Library",
    "/opt/homebrew",
  ].filter(existsSync);
}
