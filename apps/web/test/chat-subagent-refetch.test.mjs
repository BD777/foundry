import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { panel } from "./fixtures/session-panel.mjs";

register("./bundler-resolve.mjs", import.meta.url);

const {
  applySubagentUpdate,
  subagentActivity,
  subagentFetchDelay,
  subagentReadDelay,
  subagentRetryCapMs,
  subagentRetryDelayMs,
  subagentRefreshIntervalMs,
} = await import("../src/features/chat/context/chat-subagent-policy.ts");
const { useChatSubagents } =
  await import("../src/features/chat/context/use-chat-subagents.ts");

/**
 * A session's subagents as the server's panel lists them, changed as its
 * events change them: each panel() is a new panel, as each server update
 * brings one.
 */
function subagents() {
  const list = [];
  const background = [];
  const at = (taskId) => list.findIndex((item) => item.taskId === taskId);
  const state = {
    start(id, taskId) {
      list.push({
        id,
        taskId,
        toolUseId: `tool_${taskId}`,
        detail: taskId,
        status: "running",
      });
      return state;
    },
    /** A progress report: the subagent's usage grows. */
    progress(taskId) {
      const item = list[at(taskId)];
      list[at(taskId)] = {
        ...item,
        usage: {
          totalTokens: (item.usage?.totalTokens ?? 0) + 10,
          toolUses: 1,
          durationMs: 5,
        },
      };
      return state;
    },
    end(taskId) {
      list[at(taskId)] = { ...list[at(taskId)], status: "completed" };
      return state;
    },
    /** A background command, listed under Background. */
    command(id) {
      background.push({
        task: {
          id,
          provider: "claude",
          kind: "command",
          description: id,
          status: "completed",
          startedAt: "2026-10-10T00:00:00Z",
          hasOutput: false,
        },
      });
      return state;
    },
    panel: () =>
      panel({ focus: true, subagents: [...list], background: [...background] }),
  };
  return state;
}
const summary = (taskId, status = "running", responseFingerprints = []) => ({
  sessionId: "s",
  taskId,
  toolUseId: `tool_${taskId}`,
  title: taskId,
  status,
  responseFingerprints,
});

test("progress reports never change what the subagent list depends on", () => {
  const activity = (state, status = "running") =>
    subagentActivity({ provider: "claude", status, panel: state.panel() });
  const state = subagents().start("e1", "a");
  const start = activity(state);
  const moving = activity(state.progress("a"));
  assert.equal(moving.revision, start.revision, "a progress report");
  assert.equal(moving.running, true);
  const done = activity(state.end("a"));
  assert.notEqual(done.revision, start.revision, "an end changes it");
  assert.equal(done.running, false);
  assert.equal(start.ended, 0);
  assert.equal(done.ended, 1, "an end is counted");
  const another = activity(state.start("e4", "b"));
  assert.notEqual(another.revision, done.revision, "a start changes it");
  assert.equal(
    activity(state.command("c1")).revision,
    another.revision,
    "a background command: unchanged",
  );
  // Background work reporting after the session finished: still unchanged,
  // and nothing runs once the session ended.
  const after = activity(state.progress("b").progress("b"), "completed");
  assert.equal(after.revision, another.revision);
  assert.equal(after.running, false);
  // No subagents, or another runtime: nothing to read.
  assert.equal(activity(subagents().command("c2")), undefined);
  assert.equal(
    subagentActivity({
      provider: "codex",
      status: "running",
      panel: state.panel(),
    }),
    undefined,
  );
});

test("every fetch is rate limited, settled or not; running ones wait for the panel", () => {
  const running = { revision: "1:e1", running: true, ended: 0 };
  const settled = { revision: "2:e3", running: false, ended: 1 };
  const due = (input) =>
    subagentFetchDelay({ inFlight: false, now: 10_000, ...input });
  assert.equal(due({ activity: running, panelVisible: false }), undefined);
  assert.equal(due({ activity: running, panelVisible: true }), 0);
  assert.equal(
    due({ activity: settled, panelVisible: false }),
    0,
    "a settled list is read once, panel or not (its answers stay out of the transcript)",
  );
  assert.equal(
    due({
      activity: settled,
      panelVisible: false,
      lastFetchAt: 8_000,
      endedAtFetch: 1,
    }),
    subagentRefreshIntervalMs - 2_000,
    "rate limited after the session finished too",
  );
  assert.equal(
    due({ activity: settled, panelVisible: true, fetchedRevision: "2:e3" }),
    undefined,
  );
});

test("a subagent's end is fetched at once, panel or not, but never beside a request", () => {
  const due = (input) =>
    subagentFetchDelay({ inFlight: false, now: 10_000, ...input });
  // b still runs, the panel is closed, the last fetch was just now.
  const oneEnded = { revision: "3:e3", running: true, ended: 1 };
  assert.equal(
    due({
      activity: oneEnded,
      panelVisible: false,
      fetchedRevision: "2:e2",
      endedAtFetch: 0,
      lastFetchAt: 9_900,
    }),
    0,
    "its answer would show in the transcript until the list keeps it out",
  );
  assert.equal(
    due({ activity: oneEnded, panelVisible: false, inFlight: true }),
    undefined,
    "one request per session at a time",
  );
  assert.equal(
    due({
      activity: { revision: "4:e4", running: true, ended: 1 },
      panelVisible: true,
      fetchedRevision: "3:e3",
      endedAtFetch: 1,
      lastFetchAt: 9_000,
    }),
    subagentRefreshIntervalMs - 1_000,
    "a start is rate limited",
  );
  assert.equal(
    due({
      activity: oneEnded,
      panelVisible: false,
      endedAtFetch: 1,
      lastFetchAt: 9_000,
    }),
    undefined,
    "a fetch for that end failed: its retry waits like any other",
  );
});

test("with the stream open a list is read once, running ones with the panel", () => {
  const running = { revision: "1:e1", running: true, ended: 0 };
  const oneEnded = { revision: "3:e3", running: true, ended: 1 };
  const due = (input) =>
    subagentReadDelay({
      current: false,
      failed: false,
      inFlight: false,
      now: 10_000,
      panelVisible: true,
      ...input,
    });
  assert.equal(due({ activity: undefined }), undefined, "no subagents");
  assert.equal(due({ activity: running }), 0);
  assert.equal(due({ activity: running, current: true }), undefined);
  assert.equal(due({ activity: running, inFlight: true }), undefined);
  assert.equal(
    due({ activity: running, panelVisible: false }),
    undefined,
    "running ones alone wait for the panel",
  );
  assert.equal(due({ activity: oneEnded, panelVisible: false }), 0);
  assert.equal(
    due({ activity: running, lastFetchAt: 9_000 }),
    0,
    "not rate limited",
  );
  assert.equal(
    due({ activity: running, failed: true, lastFetchAt: 9_000 }),
    subagentRefreshIntervalMs - 1_000,
    "a failed read is read again after the interval",
  );
  assert.equal(
    due({ activity: running, failed: true, failures: 3, lastFetchAt: 9_000 }),
    subagentRefreshIntervalMs * 9 - 1_000,
    "reads that keep failing (a device offline) back off",
  );
  assert.equal(
    due({ activity: running, failed: true, failures: 20, lastFetchAt: 9_000 }),
    subagentRetryCapMs - 1_000,
  );
});

test("failed reads back off with the stream down too; an end shortens the wait to the interval", () => {
  const running = { revision: "1:e1", running: true, ended: 0 };
  const oneEnded = { revision: "2:e2", running: true, ended: 1 };
  const fetchDue = (input) =>
    subagentFetchDelay({
      inFlight: false,
      now: 10_000,
      panelVisible: true,
      lastFetchAt: 9_000,
      failed: true,
      ...input,
    });
  assert.equal(
    fetchDue({ activity: running, failures: 1 }),
    subagentRefreshIntervalMs - 1_000,
  );
  assert.equal(
    fetchDue({ activity: running, failures: 3 }),
    subagentRetryDelayMs(3) - 1_000,
    "fetches that keep failing back off as reads do",
  );
  assert.equal(
    fetchDue({ activity: running, failures: 20 }),
    subagentRetryCapMs - 1_000,
  );
  assert.equal(
    fetchDue({ activity: oneEnded, endedAtFetch: 0, failures: 4 }),
    subagentRefreshIntervalMs - 1_000,
    "an end since the last fetch: not at once while fetches fail, but within the interval",
  );
  assert.equal(
    fetchDue({
      activity: oneEnded,
      endedAtFetch: 0,
      failures: 4,
      failed: false,
    }),
    0,
    "an end after a good fetch: at once",
  );

  const readDue = (input) =>
    subagentReadDelay({
      current: false,
      failed: true,
      inFlight: false,
      now: 10_000,
      panelVisible: false,
      lastFetchAt: 9_000,
      ...input,
    });
  assert.equal(
    readDue({ activity: oneEnded, failures: 4, endedAtFetch: 1 }),
    subagentRetryDelayMs(4) - 1_000,
    "no end since the last read: the back-off stands",
  );
  assert.equal(
    readDue({ activity: oneEnded, failures: 4, endedAtFetch: 0 }),
    subagentRefreshIntervalMs - 1_000,
    "an end since: read within the interval, not after minutes",
  );
  assert.equal(
    readDue({
      activity: oneEnded,
      failures: 4,
      endedAtFetch: 0,
      lastFetchAt: 1_000,
    }),
    0,
    "the interval passed: at once",
  );
});

test("an update replaces its subagent; a start never undoes an end", () => {
  const list = [summary("a", "completed", ["answer"]), summary("b")];
  assert.equal(applySubagentUpdate(list, summary("a")), list, "a late start");
  assert.equal(applySubagentUpdate(list, summary("b")), list, "a known start");
  const ended = applySubagentUpdate(list, summary("b", "failed", ["partial"]));
  assert.deepEqual(
    ended.map((item) => item.status),
    ["completed", "failed"],
  );
  assert.deepEqual(
    applySubagentUpdate(list, summary("c")).map((item) => item.taskId),
    ["a", "b", "c"],
  );
});

function fakeStream({ open = true } = {}) {
  const listeners = new Set();
  const stream = {
    open,
    epochValue: 1,
    subscribe(onUpdate, lifecycle) {
      const listener = { onUpdate, lifecycle };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isOpen: () => stream.open,
    epoch: () => stream.epochValue,
    opened: async () => stream.open,
    push(update) {
      listeners.forEach((listener) =>
        listener.onUpdate({ workspaceId: "ws", sessionId: "s", ...update }),
      );
    },
    resync() {
      stream.epochValue += 1;
      listeners.forEach((listener) =>
        listener.lifecycle.onResync?.({ initial: false }),
      );
    },
    down() {
      stream.open = false;
      listeners.forEach((listener) => listener.lifecycle.onError?.());
    },
  };
  return stream;
}

/** Renders useChatSubagents in a DOM with mocked timers. */
async function withHarness(t, { list, stream }, run) {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
  const shown = {};
  function Harness({ sessions, panelVisible }) {
    shown.current = useChatSubagents({
      panelVisible,
      sessions,
      workspaceId: "ws",
      list,
      stream,
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const render = (sessions, panelVisible = true) =>
    act(() => root.render(createElement(Harness, { panelVisible, sessions })));
  const elapse = async (ms) => {
    await act(async () => {
      t.mock.timers.tick(ms);
      await new Promise((resolve) => setImmediate(resolve));
    });
  };
  const apply = async (change) => {
    await act(async () => {
      change();
      await new Promise((resolve) => setImmediate(resolve));
    });
  };
  try {
    await run({ shown, render, elapse, apply });
  } finally {
    await act(() => root.unmount());
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
}

/** A session whose panel lists `state`'s subagents now. */
const session = (id, state, status = "running") => ({
  id,
  provider: "claude",
  status,
  panel: state.panel(),
});

test("stream open: a session's list is read once, then updates keep it current", async (t) => {
  const calls = [];
  const list = async (sessionId, options) => {
    calls.push({ sessionId, etag: options.etag });
    return { etag: `"${calls.length}"`, subagents: [summary("a")] };
  };
  const stream = fakeStream();
  await withHarness(
    t,
    { list, stream },
    async ({ shown, render, elapse, apply }) => {
      const state = subagents().start("e1", "a");
      await render([session("s", state)]);
      await elapse(0);
      assert.equal(calls.length, 1, "shown: read once");
      for (let index = 0; index < 5; index++) {
        state.progress("a");
        await render([session("s", state)]);
        await elapse(subagentRefreshIntervalMs);
      }
      state.start("e2", "b");
      await render([session("s", state)]);
      await apply(() => stream.push({ subagent: summary("b") }));
      await elapse(subagentRefreshIntervalMs);
      assert.deepEqual(
        shown.current.bySession.s.map((item) => item.taskId),
        ["a", "b"],
        "a start: its update",
      );
      state.end("a");
      await render([session("s", state)]);
      await apply(() =>
        stream.push({ subagent: summary("a", "completed", ["answer of a"]) }),
      );
      await elapse(subagentRefreshIntervalMs);
      assert.ok(
        shown.current.responseFingerprints.has("answer of a"),
        "an end",
      );
      await apply(() => stream.push({ subagent: summary("a") }));
      assert.equal(shown.current.bySession.s[0].status, "completed");
      state.command("c1");
      await render([session("s", state)]);
      await elapse(subagentRefreshIntervalMs);
      await apply(() =>
        stream.push({ workspaceId: "ws_other", subagent: summary("x") }),
      );
      assert.equal(shown.current.bySession.s.length, 2, "another workspace's");
      assert.equal(
        calls.length,
        1,
        "progress, starts, ends and a background command: no read",
      );
      assert.equal(shown.current.failed, false);
    },
  );
});

test("stream open: a resync reads again once; a session shown again is not read", async (t) => {
  const calls = [];
  const list = async (sessionId, options) => {
    calls.push({ sessionId, etag: options.etag });
    // The list did not change: 304 after the first read.
    return options.etag
      ? { etag: options.etag }
      : { etag: `"${sessionId}"`, subagents: [summary("a")] };
  };
  const stream = fakeStream();
  await withHarness(
    t,
    { list, stream },
    async ({ shown, render, elapse, apply }) => {
      const one = session("s", subagents().start("e1", "a"));
      const two = session("s2", subagents().start("f1", "a"));
      await render([one]);
      await elapse(0);
      await render([two]);
      await elapse(0);
      await render([one]);
      await elapse(0);
      assert.deepEqual(
        calls.map((call) => call.sessionId),
        ["s", "s2"],
        "shown again at the same epoch: no read",
      );
      await apply(() =>
        stream.push({ subagent: summary("a", "completed", ["answer"]) }),
      );
      await apply(() => stream.resync());
      await elapse(0);
      assert.deepEqual(calls.slice(2), [{ sessionId: "s", etag: '"s"' }]);
      assert.equal(
        shown.current.bySession.s[0].status,
        "completed",
        "a 304 keeps what updates added",
      );
      await elapse(subagentRefreshIntervalMs);
      assert.equal(calls.length, 3, "once");
      await render([two]);
      await elapse(0);
      assert.deepEqual(
        calls.slice(3),
        [{ sessionId: "s2", etag: '"s2"' }],
        "a list read before the resync: when it is shown",
      );
    },
  );
});

test("stream open: an update without a subagent, and Retry, read the list", async (t) => {
  const calls = [];
  let fail = false;
  const list = async (sessionId) => {
    calls.push(sessionId);
    if (fail) throw new Error("offline");
    return { etag: `"${calls.length}"`, subagents: [summary("a")] };
  };
  const stream = fakeStream();
  await withHarness(
    t,
    { list, stream },
    async ({ shown, render, elapse, apply }) => {
      await render([session("s", subagents().start("e1", "a"))]);
      await elapse(0);
      assert.equal(calls.length, 1);
      fail = true;
      await apply(() => stream.push({}));
      await elapse(0);
      assert.equal(calls.length, 2, "a change the server could not name");
      assert.equal(shown.current.failed, true);
      assert.equal(shown.current.bySession.s.length, 1, "the list stays shown");
      fail = false;
      await apply(() => shown.current.retry());
      await elapse(0);
      assert.equal(calls.length, 3, "Retry");
      assert.equal(shown.current.failed, false);
      await elapse(subagentRefreshIntervalMs);
      assert.equal(calls.length, 3);
    },
  );
});

test("stream open: updates during the first read are applied over its answer", async (t) => {
  let answer;
  const calls = [];
  const list = (sessionId) => {
    calls.push(sessionId);
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  const stream = fakeStream();
  await withHarness(
    t,
    { list, stream },
    async ({ shown, render, elapse, apply }) => {
      await render([session("s", subagents().start("e1", "a"))]);
      await elapse(0);
      assert.equal(calls.length, 1);
      await apply(() =>
        stream.push({ subagent: summary("a", "completed", ["answer of a"]) }),
      );
      await apply(() =>
        answer({ etag: '"1"', subagents: [summary("a"), summary("b")] }),
      );
      assert.deepEqual(
        shown.current.bySession.s.map((item) => item.status),
        ["completed", "running"],
      );
      assert.equal(calls.length, 1);
    },
  );
});

test("stream open: reads that keep failing back off, but a subagent's end is read within the interval", async (t) => {
  const calls = [];
  const list = async (sessionId) => {
    calls.push(sessionId);
    throw new Error("linux-dev did not answer within 15 s");
  };
  const stream = fakeStream();
  await withHarness(t, { list, stream }, async ({ shown, render, elapse }) => {
    const state = subagents().start("e1", "a").start("e2", "b");
    const show = () => render([session("s", state)]);
    await show();
    await elapse(0);
    assert.equal(calls.length, 1);
    await elapse(subagentRetryDelayMs(1));
    await elapse(subagentRetryDelayMs(2));
    assert.equal(calls.length, 3, "retries back off");
    assert.equal(shown.current.failed, true);
    await elapse(10_000);
    assert.equal(calls.length, 3, "the next retry waits longer");

    state.end("a");
    await show();
    await elapse(0);
    assert.equal(
      calls.length,
      4,
      "an end: read without waiting out the back-off (its answer shows twice meanwhile)",
    );
    state.end("b");
    await show();
    await elapse(0);
    assert.equal(calls.length, 4, "another end right after: not at once");
    await elapse(subagentRefreshIntervalMs);
    assert.equal(calls.length, 5, "but within the interval");
    await elapse(60_000);
    assert.equal(calls.length, 5, "no end since: backing off again");
  });
});

test("stream down: fetches that keep failing back off", async (t) => {
  const calls = [];
  const list = async (sessionId) => {
    calls.push(sessionId);
    throw new Error("offline");
  };
  const stream = fakeStream({ open: false });
  await withHarness(t, { list, stream }, async ({ render, elapse }) => {
    const state = subagents().start("e1", "a");
    const show = () => render([session("s", state)]);
    await show();
    await elapse(0);
    await elapse(subagentRetryDelayMs(1));
    await elapse(subagentRetryDelayMs(2));
    assert.equal(calls.length, 3);
    await elapse(30_000);
    assert.equal(
      calls.length,
      3,
      "not every few seconds while the device cannot answer",
    );
    state.end("a");
    await show();
    await elapse(0);
    assert.equal(calls.length, 4, "an end: fetched");
  });
});

test("stream down: starts and ends are fetched, not progress reports", async (t) => {
  const calls = [];
  const list = async (sessionId) => {
    calls.push(sessionId);
    return { etag: `"${calls.length}"`, subagents: [] };
  };
  const stream = fakeStream({ open: false });
  await withHarness(t, { list, stream }, async ({ shown, render, elapse }) => {
    const state = subagents().start("e1", "a");
    const show = (status = "running", panelVisible = true) =>
      render([session("s", state, status)], panelVisible);
    await show();
    await elapse(0);
    assert.equal(calls.length, 1, "a start: fetched");
    for (let index = 0; index < 20; index++) {
      state.progress("a");
      await show();
      await elapse(1_000);
    }
    assert.equal(calls.length, 1, "twenty progress reports: no fetch");
    state.end("a");
    await show();
    await elapse(0);
    assert.equal(calls.length, 2, "an end: fetched");
    state.command("c1");
    await show();
    await elapse(subagentRefreshIntervalMs);
    assert.equal(calls.length, 2, "a background command: no fetch");

    // After the session finished, a start is still rate limited.
    state.start("e3", "b");
    await show("completed", false);
    await elapse(0);
    assert.equal(calls.length, 3, "the last fetch was long ago: at once");
    state.start("e5", "c");
    await show("completed", false);
    await elapse(0);
    assert.equal(calls.length, 3, "not again within the interval");
    await elapse(subagentRefreshIntervalMs);
    assert.equal(calls.length, 4, "then once, with the panel closed");
    // An end is fetched at once, panel or not: its answer must not show
    // in the transcript meanwhile.
    state.end("b");
    await show("completed", false);
    await elapse(0);
    assert.equal(calls.length, 5, "an end: fetched at once");
    state.end("c");
    await show("completed", false);
    await elapse(0);
    assert.equal(calls.length, 6, "another end: at once again");
    assert.equal(shown.current.failed, false);
  });
});

test("stream down: one subagent ending while another runs is fetched at once, panel closed", async (t) => {
  const calls = [];
  const list = async (sessionId) => {
    calls.push(sessionId);
    return {
      etag: `"${calls.length}"`,
      subagents: [summary("a", "completed", ["answer of a"])],
    };
  };
  const stream = fakeStream({ open: false });
  await withHarness(t, { list, stream }, async ({ shown, render, elapse }) => {
    const state = subagents().start("e1", "a").start("e2", "b");
    const show = () => render([session("s", state)], false);
    await show();
    await elapse(subagentRefreshIntervalMs);
    assert.equal(calls.length, 0, "running subagents wait for the panel");
    state.end("a");
    await show();
    await elapse(0);
    assert.equal(calls.length, 1, "an end: fetched at once");
    assert.ok(shown.current.responseFingerprints.has("answer of a"));
    state.progress("b");
    await show();
    await elapse(subagentRefreshIntervalMs);
    assert.equal(calls.length, 1, "b still runs: no more fetches");
  });
});

test("the stream going down reads nothing until subagents start or end", async (t) => {
  const calls = [];
  const list = async (sessionId) => {
    calls.push(sessionId);
    return { etag: `"${calls.length}"`, subagents: [summary("a")] };
  };
  const stream = fakeStream();
  await withHarness(t, { list, stream }, async ({ render, elapse, apply }) => {
    const state = subagents().start("e1", "a");
    await render([session("s", state)]);
    await elapse(0);
    state.start("e2", "b");
    await render([session("s", state)]);
    await elapse(0);
    assert.equal(calls.length, 1);
    await apply(() => stream.down());
    await elapse(subagentRefreshIntervalMs);
    assert.equal(calls.length, 1, "down: nothing new to read");
    state.end("a");
    await render([session("s", state)]);
    await elapse(0);
    assert.equal(calls.length, 2, "an end while down: read as before");
  });
});
