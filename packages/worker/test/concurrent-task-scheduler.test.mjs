import assert from "node:assert/strict";
import test from "node:test";
import {
  ConcurrentTaskScheduler,
  sessionAdmissionClass,
} from "../dist/platform/task-scheduler.js";

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
  assert.deepEqual(
    waits.map(([name, wait]) => ({
      name,
      running: wait.running,
      limit: wait.limit,
      hardHold: wait.hardHold,
      sameKey: wait.sameKey,
    })),
    [
      {
        name: "second",
        running: 1,
        limit: 1,
        hardHold: false,
        sameKey: false,
      },
      {
        name: "same",
        running: 1,
        limit: 1,
        hardHold: false,
        sameKey: true,
      },
    ],
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  release();
  await first;
  await second;
  assert.equal(secondStarted, true);
  await same;
  await scheduler.whenIdle();
  assert.deepEqual(scheduler.load(), {
    running: 0,
    runningExempt: 0,
    runningLimited: 0,
    limit: 1,
    queued: 0,
    queuedExempt: 0,
    queuedLimited: 0,
    hardHold: false,
    reasons: [],
  });
});

test("human and parent turns are exempt while child and timer turns are limited", () => {
  const input = { id: "input", prompt: "work" };
  assert.equal(
    sessionAdmissionClass({
      input,
      source: "chat",
    }),
    "exempt",
  );
  assert.equal(
    sessionAdmissionClass({
      input: { ...input, sentBySessionId: "sess_child" },
      source: "chat",
      waitingChildCount: 2,
    }),
    "exempt",
  );
  assert.equal(
    sessionAdmissionClass({
      input: { ...input, sentBySessionId: "sess_parent" },
      parentSessionId: "sess_parent",
      source: "agent",
    }),
    "limited",
  );
  assert.equal(
    sessionAdmissionClass({
      input: {
        ...input,
        timerFire: {
          id: "timer",
          origin: "scheduled",
        },
      },
      source: "chat",
    }),
    "limited",
  );
  assert.equal(
    sessionAdmissionClass({
      input,
      source: "naming",
    }),
    "limited",
  );
});

test("an occupied limit never queues human or orchestration-parent turns", async () => {
  const scheduler = new ConcurrentTaskScheduler(1);
  const started = [];
  const releases = new Map();
  const run = (name, admissionClass) =>
    scheduler.schedule(
      `chat:${name}`,
      async () => {
        started.push(name);
        await new Promise((resolve) => releases.set(name, resolve));
      },
      undefined,
      {
        admissionClass,
        sessionId: `sess_${name}`,
        workspaceId: "ws",
        runtime: "claude",
      },
    );

  const limited = run("limited", "limited");
  const human = run("human", "exempt");
  const parent = run("parent", "exempt");
  const child = run("child", "limited");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["limited", "human", "parent"]);
  assert.equal(scheduler.load().runningLimited, 1);
  assert.equal(scheduler.load().runningExempt, 2);
  assert.equal(scheduler.load().queuedLimited, 1);

  releases.get("limited")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["limited", "human", "parent", "child"]);
  for (const release of releases.values()) release();
  await Promise.all([limited, human, parent, child]);
});

test("hard hold queues with a reason and releases when memory returns", async () => {
  const scheduler = new ConcurrentTaskScheduler(2);
  const waits = [];
  let started = false;
  scheduler.configureAdmission({
    hardHold: true,
    limit: 2,
    reasons: ["memory_hard_hold"],
  });
  const run = scheduler.schedule(
    "chat:a",
    () => {
      started = true;
    },
    (wait) => waits.push(wait),
    { sessionId: "sess_a", workspaceId: "ws_a", runtime: "claude" },
  );
  assert.equal(started, false);
  assert.equal(waits[0].hardHold, true);
  assert.deepEqual(waits[0].reasons, ["memory_hard_hold"]);
  assert.deepEqual(scheduler.runningContexts(), []);
  assert.deepEqual(scheduler.queuedContexts(), [
    { sessionId: "sess_a", workspaceId: "ws_a", runtime: "claude" },
  ]);

  scheduler.configureAdmission({ hardHold: false, limit: 2, reasons: [] });
  await run;
  assert.equal(started, true);
});

test("a larger limit releases every queued task that now fits at once", async () => {
  const scheduler = new ConcurrentTaskScheduler(1);
  const started = [];
  const releases = [];
  const wait = () =>
    new Promise((resolve) => {
      releases.push(resolve);
    });
  const first = scheduler.schedule("chat:a", async () => {
    started.push("a");
    await wait();
  });
  const second = scheduler.schedule("chat:b", async () => {
    started.push("b");
    await wait();
  });
  const third = scheduler.schedule("chat:c", async () => {
    started.push("c");
    await wait();
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a"]);

  scheduler.configureAdmission({ limit: 3, reasons: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["a", "b", "c"]);
  for (const release of releases) release();
  await Promise.all([first, second, third]);
});
