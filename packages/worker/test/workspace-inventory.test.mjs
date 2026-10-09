import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  daemonCapabilities,
  explicitWorkspacePath,
  withServedWorkspaces,
} from "../dist/workspace-ops.js";
import {
  readRegistry,
  recordExplicitWorkspace,
  writeForgottenWorkspaces,
  writeRegistry,
} from "../dist/workspaces.js";

function workspaceFolder(t, id) {
  const root = mkdtempSync(join(tmpdir(), "foundry-inventory-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    writeRegistry([]);
    writeForgottenWorkspaces([]);
  });
  mkdirSync(join(root, ".foundry"));
  writeFileSync(
    join(root, ".foundry", "workspace.json"),
    JSON.stringify({
      id,
      name: "foundry",
      path: root,
      baseline: "main",
      createdAt: "2026-10-10T00:00:00.000Z",
      schemaVersion: 1,
    }),
  );
  return root;
}

test("the hello names every workspace the daemon serves, none for a device without one", () => {
  assert.ok(daemonCapabilities.includes("workspace_inventory"));
  const hello = withServedWorkspaces({ device: { id: "dev" } }, [
    { workspace: { id: "ws_a" } },
    { workspace: { id: "ws_b" } },
  ]);
  assert.deepEqual(hello.servedWorkspaceIds, ["ws_a", "ws_b"]);
  assert.equal(hello.device.id, "dev");
  // A device with no workspace still sends the (empty) list: the server
  // then knows none of its old workspaces is served.
  assert.deepEqual(
    withServedWorkspaces({ device: { id: "dev" } }, []).servedWorkspaceIds,
    [],
  );
});

test("a daemon started with --workspace records the folder so a restart without the flag keeps it", (t) => {
  writeRegistry([]);
  const folder = workspaceFolder(t, "ws_explicit");
  assert.equal(
    recordExplicitWorkspace(explicitWorkspacePath(["--workspace", folder])),
    true,
  );
  assert.deepEqual(
    readRegistry().map((entry) => [entry.id, entry.path]),
    [["ws_explicit", folder]],
  );
  // Already recorded: nothing changes.
  assert.equal(recordExplicitWorkspace(folder), false);
  assert.equal(readRegistry().length, 1);
});

test("the current folder is never recorded, nor a removed or non-workspace folder", (t) => {
  writeRegistry([]);
  const folder = workspaceFolder(t, "ws_cwd");
  const previous = process.cwd();
  process.chdir(folder);
  try {
    // Started from inside a workspace without --workspace (the #114 case).
    assert.equal(explicitWorkspacePath(["connect"]), "");
    assert.equal(recordExplicitWorkspace(explicitWorkspacePath([])), false);
  } finally {
    process.chdir(previous);
  }
  writeForgottenWorkspaces([
    { id: "ws_cwd", path: folder, forgottenAt: "2026-10-10T00:00:00.000Z" },
  ]);
  assert.equal(recordExplicitWorkspace(folder), false);
  const plain = mkdtempSync(join(tmpdir(), "foundry-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(recordExplicitWorkspace(plain), false);
  assert.deepEqual(readRegistry(), []);
});
