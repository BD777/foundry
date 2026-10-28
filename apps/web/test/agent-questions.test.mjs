// Codex async questions (request_user_input_async, DEV-063): the reply
// envelope Codex's own apps send, the states read from the transcript, and
// the card's keyboard and delivery.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "KeyboardEvent",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
await import("../src/i18n/index.ts");
const {
  agentQuestionReplyText,
  parseAgentQuestionReply,
  withAgentQuestionStates,
} = await import("../src/components/conversation/agent-questions.ts");
const { AgentQuestionCard } =
  await import("../src/components/conversation/agent-question-card.tsx");

const questions = [
  { title: "Which scope?", options: ["Q4 cumulative", "Created in Q4"] },
  { title: "Anything else?" },
];

test("the reply uses Codex's envelope and reads back", () => {
  const text = agentQuestionReplyText("call_1", questions, [
    "Created in Q4",
    "",
  ]);
  // The shape Codex's own app sent in a recorded session.
  assert.equal(
    text,
    '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_1\\",0]","question":"Which scope?","answer":"Created in Q4"}]\n</send_user_message_question_reply>\n',
  );
  assert.deepEqual(parseAgentQuestionReply(text), [
    {
      itemId: "call_1",
      index: 0,
      question: "Which scope?",
      answer: "Created in Q4",
    },
  ]);
  assert.equal(parseAgentQuestionReply("plain text"), undefined);
  assert.equal(
    parseAgentQuestionReply(
      "<send_user_message_question_reply>not json</send_user_message_question_reply>",
    ),
    undefined,
  );
});

test("states follow the transcript: waiting, assumed, unanswered, answered", () => {
  const asked = {
    id: "a",
    role: "bot",
    text: "Which scope?",
    questions,
    questionItemId: "call_1",
  };
  const states = (messages, active) =>
    withAgentQuestionStates(messages, active).map(
      (message) => message.questionState,
    );
  assert.deepEqual(states([asked], true), ["waiting"]);
  assert.deepEqual(states([asked], false), ["assumed"]);
  const other = { id: "u", role: "user", text: "Something else" };
  assert.deepEqual(states([asked, other], true), ["unanswered", undefined]);
  const reply = {
    id: "r",
    role: "user",
    text: agentQuestionReplyText("call_1", questions, ["Q4 cumulative", "no"]),
  };
  const answered = withAgentQuestionStates([asked, other, reply], false);
  assert.equal(answered[0].questionState, "answered");
  assert.deepEqual(answered[0].questionAnswers, ["Q4 cumulative", "no"]);
  assert.deepEqual(answered[2].questionReply, [
    { question: "Which scope?", answer: "Q4 cumulative" },
    { question: "Anything else?", answer: "no" },
  ]);
  // A reply that came from another app reads as an answer without its question.
  const alone = withAgentQuestionStates([reply], false);
  assert.equal(alone[0].questionReply.length, 2);
  // Nothing to do: the same array.
  const plain = [other];
  assert.equal(withAgentQuestionStates(plain, true), plain);
});

async function render(props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(AgentQuestionCard, props)));
  return { container, root };
}

function key(target, value) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: value, bubbles: true }),
  );
}

test("the card picks with digits, sends once with Enter and collapses with Esc", async () => {
  const sent = [];
  const { container, root } = await render({
    active: true,
    itemId: "call_1",
    questions,
    state: "waiting",
    onAnswer: async (text, id) => {
      sent.push({ text, id });
      return undefined;
    },
  });
  const radios = [...container.querySelectorAll('input[type="radio"]')];
  // Two options and "Other"; the recommended first one is chosen.
  assert.equal(radios.length, 3);
  assert.equal(radios[0].checked, true);
  await act(async () => key(radios[0], "2"));
  assert.equal(radios[1].checked, true);
  const free = container.querySelectorAll('input:not([type="radio"])');
  assert.equal(free.length, 1);
  await act(async () => {
    const input = free[0];
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "nothing else");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => key(radios[1], "Enter"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, "question:call_1");
  assert.deepEqual(
    parseAgentQuestionReply(sent[0].text).map((reply) => reply.answer),
    ["Created in Q4", "nothing else"],
  );
  assert.match(container.textContent, /Answer sent/);
  await act(async () => root.unmount());
});

test("a passed-over question is collapsed and reopens to answer late", async () => {
  const { container, root } = await render({
    active: false,
    itemId: "call_1",
    questions,
    state: "assumed",
    onAnswer: async () => undefined,
  });
  assert.equal(container.querySelector("form"), null);
  assert.match(container.textContent, /Continued on its own assumption/);
  const reopen = [...container.querySelectorAll("button")].find((button) =>
    /Answer/.test(button.textContent),
  );
  await act(async () => reopen.click());
  const form = container.querySelector("form");
  assert.ok(form);
  assert.match(form.textContent, /Starts the agent's next turn/);
  await act(async () => key(form.querySelector("input"), "Escape"));
  assert.equal(container.querySelector("form"), null);
  await act(async () => root.unmount());
});

test("an open question collapses when the turn ends, unless it is being answered", async () => {
  const props = {
    active: true,
    itemId: "call_1",
    questions,
    state: "waiting",
    onAnswer: async () => undefined,
  };
  const { container, root } = await render(props);
  assert.ok(container.querySelector("form"));
  await act(async () =>
    root.render(
      createElement(AgentQuestionCard, {
        ...props,
        active: false,
        state: "assumed",
      }),
    ),
  );
  assert.equal(container.querySelector("form"), null, "collapsed live");
  assert.match(container.textContent, /Continued on its own assumption/);
  // Waiting again, then the turn ends while the person picks an option.
  await act(async () => root.render(createElement(AgentQuestionCard, props)));
  container.querySelector('input[type="radio"]').focus();
  await act(async () =>
    root.render(
      createElement(AgentQuestionCard, {
        ...props,
        active: false,
        state: "assumed",
      }),
    ),
  );
  assert.ok(container.querySelector("form"), "kept open while answering");
  await act(async () => root.unmount());
});
