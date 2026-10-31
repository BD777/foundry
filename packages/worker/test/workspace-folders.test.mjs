import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  daemonCapabilities,
  withServedWorkspaces,
} from "../dist/workspace-ops.js";
import { serverFeatures } from "../dist/transport.js";
import {
  initWorkspace,
  readRegistry,
  readWorkspace,
  writeForgottenWorkspaces,
  writeRegistry,
} from "../dist/workspaces.js";
import {
  requireWorkspaceFolder,
  WorkspaceFolderMissingError,
} from "../dist/workspace-registration.js";
import {
  claudeProjectDirectoryName,
  findMovedWorkspaceFolders,
  registryWorkspaceFolders,
  relinkWorkspaceFolder,
} from "../dist/workspace-folders.js";
import { ExecutionStore } from "../dist/execution-storage.js";
import { inspectWorkspace } from "../dist/workspace-inspection.js";

function scratch(t, prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    writeRegistry([]);
    writeForgottenWorkspaces([]);
  });
  return root;
}

function workspaceFolder(path, id) {
  mkdirSync(join(path, ".foundry"), { recursive: true });
  writeFileSync(
    join(path, ".foundry", "workspace.json"),
    JSON.stringify({
      id,
      name: "app",
      path,
      baseline: "trunk",
      createdAt: "2026-10-01T00:00:00.000Z",
      schemaVersion: 1,
    }),
  );
  return path;
}

function registryEntry(id, path) {
  return {
    id,
    name: "app",
    path,
    baseline: "trunk",
    registeredAt: "2026-10-01T00:00:00.000Z",
  };
}

test("the worker declares workspace_folders and reads the server's feature", () => {
  assert.ok(daemonCapabilities.includes("workspace_folders"));
  assert.equal(
    serverFeatures({ features: ["workspace_folders"] }).workspaceFolders,
    true,
  );
  assert.equal(serverFeatures({ features: [] }).workspaceFolders, false);
  const hello = withServedWorkspaces(
    {},
    [{ workspace: { id: "ws_a" } }],
    ["ws_gone"],
  );
  assert.deepEqual(hello.servedWorkspaceIds, ["ws_a"]);
  assert.deepEqual(hello.missingWorkspaceIds, ["ws_gone"]);
  assert.deepEqual(withServedWorkspaces({}, []).missingWorkspaceIds, []);
});

test("registry workspaces whose folder is gone are listed missing; removed ones not at all", (t) => {
  const root = scratch(t, "foundry-folders-");
  const kept = workspaceFolder(join(root, "kept"), "ws_kept");
  const moved = workspaceFolder(join(root, "moved"), "ws_moved");
  const removed = join(root, "removed");
  writeRegistry([
    registryEntry("ws_kept", kept),
    registryEntry("ws_moved", moved),
    registryEntry("ws_removed", removed),
  ]);
  writeForgottenWorkspaces([
    { id: "ws_removed", path: removed, forgottenAt: "2026-10-02T00:00:00Z" },
  ]);
  renameSync(moved, join(root, "moved-renamed"));
  // A file where the folder was is no folder either.
  writeFileSync(moved, "not a folder");
  assert.deepEqual(registryWorkspaceFolders(), [
    { id: "ws_kept", path: kept, present: true },
    { id: "ws_moved", path: moved, present: false },
  ]);
});

test("an operation on a missing folder is refused clearly and never recreates it", (t) => {
  const root = scratch(t, "foundry-refusal-");
  const gone = join(root, "gone");
  assert.equal(requireWorkspaceFolder(root), root);
  assert.throws(
    () => requireWorkspaceFolder(gone),
    (error) =>
      error instanceof WorkspaceFolderMissingError &&
      error.message ===
        `The folder ${gone} no longer exists on this device. Use "Locate folder…" or "Remove" for this workspace on the Workspaces page.`,
  );
  assert.equal(existsSync(gone), false);
});

test("Claude's project directory name follows the SDK's encoding", () => {
  assert.equal(
    claudeProjectDirectoryName("/nonexistent-foundry/My Folder/app.v2"),
    "-nonexistent-foundry-My-Folder-app-v2",
  );
  const long = `/nonexistent-foundry/${"a".repeat(240)}`;
  const name = claudeProjectDirectoryName(long);
  assert.equal(
    name.slice(0, 201),
    `${long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200)}-`,
  );
  assert.match(name.slice(201), /^[0-9a-z]+$/);
});

test("relinking keeps the workspace id, follows the Issue registration, and copies Claude sessions", async (t) => {
  const root = scratch(t, "foundry-relink-");
  const claudeHome = join(root, "claude-home");
  const codexHome = join(root, "codex-home");
  const stateRoot = join(root, "state");
  const previousPath = workspaceFolder(join(root, "app"), "ws_relink");
  writeRegistry([registryEntry("ws_relink", previousPath)]);
  const store = new ExecutionStore(stateRoot);
  store.saveRegistration({
    version: 1,
    workspaceId: "ws_relink",
    sourcePath: previousPath,
    scannedAt: "2026-10-01T00:00:00.000Z",
    repositories: [
      {
        id: "repo_root",
        relativePath: ".",
        sourcePath: previousPath,
        gitDirectory: join(previousPath, ".git"),
        commonDirectory: join(previousPath, ".git"),
        kind: "root",
        baseline: "trunk",
        status: "ready",
      },
    ],
    errors: [],
  });
  // The Foundry chat's native session, its subagent files, and a native
  // chat started outside Foundry, kept where Claude Code keys them.
  const sessionId = randomUUID();
  const otherChat = randomUUID();
  const oldProject = join(
    claudeHome,
    "projects",
    claudeProjectDirectoryName(previousPath),
  );
  mkdirSync(join(oldProject, sessionId, "subagents"), { recursive: true });
  writeFileSync(join(oldProject, `${sessionId}.jsonl`), '{"type":"user"}\n');
  writeFileSync(
    join(oldProject, sessionId, "subagents", "agent-1.jsonl"),
    "{}\n",
  );
  writeFileSync(join(oldProject, `${otherChat}.jsonl`), '{"type":"user"}\n');
  const codexThread = "019a0000-codex-thread";
  mkdirSync(join(codexHome, "sessions", "2026", "10", "13"), {
    recursive: true,
  });
  writeFileSync(
    join(
      codexHome,
      "sessions",
      "2026",
      "10",
      "13",
      `rollout-2026-10-13T00-00-00-${codexThread}.jsonl`,
    ),
    "{}\n",
  );

  // The person renames the folder; it carries its workspace file, which
  // still names the old path.
  const path = join(root, "app-renamed");
  renameSync(previousPath, path);

  const nativeSessions = [
    { provider: "claude", id: sessionId },
    { provider: "claude", id: randomUUID() },
    { provider: "codex", id: codexThread },
  ];
  const relinked = await relinkWorkspaceFolder(
    { workspaceId: "ws_relink", path, previousPath, nativeSessions },
    { store, homes: { claude: [claudeHome], codex: [codexHome] } },
  );
  assert.deepEqual(relinked.nativeSessions, {
    copied: 1,
    alreadyThere: 1,
    notFound: 1,
  });
  const file = JSON.parse(
    readFileSync(join(path, ".foundry", "workspace.json"), "utf8"),
  );
  assert.equal(file.id, "ws_relink");
  assert.equal(file.path, path);
  assert.equal(file.name, "app-renamed");
  assert.equal(file.baseline, "trunk");
  assert.equal(file.createdAt, "2026-10-01T00:00:00.000Z");
  // Read the usual way, it is the same workspace, not a copy.
  assert.equal(readWorkspace(path).id, "ws_relink");
  assert.deepEqual(
    readRegistry().map((entry) => [entry.id, entry.path]),
    [["ws_relink", path]],
  );
  assert.equal(store.registration("ws_relink").sourcePath, path);
  assert.equal(
    store.registration("ws_relink").repositories[0].gitDirectory,
    join(path, ".git"),
  );
  const inspection = await inspectWorkspace(path, "ws_relink", false, store);
  assert.equal(inspection.sourcePath, path);

  const newProject = join(
    claudeHome,
    "projects",
    claudeProjectDirectoryName(path),
  );
  assert.ok(existsSync(join(newProject, `${sessionId}.jsonl`)));
  assert.ok(
    existsSync(join(newProject, sessionId, "subagents", "agent-1.jsonl")),
  );
  assert.ok(existsSync(join(newProject, `${otherChat}.jsonl`)));
  // Copied, never moved.
  assert.ok(existsSync(join(oldProject, `${sessionId}.jsonl`)));

  // Again: the session is already there.
  const again = await relinkWorkspaceFolder(
    {
      workspaceId: "ws_relink",
      path,
      previousPath,
      nativeSessions: nativeSessions.slice(0, 1),
    },
    { store, homes: { claude: [claudeHome], codex: [codexHome] } },
  );
  assert.deepEqual(again.nativeSessions, {
    copied: 0,
    alreadyThere: 1,
    notFound: 0,
  });
});

test("relinking finds Claude sessions in the worker's CLAUDE_CONFIG_DIR and replaces a copy's identity", async (t) => {
  const root = scratch(t, "foundry-relink-env-");
  const claudeHome = join(root, "claude-config");
  const previousPath = join(root, "gone");
  // The chosen folder holds another workspace's file (a copy of it).
  const path = workspaceFolder(join(root, "chosen"), "ws_copy");
  const sessionId = randomUUID();
  const oldProject = join(
    claudeHome,
    "projects",
    claudeProjectDirectoryName(previousPath),
  );
  mkdirSync(oldProject, { recursive: true });
  writeFileSync(join(oldProject, `${sessionId}.jsonl`), "{}\n");
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  });
  const relinked = await relinkWorkspaceFolder(
    {
      workspaceId: "ws_env",
      path,
      previousPath,
      nativeSessions: [{ provider: "claude", id: sessionId }],
    },
    { store: new ExecutionStore(join(root, "state")) },
  );
  assert.equal(relinked.nativeSessions.copied, 1);
  assert.equal(readWorkspace(path).id, "ws_env");
  assert.ok(
    existsSync(
      join(
        claudeHome,
        "projects",
        claudeProjectDirectoryName(path),
        `${sessionId}.jsonl`,
      ),
    ),
  );
  await assert.rejects(
    relinkWorkspaceFolder(
      {
        workspaceId: "ws_env",
        path: join(root, "nope"),
        previousPath,
        nativeSessions: [],
      },
      { store: new ExecutionStore(join(root, "state")) },
    ),
    /Choose an existing folder/,
  );
});

test("a moved folder is found beside its old place by its workspace identity", (t) => {
  const root = scratch(t, "foundry-find-");
  const previousPath = join(root, "app");
  const renamed = workspaceFolder(join(root, "app-2026"), "ws_find");
  // Its old path recorded, another id (a copy made before it moved).
  const copy = workspaceFolder(join(root, "app-copy"), "ws_other_copy");
  writeFileSync(
    join(copy, ".foundry", "workspace.json"),
    JSON.stringify({ id: "ws_other_copy", path: previousPath }),
  );
  // Registered as another workspace: never offered.
  const registered = workspaceFolder(join(root, "app-registered"), "ws_find");
  writeRegistry([registryEntry("ws_registered", registered)]);
  workspaceFolder(join(root, ".hidden"), "ws_find");
  mkdirSync(join(root, "unrelated"));
  assert.deepEqual(
    findMovedWorkspaceFolders({ workspaceId: "ws_find", previousPath }),
    [
      { path: renamed, reason: "same_workspace" },
      { path: copy, reason: "same_workspace" },
    ],
  );
  // A renamed parent: the same place under each sibling of the ancestor.
  const deepPrevious = join(root, "projects", "app");
  const deepMoved = workspaceFolder(
    join(root, "projects-old", "app"),
    "ws_deep",
  );
  assert.deepEqual(
    findMovedWorkspaceFolders({
      workspaceId: "ws_deep",
      previousPath: deepPrevious,
    }),
    [{ path: deepMoved, reason: "same_workspace" }],
  );
  assert.deepEqual(
    findMovedWorkspaceFolders({
      workspaceId: "ws_none",
      previousPath: join(root, "never-there"),
    }),
    [],
  );
});

test("a daemon reports missing folders, refuses work in them, relinks one and serves one that came back", async (t) => {
  const { spawn, spawnSync } = await import("node:child_process");
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { WebSocketServer } = await import("ws");
  const cli = join(import.meta.dirname, "../dist/cli.js");
  const root = scratch(t, "foundry-daemon-folders-");
  const stateRoot = join(root, "state");
  mkdirSync(stateRoot);
  const env = {
    ...process.env,
    FOUNDRY_STATE_ROOT: stateRoot,
    FOUNDRY_STACK: "",
  };
  const ids = {};
  for (const name of ["served", "moved", "back"]) {
    const init = spawnSync(process.execPath, [cli, "init", join(root, name)], {
      env,
      encoding: "utf8",
    });
    assert.equal(init.status, 0, init.stderr);
    ids[name] = JSON.parse(
      readFileSync(join(root, name, ".foundry", "workspace.json"), "utf8"),
    ).id;
  }
  renameSync(join(root, "moved"), join(root, "moved-renamed"));
  renameSync(join(root, "back"), join(root, "back-away"));

  const server = createServer(async (request, response) => {
    for await (const _ of request);
    const path = request.url.split("?")[0];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(path === "/api/issues" ? "[]" : "{}");
  });
  const sockets = new WebSocketServer({ noServer: true });
  const received = [];
  let connection;
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (open) => {
      connection = open;
      open.on("message", (raw) => {
        const envelope = JSON.parse(String(raw));
        received.push(envelope);
        if (envelope.type === "hello")
          open.send(
            JSON.stringify({
              id: envelope.id,
              type: "registered",
              payload: { features: ["workspace_folders"] },
            }),
          );
      });
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const serverURL = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(
    join(stateRoot, "daemon-config.json"),
    JSON.stringify({
      pairedAt: new Date().toISOString(),
      deviceCredential: "test-credential",
      serverURL,
      workspacePath: join(root, "served"),
    }),
  );
  const daemon = spawn(
    process.execPath,
    [cli, "daemon", "--server", serverURL],
    {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  daemon.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(() => {
    daemon.kill("SIGKILL");
    sockets.close();
    server.close();
  });
  const waitFor = async (predicate, what, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = received.find(predicate);
      if (found) return found;
      if (daemon.exitCode !== null) break;
      await new Promise((settle) => setTimeout(settle, 50));
    }
    assert.fail(`no ${what}: ${stderr}`);
  };
  const ask = (type, payload) => {
    const id = `${type}_${received.length}_${Date.now()}`;
    connection.send(JSON.stringify({ id, type, payload }));
    return waitFor((envelope) => envelope.id === id, `answer to ${type}`);
  };

  const hello = await waitFor((envelope) => envelope.type === "hello", "hello");
  assert.deepEqual(hello.payload.servedWorkspaceIds, [ids.served]);
  assert.deepEqual(
    hello.payload.missingWorkspaceIds,
    [ids.moved, ids.back].sort(),
  );
  assert.ok(hello.payload.capabilities.includes("workspace_folders"));

  const refused = await ask("read_file", {
    workspaceId: ids.moved,
    path: "README.md",
  });
  assert.equal(
    refused.payload.error,
    `The folder ${join(root, "moved")} no longer exists on this device. Use "Locate folder…" or "Remove" for this workspace on the Workspaces page.`,
  );
  // A chat turn there is refused before anything is written under it.
  connection.send(
    JSON.stringify({
      id: "run_moved",
      type: "run_session",
      payload: {
        session: {
          id: "sess_moved",
          workspaceId: ids.moved,
          provider: "claude",
          title: "Chat",
          status: "queued",
          input: { id: "input_1", prompt: "hello" },
        },
      },
    }),
  );
  const completed = await waitFor(
    (envelope) =>
      envelope.type === "session_completed" &&
      envelope.payload?.sessionId === "sess_moved",
    "refused session",
  );
  assert.equal(completed.payload.error, refused.payload.error);
  assert.equal(existsSync(join(root, "moved")), false);

  const found = await ask("find_moved_workspace", {
    workspaceId: ids.moved,
    previousPath: join(root, "moved"),
  });
  assert.deepEqual(found.payload.suggestions, [
    { path: join(root, "moved-renamed"), reason: "same_workspace" },
  ]);

  const relinked = await ask("relink_workspace", {
    workspaceId: ids.moved,
    path: join(root, "moved-renamed"),
    previousPath: join(root, "moved"),
    nativeSessions: [],
  });
  assert.equal(relinked.payload.error, undefined, stderr);
  assert.equal(relinked.payload.registration.workspace.id, ids.moved);
  assert.equal(
    relinked.payload.registration.workspace.localPath,
    join(root, "moved-renamed"),
  );
  assert.deepEqual(relinked.payload.nativeSessions, {
    copied: 0,
    alreadyThere: 0,
    notFound: 0,
  });
  await waitFor(
    (envelope) =>
      envelope.type === "workspace_folders" &&
      envelope.payload.missingWorkspaceIds.join() === ids.back,
    "folder report after the relink",
  );

  // The folder that was away comes back: served again within a round.
  renameSync(join(root, "back-away"), join(root, "back"));
  const ready = await waitFor(
    (envelope) =>
      envelope.type === "workspace_ready" &&
      envelope.payload?.registration?.workspace?.id === ids.back,
    "workspace_ready for the folder that came back",
  );
  assert.equal(
    ready.payload.registration.workspace.localPath,
    join(root, "back"),
  );
  await waitFor(
    (envelope) =>
      envelope.type === "workspace_folders" &&
      envelope.payload.missingWorkspaceIds.length === 0 &&
      envelope.payload.servedWorkspaceIds.length === 3,
    "folder report with all three served",
  );

  // A served folder disappears: the first refused operation reports it.
  renameSync(join(root, "served"), join(root, "served-away"));
  const tree = await ask("list_workspace_tree", {
    workspaceId: ids.served,
    path: "",
  });
  assert.match(tree.payload.error, /no longer exists on this device/);
  await waitFor(
    (envelope) =>
      envelope.type === "workspace_folders" &&
      envelope.payload.missingWorkspaceIds.join() === ids.served,
    "folder report naming the served folder missing",
    3_000,
  );
  assert.equal(existsSync(join(root, "served")), false);
});

test("adding a moved folder (not locating it) registers it under its own identity at its own path", (t) => {
  const root = scratch(t, "fdy-init-moved-");
  const before = join(root, "economic-research");
  const after = join(root, "research");
  workspaceFolder(before, "ws_old");
  renameSync(before, after);
  initWorkspace(after);
  const workspace = readWorkspace(after);
  assert.notEqual(workspace.id, "ws_old");
  assert.equal(workspace.path, after);
  const entry = readRegistry().find((item) => item.id === workspace.id);
  assert.equal(entry?.path, after);
  assert.equal(
    readRegistry().some((item) => item.path === before),
    false,
  );
});
