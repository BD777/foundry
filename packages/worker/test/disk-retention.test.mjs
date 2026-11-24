import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  chmodSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pruneIdleVerifiers,
  pruneSessionLogs,
} from "../dist/maintenance/disk-retention.js";
import {
  removeIdleSessionScratches,
  removeLeaseLeftovers,
} from "../dist/resources/index.js";

const day = 24 * 60 * 60 * 1000;

function folder(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionInput(workspace, session, input, ageDays) {
  const inputs = join(workspace, ".foundry", "sessions", session, "inputs");
  const dir = join(inputs, input);
  mkdirSync(dir, { recursive: true });
  for (const name of [
    "claude-sdk.messages.jsonl",
    "claude-sdk.stderr.log",
    "codex-sdk.events.jsonl",
    "result.md",
    "completion.json",
  ])
    writeFileSync(join(dir, name), "synthetic");
  const at = new Date(Date.now() - ageDays * day);
  utimesSync(inputs, at, at);
  return dir;
}

test("SDK logs go once a session has had no input for two weeks; results, active and recent sessions stay", async (t) => {
  const workspace = folder(t, "retention-ws-");
  const old = sessionInput(workspace, "sess_old", "i1", 20);
  const active = sessionInput(workspace, "sess_active", "i1", 20);
  const recent = sessionInput(workspace, "sess_recent", "i1", 3);
  const report = await pruneSessionLogs(workspace, new Set(["sess_active"]));
  assert.deepEqual(report, { sessions: 1, files: 3, bytes: 27 });
  for (const name of [
    "claude-sdk.messages.jsonl",
    "claude-sdk.stderr.log",
    "codex-sdk.events.jsonl",
  ]) {
    assert.ok(!existsSync(join(old, name)), name);
    assert.ok(existsSync(join(active, name)), `active ${name}`);
    assert.ok(existsSync(join(recent, name)), `recent ${name}`);
  }
  for (const name of ["result.md", "completion.json"])
    assert.ok(existsSync(join(old, name)), name);

  // A cleared session is not walked again until it gets a new input.
  assert.deepEqual(
    await pruneSessionLogs(workspace, new Set()),
    {
      sessions: 1,
      files: 3,
      bytes: 27,
    },
    "only sess_active is left to clear now",
  );
  const later = sessionInput(workspace, "sess_old", "i2", 15);
  // The marker was written "now", after the new input's (older) time: the
  // marker covers it, so that input's logs stay until the next input.
  assert.equal((await pruneSessionLogs(workspace, new Set())).files, 0);
  const inputs = join(workspace, ".foundry", "sessions", "sess_old", "inputs");
  const future = new Date(Date.now() + day);
  utimesSync(inputs, future, future);
  const report2 = await pruneSessionLogs(
    workspace,
    new Set(),
    Date.now() + 15 * day,
  );
  // Two weeks on, sess_recent is idle as well.
  assert.deepEqual(report2, { sessions: 2, files: 6, bytes: 54 });
  assert.ok(!existsSync(join(later, "claude-sdk.messages.jsonl")));
  assert.ok(existsSync(join(later, "result.md")));
});

test("verifier sandboxes unused for a week go in every workspace", async (t) => {
  const root = folder(t, "retention-exec-");
  const stale = join(root, "ws_a", "verifications", "sess_stale");
  const fresh = join(root, "ws_b", "verifications", "sess_fresh");
  mkdirSync(stale, { recursive: true });
  mkdirSync(fresh, { recursive: true });
  const snapshot = join(stale, "scratch", "skill-sets", "generation");
  mkdirSync(snapshot, { recursive: true });
  writeFileSync(join(snapshot, "SKILL.md"), "sealed", { mode: 0o400 });
  chmodSync(snapshot, 0o500);
  const old = new Date(Date.now() - 8 * day);
  utimesSync(stale, old, old);
  assert.equal(await pruneIdleVerifiers(root), 1);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(fresh));
});

test("named compute scratch folders go after two weeks unused; lease leftovers after a day", async (t) => {
  const root = folder(t, "retention-compute-");
  const at = (days) => new Date(Date.now() - days * day);
  for (const [name, days] of [
    ["sess_idle", 4],
    ["shared-old", 15],
    ["shared-recent", 5],
    ["shared-used", 30],
  ]) {
    mkdirSync(join(root, name));
    utimesSync(join(root, name), at(days), at(days));
  }
  const removed = await removeIdleSessionScratches(
    root,
    3 * day,
    Date.now(),
    new Set(["shared-used"]),
    14 * day,
  );
  assert.deepEqual(removed.sort(), ["sess_idle", "shared-old"]);
  assert.ok(existsSync(join(root, "shared-recent")));
  assert.ok(existsSync(join(root, "shared-used")));

  mkdirSync(join(root, ".tmp", "lease_dead"), { recursive: true });
  mkdirSync(join(root, ".tmp", "lease_live"), { recursive: true });
  mkdirSync(join(root, ".tmp", "lease_new"), { recursive: true });
  mkdirSync(join(root, ".uploads"), { recursive: true });
  writeFileSync(join(root, ".uploads", "lease_dead-my-upload-1"), "x");
  writeFileSync(join(root, ".uploads", "lease_live-my-upload"), "x");
  for (const path of [
    join(root, ".tmp", "lease_dead"),
    join(root, ".tmp", "lease_live"),
    join(root, ".uploads", "lease_dead-my-upload-1"),
    join(root, ".uploads", "lease_live-my-upload"),
  ])
    utimesSync(path, at(2), at(2));
  const leftovers = await removeLeaseLeftovers(
    root,
    new Set(["lease_live"]),
    Date.now(),
  );
  assert.deepEqual(leftovers.sort(), [
    ".tmp/lease_dead",
    ".uploads/lease_dead-my-upload-1",
  ]);
  assert.ok(existsSync(join(root, ".tmp", "lease_new")));
});
