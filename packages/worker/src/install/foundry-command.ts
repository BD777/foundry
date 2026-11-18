/**
 * This machine's `foundry` command, beside `foundry-worker`, so shells and
 * agents outside Foundry can run it. Install, update and each daemon start
 * write it as a shell wrapper that runs the installed runtime through
 * `current`, so an update needs no rewrite. When `~/.local/bin` is on PATH it
 * is linked there too. Shell rc files are never edited.
 *
 * Nothing that another program put at these paths is replaced: a file that is
 * not a Foundry wrapper (or a link to one) is left alone and reported.
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { tildePath } from "../platform/paths.js";
import { foundryStatePath } from "../platform/state-root.js";
import { runtimeRoot } from "./worker-identity.js";

const SHIM_PREFIX = "#!/bin/sh\n# Foundry ";
const SHIM_WRITTEN_BY = "written by install and update.";
const COMMAND_NAME = "foundry";
const CLI_ENTRY = "foundry-cli.js";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `<state root>/bin/foundry`: the Foundry CLI wrapper on this machine. */
export function foundryCommandPath(): string {
  return foundryStatePath("bin", COMMAND_NAME);
}

/**
 * Writes a sh wrapper that runs `node` on `cli` with this machine's stack.
 * `header` is the comment under the shebang; a wrapper Foundry wrote says
 * `written by install and update.` there, which marks it as Foundry's.
 */
export function writeCommandShim(
  path: string,
  shim: { header: string; cli: string; node: string },
): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const stack = ["FOUNDRY_STACK", "FOUNDRY_STATE_ROOT"]
    .map((key) => [key, process.env[key]?.trim()] as const)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${shellQuote(value!)}\n`)
    .join("");
  writeFileSync(
    path,
    `#!/bin/sh\n# ${shim.header}\n${stack}exec ${shellQuote(shim.node)} ${shellQuote(shim.cli)} "$@"\n`,
    { mode: 0o755 },
  );
  return path;
}

type Entry = "absent" | "foundry" | "other";

/** What sits at a path: nothing, a Foundry wrapper (or a link to one), or someone else's file. */
function entryAt(path: string): Entry {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // A directory or a dangling link: not Foundry's to replace.
    return "other";
  }
  return text.startsWith(SHIM_PREFIX) && text.includes(SHIM_WRITTEN_BY)
    ? "foundry"
    : "other";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function onPath(directory: string, pathEnv: string): boolean {
  const wanted = resolve(directory);
  return pathEnv
    .split(delimiter)
    .some((entry) => entry !== "" && resolve(entry) === wanted);
}

export type LinkOutcome =
  | { status: "linked" | "unchanged"; link: string }
  | { status: "absent" | "off-path"; directory: string }
  | { status: "occupied"; link: string };

/**
 * Links `command` as `<directory>/<name>` when the directory exists and is on
 * `pathEnv`. An existing link to another command, or a Foundry wrapper, is
 * replaced; anything else at that name is left alone.
 */
export function linkCommand(
  command: string,
  options: { name: string; directory: string; pathEnv: string },
): LinkOutcome {
  const { name, directory, pathEnv } = options;
  if (!isDirectory(directory)) return { status: "absent", directory };
  if (!onPath(directory, pathEnv)) return { status: "off-path", directory };
  const link = join(directory, name);
  let target: string | undefined;
  try {
    target = readlinkSync(link);
  } catch {
    target = undefined;
  }
  if (target === command) return { status: "unchanged", link };
  if (entryAt(link) === "other") return { status: "occupied", link };
  // Replace in one rename, so the name never points at nothing.
  const staging = join(directory, `.${name}.${process.pid}`);
  rmSync(staging, { force: true });
  symlinkSync(command, staging);
  renameSync(staging, link);
  return { status: "linked", link };
}

/**
 * Writes this machine's foundry command for the installed runtime `name`,
 * links it into ~/.local/bin when that is on PATH, and returns what to tell
 * the person. Nothing is written when another program already holds the path.
 */
export function installFoundryCommand(
  name: string,
  options: {
    node?: string;
    localBin?: string;
    pathEnv?: string;
  } = {},
): string[] {
  const path = foundryCommandPath();
  if (entryAt(path) === "other")
    return [
      `${tildePath(path)} is not a Foundry command; left it alone, so foundry is not installed there.`,
    ];
  writeCommandShim(path, {
    header: "Foundry CLI on this machine; written by install and update.",
    cli: join(
      runtimeRoot(),
      "current",
      "node_modules",
      name,
      "dist",
      CLI_ENTRY,
    ),
    node: options.node ?? process.execPath,
  });
  const shown = tildePath(path);
  const localBin = options.localBin ?? join(homedir(), ".local", "bin");
  const outcome = linkCommand(path, {
    name: COMMAND_NAME,
    directory: localBin,
    pathEnv: options.pathEnv ?? process.env.PATH ?? "",
  });
  switch (outcome.status) {
    case "linked":
      return [
        `foundry is on PATH: ${tildePath(outcome.link)} links to ${shown}.`,
      ];
    case "unchanged":
      return [
        `foundry is on PATH: ${tildePath(outcome.link)} links to ${shown}.`,
      ];
    case "absent":
    case "off-path":
      return [
        `foundry is at ${shown}. ${tildePath(outcome.directory)} is missing or not on PATH, so foundry is not linked there; run foundry by that path, or add ${tildePath(dirname(shown))} to PATH in your shell.`,
      ];
    case "occupied":
      return [
        `${tildePath(outcome.link)} is another program, left alone; foundry is at ${shown}.`,
      ];
  }
}
