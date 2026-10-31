import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { foundryStatePath } from "./state-root.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";

/**
 * Codex finds skills itself, in `.agents/skills` from the working directory
 * up to the repository root, in `~/.agents/skills` and in its own. Foundry
 * adds the workspace's selected skills there as links into their verified
 * snapshots, so Codex lists them natively next to the person's own; nothing
 * is disabled and no catalog is written into its instructions. A folder of
 * the person's with the same name stays as it is. Links Foundry made for
 * skills no longer selected are removed, and git ignores the links.
 */
export function linkCodexSkills(
  managed: ManagedSkillRuntime,
  workspacePath: string,
): void {
  const root = join(workspacePath, ".agents", "skills");
  const ours = (target: string) =>
    resolve(root, target).startsWith(foundryStatePath("skill-sets"));
  const wanted = new Map(
    managed.skills
      .filter((skill) => !skill.draft)
      .map((skill) => [skill.name, skill.dir]),
  );
  if (wanted.size === 0 && !existsSync(root)) return;
  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!lstatSync(path).isSymbolicLink() || !ours(readlinkSync(path)))
      continue;
    if (wanted.get(entry) !== resolve(root, readlinkSync(path)))
      unlinkSync(path);
  }
  const linked: string[] = [];
  for (const [name, dir] of wanted) {
    const path = join(root, name);
    if (!existsSync(path) && !isLink(path)) symlinkSync(dir, path, "dir");
    if (isLink(path) && ours(readlinkSync(path))) linked.push(name);
  }
  ignoreInGit(workspacePath, linked);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Adds the links to the repository's own exclude file, if it is one. */
function ignoreInGit(workspacePath: string, names: string[]): void {
  if (names.length === 0) return;
  let exclude: string, top: string;
  try {
    [top, exclude] = execFileSync(
      "git",
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-path",
        "info/exclude",
      ],
      {
        cwd: workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .trim()
      .split("\n") as [string, string];
  } catch {
    return;
  }
  if (!isAbsolute(exclude) || !isAbsolute(top)) return;
  const base = relative(top, resolve(workspacePath)).split("\\").join("/");
  const present = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const lines = new Set(present.split("\n"));
  const missing = names
    .map((name) => `/${base ? `${base}/` : ""}.agents/skills/${name}`)
    .filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  mkdirSync(resolve(exclude, ".."), { recursive: true });
  appendFileSync(
    exclude,
    (present && !present.endsWith("\n") ? "\n" : "") +
      missing.join("\n") +
      "\n",
  );
}
