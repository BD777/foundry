import assert from "node:assert/strict";
import test from "node:test";
import {
  createResponseStreamBatcher,
  createSubtaskProgressCoalescer,
  responseStreamIntervalMs,
  subtaskProgressIntervalMs,
} from "../dist/session-helpers.js";

/** A clock and timers the test advances by hand. */
function fakeClock() {
  let time = 1_000_000;
  let nextID = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, ms) => {
      const id = nextID++;
      timers.set(id, { at: time + ms, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= time && timers.has(id)) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

const running = (taskId, detail) => ({
  label: "Subtask running",
  detail,
  metadata: { taskId },
});

function progressHarness() {
  const clock = fakeClock();
  const sent = [];
  const coalesce = createSubtaskProgressCoalescer(clock);
  const emit = (sessionId, event) =>
    coalesce(sessionId, event, () => sent.push(`${sessionId}:${event.detail}`));
  return { clock, sent, emit };
}

test("a subagent's progress goes out at most once per interval, latest wins", () => {
  assert.equal(subtaskProgressIntervalMs, 10_000);
  const { clock, sent, emit } = progressHarness();
  emit("s", running("t1", "p1"));
  assert.deepEqual(sent, ["s:p1"], "the first report goes out at once");
  for (const detail of ["p2", "p3", "p4"]) {
    clock.advance(1_000);
    emit("s", running("t1", detail));
  }
  assert.deepEqual(sent, ["s:p1"], "reports within the interval are held");
  clock.advance(7_000);
  assert.deepEqual(sent, ["s:p1", "s:p4"], "the latest held report goes out");
  clock.advance(10_000);
  assert.deepEqual(sent, ["s:p1", "s:p4"], "nothing more without a report");
  emit("s", running("t1", "p5"));
  assert.deepEqual(sent, ["s:p1", "s:p4", "s:p5"]);
});

test("tasks and sessions are coalesced separately", () => {
  const { sent, emit } = progressHarness();
  emit("s", running("t1", "a"));
  emit("s", running("t2", "b"));
  emit("other", running("t1", "c"));
  emit("s", running("t1", "held"));
  assert.deepEqual(sent, ["s:a", "s:b", "other:c"]);
});

test("start, completion and failure always go out and drop held progress", () => {
  const { clock, sent, emit } = progressHarness();
  emit("s", {
    label: "Starting subtask",
    detail: "start",
    metadata: { taskId: "t1" },
  });
  emit("s", running("t1", "p1"));
  emit("s", running("t1", "p2"));
  emit("s", {
    label: "Subtask completed",
    detail: "done",
    metadata: { taskId: "t1" },
  });
  assert.deepEqual(sent, ["s:start", "s:p1", "s:done"]);
  clock.advance(20_000);
  assert.deepEqual(
    sent,
    ["s:start", "s:p1", "s:done"],
    "held progress is dropped",
  );
  assert.equal(clock.pending(), 0);
  emit("s", running("t2", "q1"));
  emit("s", running("t2", "q2"));
  emit("s", {
    label: "Subtask failed",
    detail: "failed",
    metadata: { taskId: "t2" },
  });
  assert.deepEqual(sent.slice(3), ["s:q1", "s:failed"]);
});

test("events without a task are never held", () => {
  const { sent, emit } = progressHarness();
  emit("s", { label: "Subtask running", detail: "no task" });
  emit("s", { label: "Subtask running", detail: "still none" });
  emit("s", { label: "Using tool", detail: "Bash", metadata: { taskId: "t" } });
  emit("s", {
    label: "Using tool",
    detail: "Bash again",
    metadata: { taskId: "t" },
  });
  assert.deepEqual(sent, [
    "s:no task",
    "s:still none",
    "s:Bash",
    "s:Bash again",
  ]);
});

function responseHarness() {
  const clock = fakeClock();
  const sent = [];
  const batcher = createResponseStreamBatcher(
    (update) => sent.push(update.detail),
    clock,
  );
  return { clock, sent, batcher };
}

test("a streamed answer is batched to one update per interval", () => {
  assert.ok(responseStreamIntervalMs >= 250);
  const { clock, sent, batcher } = responseHarness();
  let text = "";
  for (let index = 0; index < 20; index += 1) {
    text += `w${index} `;
    batcher.offer({ detail: text, message: { id: "m1" } });
    clock.advance(50);
  }
  // 20 updates over a second: the first at once, then one per 250ms.
  assert.ok(sent.length <= 5, `sent ${sent.length} updates`);
  assert.equal(sent[0], "w0 ");
  batcher.flush();
  assert.equal(sent.at(-1), text, "the final text is exact");
  assert.equal(clock.pending(), 0);
});

test("a new message flushes the held one first", () => {
  const { sent, batcher } = responseHarness();
  batcher.offer({ detail: "first", message: { id: "m1" } });
  batcher.offer({ detail: "first, longer", message: { id: "m1" } });
  batcher.offer({ detail: "second", message: { id: "m2" } });
  assert.deepEqual(sent, ["first", "first, longer"]);
  batcher.flush();
  assert.deepEqual(sent, ["first", "first, longer", "second"]);
  batcher.flush();
  assert.equal(sent.length, 3, "flushing nothing sends nothing");
});

test("a held update goes out when the interval ends", () => {
  const { clock, sent, batcher } = responseHarness();
  batcher.offer({ detail: "a" });
  clock.advance(100);
  batcher.offer({ detail: "ab" });
  clock.advance(149);
  assert.deepEqual(sent, ["a"]);
  clock.advance(1);
  assert.deepEqual(sent, ["a", "ab"]);
});
