import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type {
  RegisteredRepository,
  WorkspaceRegistration,
} from "./execution-types.js";
import { canonical, ExecutionStore, within } from "./execution-storage.js";
import { git } from "./execution-git.js";
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
      entries = readdirSync(directory, { withFileTypes: true });
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
        await git(directory, ["ls-files", "--stage", "-z"], { optional: true })
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

export async function registerExecutionWorkspace(
  source: string,
  workspaceId: string,
  store = new ExecutionStore(),
): Promise<WorkspaceRegistration> {
  return store.lock(workspaceId, "registration", async () => {
    source = canonical(source);
    if (
      within(source, store.executionRoot) ||
      within(store.executionRoot, source)
    )
      throw new Error("executionRoot must be outside the source workspace");
    const containing = await git(source, ["rev-parse", "--show-toplevel"], {
      optional: true,
    });
    const initialized = !containing && !existsSync(resolve(source, ".git"));
    if (initialized) await git(source, ["init", "-b", "main"]);
    let registration = await scanRepositories(source, workspaceId, store);
    // Store repository declarations without machine-local paths or credentials.
    const declaration = resolve(source, ".foundry/repositories.yaml");
    if (!existsSync(declaration)) {
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
    const bootstrapped = await bootstrapWorkspace(registration, store);
    if (bootstrapped) {
      registration = await scanRepositories(source, workspaceId, store);
    }
    registration.content = await workspaceContentInventory(source);
    store.saveRegistration(registration);
    return registration;
  });
}
