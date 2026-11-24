import { existsSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isInside } from "../platform/paths.js";
import { foundryStatePath } from "../platform/state-root.js";

/** Recognize native discovery links, including a snapshot left on another device. */
export function isFoundryManagedSkillPath(
  path: string,
  workspace: string,
  resolvedTarget?: string,
): boolean {
  const sets = foundryStatePath("skill-sets");
  try {
    const target = resolve(dirname(path), readlinkSync(path));
    if (!resolvedTarget && !existsSync(path))
      return isInside(sets, target) || /[\\/]skill-sets[\\/]/.test(target);
    const canonical = resolvedTarget ?? realpathSync(path);
    return (
      (existsSync(sets) && isInside(realpathSync(sets), canonical)) ||
      isInside(
        join(realpathSync(workspace), ".foundry", "assistant-skills"),
        canonical,
      )
    );
  } catch {
    return !resolvedTarget && isInside(sets, path);
  }
}
