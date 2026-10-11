import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackgroundOutputFollowers } from "../dist/background-output-follow.js";

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "fdy-follow-"));
  const path = join(directory, "b1.output");
  let clock = 0;
  const told = [];
  const log = { path, running: true };
  const followers = new BackgroundOutputFollowers({
    notify: (sessionId, taskId) => told.push(`${sessionId}/${taskId}`),
    now: () => clock,
    leaseMs: 60_000,
    // The test checks by hand.
    checkEveryMs: 3_600_000,
    ...options,
  });
  return {
    path,
    log,
    told,
    followers,
    tick: (ms) => {
      clock += ms;
      followers.check();
    },
    done: () => {
      followers.close();
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

test("a followed log is told once per growth until its lease ends", () => {
  const f = fixture();
  try {
    writeFileSync(f.path, "one\n");
    assert.equal(
      f.followers.follow("sess", "b1", 4, () => f.log),
      true,
    );
    f.tick(1000);
    assert.deepEqual(f.told, [], "nothing new since the read");
    appendFileSync(f.path, "two\n");
    f.tick(1000);
    f.tick(1000);
    assert.deepEqual(f.told, ["sess/b1"], "told once");
    // A read renews the lease; without one it ends.
    f.tick(30_000);
    f.followers.follow("sess", "b1", 8, () => f.log);
    f.tick(45_000);
    appendFileSync(f.path, "three\n");
    f.tick(1000);
    assert.deepEqual(f.told, ["sess/b1", "sess/b1"]);
    f.tick(60_000);
    appendFileSync(f.path, "four\n");
    f.tick(1000);
    assert.equal(f.told.length, 2, "an expired lease tells nothing");
    assert.equal(f.followers.size, 0);
  } finally {
    f.done();
  }
});

test("a log is followed while its task runs, and its last change is told", () => {
  const f = fixture();
  try {
    // No log yet: it is looked for again on every check.
    const log = { running: true };
    assert.equal(
      f.followers.follow("sess", "b1", 0, () => log),
      true,
    );
    f.tick(1000);
    assert.deepEqual(f.told, []);
    writeFileSync(f.path, "started\n");
    log.path = f.path;
    f.tick(1000);
    assert.deepEqual(f.told, ["sess/b1"]);
    appendFileSync(f.path, "exit 0\n");
    log.running = false;
    f.tick(1000);
    assert.deepEqual(f.told, ["sess/b1", "sess/b1"]);
    assert.equal(f.followers.size, 0, "a finished task is not followed");
    assert.equal(
      f.followers.follow("sess", "b1", 0, () => log),
      false,
      "nor followed again",
    );
  } finally {
    f.done();
  }
});

test("followed logs are bounded and end with the connection", () => {
  const f = fixture({ limit: 2 });
  try {
    writeFileSync(f.path, "x");
    assert.equal(
      f.followers.follow("sess", "a", 1, () => f.log),
      true,
    );
    assert.equal(
      f.followers.follow("sess", "b", 1, () => f.log),
      true,
    );
    assert.equal(
      f.followers.follow("sess", "c", 1, () => f.log),
      false,
    );
    assert.equal(
      f.followers.follow("sess", "a", 1, () => f.log),
      true,
    );
    f.followers.close();
    assert.equal(f.followers.size, 0);
    assert.equal(
      f.followers.follow("sess", "a", 1, () => f.log),
      false,
    );
  } finally {
    f.done();
  }
});
