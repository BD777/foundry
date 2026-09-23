import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  foundryStateRoot,
  foundryStackSuffix,
  foundryStatePath,
} from "../dist/state-root.js";

test("each stack resolves its own private state root", (t) => {
  const original = {
    stack: process.env.FOUNDRY_STACK,
    root: process.env.FOUNDRY_STATE_ROOT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      FOUNDRY_STACK: original.stack,
      FOUNDRY_STATE_ROOT: original.root,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });

  delete process.env.FOUNDRY_STACK;
  delete process.env.FOUNDRY_STATE_ROOT;
  assert.equal(foundryStateRoot(), resolve(homedir(), ".foundry"));
  assert.equal(foundryStackSuffix(), "");

  process.env.FOUNDRY_STACK = "lab";
  assert.equal(
    foundryStateRoot(),
    resolve(homedir(), ".foundry-stacks", "lab"),
  );
  assert.equal(foundryStackSuffix(), ".lab");
  assert.equal(
    foundryStatePath("device.json"),
    resolve(homedir(), ".foundry-stacks", "lab", "device.json"),
  );

  // An explicit root wins, so a stack can live anywhere.
  process.env.FOUNDRY_STATE_ROOT = resolve(tmpdir(), "foundry-explicit");
  assert.equal(foundryStateRoot(), resolve(tmpdir(), "foundry-explicit"));
});

test("every private worker path follows the stack root", async (t) => {
  // Stack resolution is only observable when no explicit root is selected.
  // The sandboxed test launcher exports a fixed FOUNDRY_STATE_ROOT; drop it
  // for this test (and restore it afterwards) so the named-stack semantics
  // under verification actually apply. This test only compares path strings
  // and never writes, so the real stack roots it computes stay untouched.
  const original = {
    stack: process.env.FOUNDRY_STACK,
    root: process.env.FOUNDRY_STATE_ROOT,
  };
  t.after(() => {
    for (const [key, value] of Object.entries({
      FOUNDRY_STACK: original.stack,
      FOUNDRY_STATE_ROOT: original.root,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  delete process.env.FOUNDRY_STATE_ROOT;
  process.env.FOUNDRY_STACK = "probe";
  const root = resolve(homedir(), ".foundry-stacks", "probe");
  // Imported after the stack is selected: these modules resolve their paths once.
  const [workspaces, device, config, service] = await Promise.all([
    import("../dist/workspaces.js"),
    import("../dist/device.js"),
    import("../dist/config.js"),
    import("../dist/service.js"),
  ]);
  for (const path of [
    workspaces.registryPath,
    workspaces.forgottenWorkspacesPath,
    device.devicePath,
    device.runtimeSettingsPath,
    config.daemonConfigPath,
    service.daemonLogDir,
  ])
    assert.equal(
      path.startsWith(`${root}/`),
      true,
      `${path} escaped the stack root`,
    );
  assert.equal(service.serviceLabel(), "dev.foundry.probe.worker");
});

test("a copied checkout gets its own workspace identity", async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), "foundry-relocate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { readWorkspace, workspaceFilePath } =
    await import("../dist/workspaces.js");
  const original = resolve(root, "original");
  const copy = resolve(root, "copy");
  const identity = {
    id: "ws_original",
    name: "original",
    path: original,
    baseline: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
  };
  for (const place of [original, copy]) {
    mkdirSync(resolve(place, ".foundry"), { recursive: true });
    writeFileSync(workspaceFilePath(place), JSON.stringify(identity));
  }
  assert.equal(readWorkspace(original).id, "ws_original");
  const relocated = readWorkspace(copy);
  assert.notEqual(relocated.id, "ws_original");
  assert.equal(relocated.path, copy);
  assert.equal(relocated.name, "copy");
  // The new identity persists, so the second stack keeps it across restarts.
  assert.equal(readWorkspace(copy).id, relocated.id);
  assert.equal(readWorkspace(original).id, "ws_original");
});

test(
  "issue executors cannot read any stack's private state",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "foundry-stack-sandbox-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { sandboxCommand } = await import("../dist/execution-sandbox.js");
    const environment = {
      cwd: resolve(root, "candidate"),
      scratch: resolve(root, "scratch"),
      directory: root,
      sourcePath: resolve(root, "source"),
      repositories: [
        {
          repoId: "root",
          relativePath: ".",
          worktreePath: resolve(root, "candidate"),
          status: "ready",
        },
      ],
    };
    for (const path of [
      environment.cwd,
      environment.scratch,
      environment.sourcePath,
    ])
      mkdirSync(path, { recursive: true });
    const spec = sandboxCommand(
      environment,
      { repositories: [{ id: "root", relativePath: "." }] },
      "/bin/echo",
      ["ok"],
    );
    const profile = spec.args[1];
    assert.ok(existsSync(profile));
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(profile, "utf8");
    // Both the default root and the parent of every named stack stay denied.
    for (const denied of [
      resolve(homedir(), ".foundry"),
      resolve(homedir(), ".foundry-stacks"),
    ])
      assert.match(
        text,
        new RegExp(`\\(deny file-read-data \\(subpath "${denied}"\\)\\)`),
      );
  },
);
