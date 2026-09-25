import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isSandboxError,
  sandboxAvailable,
  sandboxGuarantees,
  sandboxLaunch,
  sandboxLauncher,
} from "../dist/sandbox/index.js";
import { seatbeltBackend } from "../dist/sandbox/darwin.js";

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
  assert.equal(sandboxAvailable("loopback_service", "linux"), false);
  for (const kind of [
    "writable_tree",
    "readonly_agent",
    "offline_command",
    "loopback_service",
  ])
    assert.equal(sandboxAvailable(kind, "win32"), false);
});

test("backends state whether the control plane stays unreachable", () => {
  for (const kind of ["writable_tree", "readonly_agent", "offline_command"])
    assert.equal(sandboxGuarantees(kind, "darwin").controlPlaneBlocked, true);
  // bubblewrap cannot filter ports: agent-facing kinds share the host network.
  assert.equal(
    sandboxGuarantees("writable_tree", "linux").controlPlaneBlocked,
    false,
  );
  assert.equal(
    sandboxGuarantees("readonly_agent", "linux").controlPlaneBlocked,
    false,
  );
  assert.equal(
    sandboxGuarantees("offline_command", "linux").controlPlaneBlocked,
    true,
  );
  assert.equal(sandboxGuarantees("loopback_service", "linux"), undefined);
});

test(
  "kinds without a verified backend fail closed with a typed error",
  { skip: process.platform !== "linux" },
  (t) => {
    const root = scratch(t);
    assert.throws(
      () =>
        sandboxLaunch(
          {
            kind: "loopback_service",
            policyFile: join(root, "service.sb"),
            readRoots: [root],
          },
          "/bin/true",
          [],
        ),
      (error) => isSandboxError(error, "unsupported_platform"),
    );
    assert.equal(existsSync(join(root, "service.sb")), false);
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
  };
  seatbeltBackend.launch(profile, process.execPath, ["server.mjs"]);
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
      controlServerURL: "http://127.0.0.1:4100",
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
  for (const port of ["31982", "31983", "4100"])
    assert.ok(
      rules.includes(`(deny network-outbound (remote tcp "*:${port}"))`),
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
