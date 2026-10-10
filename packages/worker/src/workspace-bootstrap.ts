import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonical, ExecutionStore, within } from "./execution-storage.js";
import { commitIdentity, git, gitCommit } from "./execution-git.js";
import { writeJSON } from "./storage.js";
import type { WorkspaceRegistration } from "./execution-types.js";

/**
 * Kept out of the first commit and of later Issue candidates: dependencies,
 * build output, logs and secrets. Written to the repository's local
 * `.git/info/exclude`, never to a `.gitignore`.
 */
const defaults = [
  "node_modules/",
  ".venv/",
  "venv/",
  ".cache/",
  ".next/",
  "__pycache__/",
  "dist/",
  "build/",
  "*.log",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.template",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa",
  "id_ed25519",
  ".ssh/",
  ".aws/",
  ".kube/",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  "credentials.json",
  "*.local.json",
];
const escapeIgnore = (path: string): string =>
  path.replace(/[\\*?\[\]#! ]/g, "\\$&");
const firstCommitMessage = "Initialize Foundry workspace assets";

/**
 * Makes the first commit of a repository that has none, once the person has
 * confirmed it: the folder's current files, minus what Git ignores, what is
 * too large or points outside, and anything under `.foundry/`. Resumes its
 * own interrupted staging; refuses files the person staged themselves.
 */
export async function bootstrapWorkspace(
  registration: WorkspaceRegistration,
  store: ExecutionStore,
): Promise<boolean> {
  const source = registration.sourcePath;
  const journalPath = resolve(
    store.metadata(registration.workspaceId),
    "bootstrap.json",
  );
  const previous = existsSync(journalPath)
    ? (JSON.parse(readFileSync(journalPath, "utf8")) as {
        status: string;
        files: string[];
      })
    : undefined;
  if (await git(source, ["rev-parse", "--verify", "HEAD"], { optional: true }))
    return false;
  const staged = (
    await git(source, ["ls-files", "--cached", "-z"], { bulk: true })
  )
    .split("\0")
    .filter(Boolean);
  // User-staged content is not ours to commit.
  if (
    staged.length &&
    (!previous || staged.some((path) => !previous.files.includes(path)))
  )
    throw new Error(
      "Empty repository contains user-staged files. Commit or unstage those files before Foundry initializes its baseline.",
    );
  if (
    registration.errors.length ||
    registration.repositories.some(
      (repo) => repo.kind !== "root" && repo.status === "conflict",
    )
  )
    throw new Error(
      `Workspace initialization is blocked by ${registration.errors.length || "repository"} discovery problem(s). ${registration.errors[0] ?? "Resolve conflicting repository boundaries before initialization."} See the Environment repository list for details.`,
    );
  const root = registration.repositories.find((repo) => repo.kind === "root");
  if (!root) return false;
  const childPaths = registration.repositories
    .filter((repo) => repo.parentId === root.id && repo.kind === "independent")
    .map((repo) => `/${escapeIgnore(repo.relativePath)}/`);
  const excludePath = await git(source, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const start = "# BEGIN Foundry workspace boundaries";
  const end = "# END Foundry workspace boundaries";
  const withoutBlock = (text: string): string => {
    const beginIndex = text.indexOf(start);
    const endIndex = text.indexOf(end, beginIndex);
    return beginIndex >= 0 && endIndex >= 0
      ? text.slice(0, beginIndex) + text.slice(endIndex + end.length + 1)
      : text;
  };
  const existing = withoutBlock(
    existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "",
  );
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(
    excludePath,
    `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${start}\n${[...defaults, ...childPaths].join("\n")}\n${end}\n`,
  );
  const files = (
    await git(source, ["ls-files", "--others", "--exclude-standard", "-z"], {
      bulk: true,
    })
  )
    .split("\0")
    .filter((path) => path && !path.startsWith(".foundry/"));
  const excluded: Array<{ path: string; reason: string }> = [];
  const included = [...staged];
  // Asynchronous, so a large folder never stalls the worker's connection.
  for (const path of files) {
    const file = resolve(source, path);
    const stat = await lstat(file);
    if (
      stat.isSymbolicLink() &&
      (!existsSync(file) || !within(source, canonical(file)))
    ) {
      excluded.push({
        path,
        reason: "Symlink points outside Workspace or is dangling",
      });
      continue;
    }
    if (stat.size > 25 * 1024 * 1024) {
      excluded.push({
        path,
        reason:
          "File exceeds initial baseline limit of 25 MiB; explicitly track it if required",
      });
      continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      excluded.push({ path, reason: "Not a regular file" });
      continue;
    }
    included.push(path);
  }
  const excludeText = readFileSync(excludePath, "utf8");
  const entries = excluded
    .map((entry) => `/${escapeIgnore(entry.path)}`)
    .filter((entry) => !excludeText.split("\n").includes(entry));
  if (entries.length)
    writeFileSync(excludePath, `${excludeText}${entries.join("\n")}\n`);
  writeJSON(journalPath, {
    version: 1,
    status: "staging",
    files: included,
    excluded,
  });
  // The rules above leave exactly `included` unignored in this unborn
  // repository, so one `add -A` stages them all; nothing under `.foundry/`
  // (a person's preview.json stays visible) goes into the first commit.
  await git(source, ["add", "-A"], { bulk: true });
  await git(
    source,
    ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".foundry"],
    { bulk: true },
  );
  if (!(await git(source, ["diff", "--cached", "--name-only"], { bulk: true })))
    await git(source, ["commit", "--allow-empty", "-m", firstCommitMessage], {
      env: commitIdentity,
    });
  const commit = await gitCommit(source, firstCommitMessage, { bulk: true });
  writeJSON(journalPath, {
    version: 1,
    status: "complete",
    files: included,
    excluded,
    commit,
  });
  return true;
}

export async function workspaceContentInventory(source: string): Promise<{
  tracked: string[];
  untracked: string[];
  ignored: string[];
  truncated: boolean;
}> {
  const collect = async (args: string[]): Promise<string[]> => {
    const output = await git(source, ["ls-files", ...args, "-z"], {
      optional: true,
      bulk: true,
    });
    return output ? output.split("\0").filter(Boolean) : [];
  };
  const [tracked, untracked, ignored] = await Promise.all([
    collect(["--cached"]),
    collect(["--others", "--exclude-standard"]),
    collect(["--others", "--ignored", "--exclude-standard", "--directory"]),
  ]);
  return {
    tracked: tracked.slice(0, 500),
    untracked: untracked.slice(0, 500),
    ignored: ignored.slice(0, 500),
    truncated: [tracked, untracked, ignored].some(
      (items) => items.length > 500,
    ),
  };
}
