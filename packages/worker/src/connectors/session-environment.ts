import {
  accessSync,
  constants,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { delimiter, join } from "node:path";

/**
 * What a device-held connector adds to the environment of a session that
 * may use it (docs/connectors.md, "会话环境"). One builder makes it for real
 * sessions (connectors/index.ts) and for the status checks
 * (device-held.ts), so what Foundry calls usable is what a session gets.
 */
export interface ConnectorSessionSetup {
  /** Variables for the session's processes. */
  environment: NodeJS.ProcessEnv;
  /** Folders to put first on its PATH (the tools linked for it). */
  pathDirs: string[];
}

export function emptySessionSetup(): ConnectorSessionSetup {
  return { environment: {}, pathDirs: [] };
}

export function mergeSessionSetups(
  ...setups: ConnectorSessionSetup[]
): ConnectorSessionSetup {
  const merged = emptySessionSetup();
  for (const setup of setups) {
    merged.environment = mergeEnvironment(
      merged.environment,
      setup.environment,
    );
    for (const dir of setup.pathDirs)
      if (!merged.pathDirs.includes(dir)) merged.pathDirs.push(dir);
  }
  return merged;
}

const gitConfigName = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

function gitConfigCount(env: NodeJS.ProcessEnv): number {
  const count = Number(env.GIT_CONFIG_COUNT);
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/**
 * `extra` over `base`, except git's settings in the environment
 * (GIT_CONFIG_COUNT/KEY_n/VALUE_n): those of `extra` are numbered after
 * `base`'s, so one adds to the other.
 */
export function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  const first = gitConfigCount(base);
  const added = gitConfigCount(extra);
  for (const [name, value] of Object.entries(extra)) {
    if (name === "GIT_CONFIG_COUNT" || gitConfigName.test(name)) continue;
    out[name] = value;
  }
  if (added > 0) {
    for (let index = 0; index < added; index++) {
      out[`GIT_CONFIG_KEY_${first + index}`] = extra[`GIT_CONFIG_KEY_${index}`];
      out[`GIT_CONFIG_VALUE_${first + index}`] =
        extra[`GIT_CONFIG_VALUE_${index}`];
    }
    out.GIT_CONFIG_COUNT = String(first + added);
  }
  return out;
}

/** `env` as a session with this setup has it: PATH in front, variables over. */
export function applySessionSetup(
  env: NodeJS.ProcessEnv,
  setup: ConnectorSessionSetup,
): NodeJS.ProcessEnv {
  const out = mergeEnvironment(env, setup.environment);
  if (setup.pathDirs.length > 0)
    out.PATH = [...setup.pathDirs, out.PATH ?? ""]
      .filter(Boolean)
      .join(delimiter);
  return out;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The program a process with this PATH runs for `command`, or undefined. */
export function findOnPath(
  command: string,
  pathValue: string | undefined,
): string | undefined {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

const commandPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

/**
 * Makes `command` available in `binDir` as a link to `target` (the program
 * Foundry found), replacing whatever was there. The folder is the
 * session's own, never the shared tools folder.
 */
export function linkTool(
  binDir: string,
  command: string,
  target: string,
): boolean {
  if (!commandPattern.test(command)) return false;
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const link = join(binDir, command);
  rmSync(link, { force: true });
  symlinkSync(target, link);
  return true;
}

/** Removes session folders nothing has touched for `maxAgeMs`. */
export function pruneSessionFolders(root: string, maxAgeMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    try {
      const folder = join(root, entry);
      if (Date.now() - statSync(folder).mtimeMs > maxAgeMs)
        rmSync(folder, { recursive: true, force: true });
    } catch {
      // Another process removed it.
    }
  }
}
