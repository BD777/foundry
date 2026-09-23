import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { canonical, ExecutionStore, within } from "./execution-storage.js";
import { git, gitCommit } from "./execution-git.js";
import { writeJSON } from "./storage.js";
import type { WorkspaceRegistration } from "./execution-types.js";

const defaults = [
  "/.foundry/*",
  "!/.foundry/workspace.json",
  "!/.foundry/repositories.yaml",
  "!/.foundry/assets.yaml",
  "!/.foundry/skills.yaml",
  "/artifacts/",
  "/accepted/",
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
  const staged = (await git(source, ["ls-files", "--cached", "-z"]))
    .split("\0")
    .filter(Boolean);
  // A fresh empty repo is supported; user-staged content is not ours to commit.
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
  const ignore = resolve(source, ".gitignore");
  const original = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  const start = "# BEGIN Foundry workspace boundaries";
  const end = "# END Foundry workspace boundaries";
  const beginIndex = original.indexOf(start);
  const endIndex = original.indexOf(end, beginIndex);
  const base =
    beginIndex >= 0 && endIndex >= 0
      ? original.slice(0, beginIndex) + original.slice(endIndex + end.length)
      : original;
  // Existing user rules come last and retain normal Git precedence.
  writeFileSync(
    ignore,
    `${start}\n${[...defaults, ...childPaths].join("\n")}\n${end}\n${base}`,
  );
  const files = (
    await git(source, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  const excluded: Array<{ path: string; reason: string }> = [];
  const included = [...staged];
  for (const path of files) {
    const file = resolve(source, path);
    const stat = lstatSync(file);
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
  const excludePath = await git(source, [
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const excludeText = existsSync(excludePath)
    ? readFileSync(excludePath, "utf8")
    : "";
  const entries = excluded
    .map((entry) => `/${escapeIgnore(entry.path)}`)
    .filter((entry) => !excludeText.split("\n").includes(entry));
  if (entries.length) {
    mkdirSync(dirname(excludePath), { recursive: true });
    writeFileSync(excludePath, `${excludeText}\n${entries.join("\n")}\n`);
  }
  writeJSON(journalPath, {
    version: 1,
    status: "staging",
    files: included,
    excluded,
  });
  if (!included.includes(".gitignore")) {
    included.push(".gitignore");
    writeJSON(journalPath, {
      version: 1,
      status: "staging",
      files: included,
      excluded,
    });
    await git(source, ["add", "-f", "--", ".gitignore"]);
  }
  for (let offset = 0; offset < included.length; offset += 100)
    await git(source, [
      "--literal-pathspecs",
      "add",
      "--",
      ...included.slice(offset, offset + 100),
    ]);
  const commit = included.length
    ? await gitCommit(source, "Initialize Foundry workspace assets")
    : await git(source, ["rev-parse", "HEAD"]);
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
