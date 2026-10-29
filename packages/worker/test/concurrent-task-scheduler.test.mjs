import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrentTaskScheduler } from "../dist/task-scheduler.js";

test("runs independent tasks concurrently up to the configured limit", async () => {
  const scheduler = new ConcurrentTaskScheduler(2);
  const started = [];
  const releases = new Map();

  const run = (id, key) =>
    scheduler.schedule(key, async () => {
      started.push(id);
      await new Promise((resolve) => releases.set(id, resolve));
    });

  const first = run("first", "chat:first");
  const second = run("second", "chat:second");
  const third = run("third", "chat:third");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);

  releases.get("first")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second", "third"]);

  releases.get("second")();
  releases.get("third")();
  await Promise.all([first, second, third]);
});

test("keeps tasks for the same chat in order while other chats run", async () => {
  const scheduler = new ConcurrentTaskScheduler(2);
  const started = [];
  let releaseFirst;

  const first = scheduler.schedule("chat:shared", async () => {
    started.push("first");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
  });
  const second = scheduler.schedule("chat:shared", () => {
    started.push("second");
  });
  const otherChat = scheduler.schedule("chat:other", () => {
    started.push("other");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "other"]);

  releaseFirst();
  await Promise.all([first, second, otherChat]);
  assert.deepEqual(started, ["first", "other", "second"]);
});

test("a task that cannot start says why, and frees its slot the moment it ends (DEV-084)", async () => {
  const scheduler = new ConcurrentTaskScheduler(1);
  const waits = [];
  let release;
  const first = scheduler.schedule(
    "chat:a",
    () => new Promise((resolve) => (release = resolve)),
    (wait) => waits.push(["first", wait]),
  );
  let secondStarted = false;
  const second = scheduler.schedule(
    "chat:b",
    () => {
      secondStarted = true;
    },
    (wait) => waits.push(["second", wait]),
  );
  const same = scheduler.schedule(
    "chat:a",
    () => {},
    (wait) => waits.push(["same", wait]),
  );
  assert.deepEqual(waits, [
    ["second", { running: 1, limit: 1, sameKey: false }],
    ["same", { running: 1, limit: 1, sameKey: true }],
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  release();
  await first;
  await second;
  assert.equal(secondStarted, true);
  await same;
  await scheduler.whenIdle();
  assert.deepEqual(scheduler.load(), { running: 0, limit: 1 });
});
