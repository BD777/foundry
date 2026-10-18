import assert from "node:assert/strict";
import test from "node:test";
import { workerPackageName } from "@bd777/foundry-protocol";
import { createServer } from "node:http";
import {
  installDecision,
  ownPackage,
  serverPackageSpecs,
  serverWorkerRelease,
  stackPairedWith,
} from "../dist/worker-install.js";
import { runningWorker } from "../dist/worker-identity.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerLauncherScript } from "../dist/mac-worker-app.js";

test("install leaves a machine that already runs a worker for that server alone", () => {
  const server = "https://foundry.example.com";
  assert.equal(
    installDecision(
      { paired: true, serviceInstalled: true, serverURL: server },
      server,
    ),
    "already-installed",
  );
  assert.equal(
    installDecision(
      { paired: true, serviceInstalled: true, serverURL: "https://other" },
      server,
    ),
    "other-server",
  );
  // Paired without a service (an interrupted install) is finished, not refused.
  assert.equal(
    installDecision(
      { paired: true, serviceInstalled: false, serverURL: "https://other" },
      server,
    ),
    "install",
  );
  assert.equal(
    installDecision({ paired: false, serviceInstalled: false }, server),
    "install",
  );
});

test("the web's install command names this package", () => {
  assert.equal(ownPackage().name, workerPackageName);
});

test("the app's launcher exports the service environment, logs, and runs the worker", () => {
  const script = workerLauncherScript({
    command: [
      "/usr/bin/node",
      "/rt/current/cli.js",
      "daemon",
      "--server",
      "https://s",
    ],
    env: { HOME: "/Users/a b", ODD: "it's" },
    logs: { out: "/logs/out.log", err: "/logs/err.log" },
  });
  const lines = script.split("\n");
  assert.equal(lines[0], "#!/bin/sh");
  assert.ok(lines.includes("export HOME='/Users/a b'"));
  assert.ok(lines.includes("export ODD='it'\\''s'"));
  assert.ok(
    lines.some((line) =>
      /^export FOUNDRY_WORKER_APP='Foundry Worker/.test(line),
    ),
  );
  assert.ok(lines.includes("exec >>'/logs/out.log' 2>>'/logs/err.log'"));
  assert.ok(
    lines.includes(
      "exec '/usr/bin/node' '/rt/current/cli.js' 'daemon' '--server' 'https://s'",
    ),
  );
});

test("a worker follows the packages its server serves, and npm when it serves none", async () => {
  const release = {
    source: "server",
    version: "0.5.7-dev.2.gabc1234",
    packages: [
      { name: "@bd777/foundry-protocol", url: "/api/worker/packages/p.tgz" },
      { name: "@bd777/foundry-worker", url: "/api/worker/packages/w.tgz" },
    ],
  };
  const server = createServer((request, response) => {
    if (request.url === "/served/api/worker/release") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(release));
    } else if (request.url === "/broken/api/worker/release") {
      response.statusCode = 503;
      response.end("unreadable");
    } else {
      response.statusCode = 404;
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const served = await serverWorkerRelease(`${base}/served`);
    assert.deepEqual(served, release);
    assert.deepEqual(serverPackageSpecs(served, `${base}/served`), [
      `${base}/served/api/worker/packages/p.tgz`,
      `${base}/served/api/worker/packages/w.tgz`,
    ]);
    // A server older than the endpoint.
    assert.deepEqual(await serverWorkerRelease(`${base}/old`), {
      source: "npm",
    });
    await assert.rejects(
      serverWorkerRelease(`${base}/broken`, [1, 1, 1]),
      /HTTP 503/,
    );
  } finally {
    server.close();
  }
});

test("update --server finds the stack whose worker is paired with that server", () => {
  const home = mkdtempSync(join(tmpdir(), "stacks-"));
  const roots = {
    default: join(home, ".foundry"),
    stacks: join(home, ".foundry-stacks"),
  };
  const pair = (root, serverURL) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "daemon-config.json"),
      JSON.stringify({ serverURL }),
    );
  };
  pair(roots.default, "http://127.0.0.1:31982");
  pair(join(roots.stacks, "dev"), "https://dev.example.com/");
  mkdirSync(join(roots.stacks, "unpaired"), { recursive: true });
  assert.equal(stackPairedWith("https://dev.example.com", roots), "dev");
  assert.equal(stackPairedWith("http://127.0.0.1:31982/", roots), "");
  assert.equal(stackPairedWith("https://other.example.com", roots), undefined);
});

test("a worker not set up with install reports its version and no command", () => {
  const worker = runningWorker();
  assert.equal(worker.version, ownPackage().version);
  assert.equal(worker.command, undefined);
});

test("a worker not set up with install refuses to update itself, and says why", async () => {
  const { startSelfUpdate } = await import("../dist/worker-self-update.js");
  assert.throws(
    () => startSelfUpdate("https://foundry.example.com"),
    /not installed with `install`/,
  );
});

test("one update at a time: the lock holds until released or until its window passes", async () => {
  const lock = await import("../dist/self-update-lock.js");
  assert.equal(lock.selfUpdateInProgress(), undefined);
  const started = new Date();
  lock.holdSelfUpdateLock(started);
  assert.equal(lock.selfUpdateInProgress(), started.toISOString());
  assert.equal(
    lock.selfUpdateInProgress(started.getTime() + lock.selfUpdateWindowMs),
    undefined,
    "a lock left by a killed update expires",
  );
  lock.releaseSelfUpdateLock();
  assert.equal(lock.selfUpdateInProgress(), undefined);
});

test("the stable app launcher runs its execution role without overwriting that job environment", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "execution-app-role-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const entry = join(root, "execution.mjs");
  writeFileSync(
    entry,
    "console.log(JSON.stringify({account:process.env.CODEX_HOME,server:process.argv[2]}))",
  );
  const launcher = join(root, "worker.sh");
  writeFileSync(
    launcher,
    workerLauncherScript({
      command: ["/bin/false"],
      env: { CODEX_HOME: "wrong-account" },
      logs: { out: join(root, "out"), err: join(root, "err") },
    }),
  );
  const server = "https://example.test/a $(not-a-command)";
  const result = JSON.parse(
    execFileSync("/bin/sh", [launcher], {
      encoding: "utf8",
      env: {
        ...process.env,
        FOUNDRY_SERVICE_ROLE: "execution",
        FOUNDRY_EXECUTION_NODE: process.execPath,
        FOUNDRY_EXECUTION_ENTRY: entry,
        FOUNDRY_EXECUTION_SERVER: server,
        CODEX_HOME: "selected-account",
      },
    }),
  );
  assert.deepEqual(result, { account: "selected-account", server });
});

test(
  "retrying an installed server version completes service activation without reinstalling packages",
  { skip: process.platform !== "linux" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { rmSync, readFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "foundry-update-retry-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const self = ownPackage();
    const state = join(root, "state");
    const pkg = join(state, "runtime/current/node_modules", self.name);
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: self.name, version: self.version }),
    );
    writeFileSync(join(pkg, "dist/cli.js"), "");
    const units = join(root, ".config/systemd/user");
    mkdirSync(units, { recursive: true });
    writeFileSync(
      join(units, "foundry-worker.service"),
      "[Service]\nExecStart=/old/worker\n",
    );
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "systemctl.log");
    writeFileSync(
      join(bin, "systemctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          source: "server",
          version: self.version,
          packages: [{ name: self.name, url: "/worker.tgz" }],
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(
      join(state, "daemon-config.json"),
      JSON.stringify({ serverURL: url, deviceCredential: "fixture" }),
    );
    const code = `import {updateCommand} from ${JSON.stringify(new URL("../dist/worker-install.js", import.meta.url).href)};await updateCommand(['--server',${JSON.stringify(url)}]);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: {
        ...process.env,
        HOME: root,
        FOUNDRY_STATE_ROOT: state,
        FOUNDRY_STACK: "",
        XDG_RUNTIME_DIR: root,
        PATH: bin + ":" + process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const codeResult = await new Promise((r) => child.on("close", r));
    assert.equal(codeResult, 0, output);
    assert.match(readFileSync(log, "utf8"), /restart foundry-worker.service/);
    assert.match(output, /completing service activation/);
  },
);

test("pruning keeps the execution host runtime when HOME uses a symlink", async () => {
  const { pruneRuntimes } = await import("../dist/worker-install.js");
  const { existsSync, symlinkSync, rmSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "runtime-pin-"));
  const previousState = process.env.FOUNDRY_STATE_ROOT;
  const physical = join(root, "physical");
  const alias = join(root, "home-alias");
  mkdirSync(physical);
  symlinkSync(physical, alias, "dir");
  process.env.FOUNDRY_STATE_ROOT = alias;
  try {
    for (const name of [
      "active-host",
      "current-version",
      "previous-version",
      "unused",
    ])
      mkdirSync(join(physical, "runtime", name), { recursive: true });
    const entry = join(physical, "runtime", "active-host", "main.js");
    writeFileSync(entry, "");
    mkdirSync(join(physical, "execution-host"));
    writeFileSync(
      join(physical, "execution-host", "identity.json"),
      JSON.stringify({ entry }),
    );
    symlinkSync("current-version", join(physical, "runtime", "current"));
    pruneRuntimes("current-version", "previous-version");
    assert(existsSync(entry), "live host's physical directory must survive");
    assert(existsSync(join(alias, "runtime", "current")));
    assert(existsSync(join(alias, "runtime", "previous-version")));
    assert(!existsSync(join(alias, "runtime", "unused")));
  } finally {
    if (previousState === undefined) delete process.env.FOUNDRY_STATE_ROOT;
    else process.env.FOUNDRY_STATE_ROOT = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});
