// A queued message with annotations is one the transcript shows as the
// person wrote it (its comment chips and text), and it stops waiting once the
// transcript holds its steered copy: that copy is recorded under its turn's
// input id, so the annotation ids are what matches the two.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);
const { withOutbox } =
  await import("../src/features/chat/composer/chat-outbox.ts");
const { annotatedPromptText } =
  await import("../src/components/conversation/annotations.ts");

const session = "sess_s";
const at = (time) => `2026-11-19T${time}Z`;

function annotation(id, comment) {
  return {
    id,
    selectedText: `passage ${id}`,
    comment,
    sourceEventId: "agent-session:sess_s:answer",
    anchor: { start: 0, end: 9, textHash: "x" },
  };
}

/** The queue item the Web keeps: its text is the wrapper, its annotations ride along. */
function queuedEntry(id, annotations, time) {
  return {
    id,
    sessionId: session,
    inputId: id,
    text: annotatedPromptText("", annotations),
    annotations,
    at: at(time),
    state: "accepted",
    threadId: "chat_s",
  };
}

/** The steered copy the transcript holds: the input's id scoped, the text is the person's. */
function steeredMessage(annotations, time) {
  return {
    id: `agent-session:${session}:turn/steer_${annotations.map((a) => a.id).join("_")}`,
    role: "user",
    text: "",
    annotations,
    at: at(time),
  };
}

const turn = {
  id: `agent-session:${session}:turn`,
  role: "user",
  text: "请运行 sleep 60",
  at: at("05:00:38"),
};

test("an annotation-only steered message shows as its chips, and its queued copy is delivered", () => {
  const first = annotation("a1", "两种都留");
  const entries = [queuedEntry("q1", [first], "05:01:00")];
  const result = withOutbox(
    [turn, steeredMessage([first], "05:01:06")],
    entries,
    "chat_s",
  );
  assert.equal(result.messages.length, 2, "no second copy is shown");
  assert.equal(result.messages[1].clientId, "q1");
  assert.ok(result.delivered.has("q1"));
});

test("two adjacent annotation-only steers each match their own queued message", () => {
  const one = annotation("a1", "one");
  const two = annotation("a2", "two");
  const entries = [
    queuedEntry("q1", [one], "05:01:00"),
    queuedEntry("q2", [two], "05:01:02"),
  ];
  const result = withOutbox(
    [
      turn,
      steeredMessage([one], "05:01:06"),
      steeredMessage([two], "05:01:08"),
    ],
    entries,
    "chat_s",
  );
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1].clientId, "q1");
  assert.equal(result.messages[2].clientId, "q2");
  assert.deepEqual([...result.delivered].sort(), ["q1", "q2"]);
});

test("a queued message whose steered copy has not arrived waits as the person wrote it", () => {
  const pending = annotation("a3", "still waiting");
  const result = withOutbox(
    [turn],
    [queuedEntry("q3", [pending], "05:01:00")],
    "chat_s",
  );
  const waiting = result.messages.at(-1);
  assert.equal(result.messages.length, 2);
  assert.equal(waiting.role, "user");
  assert.equal(waiting.text, "", "the wrapper is never the text");
  assert.equal(waiting.annotations.length, 1);
  assert.equal(waiting.annotations[0].id, "a3");
  assert.equal(result.delivered.has("q3"), false);
});

test("a steered copy of other annotations does not deliver a queued message", () => {
  const mine = annotation("a4", "mine");
  const other = annotation("a5", "other");
  const result = withOutbox(
    [turn, steeredMessage([other], "05:01:06")],
    [queuedEntry("q4", [mine], "05:01:00")],
    "chat_s",
  );
  assert.equal(result.delivered.has("q4"), false);
  assert.equal(result.messages.at(-1).annotations[0].id, "a4");
});

test("a queued message without annotations still matches its own input id", () => {
  const entry = {
    id: "q5",
    sessionId: session,
    inputId: "q5",
    text: "hello",
    at: at("05:01:00"),
    state: "accepted",
    threadId: "chat_s",
  };
  const message = {
    id: `agent-session:${session}:q5`,
    role: "user",
    text: "hello",
    at: at("05:01:01"),
  };
  const result = withOutbox([turn, message], [entry], "chat_s");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].clientId, "q5");
});
