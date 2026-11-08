import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, PassThrough, Transform } from "node:stream";
import {
  FrameReader,
  encodeFrame,
  frameKinds,
  writeFrame,
} from "../dist/daemon/workspace-migration/framing.js";
import {
  manifestForTransfer,
  rescanForMigration,
  runSource,
  scanForMigration,
} from "../dist/daemon/workspace-migration/source.js";
import {
  checkTarget,
  runTarget,
  verifyStaging,
} from "../dist/daemon/workspace-migration/target.js";
import { activateMigration } from "../dist/daemon/workspace-migration/activate.js";
import {
  purgeMigratedSource,
  retireMigratedWorkspace,
} from "../dist/daemon/workspace-migration/purge.js";
import { stagingDir } from "../dist/daemon/workspace-migration/staging.js";
import { claudeProjectDirectoryName } from "../dist/daemon/workspace-folders.js";
import { ExecutionStore } from "../dist/candidate-store/execution-storage.js";
import {
  readForgottenWorkspaces,
  readRegistry,
  writeForgottenWorkspaces,
  writeRegistry,
} from "../dist/workspace/workspaces.js";

const migrationId = "mig_test_1";
const workspaceId = "ws_migrating";

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fdy-migration-")));
  t.after(() => {
    execFileSync("chmod", ["-R", "u+rwx", root]);
    rmSync(root, { recursive: true, force: true });
    writeRegistry([]);
    writeForgottenWorkspaces([]);
  });
  return root;
}

function homes(home) {
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  return {
    home,
    claude: { default: claude, all: [claude] },
    codex: { default: codex, all: [codex] },
  };
}

function git(cwd, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

/** A source device: a workspace folder with a repository, sessions, an Issue worktree. */
function sourceDevice(root) {
  const home = join(root, "source-home");
  const state = join(root, "source-state");
  mkdirSync(state, { recursive: true });
  const folder = join(root, "source", "app");
  mkdirSync(join(folder, "sub", "dir"), { recursive: true });
  mkdirSync(join(folder, ".foundry"), { recursive: true });
  writeFileSync(
    join(folder, ".foundry", "workspace.json"),
    JSON.stringify({
      id: workspaceId,
      name: "app",
      path: folder,
      baseline: "trunk",
      createdAt: "2026-10-01T00:00:00.000Z",
      schemaVersion: 1,
    }),
  );
  writeFileSync(join(folder, "hello.txt"), "hello\n");
  writeFileSync(join(folder, "empty"), "");
  writeFileSync(join(folder, "sub", "dir", "nested.txt"), "nested\n");
  writeFileSync(join(folder, "script.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(folder, "script.sh"), 0o755);
  writeFileSync(join(folder, "big.bin"), randomBytes(5 * 1024 * 1024 + 123));
  mkdirSync(join(folder, "emptydir"));
  symlinkSync("hello.txt", join(folder, "link"));
  symlinkSync("/etc/hostname", join(folder, "external"));
  mkdirSync(join(folder, "rodir"));
  writeFileSync(join(folder, "rodir", "inside.txt"), "inside\n");
  const skillSets = join(state, "skill-sets");
  mkdirSync(join(skillSets, "abc", "foo"), { recursive: true });
  mkdirSync(join(folder, ".agents", "skills"), { recursive: true });
  symlinkSync(
    join(skillSets, "abc", "foo"),
    join(folder, ".agents", "skills", "foo"),
  );
  writeFileSync(join(folder, ".gitignore"), "big.bin\n");
  git(folder, "init", "-q", "-b", "main");
  git(folder, "add", "hello.txt", "script.sh", "sub");
  git(folder, "commit", "-q", "-m", "first");

  // The Issue environment: a worktree in the execution root.
  const execution = join(state, "workspaces", workspaceId);
  const environment = join(execution, "environments", "iss_1");
  mkdirSync(environment, { recursive: true });
  git(
    folder,
    "worktree",
    "add",
    "-q",
    "-b",
    "iss1",
    join(environment, "workspace"),
  );
  writeFileSync(
    join(environment, "environment.json"),
    JSON.stringify({
      directory: environment,
      sourcePath: folder,
      cwd: join(environment, "workspace"),
      repositories: [
        { worktreePath: join(environment, "workspace"), sourcePath: folder },
      ],
    }),
  );
  mkdirSync(join(execution, "environment-locations"), { recursive: true });
  writeFileSync(
    join(execution, "environment-locations", "iss_1.json"),
    JSON.stringify({ path: join(environment, "environment.json") }),
  );
  writeFileSync(
    join(execution, "registration.local.json"),
    JSON.stringify({
      version: 1,
      workspaceId,
      sourcePath: folder,
      scannedAt: "2026-10-01T00:00:00.000Z",
      repositories: [
        {
          sourcePath: folder,
          gitDirectory: join(folder, ".git"),
          commonDirectory: join(folder, ".git"),
        },
      ],
      errors: [],
    }),
  );
  mkdirSync(join(execution, "locks"), { recursive: true });
  writeFileSync(join(execution, "locks", "registration.lock"), "1");

  // Native sessions: Claude in the folder's project directory and in
  // another one, Codex rollouts started in the folder and elsewhere.
  const locations = homes(home);
  const slug = claudeProjectDirectoryName(folder);
  const project = join(locations.claude.default, "projects", slug);
  mkdirSync(join(project, "memory"), { recursive: true });
  writeFileSync(join(project, "claude-session-1.jsonl"), '{"type":"user"}\n');
  writeFileSync(join(project, "memory", "MEMORY.md"), "- remembered\n");
  const other = join(locations.claude.default, "projects", "-elsewhere");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "claude-session-2.jsonl"), '{"type":"user"}\n');
  const day = join(locations.codex.default, "sessions", "2026", "11", "06");
  mkdirSync(day, { recursive: true });
  const meta = (cwd) =>
    `${JSON.stringify({ type: "session_meta", payload: { id: "x", cwd } })}\n`;
  writeFileSync(
    join(day, "rollout-2026-11-06T00-00-00-codex-thread-1.jsonl"),
    meta(folder),
  );
  writeFileSync(
    join(day, "rollout-2026-11-06T00-00-00-codex-unrelated.jsonl"),
    meta("/elsewhere"),
  );

  writeRegistry([
    {
      id: workspaceId,
      name: "app",
      path: folder,
      baseline: "trunk",
      registeredAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
  return {
    folder,
    state,
    home,
    execution,
    environment,
    locations,
    slug,
    day,
    input: {
      migrationId,
      workspaceId,
      path: folder,
      nativeSessions: [
        { provider: "claude", id: "claude-session-1" },
        { provider: "claude", id: "claude-session-2" },
        { provider: "codex", id: "codex-thread-1" },
      ],
      homes: locations,
      store: new ExecutionStore(state),
      skillSets,
    },
    stateDir: join(state, "migrations", migrationId),
  };
}

function targetDevice(root) {
  const home = join(root, "target-home");
  const state = join(root, "target-state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, "target", "parent"), { recursive: true });
  return {
    path: join(root, "target", "parent", "moved-app"),
    state,
    locations: homes(home),
    store: new ExecutionStore(state),
    stateDir: join(state, "migrations", migrationId),
  };
}

function streamPair({ cutAfter } = {}) {
  let passed = 0;
  const toTarget = cutAfter
    ? new Transform({
        transform(chunk, _encoding, done) {
          passed += chunk.length;
          if (passed > cutAfter) {
            done();
            toTarget.destroy(new Error("cut"));
            toSource.destroy(new Error("cut"));
            return;
          }
          done(null, chunk);
        },
      })
    : new PassThrough();
  const toSource = new PassThrough();
  return {
    source: Duplex.from({ readable: toSource, writable: toTarget }),
    target: Duplex.from({ readable: toTarget, writable: toSource }),
  };
}

async function transfer(source, target, options) {
  const pair = streamPair(options);
  const manifest = await manifestForTransfer(source.input, {
    stateDir: source.stateDir,
  });
  const [sent, received] = await Promise.allSettled([
    runSource(pair.source, manifest),
    runTarget(pair.target, { migrationId, path: target.path }),
  ]);
  return { sent, received };
}

test("frames survive any chunking", async () => {
  const frames = [
    [frameKinds.hello, Buffer.from('{"jobId":"a"}')],
    [frameKinds.data, randomBytes(70_000)],
    [frameKinds.done, Buffer.alloc(0)],
  ];
  const wire = Buffer.concat(
    frames.map(([kind, payload]) => encodeFrame(kind, payload)),
  );
  const stream = new PassThrough();
  const reader = new FrameReader(stream);
  for (let at = 0; at < wire.length; at += 7)
    stream.write(wire.subarray(at, at + 7));
  stream.end();
  for (const [kind, payload] of frames) {
    const frame = await reader.next();
    assert.equal(frame.kind, kind);
    assert.deepEqual(frame.payload, payload);
  }
  assert.equal(await reader.next(), undefined);

  const out = new PassThrough();
  await writeFrame(out, frameKinds.ack, { received: 2 });
  out.end();
  const back = await new FrameReader(out).expect();
  assert.equal(back.kind, frameKinds.ack);
  assert.deepEqual(JSON.parse(back.payload.toString()), { received: 2 });
  assert.throws(() =>
    encodeFrame(frameKinds.data, Buffer.alloc(1024 * 1024 + 1)),
  );
});

test("check refuses a folder that is not empty and reports space", (t) => {
  const root = scratch(t);
  mkdirSync(join(root, "full"));
  writeFileSync(join(root, "full", "x"), "x");
  assert.equal(checkTarget({ path: join(root, "full"), bytes: 1 }).ok, false);
  assert.equal(checkTarget({ path: "relative/path", bytes: 1 }).ok, false);
  const free = checkTarget({ path: join(root, "new", "folder"), bytes: 1 });
  assert.equal(free.ok, true);
  assert.ok(free.freeBytes > 0);
  mkdirSync(join(root, "empty"));
  assert.equal(checkTarget({ path: join(root, "empty"), bytes: 1 }).ok, true);
  const huge = checkTarget({ path: join(root, "new"), bytes: 1e18 });
  assert.equal(huge.ok, false);
  assert.match(huge.reason, /free space/);
});

test("a workspace moves to another device and its old copy is purged", async (t) => {
  const root = scratch(t);
  const source = sourceDevice(root);
  const target = targetDevice(root);

  chmodSync(join(source.folder, "rodir"), 0o555);
  const scanned = await scanForMigration(source.input, {
    stateDir: source.stateDir,
  });
  assert.ok(scanned.files >= 10);
  assert.ok(
    scanned.warnings.some(
      (w) => w.kind === "external_symlink" && w.path.endsWith("external"),
    ),
  );
  const manifest = await manifestForTransfer(source.input, {
    stateDir: source.stateDir,
  });
  const paths = manifest.entries.map((entry) => `${entry.root}:${entry.path}`);
  assert.ok(paths.includes("folder:.git/HEAD"));
  assert.ok(
    !paths.includes("folder:.agents/skills/foo"),
    "skill links are made again, not moved",
  );
  assert.ok(
    paths.includes(
      "claude:default:projects/" + source.slug + "/memory/MEMORY.md",
    ),
  );
  assert.ok(
    paths.includes("claude:default:projects/-elsewhere/claude-session-2.jsonl"),
  );
  assert.ok(
    paths.some(
      (path) =>
        path.startsWith("codex:default:") &&
        path.endsWith("codex-thread-1.jsonl"),
    ),
  );
  assert.ok(!paths.some((path) => path.endsWith("codex-unrelated.jsonl")));
  assert.ok(paths.includes("execution:environments/iss_1/workspace/.git"));
  assert.ok(!paths.some((path) => path.startsWith("execution:locks")));

  // Cut inside the big file, then resume: only what is missing is sent again.
  const cut = await transfer(source, target, { cutAfter: 3 * 1024 * 1024 });
  assert.equal(cut.received.status, "rejected");
  assert.equal(cut.sent.status, "rejected");
  const resumed = await transfer(source, target);
  assert.equal(resumed.sent.status, "fulfilled", resumed.sent.reason?.stack);
  assert.equal(
    resumed.received.status,
    "fulfilled",
    resumed.received.reason?.stack,
  );
  assert.ok(resumed.received.value.received >= 1);
  assert.ok(
    resumed.received.value.received < manifest.header.files,
    "files received before the cut are not sent again",
  );
  assert.equal(resumed.received.value.failed, 0);
  let verified = await verifyStaging({ migrationId, path: target.path });
  assert.equal(verified.ok, true, verified.mismatches.join("\n"));
  assert.equal(verified.manifestDigest, scanned.manifestDigest);

  // A staged file that differs is found and asked for again.
  const staging = stagingDir(target.path, migrationId);
  writeFileSync(join(staging, "folder", "hello.txt"), "HELLO\n");
  verified = await verifyStaging({ migrationId, path: target.path });
  assert.equal(verified.ok, false);
  assert.ok(verified.mismatches.some((m) => m.startsWith("folder:hello.txt")));
  const again = await transfer(source, target);
  assert.equal(again.received.value.received, 1);
  assert.equal(
    (await verifyStaging({ migrationId, path: target.path })).ok,
    true,
  );

  // A change on the source is found by the rescan and sent as a delta.
  assert.equal(
    (await rescanForMigration(source.input, { stateDir: source.stateDir }))
      .changed,
    false,
  );
  writeFileSync(join(source.folder, "sub", "dir", "nested.txt"), "changed\n");
  const rescanned = await rescanForMigration(source.input, {
    stateDir: source.stateDir,
  });
  assert.equal(rescanned.changed, true);
  assert.ok(rescanned.changes.includes("folder:sub/dir/nested.txt"));
  const delta = await transfer(source, target);
  assert.equal(delta.received.value.received, 1);
  verified = await verifyStaging({ migrationId, path: target.path });
  assert.equal(verified.ok, true, verified.mismatches.join("\n"));
  assert.equal(verified.manifestDigest, rescanned.manifestDigest);

  // Activation, as the target device.
  const activateInput = {
    migrationId,
    workspaceId,
    name: "app",
    path: target.path,
    previousPath: source.folder,
    nativeSessions: source.input.nativeSessions,
  };
  const activateOptions = {
    homes: target.locations,
    store: target.store,
    stateDir: target.stateDir,
  };
  const activated = await activateMigration(activateInput, activateOptions);
  assert.equal(existsSync(staging), false);
  const file = JSON.parse(
    readFileSync(join(target.path, ".foundry", "workspace.json"), "utf8"),
  );
  assert.equal(file.id, workspaceId);
  assert.equal(file.path, target.path);
  assert.equal(file.baseline, "trunk");
  assert.equal(
    readFileSync(join(target.path, "sub", "dir", "nested.txt"), "utf8"),
    "changed\n",
  );
  assert.equal(statSync(join(target.path, "script.sh")).mode & 0o777, 0o755);
  assert.equal(statSync(join(target.path, "empty")).size, 0);
  assert.equal(statSync(join(target.path, "rodir")).mode & 0o777, 0o555);
  assert.equal(
    readFileSync(join(target.path, "rodir", "inside.txt"), "utf8"),
    "inside\n",
  );
  assert.equal(
    statSync(join(target.path, "big.bin")).size,
    5 * 1024 * 1024 + 123,
  );
  assert.ok(statSync(join(target.path, "emptydir")).isDirectory());
  assert.equal(readlinkSync(join(target.path, "link")), "hello.txt");
  assert.equal(readlinkSync(join(target.path, "external")), "/etc/hostname");
  assert.equal(
    existsSync(join(target.path, ".agents", "skills", "foo")),
    false,
  );
  assert.ok(lstatSync(join(target.path, ".agents", "skills")).isDirectory());

  const newSlug = claudeProjectDirectoryName(target.path);
  assert.notEqual(newSlug, source.slug);
  const projects = join(target.locations.claude.default, "projects", newSlug);
  assert.ok(existsSync(join(projects, "claude-session-1.jsonl")));
  assert.ok(existsSync(join(projects, "claude-session-2.jsonl")));
  assert.ok(existsSync(join(projects, "memory", "MEMORY.md")));
  assert.ok(
    existsSync(
      join(
        target.locations.codex.default,
        "sessions",
        "2026",
        "11",
        "06",
        "rollout-2026-11-06T00-00-00-codex-thread-1.jsonl",
      ),
    ),
  );
  assert.deepEqual(activated.nativeSessions, {
    copied: 3,
    alreadyThere: 0,
    notFound: 0,
  });
  assert.equal(activated.previousExecutionRoot, source.execution);
  assert.equal(
    activated.executionRoot,
    target.store.workspaceRoot(workspaceId),
  );

  const worktree = join(
    activated.executionRoot,
    "environments",
    "iss_1",
    "workspace",
  );
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "iss1");
  assert.equal(
    realpathSync(git(worktree, "rev-parse", "--git-common-dir")),
    realpathSync(join(target.path, ".git")),
  );
  assert.ok(git(target.path, "worktree", "list").includes(worktree));
  const registration = target.store.registration(workspaceId);
  assert.equal(registration.sourcePath, target.path);
  assert.equal(
    registration.repositories[0].gitDirectory,
    join(target.path, ".git"),
  );
  const pointer = JSON.parse(
    readFileSync(
      join(activated.executionRoot, "environment-locations", "iss_1.json"),
      "utf8",
    ),
  );
  assert.equal(
    pointer.path,
    join(activated.executionRoot, "environments", "iss_1", "environment.json"),
  );
  assert.equal(
    readRegistry().find((entry) => entry.id === workspaceId)?.path,
    target.path,
  );
  const repeated = await activateMigration(activateInput, activateOptions);
  assert.equal(repeated.workspace.path, target.path);

  // Retiring and purging, as the source device.
  writeRegistry([
    {
      id: workspaceId,
      name: "app",
      path: source.folder,
      baseline: "trunk",
      registeredAt: "2026-10-01T00:00:00.000Z",
    },
  ]);
  await assert.rejects(
    purgeMigratedSource(
      { migrationId, workspaceId, confirm: true },
      { stateDir: source.stateDir },
    ),
    /still served/,
  );
  retireMigratedWorkspace(
    { migrationId, workspaceId, targetDeviceId: "dev_target" },
    { stateDir: source.stateDir },
  );
  assert.equal(
    readRegistry().some((entry) => entry.id === workspaceId),
    false,
  );
  const forgotten = readForgottenWorkspaces().find(
    (entry) => entry.id === workspaceId,
  );
  assert.equal(forgotten.migratedTo, "dev_target");
  assert.equal(forgotten.migrationId, migrationId);
  assert.ok(
    existsSync(join(source.folder, "hello.txt")),
    "retiring deletes nothing",
  );

  const uploads = join(root, "chat-uploads");
  mkdirSync(uploads);
  writeFileSync(join(uploads, "a.json"), JSON.stringify({ workspaceId }));
  writeFileSync(
    join(uploads, "b.json"),
    JSON.stringify({ workspaceId: "ws_other" }),
  );
  const purgeOptions = { stateDir: source.stateDir, chatUploadsDir: uploads };
  const preview = await purgeMigratedSource(
    { migrationId, workspaceId, confirm: false },
    purgeOptions,
  );
  assert.equal(preview.done, false);
  assert.ok(preview.removed.includes(realpathSync(source.folder)));
  assert.ok(preview.bytes > 5 * 1024 * 1024);
  assert.ok(
    existsSync(join(source.folder, "hello.txt")),
    "a preview removes nothing",
  );

  writeFileSync(join(source.folder, "hello.txt"), "edited after the move\n");
  writeFileSync(join(source.folder, "new-file.txt"), "new\n");
  const refused = await purgeMigratedSource(
    { migrationId, workspaceId, confirm: true },
    purgeOptions,
  );
  assert.equal(refused.done, false);
  assert.ok(refused.changed.includes(join(source.folder, "hello.txt")));
  assert.ok(refused.changed.includes(join(source.folder, "new-file.txt")));
  assert.ok(existsSync(join(source.folder, "hello.txt")));
  assert.equal(existsSync(join(source.folder, "script.sh")), false);
  assert.ok(existsSync(join(uploads, "a.json")));

  const finished = await purgeMigratedSource(
    { migrationId, workspaceId, confirm: true, includeChanged: true },
    purgeOptions,
  );
  assert.equal(finished.done, true);
  assert.equal(existsSync(source.folder), false);
  assert.equal(
    existsSync(join(source.locations.claude.default, "projects", source.slug)),
    false,
  );
  assert.equal(
    existsSync(
      join(
        source.locations.claude.default,
        "projects",
        "-elsewhere",
        "claude-session-2.jsonl",
      ),
    ),
    false,
  );
  assert.equal(
    existsSync(
      join(source.day, "rollout-2026-11-06T00-00-00-codex-thread-1.jsonl"),
    ),
    false,
  );
  assert.ok(
    existsSync(
      join(source.day, "rollout-2026-11-06T00-00-00-codex-unrelated.jsonl"),
    ),
  );
  assert.equal(existsSync(source.execution), false);
  assert.equal(existsSync(source.stateDir), false);
  assert.equal(existsSync(join(uploads, "a.json")), false);
  assert.ok(existsSync(join(uploads, "b.json")));
  assert.ok(
    existsSync(join(source.state, "skill-sets")),
    "nothing outside the recorded roots goes",
  );
});

test("the target refuses a manifest that writes through a link", async (t) => {
  const root = scratch(t);
  const target = targetDevice(root);
  const { manifestDigest } =
    await import("../dist/daemon/workspace-migration/manifest.js");
  const entries = [
    {
      root: "folder",
      path: "escape",
      type: "symlink",
      size: 0,
      mode: 0o777,
      mtimeMs: 0,
      target: "/tmp",
    },
    {
      root: "folder",
      path: "escape/owned",
      type: "file",
      size: 1,
      mode: 0o644,
      mtimeMs: 0,
      sha256: "a".repeat(64),
    },
  ];
  const header = {
    version: 1,
    migrationId,
    workspaceId,
    folder: "/x",
    executionRoot: "/y",
    roots: { folder: { kind: "folder", path: "/x", scopes: [""] } },
    nativeSessions: [],
    scannedAt: "",
    digest: manifestDigest(entries),
    entries: 2,
    files: 1,
    bytes: 1,
  };
  const pair = streamPair();
  const fakeSource = (async () => {
    const reader = new FrameReader(pair.source);
    await writeFrame(pair.source, frameKinds.hello, {
      jobId: migrationId,
      role: "source",
    });
    await reader.expect();
    await writeFrame(
      pair.source,
      frameKinds.manifest,
      Buffer.from(
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      ),
    );
    await writeFrame(pair.source, frameKinds.manifestEnd, header);
    const reply = await reader.next();
    pair.source.end();
    return reply;
  })();
  await assert.rejects(
    runTarget(pair.target, { migrationId, path: target.path }),
    /through a link/,
  );
  pair.target.destroy();
  await fakeSource.catch(() => undefined);
  await assert.rejects(
    (async () => {
      const bad = streamPair();
      const reader = new FrameReader(bad.source);
      const running = runTarget(bad.target, { migrationId, path: target.path });
      await writeFrame(bad.source, frameKinds.hello, {
        jobId: migrationId,
        role: "source",
      });
      await reader.expect();
      await writeFrame(
        bad.source,
        frameKinds.manifest,
        Buffer.from(
          `${JSON.stringify({ ...entries[1], path: "../outside" })}\n`,
        ),
      );
      return running;
    })(),
    /unsafe path/,
  );
});

test("both workers dial the server's relay and transfer over WebSockets", async (t) => {
  const { WebSocketServer } = await import("ws");
  const { createServer } = await import("node:http");
  const { startMigrationTransfer } =
    await import("../dist/daemon/workspace-migration/transfer.js");
  const root = scratch(t);
  const source = sourceDevice(root);
  const target = targetDevice(root);
  await scanForMigration(source.input, { stateDir: source.stateDir });

  // The relay: pairs the two streams of a migration and copies messages.
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const waiting = new Map();
  const seenHeaders = [];
  server.on("upgrade", (request, socket, head) => {
    const match = /^\/api\/daemon\/migration-streams\/([\w-]+)$/.exec(
      request.url,
    );
    if (!match) return socket.destroy();
    seenHeaders.push(request.headers["x-test-device"]);
    wss.handleUpgrade(request, socket, head, (ws) => {
      // As the server does, nothing is read before both ends are there.
      const held = [];
      const hold = (data) => held.push(data);
      ws.on("message", hold);
      const pairKey = match[1].replace(/-(source|target)$/, "");
      const other = waiting.get(pairKey);
      if (!other) return waiting.set(pairKey, { ws, held, hold });
      waiting.delete(pairKey);
      const mine = { ws, held, hold };
      for (const [from, to] of [
        [mine, other],
        [other, mine],
      ]) {
        from.ws.off("message", from.hold);
        for (const data of from.held) to.ws.send(data);
        from.ws.on("message", (data) => to.ws.send(data));
        from.ws.on("close", () => to.ws.close());
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((done) => server.once("listening", done));
  t.after(() => {
    wss.close();
    server.close();
  });
  const serverURL = `http://127.0.0.1:${server.address().port}`;
  const news = [];
  const finished = (role) =>
    new Promise((done) => {
      setTimeout(() => done({ phase: "timeout" }), 60_000).unref();
      const check = setInterval(() => {
        const last = news.filter((item) => item.role === role).at(-1);
        if (last && ["sent", "received", "failed"].includes(last.phase)) {
          clearInterval(check);
          done(last);
        }
      }, 20);
    });
  // The source's manifest is the one kept; the source module reads the
  // default state folder, so the stored manifest is placed there.
  const { migrationStateDir } =
    await import("../dist/daemon/workspace-migration/manifest.js");
  mkdirSync(join(migrationStateDir(migrationId), ".."), { recursive: true });
  execFileSync("cp", ["-r", source.stateDir, migrationStateDir(migrationId)]);
  t.after(() =>
    rmSync(migrationStateDir(migrationId), { recursive: true, force: true }),
  );
  const common = {
    migrationId,
    workspaceId,
    nativeSessions: source.input.nativeSessions,
  };
  const options = {
    serverURL,
    headers: () => ({ "x-test-device": "credential" }),
    send: (item) => news.push(item),
  };
  await startMigrationTransfer(
    {
      ...common,
      role: "source",
      streamId: "stream_abc123-source",
      path: source.folder,
    },
    options,
  );
  await startMigrationTransfer(
    {
      ...common,
      role: "target",
      streamId: "stream_abc123-target",
      path: target.path,
    },
    options,
  );
  const [sent, received] = await Promise.all([
    finished("source"),
    finished("target"),
  ]);
  assert.equal(sent.phase, "sent", sent.error);
  assert.equal(received.phase, "received", received.error);
  assert.deepEqual(seenHeaders, ["credential", "credential"]);
  const verified = await verifyStaging({ migrationId, path: target.path });
  assert.equal(verified.ok, true, verified.mismatches.join("\n"));
});
