import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExecutionStore } from "../dist/execution-storage.js";
import {
  coalescedIssueEnvironmentChanges,
  onIssueEnvironmentChange,
} from "../dist/issue-environment-changes.js";
import { queuePreview, stopIssuePreview } from "../dist/issue-preview.js";

test("saving an environment, a workspace's repositories or a preview's state is told", async () => {
  const root = mkdtempSync(join(tmpdir(), "fdy-env-"));
  const told = [];
  const stop = onIssueEnvironmentChange((change) => told.push(change));
  try {
    const store = new ExecutionStore(root);
    const directory = join(root, "env");
    store.saveEnvironment({
      version: 1,
      id: "env_1",
      workspaceId: "ws_1",
      issueId: "issue_1",
      sourcePath: root,
      directory,
      cwd: directory,
      scratch: join(directory, "scratch"),
      revision: 1,
      status: "ready",
      repositories: [],
    });
    store.saveRegistration({ workspaceId: "ws_1", repositories: [] });
    queuePreview("issue_2");
    await stopIssuePreview("issue_2");
    assert.deepEqual(told, [
      { workspaceId: "ws_1", issueId: "issue_1" },
      { workspaceId: "ws_1" },
      { issueId: "issue_2" },
      { issueId: "issue_2" },
    ]);
  } finally {
    stop();
    rmSync(root, { force: true, recursive: true });
  }
});

test("a burst of changes to one environment is told once, after it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const told = [];
  const coalesced = coalescedIssueEnvironmentChanges(
    (change) => told.push(change),
    250,
  );
  coalesced.listener({ workspaceId: "ws", issueId: "a" });
  coalesced.listener({ workspaceId: "ws", issueId: "a" });
  coalesced.listener({ workspaceId: "ws", issueId: "b" });
  assert.deepEqual(told, []);
  t.mock.timers.tick(250);
  assert.deepEqual(told, [
    { workspaceId: "ws", issueId: "a" },
    { workspaceId: "ws", issueId: "b" },
  ]);
  coalesced.listener({ workspaceId: "ws", issueId: "a" });
  coalesced.close();
  t.mock.timers.tick(250);
  assert.equal(told.length, 2, "nothing is told after close");
});
