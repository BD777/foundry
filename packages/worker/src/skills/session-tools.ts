import type { SessionToolPin } from "@bd777/foundry-protocol";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "../platform/utils.js";
import {
  managedToolsBin,
  sessionToolsRoot,
  toolVersionEntry,
} from "./managed-tools.js";

/**
 * A session's own folder of Foundry's tools (docs/skills.md, Bundle 版本),
 * on its PATH in place of the moving `bin` folder: each pinned tool links
 * to its version's program, every other tool to what `bin` pointed at when
 * the session's run started. An update or rollback later moves `bin` only,
 * so a running session keeps the CLI its skills were chosen for. Removed
 * when the run ends; folders a crashed process left are reaped at start.
 */

const folderBySession = new Map<string, string>();
const commandName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

export interface SessionTools {
  release(): void;
}

const none: SessionTools = { release: () => {} };

/** A session id as one plain folder name. */
function folderName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

/** Every tool in `bin` with the absolute path its link points at now. */
function currentTools(): Map<string, string> {
  const bin = managedToolsBin();
  const tools = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(bin);
  } catch {
    return tools;
  }
  for (const name of names) {
    if (!commandName.test(name) || name.endsWith(".tmp")) continue;
    const entry = join(bin, name);
    try {
      // One hop: a version's program, or a vendor install's own entry.
      tools.set(
        name,
        lstatSync(entry).isSymbolicLink()
          ? resolve(bin, readlinkSync(entry))
          : entry,
      );
    } catch {
      continue;
    }
  }
  return tools;
}

/**
 * Builds the session's tool folder from run_session's pins. Without pins
 * (an older server) the session keeps the shared `bin` folder.
 */
export function prepareSessionTools(
  sessionId: string | undefined,
  pins: SessionToolPin[] | undefined,
  log: (message: string) => void = (message) => console.log(message),
): SessionTools {
  if (!sessionId || !Array.isArray(pins)) return none;
  const tools = currentTools();
  for (const pin of pins) {
    let entry: string;
    try {
      entry = toolVersionEntry(pin.name, pin.version);
    } catch {
      log(`Tool pin ${pin.name} ${pin.version} is not a valid tool version.`);
      continue;
    }
    if (existsSync(entry)) tools.set(pin.name, entry);
    else
      log(
        `Session ${sessionId}: ${pin.name} ${pin.version} is not installed on this device; it runs ${tools.has(pin.name) ? "the current version" : "without it"}.`,
      );
  }
  const folder = join(sessionToolsRoot(), folderName(sessionId));
  try {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true, mode: 0o755 });
    for (const [name, target] of tools) symlinkSync(target, join(folder, name));
  } catch (error) {
    log(
      `Session ${sessionId}: could not set up its tool folder (${errorMessage(error)}); it uses the current tool versions.`,
    );
    rmSync(folder, { recursive: true, force: true });
    return none;
  }
  folderBySession.set(sessionId, folder);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      if (folderBySession.get(sessionId) === folder)
        folderBySession.delete(sessionId);
      rmSync(folder, { recursive: true, force: true });
    },
  };
}

/** The session's tool folder, if its run has one. */
export function sessionToolsFolder(
  sessionId: string | undefined,
): string | undefined {
  return sessionId ? folderBySession.get(sessionId) : undefined;
}

/**
 * Removes the tool folders of sessions this process does not run: call
 * where the previous owner of sessions is known to be gone.
 */
export function reapSessionTools(log: (message: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(sessionToolsRoot());
  } catch {
    return;
  }
  const live = new Set(folderBySession.values());
  for (const entry of entries) {
    const folder = join(sessionToolsRoot(), entry);
    if (live.has(folder)) continue;
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch (error) {
      log(
        `Could not remove the leftover session tool folder ${folder}: ${errorMessage(error)}`,
      );
    }
  }
}
