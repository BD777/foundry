import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  computeBackend,
  computeOperations,
  resourceComputeCapability,
} from "@bd777/foundry-protocol";
import {
  createComputeDetector,
  createComputeProvider,
  ProviderRegistry,
  ResourceOperations,
  ResourceSettingsStore,
  runDetector,
  unpackArchive,
} from "../dist/resources/index.js";
import { daemonCapabilities } from "../dist/workspace-ops.js";

function harness({ allowed = true, workspaces = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "compute-"));
  const settings = { allowRemoteCommands: allowed };
  const provider = createComputeProvider({
    root: join(root, "compute"),
    settings: () => settings,
    workspacePaths: () => workspaces,
    env: () => process.env,
  });
  const operations = new ResourceOperations({
    providers: new ProviderRegistry([provider]),
    notify: async () => undefined,
  });
  let generation = 1;
  const operate = async (op, args = {}, lease = "lease_1") => {
    const result = await operations.operate({
      resourceId: "res_c",
      key: "compute",
      type: "compute",
      backend: computeBackend,
      leaseId: lease,
      generation,
      actions: [{ op, args }],
      deadlineMs: 60_000,
    });
    const outcome = result.results[0] ?? {
      ok: false,
      errorCode: result.errorCode,
      error: result.error,
    };
    return {
      ...outcome,
      value: outcome.text ? JSON.parse(outcome.text) : undefined,
    };
  };
  const reset = async () => {
    generation++;
    await operations.reset({
      resourceId: "res_c",
      key: "compute",
      type: "compute",
      generation,
      reason: "test",
    });
  };
  return {
    root,
    scratch: join(root, "compute"),
    settings,
    operate,
    reset,
    provider,
  };
}

test("compute runs commands in its scratch folder and answers exit code and tails", async () => {
  const { operate, scratch } = harness();
  const argv = await operate("run", {
    argv: [
      process.execPath,
      "-e",
      "console.log(process.cwd()); console.error('warn'); process.exit(3)",
    ],
  });
  assert.equal(argv.ok, true, argv.error);
  assert.equal(argv.value.exitCode, 3);
  assert.equal(argv.value.stdout.trim(), join(scratch, "default"));
  assert.equal(argv.value.stderr.trim(), "warn");
  assert.equal(argv.outcome.exitCode, 3);
  assert.equal(argv.outcome.cwd, "scratch default");

  const shell = await operate("run", {
    scratch: "build",
    command:
      'mkdir -p out && echo "$GREETING" > out/a.txt && printf 0123456789',
    env: { GREETING: "hi" },
    tailBytes: 4,
    saveOutput: "out/all.log",
  });
  assert.equal(shell.value.exitCode, 0);
  assert.equal(shell.value.stdout, "6789");
  assert.equal(shell.value.stdoutCut, true);
  assert.equal(shell.value.stdoutBytes, 10);
  assert.equal(
    readFileSync(join(scratch, "build", "out", "a.txt"), "utf8"),
    "hi\n",
  );
  assert.equal(
    readFileSync(join(scratch, "build", "out", "all.log"), "utf8"),
    "0123456789",
  );

  const sub = await operate("run", {
    scratch: "build",
    cwd: "out",
    argv: ["ls"],
  });
  assert.match(sub.value.stdout, /a\.txt/);
});

test("compute keeps commands inside the folder and refuses bad arguments", async () => {
  const { operate, scratch } = harness();
  assert.equal(
    (await operate("run", { cwd: "..", argv: ["pwd"] })).errorCode,
    "path_outside",
  );
  assert.equal(
    (await operate("run", { cwd: "/tmp", argv: ["pwd"] })).errorCode,
    "path_outside",
  );
  mkdirSync(join(scratch, "default"), { recursive: true });
  symlinkSync(tmpdir(), join(scratch, "default", "out"));
  assert.equal(
    (await operate("run", { cwd: "out", argv: ["pwd"] })).errorCode,
    "path_outside",
  );
  assert.equal(
    (await operate("get_file", { path: "out/x" })).errorCode,
    "path_outside",
  );
  assert.equal(
    (await operate("run", { scratch: "../x", argv: ["pwd"] })).errorCode,
    "invalid_args",
  );
  assert.equal(
    (await operate("run", { argv: ["pwd"], command: "pwd" })).errorCode,
    "invalid_args",
  );
  assert.equal(
    (await operate("run", { argv: ["pwd"], env: { "A-B": "1" } })).errorCode,
    "invalid_args",
  );
  assert.equal(
    (await operate("run", { argv: ["no-such-program-here"] })).errorCode,
    "command_not_found",
  );
  assert.equal(
    (await operate("run", { workspaceId: "ws_1", argv: ["pwd"] })).errorCode,
    "invalid_args",
  );
});

test("compute runs nothing while remote commands are off", async () => {
  const off = harness({ allowed: false });
  assert.equal(
    (await off.operate("run", { argv: ["pwd"] })).errorCode,
    "remote_commands_off",
  );

  const on = harness();
  assert.equal((await on.operate("run", { argv: ["true"] })).ok, true);
  on.settings.allowRemoteCommands = false;
  assert.equal(
    (await on.operate("run", { argv: ["true"] })).errorCode,
    "remote_commands_off",
  );
});

test("a run past its timeout is stopped and says so", async () => {
  const { operate } = harness();
  const started = Date.now();
  const result = await operate("run", {
    command: "echo start; sleep 20",
    timeoutSec: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.timedOut, true);
  assert.notEqual(result.value.exitCode, 0);
  assert.equal(result.value.stdout, "start\n");
  assert.ok(Date.now() - started < 10_000);
});

test("a background job outlives its run and stops when the lease ends", async () => {
  const { operate, reset, scratch } = harness();
  const started = await operate("run", {
    command: "nohup sleep 30 > job.log 2>&1 & echo $!",
    timeoutSec: 10,
  });
  assert.equal(started.ok, true);
  const pid = Number(started.value.stdout.trim());
  assert.ok(pid > 0);
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.ok(existsSync(join(scratch, "default", "job.log")));
  await reset();
  await new Promise((done) => setTimeout(done, 200));
  assert.throws(() => process.kill(pid, 0));
});

test("put_files takes a file in pieces and unpacks a tar.gz, refusing a wrong offset", async () => {
  const { operate, scratch } = harness();
  const first = await operate("put_files", {
    upload: "p",
    offset: 0,
    data: Buffer.from("hello ").toString("base64"),
  });
  assert.equal(first.value.received, 6);
  const wrong = await operate("put_files", {
    upload: "p",
    offset: 3,
    data: "",
  });
  assert.equal(wrong.errorCode, "upload_offset");
  const last = await operate("put_files", {
    upload: "p",
    offset: 6,
    data: Buffer.from("world").toString("base64"),
    done: true,
    format: "file",
    dest: "in/patch.diff",
  });
  assert.equal(last.ok, true, last.error);
  assert.equal(
    readFileSync(join(scratch, "default", "in", "patch.diff"), "utf8"),
    "hello world",
  );

  const source = mkdtempSync(join(tmpdir(), "compute-src-"));
  mkdirSync(join(source, "a", "b"), { recursive: true });
  writeFileSync(join(source, "a", "b", "c.txt"), "deep");
  writeFileSync(join(source, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  symlinkSync("a/b/c.txt", join(source, "link"));
  const archive = execFileSync("tar", [
    "-czf",
    "-",
    "-C",
    source,
    "a",
    "run.sh",
    "link",
  ]);
  const unpacked = await operate("put_files", {
    upload: "t",
    offset: 0,
    data: archive.toString("base64"),
    done: true,
    format: "tar.gz",
    dest: "repo",
  });
  assert.equal(unpacked.ok, true, unpacked.error);
  assert.equal(unpacked.value.files, 2);
  assert.equal(
    readFileSync(join(scratch, "default", "repo", "a", "b", "c.txt"), "utf8"),
    "deep",
  );
  assert.equal(
    readlinkSync(join(scratch, "default", "repo", "link")),
    "a/b/c.txt",
  );
  assert.equal(
    (await operate("run", { cwd: "repo", argv: ["./run.sh"] })).value.exitCode,
    0,
  );
});

test("get_file reads a file, in ranges", async () => {
  const { operate, scratch } = harness();
  mkdirSync(join(scratch, "default"), { recursive: true });
  writeFileSync(join(scratch, "default", "out.txt"), "0123456789");
  const whole = await operate("get_file", { path: "out.txt" });
  assert.equal(
    Buffer.from(whole.value.data, "base64").toString(),
    "0123456789",
  );
  assert.equal(whole.value.truncated, false);
  assert.equal(whole.outcome.bytes, 10);
  const part = await operate("get_file", {
    path: "out.txt",
    offset: 4,
    length: 3,
  });
  assert.equal(Buffer.from(part.value.data, "base64").toString(), "456");
  assert.equal(part.value.truncated, true);
  assert.equal(
    (await operate("get_file", { path: "none.txt" })).errorCode,
    "not_found",
  );
});

test("a workspace is used only when the worker serves its folder", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "compute-ws-"));
  const { operate } = harness({ workspaces: [workspace] });
  const inside = await operate("run", {
    workspaceId: "ws_1",
    workspacePath: workspace,
    argv: ["pwd"],
  });
  assert.equal(
    inside.value.stdout.trim().endsWith(workspace.split("/").pop()),
    true,
  );
  assert.equal(inside.outcome.cwd, "workspace ws_1");
  const other = mkdtempSync(join(tmpdir(), "compute-other-"));
  assert.equal(
    (
      await operate("run", {
        workspaceId: "ws_2",
        workspacePath: other,
        argv: ["pwd"],
      })
    ).errorCode,
    "workspace_not_served",
  );
  assert.equal(
    (
      await operate("cleanup", {
        workspaceId: "ws_1",
        workspacePath: workspace,
      })
    ).errorCode,
    "invalid_args",
  );
});

test("cleanup deletes a scratch folder or a path in it", async () => {
  const { operate, scratch } = harness();
  await operate("run", {
    scratch: "s",
    command: "mkdir -p a b && touch a/x b/y",
  });
  assert.equal(
    (await operate("cleanup", { scratch: "s", path: "a" })).ok,
    true,
  );
  assert.equal(existsSync(join(scratch, "s", "a")), false);
  assert.equal(existsSync(join(scratch, "s", "b", "y")), true);
  assert.equal(
    (await operate("cleanup", { scratch: "s", path: "../.." })).errorCode,
    "path_outside",
  );
  assert.equal((await operate("cleanup", { scratch: "s" })).ok, true);
  assert.equal(existsSync(join(scratch, "s")), false);
});

test("git_sync takes https remotes without credentials only", async () => {
  const { operate } = harness();
  assert.equal(
    (await operate("git_sync", { url: "file:///tmp/repo" })).errorCode,
    "invalid_args",
  );
  assert.equal(
    (await operate("git_sync", { url: "https://user:pw@example.com/r.git" }))
      .errorCode,
    "invalid_args",
  );
  assert.equal(
    (
      await operate("git_sync", {
        url: "https://example.com/r.git",
        ref: "--upload-pack=x",
      })
    ).errorCode,
    "invalid_args",
  );
});

/** A tar entry: a 512-byte ustar header and its padded body. */
function tarEntry(name, body = "", type = "0", link = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000644\0", 100);
  header.write(
    `${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`,
    124,
  );
  header.write(type, 156);
  header.write(link, 157);
  header.write("ustar\0", 257);
  const padded = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512);
  padded.write(body);
  return Buffer.concat([header, padded]);
}

test("unpacking refuses entries that leave the folder", async () => {
  const end = Buffer.alloc(1024);
  for (const [name, entry] of [
    ["parent", tarEntry("../escape.txt", "x")],
    ["absolute", tarEntry("/tmp/escape.txt", "x")],
    ["link out", tarEntry("out", "", "2", "../../etc")],
    ["absolute link", tarEntry("out", "", "2", "/etc")],
    ["hard link", tarEntry("h", "", "1", "a")],
  ]) {
    const dest = mkdtempSync(join(tmpdir(), "unpack-"));
    await assert.rejects(
      unpackArchive(Buffer.concat([entry, end]), "tar", dest),
      /ArchiveError|folder|absolute|hard link/,
      name,
    );
  }
  // A link already in the folder that points out is not written through.
  const dest = mkdtempSync(join(tmpdir(), "unpack-"));
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  symlinkSync(outside, join(dest, "ext"));
  await assert.rejects(
    unpackArchive(
      Buffer.concat([tarEntry("ext/new/file.txt", "x"), end]),
      "tar",
      dest,
    ),
    /outside the folder/,
  );
  assert.equal(existsSync(join(outside, "new")), false);
});

/** A zip of stored and deflated files. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body, deflate] of files) {
    const data = Buffer.from(body);
    const stored = deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(Buffer.byteLength(name), 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(Buffer.byteLength(name), 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    const entry = Buffer.concat([local, Buffer.from(name), stored]);
    locals.push(entry);
    centrals.push(Buffer.concat([central, Buffer.from(name)]));
    offset += entry.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("unpacking a zip writes stored and deflated files", async () => {
  const dest = mkdtempSync(join(tmpdir(), "unzip-"));
  const files = await unpackArchive(
    zip([
      ["dir/", "", false],
      ["dir/a.txt", "stored", false],
      ["b.txt", "deflated ".repeat(50), true],
    ]),
    "zip",
    dest,
  );
  assert.equal(files, 2);
  assert.equal(readFileSync(join(dest, "dir", "a.txt"), "utf8"), "stored");
  assert.equal(
    readFileSync(join(dest, "b.txt"), "utf8"),
    "deflated ".repeat(50),
  );
  await assert.rejects(
    unpackArchive(zip([["../x", "x", false]]), "zip", dest),
    /goes up/,
  );
});

test("the compute instance is ready only while remote commands are allowed", async () => {
  const settings = { allowRemoteCommands: false };
  const detector = createComputeDetector(() => settings);
  const off = await runDetector(detector, { platform: "linux" });
  const [instance] = off.instances;
  assert.equal(instance.key, "compute");
  assert.equal(instance.type, "compute");
  assert.equal(instance.readiness.ready, false);
  assert.deepEqual(instance.readiness.missing, ["remote_commands_off"]);
  assert.equal(instance.backends[0].id, computeBackend);
  assert.equal(instance.backends[0].mode, "remote_ops");
  assert.ok(Number(instance.details.cpus) >= 1);
  assert.ok(instance.details.loadAvg !== undefined);
  settings.allowRemoteCommands = true;
  const on = await runDetector(detector, { platform: "linux" });
  assert.equal(on.instances[0].readiness.ready, true);
});

test("the settings a worker was sent persist, on by default", () => {
  const folder = mkdtempSync(join(tmpdir(), "settings-"));
  const path = join(folder, "resources", "settings.json");
  assert.deepEqual(new ResourceSettingsStore(path).get(), {
    allowRemoteCommands: true,
  });
  assert.deepEqual(
    new ResourceSettingsStore(path).set({ allowRemoteCommands: false }),
    { allowRemoteCommands: false },
  );
  assert.deepEqual(new ResourceSettingsStore(path).get(), {
    allowRemoteCommands: false,
  });
  assert.deepEqual(
    new ResourceSettingsStore(path).set({ allowRemoteCommands: true }),
    { allowRemoteCommands: true },
  );
  assert.deepEqual(new ResourceSettingsStore(path).get(), {
    allowRemoteCommands: true,
  });
  assert.deepEqual(
    new ResourceSettingsStore(path).set({ allowRemoteCommands: "yes" }),
    { allowRemoteCommands: false },
  );
});

test("the worker declares compute and the protocol lists its operations", () => {
  assert.ok(daemonCapabilities.includes(resourceComputeCapability));
  assert.deepEqual(
    [...computeOperations],
    ["run", "put_files", "get_file", "git_sync", "cleanup"],
  );
});
