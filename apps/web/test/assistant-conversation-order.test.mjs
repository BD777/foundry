// The assistant's conversation keeps the server's order through a live
// exchange through durable receipt and serialized dispatch. Replays a two-message sequence (dev, 2026-10-15; text
// de-identified, steps trimmed): the first message creates the session, the
// second continues it. The server answers a create and a send without
// events, and streams no event for a new session's first input, so the page
// learns that message only by reading the session.
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({ url: "https://foundry.example/assistant" });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });

let stream;
let streamed = 0;
globalThis.EventSource = class {
  constructor() {
    stream = this;
  }
  addEventListener() {}
  close() {}
};
function emit(type, payload) {
  stream.onmessage?.({
    lastEventId: `ep-${++streamed}`,
    data: JSON.stringify({ type, payload }),
  });
}

const workspaceId = "ws_pa";
const base = Date.now() - 5 * 60_000;
const at = (ms) => new Date(base + ms).toISOString();
const firstInput = "e19acfec-19d2-4722-9206-e09a2910ad2a";
const secondInput = "42855f7f-139b-4c53-b8c3-e6634bc0beed";
const firstText = "Hi, where do you run? Which workspaces do I have?";
const firstAnswer = "I run on your server. You have 17 workspaces.";
const secondText = "Can you keep a to-do list for me?";
const secondAnswer = "Yes. Tell me an item and I will note it.";

/** The server: what it stores, and what it streams and answers. */
const stored = new Map();
const inbox = [];
const slim = (session) => ({ ...session, events: undefined });
function userEvent(sessionId, input) {
  return {
    id: `evt_${input.id}`,
    sessionId,
    at: input.at,
    label: "User message",
    detail: "",
    level: "info",
    message: { id: input.id, kind: "user", text: input.prompt, at: input.at },
  };
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const route = `${method} ${url.pathname}`;
  if (route === "GET /api/personal-agent/inbox") return json(inbox);
  if (route === "POST /api/personal-agent/inbox") {
    const existing = inbox.find((e) => e.messageId === body.messageId);
    if (existing) return json(existing, 202);
    const entry = {
      id: `inbox_${body.messageId}`,
      rootId: `inbox_${body.messageId}`,
      channel: "web",
      messageId: body.messageId,
      text: body.text,
      inputId: body.messageId,
      status: "pending",
      revision: 1,
      createdAt: at(inbox.length ? 73001 : 0),
      updatedAt: at(inbox.length ? 73001 : 0),
    };
    inbox.push(entry);
    dispatchInbox(entry);
    return json(entry, 202);
  }
  if (route === "GET /api/agent-sessions")
    return json(
      [...stored.values()]
        .filter(
          (session) =>
            session.workspaceId === url.searchParams.get("workspaceId"),
        )
        .map(slim),
    );
  const read = url.pathname.match(/^\/api\/agent-sessions\/([^/]+)$/);
  if (method === "GET" && read && stored.has(read[1]))
    return json(stored.get(read[1]));
  throw new Error(`unexpected ${route}`);
};

function dispatchInbox(entry) {
  const latest = [...stored.values()].at(-1);
  if (latest && ["queued", "running", "blocked"].includes(latest.status))
    return;
  const session = latest
    ? sendMessage(latest.id, entry.inputId, entry.text, 73001)
    : createSession("sess_1792025645924060412", entry.inputId, entry.text, 0);
  entry.sessionId = session.id;
  entry.status = "delivered";
}

/** Creating a session (the page, Feishu, a new conversation after a quiet spell). */
function createSession(id, inputId, prompt, atMs) {
  const input = { id: inputId, prompt, at: at(atMs) };
  const session = {
    id,
    threadId: id,
    workspaceId,
    agentId: "agent_pa",
    deviceId: "dev_server",
    provider: "claude",
    role: "personal_agent",
    source: "chat",
    status: "queued",
    title: prompt,
    prompt,
    createdLabel: "",
    updatedLabel: "",
    input,
    // The store writes the input's event; nothing streams it.
    events: [userEvent(id, input)],
  };
  stored.set(id, session);
  emit("agent_session_created", slim(session));
  return slim(session);
}

/** A message to a session: its next input, or a steer while it runs. */
function sendMessage(id, inputId, prompt, atMs) {
  const session = stored.get(id);
  if (session.status === "running") {
    session.steers = [
      ...(session.steers ?? []),
      { id: inputId, prompt, at: at(atMs) },
    ];
    return slim(session);
  }
  session.input = { id: inputId, prompt, at: at(atMs) };
  session.status = "queued";
  session.response = "";
  session.startedAt = "";
  const event = userEvent(session.id, session.input);
  session.events.push(event);
  emit("agent_session_event", event);
  emit("agent_session_created", slim(session));
  return slim(session);
}

/** The device takes a steer in: its transcript says what the person said. */
function takeSteer(id) {
  const session = stored.get(id);
  const steer = session.steers.shift();
  const event = userEvent(id, steer);
  session.events.push(event);
  emit("agent_session_event", event);
}

/** The session's device runs one turn: its steps stream as they happen. */
function runTurn(sessionId, inputId, startMs, answer, { midway } = {}) {
  const session = stored.get(sessionId);
  session.status = "running";
  session.startedAt = at(startMs);
  emit("agent_session_started", slim(session));
  midway?.();
  const step = (ms, label, detail, extra = {}) => ({
    id: `evt_${sessionId}_${startMs + ms}`,
    sessionId,
    at: at(startMs + ms),
    label,
    detail,
    level: "info",
    ...extra,
  });
  const steps = [
    step(2_441, "Loaded skills", "foundry, skill-creator"),
    step(3_907, "Requesting model", "Claude is generating a response."),
    step(4_771, "Thinking", "Claude is thinking.", {
      message: {
        id: `${inputId}/`,
        kind: "reasoning",
        text: "Claude is thinking.",
      },
    }),
    step(7_675, "Using tool", "mcp__foundry__list_workspaces", {
      message: {
        id: `${inputId}/toolu_1`,
        kind: "tool",
        text: "mcp__foundry__list_workspaces",
      },
    }),
    {
      ...step(12_536, "Response stream", answer),
      id: `evt_${sessionId}_${inputId}_response_stream`,
    },
    step(12_558, "Claude Agent SDK finished", ""),
  ];
  for (const event of steps) {
    if (event.label === "Response stream") session.beforeAnswer?.();
    session.events.push(event);
    emit("agent_session_event", event);
  }
  session.status = "completed";
  session.response = answer;
  session.lastActivityAt = at(startMs + 12_558);
  session.completedAt = at(startMs + 12_558);
  emit("agent_session_completed", slim(session));
}

const { createRoot } = await import("react-dom/client");
const { useAssistantConversation } =
  await import("../src/features/personal-agent/use-assistant-conversation.ts");

const runtime = { provider: "claude", profileId: "claude_local" };
const settle = () =>
  act(async () => {
    for (let index = 0; index < 6; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** The home's conversation, rendered; `shown` is what it lists, in order. */
async function openConversation() {
  stored.clear();
  inbox.length = 0;
  const view = {};
  function Harness() {
    view.conversation = useAssistantConversation(workspaceId);
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  await act(async () => stream.onopen?.());
  await settle();
  view.shown = () =>
    view.conversation.lines.map((line) => `${line.role}: ${line.text}`);
  view.close = () => act(async () => root.unmount());
  return view;
}

test("the first message stays first after the second is answered (real sequence)", async () => {
  const page = await openConversation();
  const shown = page.shown;

  await act(() => page.conversation.send(firstText, firstInput, runtime));
  await settle();
  await act(async () =>
    runTurn("sess_1792025645924060412", firstInput, 2_441, firstAnswer),
  );
  await settle();
  assert.deepEqual(shown(), [
    `person: ${firstText}`,
    `assistant: ${firstAnswer}`,
  ]);

  await act(() => page.conversation.send(secondText, secondInput, runtime));
  await settle();
  await act(async () =>
    runTurn("sess_1792025645924060412", secondInput, 73_338, secondAnswer),
  );
  await settle();
  assert.deepEqual(shown(), [
    `person: ${firstText}`,
    `assistant: ${firstAnswer}`,
    `person: ${secondText}`,
    `assistant: ${secondAnswer}`,
  ]);
  await page.close();
});

test("a conversation started in Feishu keeps its first message first", async () => {
  const page = await openConversation();
  await act(async () => createSession("sess_feishu", firstInput, firstText, 0));
  await settle();
  await act(async () => runTurn("sess_feishu", firstInput, 2_441, firstAnswer));
  await settle();
  await act(async () =>
    sendMessage("sess_feishu", secondInput, secondText, 73_001),
  );
  await act(async () =>
    runTurn("sess_feishu", secondInput, 73_338, secondAnswer),
  );
  await settle();
  assert.deepEqual(page.shown(), [
    `person: ${firstText}`,
    `assistant: ${firstAnswer}`,
    `person: ${secondText}`,
    `assistant: ${secondAnswer}`,
  ]);
  await page.close();
});

test("a message received during a reply is saved once and continues after that reply", async () => {
  const page = await openConversation();
  await act(() => page.conversation.send(firstText, firstInput, runtime));
  await settle();
  const session = stored.get("sess_1792025645924060412");
  await act(async () =>
    runTurn(session.id, firstInput, 2_441, firstAnswer, {
      midway: () =>
        void page.conversation.send(secondText, secondInput, runtime),
    }),
  );
  await settle();
  assert.deepEqual(page.shown(), [
    `person: ${firstText}`,
    `assistant: ${firstAnswer}`,
    `person: ${secondText}`,
  ]);
  assert.equal(inbox.filter((e) => e.messageId === secondInput).length, 1);
  assert.equal(
    inbox.find((e) => e.messageId === secondInput).status,
    "pending",
  );
  await act(async () =>
    dispatchInbox(inbox.find((e) => e.messageId === secondInput)),
  );
  await settle();
  await act(async () => runTurn(session.id, secondInput, 73338, secondAnswer));
  await settle();
  assert.deepEqual(page.shown(), [
    `person: ${firstText}`,
    `assistant: ${firstAnswer}`,
    `person: ${secondText}`,
    `assistant: ${secondAnswer}`,
  ]);
  await page.close();
});
