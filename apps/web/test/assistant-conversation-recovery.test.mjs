// The assistant's conversation recovers and stays current (DEV-287). Two
// replays on the hook alone:
// - a full read that started before the session's completion arrived on the
//   stream must not put its older status back (the page showed Running after
//   the answer had been stored);
// - a read that failed while the network was down is read again by itself;
//   the page used to keep its error until someone pressed retry.
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
const sessionId = "sess_home";
const startedAt = new Date(Date.now() - 60_000).toISOString();
const input = { id: "input_1", prompt: "How are the helpers?", at: startedAt };

/** What the server holds for the home session; reads answer from it. */
let stored;
/** When set, the next full read of the session waits for this promise. */
let holdSessionRead;
/** How many of the next session-list reads fail (the network is down). */
let failSessionListReads = 0;

function session(overrides = {}) {
  return {
    id: sessionId,
    threadId: sessionId,
    workspaceId,
    agentId: "agent_pa",
    deviceId: "dev_server",
    provider: "claude",
    role: "personal_agent",
    source: "chat",
    status: "running",
    title: "Home",
    startedAt,
    lastActivityAt: startedAt,
    input,
    events: [],
    ...overrides,
  };
}

globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const json = (value) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (method === "GET" && target.pathname === "/api/agent-sessions") {
    if (failSessionListReads > 0) {
      failSessionListReads -= 1;
      throw new TypeError("Failed to fetch");
    }
    return json([{ ...stored, events: undefined }]);
  }
  if (
    method === "GET" &&
    target.pathname === `/api/agent-sessions/${sessionId}`
  ) {
    // The answer carries the session as it was when the read reached the server.
    const answer = stored;
    if (holdSessionRead) await holdSessionRead.promise;
    return json(answer);
  }
  if (method === "GET" && target.pathname.endsWith("/inbox")) return json([]);
  if (method === "GET" && target.pathname.endsWith("/channels"))
    return json([]);
  throw new Error(`unexpected ${method} ${target.pathname}`);
};

const { createRoot } = await import("react-dom/client");
const { useAssistantConversation } =
  await import("../src/features/personal-agent/use-assistant-conversation.ts");

const settle = (ticks = 6) =>
  act(async () => {
    for (let index = 0; index < ticks; index += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mountConversation() {
  const view = {};
  function Harness() {
    view.conversation = useAssistantConversation("asst_1", workspaceId);
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  await act(async () => stream.onopen?.());
  await settle();
  view.close = () => act(async () => root.unmount());
  return view;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

test("a read started before a completion keeps the completion it overtook", async () => {
  stored = session();
  const view = await mountConversation();
  assert.equal(view.conversation.state, "ready");
  assert.equal(view.conversation.latestSession?.status, "running");

  // A read of the session starts and waits on the network.
  holdSessionRead = deferred();
  let reading;
  await act(async () => {
    reading = view.conversation.retry();
  });
  await settle(2);

  // The completion arrives on the stream while that read is in flight.
  const completed = session({
    status: "completed",
    completedAt: new Date().toISOString(),
    response: "Two helpers finished.",
  });
  stored = completed;
  emit("agent_session_completed", completed);
  await settle(2);
  assert.equal(view.conversation.latestSession?.status, "completed");

  // The read answers with what the session was before the completion.
  holdSessionRead.resolve();
  holdSessionRead = undefined;
  await act(async () => reading);
  await settle();

  assert.equal(
    view.conversation.latestSession?.status,
    "completed",
    "a stale read must not put the running status back",
  );
  assert.equal(view.conversation.working, false);
  await view.close();
});

test("a read that failed while offline is read again without a retry press", async () => {
  stored = session({
    status: "completed",
    completedAt: startedAt,
    response: "Done.",
  });
  failSessionListReads = 1;
  const view = await mountConversation();
  assert.equal(view.conversation.state, "failed");

  // The retry is scheduled by itself; no stream event or press is needed.
  const deadline = Date.now() + 15_000;
  while (view.conversation.state !== "ready" && Date.now() < deadline)
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(view.conversation.state, "ready");
  await view.close();
});
