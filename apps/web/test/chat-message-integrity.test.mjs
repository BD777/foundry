import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);
const { useConversationInput } =
  await import("../src/components/conversation/use-conversation-input.ts");
const { withOutbox } = await import("../src/features/chat/chat-outbox.ts");
const { useChatQueue } = await import("../src/features/chat/use-chat-queue.ts");
const { createTranscriptLoader, transcriptSlowAfterMs } =
  await import("../src/features/chat/chat-transcript-loader.ts");
const { subagentActivity, subagentFetchDelay } =
  await import("../src/features/chat/chat-subagent-policy.ts");
const { processDisplayRows, processDisplaySummary } =
  await import("../src/components/conversation/chat-process-display.ts");

async function withDom(t) {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const root = createRoot(window.document.createElement("div"));
  t.after(async () => {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  return root;
}

async function composer(t, options) {
  const root = await withDom(t);
  let state;
  let props = {
    threadKey: "thread",
    messages: [],
    composer: { mode: "fixed", runtime: "claude", model: "test" },
    ...options,
  };
  function Probe() {
    state = useConversationInput(props, () => {});
    return null;
  }
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await act(() => root.render(createElement(Probe)));
  };
  await render();
  return {
    get input() {
      return state;
    },
    render,
    type: (text) => act(() => state.updateDraft(text)),
    submit: () =>
      act(async () => {
        state.submit();
        await Promise.resolve();
      }),
  };
}

function pendingSend() {
  const calls = [];
  return {
    calls,
    onSend: (text, attachments, options) =>
      new Promise((resolve, reject) => {
        calls.push({ text, key: options?.idempotencyKey, resolve, reject });
      }),
  };
}

test("the composer lets a message go once the server accepted it", async (t) => {
  const send = pendingSend();
  const h = await composer(t, { onSend: send.onSend });
  await h.type("hello");
  await h.submit();
  assert.equal(h.input.sending, true);
  assert.equal(h.input.draft, "hello");
  assert.ok(send.calls[0].key, "the send carries a client id");
  await act(async () => send.calls[0].resolve(true));
  assert.equal(h.input.sending, false);
  assert.equal(h.input.draft, "");
});

test("the composer lets a message go once the transcript shows it, before the reply", async (t) => {
  const send = pendingSend();
  const h = await composer(t, { onSend: send.onSend });
  await h.type("hello");
  await h.submit();
  const key = send.calls[0].key;
  await h.render({
    messages: [
      { id: "agent-session:s:in1", role: "user", text: "hello", clientId: key },
    ],
  });
  assert.equal(h.input.sending, false, "no spinner once it is shown");
  assert.equal(h.input.draft, "");
  // The person types the next message while the slow reply is on its way.
  await h.type("next");
  assert.equal(h.input.draft, "next");
  await act(async () => send.calls[0].resolve(true));
  assert.equal(h.input.draft, "next", "the reply does not wipe the new text");
});

test("a message shown in the transcript does not come back on a late failure", async (t) => {
  const send = pendingSend();
  const h = await composer(t, { onSend: send.onSend });
  await h.type("hello");
  await h.submit();
  await h.render({
    messages: [
      { id: "x", role: "user", text: "hello", clientId: send.calls[0].key },
    ],
  });
  await act(async () => send.calls[0].reject(new Error("reply lost")));
  assert.equal(h.input.draft, "", "never in two places");
  assert.match(h.input.error, /reply lost/);
});

const at = "2026-10-10T02:00:00.000Z";

test("outbox: a pending send marks its transcript copy, an accepted one shows until its event", () => {
  const user = (id, text, when = "2026-10-10T02:00:01.000Z") => ({
    id: `agent-session:s1:${id}`,
    role: "user",
    text,
    at: when,
  });
  const pending = {
    id: "c1",
    sessionId: "s1",
    threadId: "t",
    text: "hi",
    at,
    state: "pending",
  };
  // The server's event arrived before the reply: matched by text and time.
  let projection = withOutbox([user("in1", "hi")], [pending], "t");
  assert.equal(projection.messages[0].clientId, "c1");
  assert.ok(projection.delivered.has("c1"));
  // An older message with the same text is not it.
  projection = withOutbox(
    [user("in0", "hi", "2026-10-10T01:00:00.000Z")],
    [pending],
    "t",
  );
  assert.equal(projection.messages[0].clientId, undefined);

  // Accepted with its input id: shown under the id its event will have.
  const accepted = {
    ...pending,
    state: "accepted",
    inputId: "in2",
    text: "next",
  };
  projection = withOutbox([user("in1", "hi")], [accepted], "t");
  assert.deepEqual(
    projection.messages.map((message) => message.id),
    ["agent-session:s1:in1", "agent-session:s1:in2"],
  );
  assert.equal(projection.messages[1].clientId, "c1");
  // Its event arrives: the same row, now the server's, no duplicate.
  projection = withOutbox(
    [user("in1", "hi"), user("in2", "next")],
    [accepted],
    "t",
  );
  assert.equal(projection.messages.length, 2);
  assert.equal(projection.messages[1].clientId, "c1");
  // Another chat does not show it.
  assert.equal(withOutbox([], [accepted], "other").messages.length, 0);
});

test("outbox: a queue item that leaves the queue as sent is reported once", async (t) => {
  const root = await withDom(t);
  let listener;
  const sent = [];
  const queue = (revision, items) => ({
    workspaceId: "w",
    chatId: "c",
    revision,
    items,
  });
  const item = (state) => ({
    id: "q1",
    chatId: "c",
    position: 1,
    text: "queued",
    runSettings: {},
    createdAt: at,
    updatedAt: at,
    revision: 1,
    state,
    sentSessionId: "s1",
  });
  const transport = {
    get: async () => ({ ok: true, queue: queue(1, [item("queued")]) }),
    subscribe: (onQueue) => {
      listener = onQueue;
      return () => {};
    },
  };
  function Probe() {
    useChatQueue({
      workspaceId: "w",
      chatId: "c",
      runSettings: () => ({}),
      transport,
      onSent: (chatId, items) => sent.push(...items.map((entry) => entry.id)),
    });
    return null;
  }
  await act(() => root.render(createElement(Probe)));
  await act(async () => listener(queue(2, [item("dispatching")])));
  assert.deepEqual(sent, []);
  await act(async () => listener(queue(3, [])));
  assert.deepEqual(sent, ["q1"]);
  await act(async () => listener(queue(3, [])));
  assert.deepEqual(sent, ["q1"]);
});

function fakeTimers() {
  let now = 1_000;
  const timers = new Set();
  return {
    now: () => now,
    setTimer: (callback, ms) => {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return timer;
    },
    clearTimer: (timer) => timers.delete(timer),
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at <= now && timers.delete(timer)) timer.callback();
      }
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => ((resolve = ok), (reject = fail)));
  return { promise, resolve, reject };
}

test("transcript: the recent window loads once; live events and resyncs never abort it", async () => {
  const timers = fakeTimers();
  const loads = [];
  const loaded = [];
  let state;
  const loader = createTranscriptLoader({
    ...timers,
    transport: {
      loadRecent: (threadId, { signal, onProgress }) => {
        const request = { threadId, signal, ...deferred() };
        loads.push(request);
        onProgress({ loadedBytes: 1024 });
        return request.promise;
      },
      loadEarlier: async (sessionId, before) => {
        loaded.push(`earlier:${sessionId}:${before}`);
        return { id: sessionId, events: [] };
      },
    },
    onLoaded: (sessions) =>
      loaded.push(...sessions.map((session) => session.id)),
    onState: (next) => (state = next),
  });
  loader.select("t1");
  loader.request("missing");
  assert.equal(loads.length, 1);
  assert.equal(state.loading, true);
  assert.equal(state.progress.loadedBytes, 1024);
  // Events keep arriving, a resync comes in: the load goes on.
  loader.request("missing");
  loader.request("stale");
  loader.request("resync");
  assert.equal(loads.length, 1);
  assert.equal(loads[0].signal.aborted, false);
  // Slow: says so and offers a retry.
  timers.advance(transcriptSlowAfterMs);
  assert.equal(state.slow, true);
  loads[0].resolve([{ id: "s1", eventsBefore: "cursor-1" }]);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(loaded, ["s1"]);
  assert.equal(state.slow, false);
  assert.deepEqual(state.earlier, { s1: "cursor-1" });
  // The resync asked while it ran: one more load, after it.
  assert.equal(loads.length, 2);
  loads[1].resolve([{ id: "s1" }]);
  await Promise.resolve();
  await Promise.resolve();
  // Older pages on request.
  loader.loadEarlier();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(loaded.includes("earlier:s1:cursor-1"));
  // Leaving the chat is what drops a load.
  loader.request("retry");
  const running = loads[2];
  loader.select("t2");
  assert.equal(running.signal.aborted, true);
});

test("transcript: a failed load retries by itself, and a retry starts at once", async () => {
  const timers = fakeTimers();
  const loads = [];
  let state;
  const loader = createTranscriptLoader({
    ...timers,
    transport: {
      loadRecent: () => {
        const request = deferred();
        loads.push(request);
        return request.promise;
      },
      loadEarlier: async () => ({ id: "s", events: [] }),
    },
    onLoaded: () => {},
    onState: (next) => (state = next),
  });
  loader.select("t");
  loader.request("missing");
  loads[0].reject(new Error("offline"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.failed, true);
  timers.advance(500);
  assert.equal(loads.length, 2, "retried after a short delay");
  loader.request("retry");
  assert.equal(loads.length, 3);
});

function subtask(id, label, taskId) {
  return {
    id,
    sessionId: "s",
    at,
    label,
    level: "info",
    detail: "",
    metadata: { taskId },
  };
}

test("subagents: fetched only with the panel open while they run, once when they settle", () => {
  const running = {
    provider: "claude",
    status: "running",
    events: [
      subtask("e1", "Starting subtask", "a"),
      subtask("e2", "Subtask running", "a"),
    ],
  };
  const activity = subagentActivity(running);
  assert.equal(
    activity.revision,
    "1:e1",
    "a short revision of starts and ends; progress leaves it",
  );
  assert.equal(activity.running, true);
  const due = (input) =>
    subagentFetchDelay({ activity, inFlight: false, now: 10_000, ...input });
  assert.equal(
    due({ panelVisible: false }),
    undefined,
    "panel closed: no fetch",
  );
  assert.equal(due({ panelVisible: true }), 0);
  assert.equal(
    due({ panelVisible: true, inFlight: true }),
    undefined,
    "no overlap",
  );
  assert.equal(
    due({ panelVisible: true, fetchedRevision: "1:e1" }),
    undefined,
    "unchanged",
  );
  assert.equal(
    due({ panelVisible: true, lastFetchAt: 8_000 }),
    3_000,
    "throttled",
  );
  const settled = subagentActivity({
    ...running,
    events: [...running.events, subtask("e3", "Subtask completed", "a")],
  });
  assert.equal(settled.running, false);
  assert.equal(
    subagentFetchDelay({
      activity: settled,
      panelVisible: false,
      fetchedRevision: "1:e1",
      inFlight: false,
      now: 10_000,
    }),
    0,
    "one fetch once they settle, panel or not",
  );
  assert.equal(
    subagentActivity({ provider: "claude", status: "running", events: [] }),
    undefined,
  );
});

test("step row: a finished last step shows a neutral Working…, never a spinner on it", () => {
  const rows = processDisplayRows(
    [
      { id: "1", title: "Thinking", detail: "planning" },
      { id: "2", title: "Loaded skills", detail: "foundry, skill-creator" },
    ],
    true,
  );
  const summary = processDisplaySummary(rows, "Processed", true);
  assert.equal(summary.between, true);
  assert.equal(summary.detail, "");
  assert.notEqual(summary.title, "Loaded skills");
  // A step still running keeps its own label and detail.
  const live = processDisplaySummary(
    processDisplayRows(
      [{ id: "1", title: "Using tool", detail: "Bash" }],
      true,
    ),
    "Processed",
    true,
  );
  assert.equal(live.between, undefined);
  assert.equal(live.detail, "Bash");
});

test("step row: a step's start and finish pair into one row", () => {
  const rows = processDisplayRows(
    [
      { id: "1", title: "Loading skills", detail: "foundry, skill-creator" },
      { id: "2", title: "Loaded skills", detail: "foundry, skill-creator" },
    ],
    true,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Loaded skills");
});
