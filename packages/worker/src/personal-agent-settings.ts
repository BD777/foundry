// The device owner's Personal Agent settings (docs/personal-agent.md §4):
// the folders the person's assistant may create projects in. They live in
// the worker's state folder, which only the device owner can write, and are
// reported, resolved, in DeviceProjection.managedRoots.
//
// personal-agent.json: { "managedRoots": ["~/Foundry", "/data/projects"] }

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { canonical } from "./paths.js";
import { foundryStatePath } from "./state-root.js";
import { tryReadJSONFile } from "./storage.js";

export const defaultManagedRoots = ["~/Foundry"];

export interface PersonalAgentSettings {
  /** As the owner wrote them; `~` stands for the home folder. */
  managedRoots: string[];
}

export const personalAgentSettingsPath = (): string =>
  foundryStatePath("personal-agent.json");

/**
 * A missing or unreadable file, or one without a managedRoots list, is the
 * default. An empty list is the owner turning project creation off.
 */
export function readPersonalAgentSettings(
  path: string = personalAgentSettingsPath(),
): PersonalAgentSettings {
  const value = tryReadJSONFile<{ managedRoots?: unknown } | null>(path);
  const roots = value?.managedRoots;
  if (!Array.isArray(roots)) return { managedRoots: [...defaultManagedRoots] };
  return {
    managedRoots: roots.filter(
      (root): root is string => typeof root === "string" && !!root.trim(),
    ),
  };
}

/**
 * One configured root as a real absolute path (symbolic links resolved, the
 * folder need not exist yet), or undefined for one that names no absolute
 * folder.
 */
export function resolveManagedRoot(
  root: string,
  home: string = homedir(),
): string | undefined {
  const trimmed = root.trim();
  const expanded =
    trimmed === "~"
      ? home
      : trimmed.startsWith("~/")
        ? resolve(home, trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded)) return undefined;
  return canonical(resolve(expanded));
}

/** The resolved managed roots, without repeats. */
export function managedRoots(
  settings: PersonalAgentSettings = readPersonalAgentSettings(),
  home: string = homedir(),
): string[] {
  const roots = settings.managedRoots
    .map((root) => resolveManagedRoot(root, home))
    .filter((root): root is string => !!root);
  return [...new Set(roots)];
}
