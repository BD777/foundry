import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { ExecutionStore, identifier } from "./execution-storage.js";
import { git, gitCommit, commitIdentity } from "./execution-git.js";
import { validateWorktree } from "./issue-environments.js";
import { writeJSON } from "./storage.js";
import type {
  IssueEnvironment,
  WorkspaceAcceptance,
} from "./execution-types.js";

function acceptancePath(environment: IssueEnvironment, id: string): string {
  return resolve(
    environment.directory,
    "../../acceptances",
    identifier(id),
    "acceptance.json",
  );
}

function assertNoOtherPartialIntegration(
  environment: IssueEnvironment,
  currentID: string,
): void {
  const root = resolve(environment.directory, "../../acceptances");
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentID) continue;
    const path = resolve(root, entry.name, "acceptance.json");
    if (!existsSync(path)) continue;
    const journal = JSON.parse(
      readFileSync(path, "utf8"),
    ) as WorkspaceAcceptance;
    if (journal.status === "applying")
      throw new Error(
        `workspace_integration_recovery_required: resume journal ${journal.id} before another integration`,
      );
  }
}

async function reviewUnchanged(
  environment: IssueEnvironment,
  revision: number,
): Promise<void> {
  if (environment.status !== "review" || environment.revision !== revision)
    throw new Error(
      "Candidate revision changed; review again before accepting",
    );
  for (const repo of environment.repositories) {
    await validateWorktree(repo);
    if (
      !repo.candidate ||
      (await git(repo.worktreePath, ["rev-parse", "HEAD"])) !==
        repo.candidate ||
      (await git(repo.worktreePath, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]))
    )
      throw new Error(`Candidate changed after review: ${repo.relativePath}`);
  }
}

async function sourceHead(
  source: string,
  baselineRef: string,
): Promise<string> {
  const head = await git(source, ["rev-parse", "HEAD"]);
  const branch = await git(source, ["symbolic-ref", "--quiet", "HEAD"], {
    optional: true,
  });
  const expectedBranch =
    baselineRef === "HEAD"
      ? ""
      : await git(source, ["rev-parse", "--symbolic-full-name", baselineRef]);
  if (
    branch !== expectedBranch ||
    (await git(source, [
      "rev-parse",
      "--verify",
      `${baselineRef}^{commit}`,
    ])) !== head
  )
    throw new Error(
      "Source checkout must be on its registered baseline branch",
    );
  return head;
}

export async function prepareAcceptance(
  workspaceId: string,
  issueId: string,
  revision: number,
  store = new ExecutionStore(),
): Promise<WorkspaceAcceptance> {
  return store.lock(workspaceId, `environment-${issueId}`, async () => {
    const environment = store.environment(workspaceId, issueId);
    if (!environment) throw new Error("Issue environment is missing");
    await reviewUnchanged(environment, revision);
    const acceptance: WorkspaceAcceptance = {
      version: 1,
      id: `acc_${randomUUID()}`,
      environmentId: environment.id,
      revision,
      status: "prepared",
      repositories: [],
      createdAt: new Date().toISOString(),
    };
    const path = acceptancePath(environment, acceptance.id);
    writeJSON(path, acceptance);
    try {
      // Prepare every merge before touching any source checkout. Integration
      // worktrees are retained for inspecting/resolving a conflicting merge.
      for (const repo of [...environment.repositories].sort(
        (a, b) => b.relativePath.length - a.relativePath.length,
      )) {
        if (
          await git(repo.sourcePath, [
            "status",
            "--porcelain",
            "--untracked-files=all",
          ])
        )
          throw new Error(
            `Source has uncommitted changes: ${repo.relativePath}`,
          );
        const expected = await sourceHead(repo.sourcePath, repo.baselineRef);
        const worktreePath = resolve(path, "..", repo.repoId);
        mkdirSync(resolve(path, ".."), { recursive: true });
        await git(repo.sourcePath, [
          "worktree",
          "add",
          "-b",
          `codex/accept-${acceptance.id}-${repo.repoId}`,
          worktreePath,
          expected,
        ]);
        const entry = {
          repoId: repo.repoId,
          relativePath: repo.relativePath,
          sourcePath: repo.sourcePath,
          baselineRef: repo.baselineRef,
          worktreePath,
          expected,
          target: "",
          status: "prepared" as const,
        };
        acceptance.repositories.push(entry);
        writeJSON(path, acceptance);
        await git(worktreePath, ["merge", "--no-edit", repo.candidate!], {
          env: commitIdentity,
        });
        for (const child of environment.repositories.filter(
          (item) => item.parentId === repo.repoId && item.kind === "submodule",
        )) {
          const target = acceptance.repositories.find(
            (item) => item.repoId === child.repoId,
          )!.target;
          await git(worktreePath, [
            "update-index",
            "--cacheinfo",
            `160000,${target},${relative(repo.sourcePath, child.sourcePath)}`,
          ]);
        }
        entry.target = await gitCommit(
          worktreePath,
          `Accept ${issueId} repository references`,
        );
        writeJSON(path, acceptance);
      }
      return acceptance;
    } catch (error) {
      acceptance.status = "conflict";
      acceptance.error = String(error);
      writeJSON(path, acceptance);
      return acceptance;
    }
  });
}

export async function applyAcceptance(
  workspaceId: string,
  issueId: string,
  acceptanceId: string,
  revision: number,
  store = new ExecutionStore(),
  validateEvidence?: (
    environment: IssueEnvironment,
    acceptance: WorkspaceAcceptance,
  ) => Promise<void>,
): Promise<WorkspaceAcceptance> {
  return store.lock(workspaceId, "accept", () =>
    store.lock(workspaceId, `environment-${issueId}`, async () => {
      const environment = store.environment(workspaceId, issueId);
      if (!environment) throw new Error("Issue environment is missing");
      const path = acceptancePath(environment, acceptanceId);
      if (!existsSync(path)) throw new Error("Acceptance was not prepared");
      const acceptance = JSON.parse(
        readFileSync(path, "utf8"),
      ) as WorkspaceAcceptance;
      assertNoOtherPartialIntegration(environment, acceptance.id);
      if (
        acceptance.environmentId !== environment.id ||
        acceptance.revision !== revision ||
        environment.revision !== revision
      )
        throw new Error("Acceptance revision does not match candidate");
      if (acceptance.status === "integrated") {
        environment.status = "integrated";
        store.saveEnvironment(environment);
        return acceptance;
      }
      if (acceptance.status === "conflict")
        throw new Error(
          acceptance.error ??
            "Resolve candidate conflicts and prepare a new acceptance",
        );
      if (validateEvidence) await validateEvidence(environment, acceptance);
      await reviewUnchanged(environment, revision);
      // Preflight all repositories, including those already applied after a crash.
      for (const repo of acceptance.repositories) {
        const head = await sourceHead(repo.sourcePath, repo.baselineRef);
        if (head !== repo.expected && head !== repo.target)
          throw new Error(
            `Baseline moved: ${repo.relativePath}; prepare a new acceptance`,
          );
        if (
          await git(repo.sourcePath, [
            "status",
            "--porcelain",
            "--ignore-submodules=all",
            "--untracked-files=all",
          ])
        )
          throw new Error(
            `Source has uncommitted changes: ${repo.relativePath}`,
          );
      }
      acceptance.status = "applying";
      writeJSON(path, acceptance);
      for (const repo of acceptance.repositories) {
        const head = await sourceHead(repo.sourcePath, repo.baselineRef);
        if (head !== repo.target) {
          if (
            head !== repo.expected ||
            (await git(repo.sourcePath, [
              "status",
              "--porcelain",
              "--ignore-submodules=all",
              "--untracked-files=all",
            ]))
          )
            throw new Error(
              `Source changed during acceptance: ${repo.relativePath}`,
            );
          await git(repo.sourcePath, [
            "-c",
            "submodule.recurse=false",
            "merge",
            "--ff-only",
            repo.target,
          ]);
        }
        repo.status = "applied";
        writeJSON(path, acceptance);
      }
      acceptance.status = "integrated";
      writeJSON(path, acceptance);
      environment.status = "integrated";
      store.saveEnvironment(environment);
      return acceptance;
    }),
  );
}
