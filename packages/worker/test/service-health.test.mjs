import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  lingerEnabled,
  oomKillsFromCgroup,
  oomKillsFromJournal,
  serviceState,
  swapBytes,
} from "../dist/service-health.js";

test("linger reads loginctl's yes/no and stays unknown otherwise", () => {
  const run = (status, stdout) => () => ({ status, stdout });
  assert.equal(lingerEnabled(run(0, "no\n")), false);
  assert.equal(lingerEnabled(run(0, "yes\n")), true);
  assert.equal(lingerEnabled(run(1, "")), undefined);
  assert.equal(lingerEnabled(run(0, "maybe")), undefined);
});

test("OOM kills are counted from the unit's user journal", () => {
  const journal = [
    "2026-10-29T09:30:00+0000 host systemd[812]: Started foundry-worker.service.",
    "2026-10-29T09:37:02+0000 host systemd[812]: foundry-worker.service: A process of this unit has been killed by the OOM killer.",
    "2026-10-29T09:37:02+0000 host systemd[812]: foundry-worker.service: Failed with result 'oom-kill'.",
    "2026-10-29T10:01:10+0000 host systemd[812]: foundry-worker.service: A process of this unit has been killed by the OOM killer.",
  ].join("\n");
  assert.deepEqual(oomKillsFromJournal(journal), {
    count: 2,
    lastAt: "2026-10-29T10:01:10.000Z",
  });
  assert.equal(oomKillsFromJournal("nothing here"), undefined);
});

test("the service cgroup's oom_kill counter and SwapTotal are read from files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "foundry-service-health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const unit = join(root, "sys", "user.slice", "foundry-worker.service");
  mkdirSync(unit, { recursive: true });
  writeFileSync(
    join(unit, "memory.events"),
    "low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n",
  );
  writeFileSync(
    join(root, "cgroup"),
    "0::/user.slice/foundry-worker.service\n",
  );
  assert.equal(oomKillsFromCgroup(join(root, "cgroup"), join(root, "sys")), 1);
  assert.equal(oomKillsFromCgroup(join(root, "missing")), undefined);
  if (process.platform === "linux") {
    writeFileSync(
      join(root, "meminfo"),
      "MemTotal: 2000000 kB\nSwapTotal:       0 kB\n",
    );
    assert.equal(swapBytes(join(root, "meminfo")), 0);
    writeFileSync(join(root, "meminfo"), "SwapTotal:  2097148 kB\n");
    assert.equal(swapBytes(join(root, "meminfo")), 2097148 * 1024);
  }
});

test("the reported service names its unit and log folder", () => {
  const state = serviceState();
  if (process.platform === "linux") {
    assert.match(state.unit, /^foundry-worker.*\.service$/);
  }
  assert.ok(state.logDir);
  assert.equal(typeof state.installed, "boolean");
});
