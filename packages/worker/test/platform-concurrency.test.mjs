import assert from "node:assert/strict";
import test from "node:test";
import { SingleFlight } from "../dist/platform/single-flight.js";
import {
  KeyedSerialQueue,
  SerialQueue,
} from "../dist/platform/serial-queue.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("SingleFlight shares a running task per key and frees the key after", async () => {
  const flights = new SingleFlight();
  const gate = deferred();
  let starts = 0;
  const task = () => {
    starts += 1;
    return gate.promise;
  };
  const first = flights.run("a", task);
  const second = flights.run("a", task);
  assert.equal(first, second);
  assert.equal(starts, 1, "the task starts at once, in the caller's turn");
  const other = flights.run("b", async () => "b");
  assert.equal(flights.size, 2);
  gate.resolve("a");
  assert.equal(await first, "a");
  assert.equal(await other, "b");
  assert.equal(flights.size, 0);
  await flights.run("a", task);
  assert.equal(starts, 2);
});

test("SingleFlight forgets failures, including a task that throws at once", async () => {
  const flights = new SingleFlight();
  await assert.rejects(
    flights.run("a", () => {
      throw new Error("sync");
    }),
    /sync/,
  );
  await assert.rejects(
    flights.run("a", async () => {
      throw new Error("async");
    }),
    /async/,
  );
  assert.equal(flights.has("a"), false);
});

test("SingleFlight with keepResolved keeps results until forgotten", async () => {
  const flights = new SingleFlight({ keepResolved: true });
  let starts = 0;
  const start = async () => ++starts;
  assert.equal(await flights.run("a", start), 1);
  assert.equal(await flights.run("a", start), 1);
  flights.forget("a");
  assert.equal(await flights.run("a", start), 2);
  await assert.rejects(
    flights.run("b", async () => {
      throw new Error("no");
    }),
  );
  assert.equal(flights.has("b"), false);
});

test("SerialQueue runs tasks in order and past failures", async () => {
  const queue = new SerialQueue();
  const order = [];
  const gate = deferred();
  const first = queue.run(async () => {
    await gate.promise;
    order.push(1);
  });
  const failing = queue.run(() => {
    order.push(2);
    throw new Error("two");
  });
  const third = queue.run(() => {
    order.push(3);
    return 3;
  });
  let idle = false;
  void queue.idle().then(() => (idle = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  gate.resolve();
  await first;
  await assert.rejects(failing, /two/);
  assert.equal(await third, 3);
  await queue.idle();
  assert.equal(idle, true);
  assert.deepEqual(order, [1, 2, 3]);
});

test("KeyedSerialQueue serializes per key and runs keys concurrently", async () => {
  const queue = new KeyedSerialQueue();
  const gate = deferred();
  const order = [];
  const a1 = queue.run("a", async () => {
    await gate.promise;
    order.push("a1");
  });
  const a2 = queue.run("a", () => order.push("a2"));
  const b1 = queue.run("b", () => order.push("b1"));
  await b1;
  assert.deepEqual(order, ["b1"]);
  gate.resolve();
  await Promise.all([a1, a2]);
  assert.deepEqual(order, ["b1", "a1", "a2"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queue.size, 0);
});
