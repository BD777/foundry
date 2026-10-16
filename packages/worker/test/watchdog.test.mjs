import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

test(
  "Mac watchdog grants update/startup grace and targets only the worker job",
  { skip: process.platform !== "darwin" },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "watchdog-review-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "logs"));
    mkdirSync(join(root, "bin"));
    const calls = join(root, "calls");
    const hb = join(root, "daemon-heartbeat");
    const lock = join(root, "logs/self-update.lock");
    writeFileSync(
      join(root, "bin/launchctl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$WATCHDOG_CALLS"\n',
      { mode: 0o700 },
    );
    writeFileSync(hb, "heartbeat");
    const old = new Date(Date.now() - 400000);
    utimesSync(hb, old, old);
    const run = () =>
      execFileSync(
        "/bin/sh",
        [
          fileURLToPath(new URL("../scripts/watchdog.sh", import.meta.url)),
          root,
          "dev.foundry.test-worker",
        ],
        {
          env: {
            ...process.env,
            PATH: join(root, "bin") + ":" + process.env.PATH,
            WATCHDOG_CALLS: calls,
          },
        },
      );
    writeFileSync(lock, "update");
    run();
    assert.equal(existsSync(calls), false);
    const expired = new Date(Date.now() - 901000);
    utimesSync(lock, expired, expired);
    run();
    assert.match(
      readFileSync(calls, "utf8"),
      /^kill TERM gui\/\d+\/dev\.foundry\.test-worker\n$/,
    );
    const now = new Date();
    utimesSync(hb, now, now);
    run();
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
  },
);

test(
  "Mac watchdog checks the actual worker identity and leaves other jobs alone",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { processIdentity } = await import("../dist/agent-processes.js");
    const root = mkdtempSync(join(tmpdir(), "watchdog-identity-"));
    mkdirSync(join(root, "logs"));
    mkdirSync(join(root, "bin"));
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    t.after(() => {
      child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    });
    await once(child, "spawn");
    const identity = processIdentity(child.pid);
    assert.ok(identity);
    const calls = join(root, "calls");
    writeFileSync(
      join(root, "bin/launchctl"),
      '#!/bin/sh\nprintf unexpected >> "$WATCHDOG_CALLS"\n',
      { mode: 0o700 },
    );
    const hb = join(root, "daemon-heartbeat");
    const old = new Date(Date.now() - 400000);
    const run = () =>
      execFileSync(
        "/bin/sh",
        [
          fileURLToPath(new URL("../scripts/watchdog.sh", import.meta.url)),
          root,
          "dev.foundry.test-worker",
        ],
        {
          env: {
            ...process.env,
            PATH: join(root, "bin") + ":" + process.env.PATH,
            WATCHDOG_CALLS: calls,
          },
        },
      );
    writeFileSync(
      hb,
      JSON.stringify({ pid: child.pid, startTime: "another process" }),
    );
    utimesSync(hb, old, old);
    run();
    assert.ok(processIdentity(child.pid));
    assert.equal(existsSync(calls), false);
    writeFileSync(
      hb,
      JSON.stringify({ pid: child.pid, startTime: identity.startTime }),
    );
    utimesSync(hb, old, old);
    run();
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit");
    assert.equal(
      existsSync(calls),
      false,
      "must not kill the execution service or a replacement worker job",
    );
  },
);
