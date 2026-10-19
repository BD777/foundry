import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await pause(25);
  }
  throw new Error("condition not met");
}

for (const broken of [false, true])
  test(`legacy migration ${broken ? "releases a paused worker when the server check fails" : "waits for active inputs before pausing the old worker"}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "legacy-update-"));
    const state = join(root, "state");
    mkdirSync(state);
    let active = true,
      calls = 0;
    const server = createServer((req, res) => {
      calls++;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          broken && calls > 1
            ? {}
            : {
                activeSessionIds: !broken && active ? ["session-working"] : [],
              },
        ),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(
      join(state, "daemon-config.json"),
      JSON.stringify({ serverURL: url, deviceCredential: "fake-device" }),
    );
    writeFileSync(
      join(state, "workspaces.json"),
      JSON.stringify([
        {
          id: "ws",
          path: root,
          name: "test",
          baseline: "main",
          registeredAt: new Date().toISOString(),
        },
      ]),
    );
    writeFileSync(join(root, "package.json"), ' {"type":"module"}');
    const worker = join(root, "cli.js");
    writeFileSync(
      worker,
      `import {acquireDaemonLock} from ${JSON.stringify(new URL("../dist/device-pairing.js", import.meta.url).href)};acquireDaemonLock();process.send('ready');setInterval(()=>process.send('heartbeat'),30);`,
    );
    const env = {
      ...process.env,
      FOUNDRY_STATE_ROOT: state,
      HOME: root,
      CODEX_HOME: join(root, "codex"),
      CLAUDE_CONFIG_DIR: join(root, "claude"),
    };
    const child = spawn(process.execPath, [worker, "daemon"], {
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let beats = 0;
    child.on("message", (m) => {
      if (m === "heartbeat") beats++;
    });
    await once(child, "message");
    const source = `import {prepareWorkerRestart} from ${JSON.stringify(new URL("../dist/execution-host/update.js", import.meta.url).href)};try{const release=await prepareWorkerRestart('next');process.send('paused');process.on('message',()=>{release();process.exit(0);});}catch(e){process.send({error:e.message});}`;
    const updater = spawn(
      process.execPath,
      ["--input-type=module", "-e", source],
      { env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    const messages = [];
    let errors = "";
    updater.on("message", (m) => messages.push(m));
    updater.stderr.on("data", (d) => (errors += d));
    t.after(() => {
      try {
        process.kill(child.pid, "SIGCONT");
      } catch {}
      child.kill("SIGKILL");
      updater.kill("SIGKILL");
      server.close();
      rmSync(root, { recursive: true, force: true });
    });
    await until(() => calls > 0);
    if (broken) {
      await until(() => messages.some((m) => m.error));
      assert.match(
        messages.find((m) => m.error).error,
        /server before migrating/,
      );
      const before = beats;
      await pause(100);
      assert.ok(beats > before, "old worker was left running");
      return;
    }
    await pause(100);
    assert.ok(beats > 0);
    assert.deepEqual(messages, []);
    active = false;
    await until(() => messages.includes("paused"));
    await pause(50);
    const before = beats;
    await pause(150);
    assert.equal(
      beats,
      before,
      "old worker is paused across final check and restart",
    );
    updater.send("release");
    await until(() => beats > before);
    assert.equal(errors, "");
  });

test("systemd ownership is recognized on cgroup v1 and v2", async () => {
  const { systemdCgroup } = await import("../dist/execution-host/service.js");
  assert.deepEqual(
    systemdCgroup("0::/user.slice/app.slice/foundry-execution-test.service\n"),
    {
      group: "/user.slice/app.slice/foundry-execution-test.service",
      root: "/sys/fs/cgroup",
    },
  );
  assert.deepEqual(
    systemdCgroup(
      "11:pids:/user.slice\n1:name=systemd:/user.slice/app.slice/foundry-execution-test.service\n",
    ),
    {
      group: "/user.slice/app.slice/foundry-execution-test.service",
      root: "/sys/fs/cgroup/systemd",
    },
  );
  assert.equal(systemdCgroup("3:memory:/user.slice\n"), undefined);
  assert.equal(systemdCgroup("0::/../unsafe\n"), undefined);
});

test("legacy idle transition accepts only leftover direct Codex app-servers, never tools or Claude", async () => {
  const { legacyMembersAreIdleCodex } =
    await import("../dist/execution-host/service.js");
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11], () => ({
      parent: 10,
      argv: ["/tools/codex", "app-server"],
    })),
    true,
  );
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11, 12], (pid) =>
      pid === 11
        ? { parent: 10, argv: ["codex", "app-server"] }
        : { parent: 11, argv: ["bash", "build.sh"] },
    ),
    false,
  );
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11], () => ({
      parent: 10,
      argv: ["claude"],
    })),
    false,
  );
  assert.equal(
    legacyMembersAreIdleCodex(10, [11], () => ({
      parent: 10,
      argv: ["codex", "app-server"],
    })),
    false,
  );
});

test("the idle Codex code-mode sidecar is accepted but its tools are not", async () => {
  const { legacyMembersAreIdleCodex } =
    await import("../dist/execution-host/service.js");
  const rows = {
    11: { parent: 10, argv: ["codex", "app-server"] },
    12: { parent: 11, argv: ["/release/bin/codex-code-mode-host"] },
    13: { parent: 12, argv: ["node", "build.js"] },
  };
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11, 12], (pid) => rows[pid]),
    true,
  );
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11, 12, 13], (pid) => rows[pid]),
    false,
  );
});

test("legacy idle upgrade recognizes the Node Codex launcher without accepting arbitrary Node work", async () => {
  const { legacyMembersAreIdleCodex } =
    await import("../dist/execution-host/service.js");
  const rows = {
    11: {
      parent: 10,
      argv: [
        "/bin/node",
        "/managed/.bin/codex",
        "app-server",
        "--listen",
        "stdio://",
      ],
    },
    12: {
      parent: 11,
      argv: ["/managed/vendor/bin/codex", "app-server", "--listen", "stdio://"],
    },
    13: { parent: 12, argv: ["/managed/vendor/bin/codex-code-mode-host"] },
    14: { parent: 13, argv: ["node", "build.js"] },
  };
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11, 12, 13], (pid) => rows[pid]),
    true,
  );
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11, 12, 13, 14], (pid) => rows[pid]),
    false,
  );
  rows[11].argv = ["node", "build.js", "app-server"];
  assert.equal(
    legacyMembersAreIdleCodex(10, [10, 11, 12, 13], (pid) => rows[pid]),
    false,
  );
});
