import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorkspace } from "../dist/workspace-inspection.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import { git, commitIdentity } from "../dist/execution-git.js";

test("workspace inspection separates live root state from explicit discovery without initializing source", async (t) => {
  const temp = mkdtempSync(resolve(tmpdir(), "foundry-inspection-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const source = resolve(temp, "source"),
    child = resolve(source, "a/b/repo"),
    store = new ExecutionStore(resolve(temp, "state"));
  mkdirSync(child, { recursive: true });
  await git(child, ["init", "-b", "main"]);
  await git(child, ["commit", "--allow-empty", "-m", "seed"], {
    env: commitIdentity,
  });
  let status = await inspectWorkspace(source, "ws_inspect", false, store);
  assert.equal(status.gitState, "not_git");
  assert.equal(status.scannedAt, undefined);
  status = await inspectWorkspace(source, "ws_inspect", true, store);
  assert.equal(status.gitState, "not_git");
  assert.deepEqual(
    status.repositories.map((repo) => repo.path),
    ["a/b/repo"],
  );
  assert.equal(existsSync(resolve(source, ".git")), false);
  assert.equal(existsSync(resolve(source, ".foundry")), false);
  const scannedAt = status.scannedAt;
  await git(source, ["init", "-b", "main"]);
  status = await inspectWorkspace(source, "ws_inspect", false, store);
  assert.equal(status.gitState, "unborn");
  assert.equal(status.scannedAt, scannedAt);
  writeFileSync(resolve(source, "tracked.txt"), "seed");
  await git(source, ["add", "tracked.txt"]);
  await git(source, ["commit", "-m", "seed"], { env: commitIdentity });
  writeFileSync(resolve(source, "tracked.txt"), "edited");
  status = await inspectWorkspace(source, "ws_inspect", true, store);
  assert.equal(status.gitState, "ready");
  assert.equal(status.branch, "main");
  assert.equal(status.trackedChanges, true);
  assert.equal(status.repositories.length, 2);
  assert.equal(status.uniqueRepositoryCount, 2);
  await git(source, [
    "worktree",
    "add",
    "--detach",
    resolve(source, "checkouts/linked"),
    "HEAD",
  ]);
  status = await inspectWorkspace(source, "ws_inspect", true, store);
  assert.equal(status.repositories.length, 3);
  assert.equal(status.uniqueRepositoryCount, 2);
  assert.equal(status.linkedWorktreeCount, 1);
  const inside = resolve(source, "ordinary");
  mkdirSync(inside);
  assert.equal(
    (await inspectWorkspace(inside, "ws_nested", false, store)).gitState,
    "nested",
  );
  await assert.rejects(
    () => inspectWorkspace(inside, "ws_inspect", false, store),
    /path mismatch/,
  );
});
