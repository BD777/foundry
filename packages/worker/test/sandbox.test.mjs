import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isSandboxError,
  sandboxAvailable,
  sandboxLaunch,
  sandboxLauncher,
} from "../dist/sandbox/index.js";
import { seatbeltBackend } from "../dist/sandbox/darwin.js";
import { privateTmpAllowed } from "../dist/sandbox/linux.js";

const runtimeRoot = realpathSync(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const supported = (kind) => ({ skip: !sandboxAvailable(kind) });

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "foundry-sandbox-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(launch, cwd) {
  return spawnSync(launch.command, launch.args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
}

test("each profile kind declares its verified platforms", () => {
  assert.equal(sandboxAvailable("writable_tree", "darwin"), true);
  assert.equal(sandboxAvailable("writable_tree", "linux"), true);
  assert.equal(sandboxAvailable("offline_command", "linux"), true);
  assert.equal(sandboxAvailable("readonly_agent", "darwin"), true);
  assert.equal(sandboxAvailable("readonly_agent", "linux"), true);
  assert.equal(sandboxAvailable("loopback_service", "darwin"), true);
  assert.equal(sandboxAvailable("loopback_service", "linux"), true);
  for (const kind of [
    "writable_tree",
    "readonly_agent",
    "offline_command",
    "loopback_service",
  ])
    assert.equal(sandboxAvailable(kind, "win32"), false);
});

test(
  "Linux loopback service reaches nothing on the host and is reached only through its socket",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = scratch(t);
    // Unix socket paths are limited to about 100 bytes.
    const socketDirectory = mkdtempSync("/tmp/fdy-test-");
    t.after(() => rmSync(socketDirectory, { recursive: true, force: true }));
    const host = createServer((_, res) => res.end("host secret"));
    await new Promise((done) => host.listen(0, "127.0.0.1", done));
    t.after(() => host.close());
    const service = join(root, "service.mjs");
    writeFileSync(
      service,
      [
        'import http from "node:http";',
        'import { writeFileSync } from "node:fs";',
        "const probe = async () => {",
        "  const reached = await fetch(process.argv[2]).then(() => true, () => false);",
        "  let wrote = true;",
        "  try { writeFileSync(process.argv[3], 'x'); } catch { wrote = false; }",
        "  return JSON.stringify({ reached, wrote });",
        "};",
        "const server = http.createServer(async (_, res) => res.end(await probe()));",
        "server.listen(process.argv[4], () => process.send('listening'));",
        'process.on("disconnect", () => process.exit(0));',
      ].join("\n"),
    );
    const launch = sandboxLaunch(
      {
        kind: "loopback_service",
        policyFile: join(root, "service.sb"),
        readRoots: [root],
        socketDirectory,
      },
      process.execPath,
      [],
    );
    assert.equal(launch.endpoint.kind, "unix");
    const child = spawn(
      launch.command,
      [
        ...launch.args,
        service,
        `http://127.0.0.1:${host.address().port}/`,
        join(root, "written.txt"),
        launch.endpoint.servicePath,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    t.after(() => child.kill("SIGKILL"));
    await new Promise((done) => child.once("message", done));
    const body = await new Promise((done, reject) =>
      httpGet({ socketPath: launch.endpoint.hostPath, path: "/" }, (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk)).on("end", () => done(text));
      }).on("error", reject),
    );
    assert.deepEqual(JSON.parse(body), { reached: false, wrote: false });
    assert.equal(existsSync(join(root, "written.txt")), false);
  },
);

test("macOS offline command policy denies network and keeps the checker read-only", (t) => {
  const root = scratch(t);
  const candidate = join(root, "candidate");
  const output = join(root, "output");
  const policyFile = join(root, "checker.sb");
  const launch = seatbeltBackend.launch(
    {
      kind: "offline_command",
      policyFile,
      workdir: candidate,
      readRoots: [candidate],
      writeRoot: output,
      readOnlyPaths: [join(output, "checker")],
    },
    "/bin/echo",
    ["hi"],
  );
  assert.deepEqual(launch, {
    command: "/usr/bin/sandbox-exec",
    args: ["-f", policyFile, "/bin/echo", "hi"],
  });
  const rules = readFileSync(policyFile, "utf8").split("\n");
  assert.equal(rules[1], "(deny default)");
  assert.ok(
    rules.includes(
      `(allow file-read-data (subpath ${JSON.stringify(candidate)}))`,
    ),
  );
  assert.ok(
    rules.includes(`(allow file-write* (subpath ${JSON.stringify(output)}))`),
  );
  assert.ok(
    rules.includes(
      `(deny file-write* (subpath ${JSON.stringify(join(output, "checker"))}))`,
    ),
  );
  assert.equal(
    rules.some((rule) => rule.includes("network")),
    false,
  );
});

test("macOS loopback service policy only listens on localhost and is written once", (t) => {
  const root = scratch(t);
  const profile = {
    kind: "loopback_service",
    policyFile: join(root, "service.sb"),
    readRoots: [root],
    socketDirectory: root,
  };
  const launch = seatbeltBackend.launch(profile, process.execPath, [
    "server.mjs",
  ]);
  assert.deepEqual(launch.endpoint, { kind: "loopback_tcp" });
  const rules = readFileSync(profile.policyFile, "utf8").split("\n");
  assert.ok(rules.includes('(allow network-bind (local tcp "localhost:*"))'));
  assert.equal(
    rules.some((rule) => rule.includes("network-outbound")),
    false,
  );
  assert.equal(statSync(profile.policyFile).mode & 0o777, 0o400);
  assert.throws(() => seatbeltBackend.launch(profile, process.execPath, []), {
    code: "EEXIST",
  });
});

test("macOS read-only agent policy confines writes to the private home", (t) => {
  const root = scratch(t);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const policyFile = join(root, "verifier.sb");
  const launch = seatbeltBackend.launch(
    {
      kind: "readonly_agent",
      policyFile,
      home,
      readRoots: [workspace],
      workdir: workspace,
    },
    process.execPath,
    [],
  );
  assert.deepEqual(launch.args, ["-f", policyFile, process.execPath]);
  const rules = readFileSync(policyFile, "utf8").split("\n");
  const writes = rules.filter((rule) => rule.startsWith("(allow file-write*"));
  assert.deepEqual(writes, [
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${JSON.stringify(home)}))`,
  ]);
  assert.equal(
    rules.some((rule) => rule.includes("deny network")),
    false,
  );
});

test(
  "a launcher runs the command inside the profile from its workdir, once",
  supported("readonly_agent"),
  (t) => {
    const root = scratch(t);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    const profile = {
      kind: "readonly_agent",
      policyFile: join(root, "verifier.sb"),
      home,
      readRoots: [workspace],
      workdir: workspace,
    };
    const launcherFile = join(root, "verifier-cli");
    let wrapper;
    try {
      wrapper = sandboxLauncher(profile, process.execPath, launcherFile);
    } catch (error) {
      if (isSandboxError(error, "user_namespaces_unavailable"))
        return t.skip(error.message);
      throw error;
    }
    assert.equal(wrapper, launcherFile);
    assert.equal(statSync(wrapper).mode & 0o777, 0o500);
    const script = readFileSync(wrapper, "utf8");
    assert.ok(
      script.startsWith(`#!/bin/sh\ncd '${workspace}' || exit 1\nexec '`),
    );
    assert.ok(script.endsWith(` "$@"\n`));
    const result = spawnSync(wrapper, ["-p", "process.cwd()"], {
      encoding: "utf8",
    });
    assert.equal(result.stdout.trim(), workspace);
    assert.throws(
      () => sandboxLauncher(profile, process.execPath, launcherFile),
      { code: "EEXIST" },
    );
  },
);

test(
  "read-only agents reject unreadable workdirs and missing executables",
  supported("readonly_agent"),
  (t) => {
    const root = scratch(t);
    const home = join(root, "home");
    mkdirSync(home);
    const profile = {
      kind: "readonly_agent",
      policyFile: join(root, "p.sb"),
      home,
      readRoots: [],
    };
    assert.throws(
      () => sandboxLaunch({ ...profile, workdir: root }, process.execPath, []),
      (error) => isSandboxError(error, "workdir_not_readable"),
    );
    assert.throws(
      () => sandboxLaunch(profile, "foundry-missing-executable", []),
      (error) => isSandboxError(error, "executable_missing"),
    );
  },
);

function linuxBackend(t, launch) {
  try {
    return launch();
  } catch (error) {
    if (
      isSandboxError(error, "backend_missing") ||
      isSandboxError(error, "user_namespaces_unavailable")
    ) {
      t.skip(`bubblewrap unavailable: ${error.message}`);
      return undefined;
    }
    throw error;
  }
}

test(
  "Linux offline command writes only its output and keeps inputs read-only",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = scratch(t);
    const candidate = join(root, "candidate");
    const output = join(root, "output");
    mkdirSync(candidate);
    mkdirSync(join(output, "checker"), { recursive: true });
    const attempt = (target) =>
      linuxBackend(t, () =>
        sandboxLaunch(
          {
            kind: "offline_command",
            policyFile: join(root, "checker.sb"),
            workdir: candidate,
            readRoots: [candidate],
            writeRoot: output,
            readOnlyPaths: [join(output, "checker")],
          },
          "/bin/sh",
          ["-c", `echo probe > '${target}'`],
        ),
      );
    const allowed = attempt(join(output, "result"));
    if (!allowed) return;
    assert.equal(run(allowed, candidate).status, 0);
    assert.equal(readFileSync(join(output, "result"), "utf8"), "probe\n");
    assert.notEqual(
      run(attempt(join(candidate, "tampered")), candidate).status,
      0,
    );
    assert.notEqual(
      run(attempt(join(output, "checker", "tampered")), candidate).status,
      0,
    );
    assert.equal(existsSync(join(candidate, "tampered")), false);
  },
);

test(
  "Linux writable tree keeps read-only directories and paths inside writable roots",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = scratch(t);
    const source = join(root, "source");
    const tree = join(root, "tree");
    mkdirSync(source);
    mkdirSync(tree);
    writeFileSync(join(tree, ".git"), "gitdir: elsewhere\n");
    const locked = join(tree, "locked");
    const attempt = (target) =>
      linuxBackend(t, () =>
        sandboxLaunch(
          {
            kind: "writable_tree",
            policyFile: join(root, "executor.sb"),
            workdir: tree,
            readRoots: [source],
            writeRoots: [tree],
            protectedReadRoots: [],
            readOnlyDirectories: [locked],
            readOnlyPaths: [join(tree, ".git")],
            connectSockets: [],
            executables: [],
            userFiles: "hidden",
            userFiles: "hidden",
          },
          "/bin/sh",
          ["-c", `echo probe > '${target}'`],
        ),
      );
    const allowed = attempt(join(tree, "result"));
    if (!allowed) return;
    assert.equal(
      existsSync(locked),
      true,
      "read-only directories are created when missing",
    );
    assert.equal(run(allowed, tree).status, 0);
    assert.equal(readFileSync(join(tree, "result"), "utf8"), "probe\n");
    for (const target of [
      join(locked, "x"),
      join(tree, ".git"),
      join(source, "x"),
    ])
      assert.notEqual(run(attempt(target), tree).status, 0, target);
    assert.equal(
      readFileSync(join(tree, ".git"), "utf8"),
      "gitdir: elsewhere\n",
    );
  },
);

test(
  "Linux read-only agent reads its roots, writes only its home and resolves names",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = scratch(t);
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    writeFileSync(join(workspace, "README"), "hello\n");
    const attempt = (script) =>
      linuxBackend(t, () =>
        sandboxLaunch(
          {
            kind: "readonly_agent",
            policyFile: join(root, "verifier.sb"),
            home,
            readRoots: [workspace],
            workdir: workspace,
          },
          "/bin/sh",
          ["-c", script],
        ),
      );
    const read = attempt("cat README && echo note > " + join(home, "note"));
    if (!read) return;
    const result = run(read, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "hello\n");
    assert.equal(readFileSync(join(home, "note"), "utf8"), "note\n");
    assert.notEqual(run(attempt("echo x > README"), workspace).status, 0);
    assert.equal(readFileSync(join(workspace, "README"), "utf8"), "hello\n");
    // Host name-resolution configuration is present, as on macOS.
    assert.equal(run(attempt("getent hosts localhost"), workspace).status, 0);
    // The Foundry runtime is not mounted for read-only agents.
    assert.notEqual(
      run(attempt(`ls '${runtimeRoot}/package.json'`), workspace).status,
      0,
    );
  },
);

/** Foundry's own state outside /tmp, as in a real deployment (~/.foundry). */
function stateOutsideTmp(t) {
  const previous = process.env.FOUNDRY_STATE_ROOT;
  process.env.FOUNDRY_STATE_ROOT = "/nonexistent-foundry-state";
  t.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = previous;
  });
}

const outsideTmpTree = {
  kind: "writable_tree",
  policyFile: "/nonexistent-foundry-state/executor.sb",
  workdir: runtimeRoot,
  readRoots: [],
  writeRoots: [],
  protectedReadRoots: [],
  readOnlyDirectories: [],
  readOnlyPaths: [],
  connectSockets: [],
  executables: [],
  userFiles: "hidden",
};

test("a private /tmp is given only when no Foundry path lives under /tmp", (t) => {
  stateOutsideTmp(t);
  assert.equal(privateTmpAllowed(outsideTmpTree), true);
  // A socket directly in /tmp has no Foundry neighbours to expose.
  assert.equal(
    privateTmpAllowed({
      ...outsideTmpTree,
      connectSockets: ["/tmp/foundry-tools.sock"],
    }),
    true,
  );
  assert.equal(
    privateTmpAllowed({
      ...outsideTmpTree,
      writeRoots: ["/tmp/state/environments/iss/workspace"],
    }),
    false,
  );
  process.env.FOUNDRY_STATE_ROOT = scratch(t);
  assert.equal(
    privateTmpAllowed(outsideTmpTree),
    !realpathSync(process.env.FOUNDRY_STATE_ROOT).startsWith("/tmp/"),
  );
});

test(
  "Linux writable tree writes its own private /tmp, never the host's",
  { skip: process.platform !== "linux" },
  (t) => {
    stateOutsideTmp(t);
    const marker = `foundry-private-tmp-${process.pid}-${Date.now()}`;
    const launch = linuxBackend(t, () =>
      sandboxLaunch(outsideTmpTree, "/bin/sh", [
        "-c",
        `echo x > /tmp/${marker} && cat /tmp/${marker}`,
      ]),
    );
    if (!launch) return;
    const result = run(launch, runtimeRoot);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "x\n");
    assert.equal(existsSync(join("/tmp", marker)), false);
  },
);

test(
  "Linux writable tree hides the runtime's server data",
  {
    skip:
      process.platform !== "linux" ||
      !existsSync(join(runtimeRoot, "apps/server/.data")),
  },
  (t) => {
    const root = scratch(t);
    const launch = linuxBackend(t, () =>
      sandboxLaunch(
        {
          kind: "writable_tree",
          policyFile: join(root, "executor.sb"),
          workdir: root,
          readRoots: [],
          writeRoots: [root],
          protectedReadRoots: [],
          readOnlyDirectories: [],
          readOnlyPaths: [],
          connectSockets: [],
          executables: [],
          userFiles: "hidden",
        },
        "/bin/sh",
        [
          "-c",
          `ls -A '${runtimeRoot}/apps/server/.data' | wc -l && test -f '${runtimeRoot}/package.json'`,
        ],
      ),
    );
    if (!launch) return;
    const result = run(launch, root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "0");
  },
);

/**
 * An installed worker runs from ~/.foundry/runtime, inside the state the
 * sandbox hides. Its own code must stay readable; the rest of the state not.
 * The checkout's parent stands in for that state directory here.
 */
function runtimeInsideState(t) {
  const state = dirname(runtimeRoot);
  const previous = {
    HOME: process.env.HOME,
    FOUNDRY_STATE_ROOT: process.env.FOUNDRY_STATE_ROOT,
  };
  // The executor reads the person's files, so the state is visible inside
  // the mounted home unless the sandbox masks it.
  process.env.HOME = dirname(state);
  process.env.FOUNDRY_STATE_ROOT = state;
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const sibling = readdirSync(state).find(
    (name) => join(state, name) !== runtimeRoot,
  );
  return { state, sibling: sibling && join(state, sibling) };
}

test(
  "Linux writable tree keeps an installed runtime readable inside hidden state",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = scratch(t);
    const { sibling } = runtimeInsideState(t);
    const launch = linuxBackend(t, () =>
      sandboxLaunch(
        {
          kind: "writable_tree",
          policyFile: join(root, "executor.sb"),
          workdir: root,
          readRoots: [],
          writeRoots: [root],
          protectedReadRoots: [],
          readOnlyDirectories: [],
          readOnlyPaths: [],
          connectSockets: [],
          executables: [],
          userFiles: "readable",
        },
        "/bin/sh",
        [
          "-c",
          `test -f '${runtimeRoot}/packages/worker/dist/session/host-child.js' && ! test -e '${sibling ?? "/nonexistent"}'`,
        ],
      ),
    );
    if (!launch) return;
    const result = run(launch, root);
    assert.equal(result.status, 0, result.stderr);
  },
);

test(
  "macOS writable tree keeps an installed runtime readable inside hidden state",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = scratch(t);
    const { state } = runtimeInsideState(t);
    const policyFile = join(root, "executor.sb");
    seatbeltBackend.launch(
      {
        kind: "writable_tree",
        policyFile,
        workdir: root,
        readRoots: [],
        writeRoots: [root],
        protectedReadRoots: [],
        readOnlyDirectories: [],
        readOnlyPaths: [],
        connectSockets: [],
        executables: [],
        userFiles: "readable",
      },
      "/bin/echo",
      ["hi"],
    );
    const rules = readFileSync(policyFile, "utf8").split("\n");
    const denied = rules.indexOf(
      `(deny file-read-data (subpath ${JSON.stringify(state)}))`,
    );
    const allowed = rules.lastIndexOf(
      `(allow file-read-data (subpath ${JSON.stringify(runtimeRoot)}))`,
    );
    assert.ok(denied >= 0 && allowed > denied, "the runtime is allowed last");
  },
);

/**
 * A scratch home with a user credential and Foundry governance state, so a
 * profile can be checked against both without touching the real home.
 */
function userHome(t) {
  const root = scratch(t);
  const home = join(root, "home");
  const state = join(home, ".foundry-state");
  mkdirSync(join(home, ".config/tool"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(home, ".config/tool/token"), "user-token\n");
  writeFileSync(join(state, "daemon-config.json"), "{}\n");
  const previous = {
    HOME: process.env.HOME,
    FOUNDRY_STATE_ROOT: process.env.FOUNDRY_STATE_ROOT,
  };
  process.env.HOME = home;
  process.env.FOUNDRY_STATE_ROOT = state;
  t.after(() => {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const tree = join(state, "workspaces/ws/environments/iss/workspace");
  mkdirSync(tree, { recursive: true });
  return { root, home, state, tree };
}

function writableTree(root, tree, userFiles) {
  return {
    kind: "writable_tree",
    policyFile: join(root, "executor.sb"),
    workdir: tree,
    readRoots: [],
    writeRoots: [tree],
    protectedReadRoots: [],
    readOnlyDirectories: [],
    readOnlyPaths: [],
    connectSockets: [],
    executables: [],
    userFiles,
  };
}

test(
  "macOS writable tree reads the user's files only when the profile allows",
  { skip: !existsSync("/usr/bin/sandbox-exec") },
  (t) => {
    const { root, state, tree } = userHome(t);
    const policy = (userFiles) => {
      seatbeltBackend.launch(
        writableTree(root, tree, userFiles),
        "/bin/sh",
        [],
      );
      return readFileSync(join(root, "executor.sb"), "utf8").split("\n");
    };
    const deny = (path) =>
      `(deny file-read-data (subpath ${JSON.stringify(path)}))`;
    const readable = policy("readable");
    assert.equal(readable.includes("(deny file-read-data)"), false);
    assert.ok(readable.includes(deny(state)), "governance state stays hidden");
    assert.ok(
      readable.includes(
        `(allow file-read-data (subpath ${JSON.stringify(tree)}))`,
      ),
      "the candidate under the state root is re-allowed",
    );
    assert.equal(
      readable.some((rule) => rule.includes("deny network")),
      false,
    );
    const hidden = policy("hidden");
    assert.ok(hidden.includes("(deny file-read-data)"));
    assert.ok(hidden.includes(deny(state)));
    assert.ok(hidden.some((rule) => rule.includes(".config")));
  },
);

test(
  "Linux writable tree reads the user's files only when the profile allows",
  { skip: process.platform !== "linux" },
  (t) => {
    const { root, home, state, tree } = userHome(t);
    const attempt = (userFiles, script) =>
      linuxBackend(t, () =>
        sandboxLaunch(writableTree(root, tree, userFiles), "/bin/sh", [
          "-c",
          script,
        ]),
      );
    const token = join(home, ".config/tool/token");
    const governance = join(state, "daemon-config.json");
    const readable = attempt("readable", `cat '${token}'`);
    if (!readable) return;
    const result = run(readable, tree);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "user-token\n");
    for (const userFiles of ["readable", "hidden"])
      assert.notEqual(
        run(attempt(userFiles, `cat '${governance}'`), tree).status,
        0,
        `${userFiles}: governance state is never readable`,
      );
    assert.notEqual(run(attempt("hidden", `cat '${token}'`), tree).status, 0);
    assert.notEqual(
      run(attempt("readable", `echo x > '${join(home, "new")}'`), tree).status,
      0,
      "the home stays read-only",
    );
    assert.equal(
      run(attempt("readable", `echo x > '${join(tree, "out")}'`), tree).status,
      0,
      "the candidate stays writable under the masked state root",
    );
  },
);

test("sandboxes never hide the device's installed software", async () => {
  const { writableTreeSystemRoots } = await import("../dist/sandbox/host.js");
  const roots = writableTreeSystemRoots();
  for (const path of ["/opt", "/Applications", "/snap", "/nix"])
    assert.equal(roots.includes(path), existsSync(path), path);
});
