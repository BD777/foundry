import assert from "node:assert/strict";
import test from "node:test";
import { processLabels } from "@bd777/foundry-protocol";
import { slotWaitNotice } from "../dist/session/slot-wait.js";

test("a queued turn shows why it waits; the same event says when it started", () => {
  const sent = [];
  let now = 1_000;
  const notice = slotWaitNotice(
    { send: (type, payload) => sent.push({ type, payload }) },
    { id: "sess_q", input: { id: "in_1" } },
    () => now,
  );
  notice.started({ running: 1, runningLimited: 1, limit: 4 });
  assert.equal(sent.length, 0, "a turn that never waited says nothing");
  notice.onWait({
    running: 4,
    runningExempt: 1,
    runningLimited: 3,
    limit: 4,
    queued: 1,
    queuedExempt: 0,
    queuedLimited: 1,
    hardHold: false,
    reasons: [],
    sameKey: false,
  });
  now += 125_000;
  notice.started({ running: 5, runningLimited: 4, limit: 4 });
  assert.equal(sent.length, 2);
  const [waiting, started] = sent.map((m) => m.payload.event);
  assert.equal(waiting.id, started.id, "one row, rewritten");
  assert.equal(waiting.sessionId, "sess_q");
  assert.equal(waiting.label, processLabels.waitingForSlot);
  assert.match(
    waiting.detail,
    /3 of 4 limited turns are running on this device/,
  );
  assert.match(waiting.detail, /1 additional turn is exempt from the limit/);
  assert.equal(started.label, processLabels.waitedForSlot);
  assert.match(started.detail, /waiting 2 min 5 s/);
});

test("a memory hard hold says that memory, not the turn limit, is the cause", () => {
  const sent = [];
  slotWaitNotice(
    { send: (type, payload) => sent.push({ type, payload }) },
    { id: "sess_q" },
  ).onWait({
    running: 0,
    runningExempt: 0,
    runningLimited: 0,
    limit: 4,
    queued: 1,
    queuedExempt: 0,
    queuedLimited: 1,
    hardHold: true,
    reasons: ["memory_hard_hold"],
    sameKey: false,
  });
  assert.match(sent[0].payload.event.detail, /low on available memory/);
});
