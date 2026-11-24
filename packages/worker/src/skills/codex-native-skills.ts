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
import { isFoundryManagedSkillPath } from "./managed-paths.js";
import { isInside } from "../platform/paths.js";
import type { ManagedSkillRuntime } from "./skill-materializer.js";

/** Publish resolved snapshots in the native workspace discovery folder. */
export function linkCodexSkills(
  managed: ManagedSkillRuntime,
  workspacePath: string,
  fallbackSkillsRoot?: string,
): void {
  const root = join(workspacePath, ".agents", "skills");
  const wanted = new Map(
    managed.skills
      .filter((skill) => skill.source !== "assistant")
      .map((skill) => [skill.name, skill.dir]),
  );
  if (wanted.size === 0 && !existsSync(root)) return;
  for (const folder of [join(workspacePath, ".agents"), root]) {
    if (isLink(folder))
      throw new Error("Workspace skill root is a symbolic link.");
    mkdirSync(folder, { recursive: true });
  }
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = readlinkSync(path);
    if (!isFoundryManagedSkillPath(path, workspacePath)) continue;
    // Assistant links have their own lifecycle.
    if (
      isInside(
        join(workspacePath, ".foundry", "assistant-skills"),
        resolve(root, target),
      )
    )
      continue;
    if (wanted.get(entry) !== resolve(root, target)) unlinkSync(path);
  }
  const linked: string[] = [];
  for (const [name, dir] of wanted) {
    const path = join(root, name);
    if (!existsSync(path) && !isLink(path)) symlinkSync(dir, path, "dir");
    if (isLink(path) && resolve(root, readlinkSync(path)) === dir)
      linked.push(name);
    else if (fallbackSkillsRoot) {
      // Preserve the editable draft folder. The execution home exposes its
      // immutable winner, even when another entry occupies the workspace path.
      mkdirSync(fallbackSkillsRoot, { recursive: true });
      const link = join(fallbackSkillsRoot, name);
      if (
        isLink(link) &&
        resolve(fallbackSkillsRoot, readlinkSync(link)) !== dir
      )
        unlinkSync(link);
      if (!isLink(link)) symlinkSync(dir, link, "dir");
    }
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
