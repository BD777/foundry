import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type {
  RegisteredRepository,
  WorkspaceRegistration,
} from "./execution-types.js";
import { canonical, ExecutionStore, within } from "./execution-storage.js";
import { excludeFoundryRuntimeFromGit, git } from "./execution-git.js";
import {
  bootstrapWorkspace,
  workspaceContentInventory,
} from "./workspace-bootstrap.js";

const skipped = new Set([
  ".git",
  ".foundry",
  ".worktrees",
  ".worktree",
  ".claude",
  ".agents",
  ".codex",
  ".trae",
  ".tmp",
  ".turbo",
  ".pnpm-store",
  "node_modules",
  ".venv",
  "venv",
  ".cache",
  ".next",
  "dist",
  "build",
  "target",
  "out",
  "vendor_cache",
]);

export async function scanRepositories(
  source: string,
  workspaceId: string,
  store = new ExecutionStore(),
): Promise<WorkspaceRegistration> {
  source = canonical(source);
  const repositories: RegisteredRepository[] = [];
  const errors: string[] = [];
  const old = store.registration(workspaceId);
  const declarationsPath = resolve(source, ".foundry/repositories.yaml");
  const declarations = existsSync(declarationsPath)
    ? (parse(readFileSync(declarationsPath, "utf8")) as {
        repositories?: Array<{ path: string; baseline?: string }>;
      })
    : undefined;
  async function walk(
    directory: string,
    parent?: RegisteredRepository,
  ): Promise<void> {
    let owner = parent;
    // A `.git` that resolves to an enclosing repository (for example a stray
    // gitfile) makes this a plain folder: keep walking for nested repositories.
    let top = "";
    if (existsSync(resolve(directory, ".git"))) {
      try {
        top = canonical(await git(directory, ["rev-parse", "--show-toplevel"]));
      } catch (error) {
        errors.push(`${relative(source, directory) || "."}: ${String(error)}`);
      }
    }
    if (top && top === canonical(directory)) {
      try {
        const commonDirectory = canonical(
          await git(
            directory,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            { optional: true },
          ),
        );
        const relativePath = relative(source, directory) || ".";
        const prior = old?.repositories.find(
          (repo) => repo.relativePath === relativePath,
        );
        const branch = await git(
          directory,
          ["symbolic-ref", "--quiet", "HEAD"],
          { optional: true },
        );
        const head = await git(directory, ["rev-parse", "--verify", "HEAD"], {
          optional: true,
        });
        const parentEntry = parent
          ? await git(
              parent.sourcePath,
              [
                "ls-files",
                "--stage",
                "--",
                relative(parent.sourcePath, directory),
              ],
              { optional: true },
            )
          : "";
        const submodule = parentEntry.startsWith("160000 ");
        owner = {
          id:
            prior?.id ??
            `repo_${createHash("sha256").update(`${workspaceId}:${relativePath}`).digest("hex").slice(0, 20)}`,
          relativePath,
          sourcePath: directory,
          gitDirectory: canonical(
            await git(directory, ["rev-parse", "--absolute-git-dir"]),
          ),
          commonDirectory,
          kind:
            relativePath === "."
              ? "root"
              : submodule
                ? "submodule"
                : "independent",
          parentId: parent?.id,
          baseline:
            declarations?.repositories?.find(
              (repo) => repo.path === relativePath,
            )?.baseline ??
            prior?.baseline ??
            (branch || "HEAD"),
          status: !head
            ? "unborn"
            : parentEntry && !submodule
              ? "conflict"
              : "ready",
          ...(!head
            ? { error: "Repository needs an initial commit" }
            : parentEntry && !submodule
              ? { error: "Parent already tracks files in this repository path" }
              : {}),
        };
        if (!owner.baseline) owner.baseline = head || "HEAD";
        repositories.push(owner);
        if (
          owner.gitDirectory &&
          owner.gitDirectory !== owner.commonDirectory
        ) {
          // This repository is a linked worktree. It is registered, but do not recurse into its files/subdirectories.
          return;
        }
      } catch (error) {
        errors.push(`${relative(source, directory) || "."}: ${String(error)}`);
      }
    }
    let entries;
    try {
      // Asynchronous: walking a large tree must not stall the worker.
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(`${directory}: ${String(error)}`);
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        skipped.has(entry.name)
      )
        continue;
      await walk(resolve(directory, entry.name), owner);
    }
    if (owner?.sourcePath === directory) {
      const links = (
        await git(directory, ["ls-files", "--stage", "-z"], {
          optional: true,
          bulk: true,
        })
      )
        .split("\0")
        .filter((line) => line.startsWith("160000 "));
      for (const link of links) {
        const path = resolve(directory, link.split("\t")[1]!);
        if (!repositories.some((repo) => repo.sourcePath === path)) {
          const relativePath = relative(source, path);
          const error =
            "Submodule is not initialized; initialize it in the source workspace before use";
          // This boundary is known and remains registered as unavailable.
          // It blocks preparing this repository, not unrelated root work.
          repositories.push({
            id: `repo_${createHash("sha256").update(`${workspaceId}:${relativePath}`).digest("hex").slice(0, 20)}`,
            relativePath,
            sourcePath: path,
            gitDirectory: "",
            commonDirectory: "",
            kind: "submodule",
            parentId: owner.id,
            baseline: "HEAD",
            status: "unavailable",
            error,
          });
        }
      }
    }
  }
  await walk(source);
  const result: WorkspaceRegistration = {
    version: 1,
    workspaceId,
    sourcePath: source,
    scannedAt: new Date().toISOString(),
    repositories,
    errors,
  };
  store.saveRegistration(result);
  return result;
}

/**
 * Whether Issues can run in this folder as it is. A folder without Git, or a
 * repository without commits, needs Git set up first, and only after the
 * person confirms it (see `initializeWorkspaceGit`). A folder inside a larger
 * repository is not Foundry's to initialize; preparing an Issue explains it.
 */
export async function workspaceGitState(
  source: string,
): Promise<"ready" | "needs_git"> {
  source = canonical(source);
  const top = await git(source, ["rev-parse", "--show-toplevel"], {
    optional: true,
  });
  if (!top) return "needs_git";
  if (canonical(top) !== source) return "ready";
  return (await git(source, ["rev-parse", "--verify", "HEAD"], {
    optional: true,
  }))
    ? "ready"
    : "needs_git";
}

export const needsGitMessage =
  "Issues need Git: this workspace has no Git repository or no commits yet. Create an Issue in Foundry and confirm setting up Git, or run git init and make a first commit yourself.";

/**
 * Registers a workspace's repositories for Issues. It never changes the
 * person's folder or history: no `git init`, no `.gitignore`, no commit. It
 * keeps Foundry's own `.foundry/` data out of an existing repository through
 * its local excludes.
 */
export function registerExecutionWorkspace(
  source: string,
  workspaceId: string,
  store = new ExecutionStore(),
): Promise<WorkspaceRegistration> {
  return registerWorkspace(source, workspaceId, store, false);
}

/**
 * What the person confirms before the first Issue in a folder without Git or
 * commits: `git init` where needed, Foundry's paths kept out through
 * `.git/info/exclude`, and the folder's current files committed as the first
 * commit. Does nothing to a repository that already has commits.
 */
export function initializeWorkspaceGit(
  source: string,
  workspaceId: string,
  store = new ExecutionStore(),
): Promise<WorkspaceRegistration> {
  return registerWorkspace(source, workspaceId, store, true);
}

async function registerWorkspace(
  source: string,
  workspaceId: string,
  store: ExecutionStore,
  initializeGit: boolean,
): Promise<WorkspaceRegistration> {
  return store.lock(workspaceId, "registration", async () => {
    source = canonical(source);
    if (
      within(source, store.executionRoot) ||
      within(store.executionRoot, source)
    )
      throw new Error("executionRoot must be outside the source workspace");
    if (initializeGit) {
      const containing = await git(source, ["rev-parse", "--show-toplevel"], {
        optional: true,
      });
      if (containing && canonical(containing) !== source)
        throw new Error(
          `This workspace is a folder inside the Git repository at ${containing}; Foundry does not initialize Git here.`,
        );
      if (!containing) await git(source, ["init", "-b", "main"]);
    }
    // Foundry's identity and runtime data under .foundry/ never show up as
    // the person's changes, so they never stand between them and Accept.
    await excludeFoundryRuntimeFromGit(source);
    let registration = await scanRepositories(source, workspaceId, store);
    // Store repository declarations without machine-local paths or credentials.
    const declaration = resolve(source, ".foundry/repositories.yaml");
    if (
      !existsSync(declaration) &&
      registration.repositories.some((repo) => repo.kind === "root")
    ) {
      mkdirSync(dirname(declaration), { recursive: true, mode: 0o700 });
      writeFileSync(
        declaration,
        stringify({
          version: 1,
          repositories: registration.repositories.map((repo) => ({
            id: repo.id,
            path: repo.relativePath,
            kind: repo.kind,
            baseline: repo.baseline,
          })),
        }),
        { mode: 0o600 },
      );
    }
    if (initializeGit && (await bootstrapWorkspace(registration, store)))
      registration = await scanRepositories(source, workspaceId, store);
    registration.content = await workspaceContentInventory(source);
    store.saveRegistration(registration);
    return registration;
  });
}
