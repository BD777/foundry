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
