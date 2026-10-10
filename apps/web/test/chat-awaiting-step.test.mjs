import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register("./bundler-resolve.mjs", import.meta.url);
const { chatMessagesForThread } =
  await import("../src/features/chat/chat-model.ts");
const { i18n } = await import("../src/i18n/index.ts");

const at = (second) =>
  new Date(Date.UTC(2026, 9, 10, 1, 0, second)).toISOString();
const event = (id, second, label, detail, message) => ({
  id,
  at: at(second),
  label,
  detail,
  level: "info",
  sessionId: "s",
  ...(message ? { message } : {}),
});
const input = (id, second, text) =>
  event(`evt_${id}`, second, "User message", "", { id, kind: "user", text });
const firstTurn = [
  input("in_1", 1, "First question"),
  event("think", 2, "Thinking", "Claude is processing the request."),
  event("answer", 3, "Response stream", "First answer"),
];
const thread = (session) => ({
  id: "t",
  sessions: [
    { id: "s", provider: "claude", prompt: "First question", ...session },
  ],
});
const awaiting = (messages) =>
  messages.filter((message) => message.id === "agent-session:s:awaiting-step");

test("a running session shows it is working under an input no step followed yet", () => {
  const messages = chatMessagesForThread(
    thread({
      status: "running",
      events: [...firstTurn, input("in_2", 10, "Next question")],
    }),
  );
  const last = messages.at(-1);
  assert.equal(messages.at(-2).text, "Next question");
  assert.equal(last.id, "agent-session:s:awaiting-step");
  assert.equal(last.kind, "process");
  assert.equal(last.streaming, true);
  assert.equal(last.title, i18n.t("chat:transcript.processing"));
});

test("an accepted input whose own event has not arrived still shows the agent working", () => {
  const messages = chatMessagesForThread(
    thread({
      status: "running",
      input: { id: "in_2", prompt: "Next question", at: at(10) },
      events: firstTurn,
    }),
  );
  assert.equal(messages.at(-2).text, "Next question");
  assert.equal(messages.at(-1).id, "agent-session:s:awaiting-step");
});

test("a steer and a session still waiting for its device show it too", () => {
  const steered = chatMessagesForThread(
    thread({
      status: "running",
      events: [
        ...firstTurn,
        input("in_2", 10, "Next question"),
        event(
          "req",
          11,
          "Requesting model",
          "Claude is generating a response.",
        ),
        event("steer", 12, "Steered into active turn", "Also check the tests"),
      ],
    }),
  );
  assert.equal(steered.at(-2).text, "Also check the tests");
  assert.equal(steered.at(-1).id, "agent-session:s:awaiting-step");
  const queued = chatMessagesForThread(
    thread({
      status: "queued",
      events: [...firstTurn, input("in_2", 10, "Next question")],
    }),
  );
  assert.equal(queued.at(-1).title, i18n.t("chat:transcript.processing"));
});

test("the first real step replaces the indicator, and a settled session has none", () => {
  const working = chatMessagesForThread(
    thread({
      status: "running",
      events: [
        ...firstTurn,
        input("in_2", 10, "Next question"),
        event(
          "req",
          11,
          "Requesting model",
          "Claude is generating a response.",
        ),
      ],
    }),
  );
  assert.deepEqual(awaiting(working), []);
  assert.equal(working.at(-1).kind, "process");
  assert.equal(working.at(-1).streaming, true);
  const done = chatMessagesForThread(
    thread({
      status: "completed",
      events: [...firstTurn, input("in_2", 10, "Next question")],
    }),
  );
  assert.deepEqual(awaiting(done), []);
});
