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
  // Enter on the first question goes on to the second; from the last, it sends.
  await act(async () => radios[1].focus());
  await act(async () => key(radios[1], "Enter"));
  assert.equal(sent.length, 0);
  assert.equal(document.activeElement, free[0]);
  await act(async () => key(free[0], "Enter"));
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

test("Claude's questions: header, option details, several choices, no implied recommendation", async () => {
  const sent = [];
  const claude = [
    {
      title: "Which greeting?",
      header: "Greeting",
      options: ["Hello (Recommended)", "Bonjour"],
      descriptions: ["Plain English", "French"],
      unranked: true,
    },
    {
      title: "Which extras?",
      options: ["Emoji", "Signature"],
      multiSelect: true,
      unranked: true,
    },
  ];
  const { container, root } = await render({
    active: true,
    itemId: "toolu_1",
    questions: claude,
    state: "waiting",
    onAnswer: async (text, id) => {
      sent.push({ text, id });
      return undefined;
    },
  });
  assert.match(container.textContent, /Greeting/);
  assert.match(container.textContent, /Plain English/);
  // Claude names its recommendation in the option; Foundry adds none.
  assert.doesNotMatch(container.textContent, /Recommended(?!\))/);
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  // Two options and "Other", none chosen yet.
  assert.equal(boxes.length, 3);
  assert.equal(
    boxes.some((box) => box.checked),
    false,
  );
  await act(async () => key(boxes[0], "1"));
  await act(async () => key(boxes[0], "2"));
  assert.deepEqual(
    boxes.map((box) => box.checked),
    [true, true, false],
  );
  const radios = [...container.querySelectorAll('input[type="radio"]')];
  await act(async () => radios[0].focus());
  await act(async () => key(radios[0], "2"));
  await act(async () => boxes[0].focus());
  await act(async () => key(boxes[0], "Enter"));
  assert.equal(sent.length, 1);
  assert.deepEqual(
    parseAgentQuestionReply(sent[0].text).map((reply) => reply.answer),
    ["Bonjour", "Emoji, Signature"],
  );
  await act(async () => root.unmount());
});

test("a link in a question opens in a new tab, even right after CJK punctuation", async () => {
  const url =
    "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=J7WZ-CV7V";
  const { container, root } = await render({
    active: true,
    itemId: "call_link",
    questions: [
      {
        title: `请打开以下链接授权，完成后回复“已授权”\n仓库：${url}`,
        options: ["已授权"],
      },
    ],
    state: "waiting",
    onAnswer: async () => undefined,
  });
  const link = container.querySelector(".fdy-chat-question a");
  assert.ok(link, "the URL is a link");
  assert.equal(link.getAttribute("href"), url);
  assert.equal(link.getAttribute("target"), "_blank");
  assert.match(link.getAttribute("rel") ?? "", /noreferrer/);
  // The question still names its group of choices.
  const group = container.querySelector("fieldset");
  const title = document.getElementById(group.getAttribute("aria-labelledby"));
  assert.match(title.textContent, /请打开以下链接授权/);
  await act(async () => root.unmount());
});

test("Enter after typing an answer goes to the next question, never sends the rest unseen", async () => {
  const sent = [];
  const three = [
    { title: "Q1?", options: ["A", "B"] },
    { title: "Q2?", options: ["C", "D"] },
    { title: "Q3?", options: ["E", "F"] },
  ];
  const { container, root } = await render({
    active: true,
    itemId: "call_three",
    questions: three,
    state: "waiting",
    onAnswer: async (text) => {
      sent.push(text);
      return undefined;
    },
  });
  assert.match(container.textContent, /Enter goes to the next question/);
  const groups = () => [...container.querySelectorAll("fieldset")];
  const otherRadio = groups()[0].querySelectorAll('input[type="radio"]')[2];
  await act(async () => otherRadio.click());
  const own = groups()[0].querySelector('input:not([type="radio"])');
  await act(async () => own.focus());
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(own, "my own answer");
    own.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Enter while an input method composes does nothing.
  await act(async () =>
    own.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        isComposing: true,
      }),
    ),
  );
  assert.equal(document.activeElement, own);
  await act(async () => key(own, "Enter"));
  assert.equal(sent.length, 0, "nothing sent from the first question");
  assert.ok(groups()[1].contains(document.activeElement));
  // From the last question, an unseen one is visited before anything is sent.
  const last = groups()[2].querySelector("input");
  await act(async () => last.focus());
  await act(async () => key(last, "Enter"));
  assert.equal(sent.length, 1, "every question was seen: it sends");
  assert.deepEqual(
    parseAgentQuestionReply(sent[0]).map((reply) => reply.answer),
    ["my own answer", "C", "E"],
  );
  await act(async () => root.unmount());
});

test("from the last question, Enter first visits a question not yet seen", async () => {
  const sent = [];
  const { container, root } = await render({
    active: true,
    itemId: "call_skip",
    questions: [
      { title: "Q1?", options: ["A", "B"] },
      { title: "Q2?", options: ["C", "D"] },
    ],
    state: "waiting",
    onAnswer: async (text) => {
      sent.push(text);
      return undefined;
    },
  });
  const groups = [...container.querySelectorAll("fieldset")];
  const last = groups[1].querySelector("input");
  await act(async () => last.focus());
  await act(async () => key(last, "Enter"));
  assert.equal(sent.length, 0);
  assert.ok(groups[0].contains(document.activeElement));
  await act(async () => key(document.activeElement, "Enter"));
  await act(async () => key(document.activeElement, "Enter"));
  assert.equal(sent.length, 1);
  await act(async () => root.unmount());
});
