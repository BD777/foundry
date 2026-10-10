import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAgentEvent,
  appendAgentEvents,
  normalizeAgentEvents,
  prependOlderAgentEvents,
  reconcileAgentEvents,
} from "../src/lib/agent-event-log.ts";
import { mergeLoadedAgentSession } from "../src/lib/agent-session-events.ts";

const sessionId = "sess_log";

function at(index) {
  return new Date(Date.UTC(2026, 9, 10, 0, 0, 0) + index * 1000).toISOString();
}

function step(index, label = "Thinking") {
  return {
    id: `evt_${sessionId}_${index}`,
    sessionId,
    at: at(index),
    label,
    level: "info",
    detail: `step ${index}`,
  };
}

function stream(input, ordinal, text, index) {
  return {
    id: `evt_${sessionId}_${input}_response_stream${ordinal > 1 ? `_${ordinal}` : ""}`,
    sessionId,
    at: at(index),
    label: "Response stream",
    level: "info",
    detail: text,
  };
}

function steer(index, text) {
  return {
    id: `evt_input_${index}`,
    sessionId,
    at: at(index),
    label: "User message",
    level: "info",
    detail: "",
    message: { id: `input_${index}`, kind: "user", text },
  };
}

/** A live sequence: steps, growing answers, and steers. */
function liveSequence(length) {
  const events = [];
  let turn = 0;
  for (let index = 0; index < length; index += 1) {
    if (index % 500 === 0) {
      turn += 1;
      events.push(steer(index, `turn ${turn}`));
    } else if (index % 7 === 0) {
      // The same answer grows under one id.
      events.push(stream(`t${turn}`, 1, `answer ${turn} @${index}`, index));
    } else {
      events.push(step(index, index % 3 ? "Subtask running" : "Thinking"));
    }
  }
  return events;
}

function ids(events) {
  return events.map((event) => event.id);
}

test("merging live events is linear and keeps every event once", () => {
  const sequence = liveSequence(20_000);
  const expected = normalizeAgentEvents(sequence);
  // One burst: a single pass.
  let started = performance.now();
  const burst = appendAgentEvents([], sequence);
  assert.ok(performance.now() - started < 300, "burst merge");
  assert.deepEqual(ids(burst), ids(expected));
  // Bursts onto a long transcript cost one copy each, not a scan per event
  // (the old merge filtered the whole list per event): the same 400 events
  // in 10 bursts cost far less than in 100. A ratio of two back-to-back
  // runs holds on a loaded machine where a wall-clock budget does not.
  const history = normalizeAgentEvents(liveSequence(11_000));
  const appendInBursts = (size) => {
    let events = history;
    const begun = performance.now();
    for (let index = 0; index < 400; index += size) {
      events = appendAgentEvents(
        events,
        Array.from({ length: size }, (_, offset) =>
          step(100_000 + index + offset),
        ),
      );
    }
    return { events, ms: performance.now() - begun };
  };
  const fastest = (size) =>
    Math.min(...[0, 1, 2].map(() => appendInBursts(size).ms));
  assert.ok(fastest(40) < fastest(4) / 3, "a burst costs one pass");
  assert.equal(appendInBursts(4).events.length, history.length + 400);
  // Single appends agree with the burst.
  let single = [];
  for (const event of sequence.slice(0, 3_000))
    single = appendAgentEvent(single, event);
  assert.deepEqual(
    ids(single),
    ids(appendAgentEvents([], sequence.slice(0, 3_000))),
  );
  assert.equal(new Set(ids(burst)).size, burst.length);
});

test("normalizing scales linearly and keeps an already normal list as is", () => {
  const sequence = liveSequence(20_000);
  const started = performance.now();
  const normalized = normalizeAgentEvents(sequence);
  assert.ok(performance.now() - started < 500);
  assert.equal(normalizeAgentEvents(normalized), normalized);
  // Each growing answer collapsed into its first position.
  const answers = normalized.filter(
    (event) => event.label === "Response stream",
  );
  assert.equal(answers.length, 40);
  assert.match(answers[0].detail, /^answer 1 @49\d$/);
});

test("an older snapshot after a steer keeps the steer", () => {
  const before = [step(1), stream("t1", 1, "hello", 2)];
  let shown = before;
  // A steer arrives live.
  shown = appendAgentEvent(shown, steer(3, "also do X"));
  shown = appendAgentEvent(shown, step(4));
  // The reply to an earlier request: a snapshot from before the steer.
  const older = [step(1), stream("t1", 1, "hello world", 2)];
  const merged = reconcileAgentEvents(shown, older);
  assert.deepEqual(ids(merged), ids(shown));
  assert.equal(merged[1].detail, "hello world");
  assert.equal(merged[2].message.text, "also do X");
});

/** What the server returns: one row per id, ordered by its last write. */
function serverSnapshot(sequence) {
  const last = new Map();
  sequence.forEach((event, index) => last.set(event.id, { event, index }));
  return [...last.values()]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.event);
}

test("replaying many snapshots of a live session never drops a shown event", () => {
  const sequence = liveSequence(3_000);
  let shown = [];
  const snapshots = [];
  for (let index = 0; index < sequence.length; index += 1) {
    shown = appendAgentEvent(shown, sequence[index]);
    if (index % 250 === 0)
      snapshots.push(serverSnapshot(sequence.slice(0, index + 1)));
    if (index % 400 === 0 && snapshots.length > 1) {
      // A late, older snapshot and a recent-window snapshot.
      const before = new Set(ids(shown));
      shown = reconcileAgentEvents(shown, snapshots[snapshots.length - 2]);
      shown = reconcileAgentEvents(
        shown,
        serverSnapshot(sequence.slice(0, index + 1)).slice(-200),
      );
      for (const id of before)
        assert.ok(
          shown.some((event) => event.id === id),
          id,
        );
      assert.equal(new Set(ids(shown)).size, shown.length);
    }
  }
  const final = serverSnapshot(sequence);
  assert.deepEqual(ids(reconcileAgentEvents(shown, final)), ids(final));
});

test("a recent window merges after older events shown, and newer live events stay last", () => {
  const sequence = liveSequence(1_000);
  const all = normalizeAgentEvents(sequence);
  const shown = [...all, step(5000)];
  const window = all.slice(-200);
  const merged = reconcileAgentEvents(shown, window);
  assert.equal(merged, shown);
});

test("an unchanged snapshot keeps the list's identity", () => {
  const events = normalizeAgentEvents(liveSequence(500));
  const copy = JSON.parse(JSON.stringify(events));
  assert.equal(reconcileAgentEvents(events, copy), events);
});

test("without a shared event, time decides which side is older", () => {
  const old = [step(1), step(2)];
  const recent = [step(10), step(11)];
  assert.deepEqual(
    ids(reconcileAgentEvents(old, recent)),
    ids([...old, ...recent]),
  );
  assert.deepEqual(
    ids(reconcileAgentEvents(recent, old)),
    ids([...old, ...recent]),
  );
});

test("an older page goes before what is shown, without duplicates", () => {
  const all = normalizeAgentEvents(liveSequence(1_000));
  const shown = all.slice(-200);
  const page = all.slice(-400, -150);
  assert.deepEqual(
    ids(prependOlderAgentEvents(shown, page)),
    ids(all.slice(-400)),
  );
});

test("sibling arrays that share an index stay correct", () => {
  const base = appendAgentEvent([], step(1));
  const left = appendAgentEvent(base, step(2));
  const right = appendAgentEvent(base, step(3));
  assert.deepEqual(ids(appendAgentEvent(left, step(2))), ids(left));
  assert.deepEqual(
    ids(appendAgentEvent(right, step(2))),
    ids([step(1), step(3), step(2)]),
  );
  assert.deepEqual(
    ids(appendAgentEvent(left, step(3))),
    ids([step(1), step(2), step(3)]),
  );
});

test("a session payload merge reconciles instead of replacing events", () => {
  const existing = {
    id: sessionId,
    status: "running",
    events: [step(1), steer(2, "steer"), step(3)],
  };
  const merged = mergeLoadedAgentSession(existing, {
    id: sessionId,
    status: "running",
    events: [step(1)],
  });
  assert.deepEqual(ids(merged.events), ids(existing.events));
});
