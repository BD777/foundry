import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingWorkspaceFolder } from "../dist/workspace-registration.js";
import { registerExecutionWorkspace } from "../dist/repository-registry.js";
import { prepareIssueEnvironment } from "../dist/issue-environments.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import { git, commitIdentity } from "../dist/execution-git.js";

test("UI registration requires an existing absolute folder and never creates a missing path", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "foundry-register-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(existingWorkspaceFolder(dir), dir);
  const missing = join(dir, "does-not-exist");
  assert.throws(
    () => existingWorkspaceFolder(missing),
    /Choose an existing folder/,
  );
  assert.equal(existsSync(missing), false);
  const file = join(dir, "file");
  writeFileSync(file, "test");
  assert.throws(
    () => existingWorkspaceFolder(file),
    /Choose an existing folder/,
  );
  assert.throws(
    () => existingWorkspaceFolder("relative/path"),
    /absolute folder path/,
  );
});

test("registerExecutionWorkspace allows a subdirectory inside an existing Git repo without creating a nested .git", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "foundry-subrepo-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repoRoot = join(temp, "monorepo");
  const subDir = join(repoRoot, "packages", "app");
  mkdirSync(subDir, { recursive: true });

  await git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "root.txt"), "root");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "initial commit"], {
    env: commitIdentity,
  });

  const store = new ExecutionStore(join(temp, "state"));
  const reg = await registerExecutionWorkspace(subDir, "ws_sub_test", store);

  assert.equal(reg.workspaceId, "ws_sub_test");
  assert.equal(reg.sourcePath, subDir);
  assert.equal(
    existsSync(join(subDir, ".git")),
    false,
    "Must not initialize nested .git inside existing Git repo",
  );
  assert.equal(
    existsSync(join(subDir, ".foundry")),
    true,
    "Should initialize .foundry metadata in subdirectory workspace",
  );
});

test("an Issue in a subdirectory workspace names the repository root to register instead", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "foundry-subrepo-issue-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repoRoot = join(temp, "monorepo");
  const subDir = join(repoRoot, "packages", "app");
  mkdirSync(subDir, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "root.txt"), "root");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "initial commit"], {
    env: commitIdentity,
  });
  const store = new ExecutionStore(join(temp, "state"));
  await assert.rejects(
    prepareIssueEnvironment(subDir, "ws_sub_issue", "issue_1", store),
    /Issues need a repository root\. This workspace is a folder inside the Git repository at .*monorepo/,
  );
});

test("registerExecutionWorkspace ignores .worktrees directory during repository scanning", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "foundry-worktrees-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const repoRoot = join(temp, "project");
  mkdirSync(repoRoot, { recursive: true });

  await git(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "readme.txt"), "hello");
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "init"], { env: commitIdentity });

  // Create a .worktrees directory with dummy content
  const worktreeDir = join(repoRoot, ".worktrees", "wt-1");
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(
    join(worktreeDir, ".git"),
    "gitdir: ../../.git/worktrees/wt-1\n",
  );

  const store = new ExecutionStore(join(temp, "state"));
  const reg = await registerExecutionWorkspace(repoRoot, "ws_wt_test", store);

  assert.equal(
    reg.repositories.some((r) => r.sourcePath.includes(".worktrees")),
    false,
    "Should skip scanning inside .worktrees",
  );
});
