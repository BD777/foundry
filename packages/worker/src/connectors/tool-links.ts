import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { within } from "../platform/paths.js";

/**
 * Links for a CLI Foundry installed for the device's user (gh-install.ts,
 * alibabacloud-install.ts, tencentcloud-install.ts): one in Foundry's tools,
 * which sessions search first, and one in ~/.local/bin for the person's
 * terminal when that does not shadow another copy.
 */

/** Points `<folder>/<name>` at target, replacing an earlier link only. */
export function linkTool(folder: string, name: string, target: string): void {
  mkdirSync(folder, { recursive: true });
  const entry = join(folder, name);
  const staging = `${entry}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  symlinkSync(target, staging);
  renameSync(staging, entry);
}

/** `<folder>/<name>` is absent, or a link into installRoot. */
function ours(name: string, folder: string, installRoot: string): boolean {
  const entry = join(folder, name);
  let stat;
  try {
    stat = lstatSync(entry);
  } catch {
    return true;
  }
  return (
    stat.isSymbolicLink() &&
    within(installRoot, resolve(folder, readlinkSync(entry)))
  );
}

/**
 * `<binDir>/<name>` may be ours: it is free and no other copy is on PATH,
 * which the link could shadow in the person's terminal.
 */
export function toolLinkFree(
  name: string,
  binDir: string,
  installRoot: string,
  managedBin: string,
  path: string,
): boolean {
  if (!ours(name, binDir, installRoot)) return false;
  return path
    .split(":")
    .filter((dir) => dir && resolve(dir) !== resolve(managedBin))
    .every((dir) => ours(name, dir, installRoot));
}
