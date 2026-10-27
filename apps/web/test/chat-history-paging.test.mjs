import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { useChatTranscript } from "../src/features/chat/use-chat-transcript.ts";
import { createTranscriptLoader } from "../src/features/chat/chat-transcript-loader.ts";
import { chatMessagesForThread } from "../src/features/chat/chat-model.ts";
import { mergeLoadedAgentSession } from "../src/lib/agent-session-events.ts";

const session = {
  id: "dev050-paging",
  workspaceId: "dev050",
  provider: "codex",
  status: "completed",
  prompt: "The opening request",
  response: "Answer 639",
  startedAt: "2026-10-27T00:00:00Z",
};
const events = Array.from({ length: 640 }, (_, index) => ({
  id: `evt-${index}`,
  sessionId: session.id,
  at: new Date(Date.parse(session.startedAt) + index * 1000).toISOString(),
  label: index % 2 ? "Response" : "User message",
  level: "info",
  detail: "",
  message: {
    id: `msg-${index}`,
    kind: index % 2 ? "assistant" : "user",
    text: index === 0 ? session.prompt : `Message ${index}`,
  },
}));
const page = (end) => ({
  ...session,
  events: events.slice(Math.max(0, end - 200), end),
  eventsBefore: end > 200 ? String(end - 200) : undefined,
  eventsAfter: String(end),
});
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("four pages retain all turns and show the opening request exactly once through retries and repairs", async () => {
  let shown,
    state,
    fail = true;
  const loaded = [];
  const loader = createTranscriptLoader({
    transport: {
      loadRecent: async () => [page(640)],
      loadEarlier: async (_, before) => {
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
        return page(Number(before));
      },
    },
    onState: (next) => (state = next),
    onLoaded: (sessions) => {
      for (const next of sessions) {
        shown = mergeLoadedAgentSession(shown, next);
        loaded.push(next.events.length);
      }
    },
  });
  loader.select(session.id);
  loader.request("missing");
  await tick();
  assert.deepEqual(state.earlier, { [session.id]: "440" });
  loader.loadEarlier();
  await tick();
  assert.equal(state.earlierFailed, true);
  assert.deepEqual(state.earlier, { [session.id]: "440" });
  loader.loadEarlier();
  await tick();
  assert.deepEqual(state.earlier, { [session.id]: "240" });
  loader.request("resync");
  await tick();
  assert.deepEqual(
    state.earlier,
    { [session.id]: "240" },
    "repair cannot reset paging progress",
  );
  loader.loadEarlier();
  await tick();
  loader.loadEarlier();
  await tick();
  assert.deepEqual(state.earlier, {});
  assert.deepEqual(loaded, [200, 200, 200, 200, 40]);
  assert.equal(shown.events.length, 640);
  const messages = chatMessagesForThread({ id: session.id, sessions: [shown] });
  assert.equal(messages.filter((m) => m.text === session.prompt).length, 1);
  assert.equal(messages[0].text, session.prompt);
  assert.equal(messages.filter((m) => m.role === "user").length, 320);
  loader.request("retry");
  await tick();
  assert.deepEqual(
    state.earlier,
    {},
    "retry cannot reintroduce exhausted history",
  );
  assert.equal(shown.events.length, 640);
  loader.dispose();
});

test("reselecting a cached transcript restores the cursor and reaches the opening request", async (t) => {
  const dom = new Window({ url: "http://dev050.test/" });
  const saved = new Map();
  class EventSourceStub {
    readyState = 1;
    constructor() {
      queueMicrotask(() => this.onopen?.());
    }
    close() {}
  }
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    EventSource: EventSourceStub,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const root = createRoot(dom.document.createElement("div"));
  t.after(async () => {
    await act(() => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let selected = true,
    cached = session,
    history,
    recent = 0;
  const transport = {
    loadRecent: async () => {
      recent++;
      return [page(640)];
    },
    loadEarlier: async (_, before) => page(Number(before)),
  };
  function Probe() {
    history = useChatTranscript({
      workspaceId: "dev050",
      threadId: selected ? session.id : undefined,
      sessions: selected ? [cached] : [],
      transport,
      onLoaded: (loaded) => {
        for (const next of loaded)
          cached = mergeLoadedAgentSession(cached, next);
      },
    });
    return null;
  }
  const render = () =>
    act(async () => {
      root.render(createElement(Probe));
      await tick();
    });
  await render();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1600));
  });
  assert.equal(recent, 1);
  assert.equal(cached.events.length, 200);
  await act(async () => {
    history.loadEarlier();
    await tick();
  });
  assert.equal(cached.events.length, 400);
  selected = false;
  await render();
  selected = true;
  await render();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1600));
  });
  assert.equal(
    recent,
    2,
    "the cached transcript still needs its paging cursor restored",
  );
  assert.deepEqual(history.state.earlier, { [session.id]: "440" });
  const previousLoadEarlier = history.loadEarlier;
  await act(async () => {
    history.loadEarlier();
    await tick();
  });
  assert.equal(
    cached.events.length,
    400,
    "the restored recent cursor first returns an overlapping page",
  );
  assert.notEqual(
    history.loadEarlier,
    previousLoadEarlier,
    "a new cursor re-arms the top even without new rows",
  );
  for (let i = 0; i < 2; i++)
    await act(async () => {
      history.loadEarlier();
      await tick();
    });
  assert.equal(cached.events.length, 640);
  assert.equal(
    chatMessagesForThread({ id: session.id, sessions: [cached] })[0].text,
    session.prompt,
  );
});
