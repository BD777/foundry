import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import {
  FakeChannels,
  FakeLocks,
  fakeEventSourceClass,
  settle,
} from "./fake-tabs.mjs";

register("./bundler-resolve.mjs", import.meta.url);

const { createFoundryStream } = await import("../src/stream/foundry-stream.ts");
const { createSharedReads, sharedReadReuseMs } =
  await import("../src/stream/shared-reads.ts");

const leaderLock = "foundry-stream-leader";

/** A browser with tabs that share their stream and reads. */
function browser() {
  const locks = new FakeLocks();
  const channels = new FakeChannels();
  const sources = [];
  const fetches = [];
  const tabs = [];
  let fetchAnswer = (path) => ({
    status: 200,
    etag: `"${path}-${fetches.length}"`,
    body: JSON.stringify({ path, read: fetches.length }),
  });
  function openTab(name) {
    const EventSource = fakeEventSourceClass(sources);
    const stream = createFoundryStream({
      url: "http://api/api/events",
      eventSource: () => EventSource,
      tabs: () => ({
        locks: locks.forTab(name),
        openChannel: (channel) => channels.open(channel, name),
      }),
    });
    const reads = createSharedReads({
      stream,
      timeoutMs: 30_000,
      fetch: (path, etag) =>
        new Promise((resolve) => {
          fetches.push({ tab: name, path, etag, resolve });
        }),
    });
    const tab = {
      name,
      stream,
      reads,
      sources: () => sources.filter((source) => source.tab === name),
      events: [],
      lifecycle: [],
      follow() {
        return stream.onAnyStreamEvent(
          (event, at) => tab.events.push({ ...event, at }),
          {
            onOpen: () => tab.lifecycle.push("open"),
            onError: () => tab.lifecycle.push("error"),
            onResync: ({ initial }) =>
              tab.lifecycle.push(initial ? "resync:initial" : "resync"),
          },
        );
      },
    };
    // Sources are made by whichever tab leads: tag them as they appear.
    const before = sources.length;
    tab.tagSources = () => {
      for (const source of sources.slice(before))
        source.tab ??= locks.holder(leaderLock);
    };
    tabs.push(tab);
    return tab;
  }
  return {
    locks,
    channels,
    sources,
    fetches,
    openTab,
    /** The connection the leading tab keeps (the newest open one). */
    leaderSource: () => sources.filter((source) => !source.closed).at(-1),
    /** Answers the oldest pending fetch. */
    answer(override) {
      const pending = fetches.find((fetch) => !fetch.answered);
      assert.ok(pending, "a fetch is pending");
      pending.answered = true;
      pending.resolve(override ?? fetchAnswer(pending.path));
    },
    set answers(answer) {
      fetchAnswer = answer;
    },
    crash(tab) {
      locks.crash(tab.name);
      channels.crash(tab.name);
      for (const source of sources)
        if (source.leader === tab.name) source.close();
    },
  };
}

const names = (tab) => tab.events.map((event) => event.payload.workspaceId);

test("tabs elect one leader that keeps the only connection and relays every message in order", async () => {
  const net = browser();
  const [a, b, c] = ["a", "b", "c"].map((name) => net.openTab(name));
  a.follow();
  await settle();
  b.follow();
  c.follow();
  await settle();
  assert.equal(net.sources.length, 1, "one connection for three tabs");
  assert.equal(net.locks.holder(leaderLock), "a");
  const source = net.leaderSource();
  assert.equal(source.url, "http://api/api/events");

  source.open();
  await settle();
  for (const tab of [a, b, c])
    assert.deepEqual(
      tab.lifecycle,
      ["open", "resync:initial"],
      `${tab.name}: the first open, with nothing to resume from`,
    );
  for (const tab of [a, b, c]) assert.equal(tab.stream.isOpen(), true);

  for (let index = 1; index <= 5; index++)
    source.send(`ep-${index}`, "chats_changed", {
      workspaceId: `w${index}`,
      chats: [],
      removed: [],
    });
  await settle();
  for (const tab of [a, b, c])
    assert.deepEqual(names(tab), ["w1", "w2", "w3", "w4", "w5"], tab.name);
  // Every tab records each event at the leader's time: one clock for all.
  assert.deepEqual(
    b.events.map((event) => event.at),
    a.events.map((event) => event.at),
  );

  source.send("ep-6", "resync", { reason: "expired" });
  await settle();
  for (const tab of [a, b, c]) {
    assert.equal(tab.lifecycle.at(-1), "resync", tab.name);
    assert.equal(tab.stream.epoch(), 2, tab.name);
  }
});

test("a tab that opens later joins the open stream and gets what follows", async () => {
  const net = browser();
  const a = net.openTab("a");
  a.follow();
  await settle();
  net.leaderSource().open();
  net.leaderSource().send("ep-1", "chats_changed", {
    workspaceId: "before",
    chats: [],
    removed: [],
  });
  await settle();
  const late = net.openTab("late");
  late.follow();
  await settle();
  assert.equal(net.sources.length, 1, "it opens no connection of its own");
  assert.deepEqual(late.lifecycle, ["open", "resync:initial"]);
  assert.equal(late.stream.epoch(), 1);
  assert.ok(
    late.stream.readFloor() > 0,
    "it reads nothing older than its join",
  );
  net.leaderSource().send("ep-2", "chats_changed", {
    workspaceId: "after",
    chats: [],
    removed: [],
  });
  await settle();
  assert.deepEqual(names(late), ["after"]);
});

test("when the leader dies another tab takes over, resuming without losing or repeating events", async () => {
  const net = browser();
  const [a, b, c] = ["a", "b", "c"].map((name) => net.openTab(name));
  a.follow();
  await settle();
  b.follow();
  c.follow();
  await settle();
  const first = net.leaderSource();
  first.leader = "a";
  first.open();
  await settle();
  for (let index = 1; index <= 3; index++)
    first.send(`ep-${index}`, "chats_changed", {
      workspaceId: `w${index}`,
      chats: [],
      removed: [],
    });
  // The leader dies right after relaying: what it posted still arrives.
  net.crash(a);
  await settle();
  assert.equal(net.locks.holder(leaderLock), "b", "the next tab in line leads");
  assert.equal(net.sources.length, 2);
  const second = net.leaderSource();
  assert.equal(
    second.url,
    "http://api/api/events?lastEventId=ep-3",
    "it resumes after the last event relayed",
  );
  assert.deepEqual(b.lifecycle.slice(-1), ["error"], "between connections");
  assert.deepEqual(c.lifecycle.slice(-1), ["error"]);

  second.open();
  await settle();
  assert.deepEqual(b.lifecycle.slice(-1), ["open"], "resumed: no reload");
  assert.deepEqual(c.lifecycle.slice(-1), ["open"]);
  // A tab ahead of the new leader has seen the first of what it gets.
  second.send("ep-3", "chats_changed", {
    workspaceId: "w3",
    chats: [],
    removed: [],
  });
  second.send("ep-4", "chats_changed", {
    workspaceId: "w4",
    chats: [],
    removed: [],
  });
  await settle();
  for (const tab of [b, c])
    assert.deepEqual(names(tab), ["w1", "w2", "w3", "w4"], tab.name);
  assert.equal(b.stream.epoch(), 1, "nothing was missed: no resync");
  assert.equal(c.stream.epoch(), 1);
});

test("a leader whose tab no longer follows the stream hands it on", async (t) => {
  const net = browser();
  const [a, b] = ["a", "b"].map((name) => net.openTab(name));
  const stopA = a.follow();
  await settle();
  b.follow();
  await settle();
  const first = net.leaderSource();
  first.open();
  first.send("ep-1", "chats_changed", {
    workspaceId: "w1",
    chats: [],
    removed: [],
  });
  await settle();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  stopA();
  t.mock.timers.tick(1_000);
  t.mock.timers.reset();
  await settle();
  assert.equal(first.closed, true);
  assert.equal(net.locks.holder(leaderLock), "b");
  assert.equal(
    net.leaderSource().url,
    "http://api/api/events?lastEventId=ep-1",
  );
});

test("a follower's reconnect is made by the leader, once", async () => {
  const net = browser();
  const [a, b, c] = ["a", "b", "c"].map((name) => net.openTab(name));
  a.follow();
  await settle();
  b.follow();
  c.follow();
  await settle();
  net.leaderSource().open();
  await settle();
  const originalNow = Date.now;
  Date.now = () => originalNow() + 60_000;
  try {
    b.stream.reconnect();
    c.stream.reconnect();
    await settle();
  } finally {
    Date.now = originalNow;
  }
  assert.equal(net.sources.length, 2, "one reconnect for both asks");
});

test("tabs share reads: one request answers every tab asking at the time", async () => {
  const net = browser();
  const [a, b, c] = ["a", "b", "c"].map((name) => net.openTab(name));
  for (const tab of [a, b, c]) tab.follow();
  await settle();
  net.leaderSource().open();
  await settle();

  const reads = [a, b, c].map((tab) => tab.reads.read("/api/data?w=1"));
  await settle();
  assert.equal(net.fetches.length, 1, "the leader reads once");
  assert.equal(net.fetches[0].tab, "a");
  net.answer();
  const answers = await Promise.all(reads);
  assert.deepEqual(
    answers.map((answer) => JSON.parse(answer.body).read),
    [1, 1, 1],
  );

  // Within moments, with nothing announced since, the answer still serves.
  assert.deepEqual(JSON.parse((await b.reads.read("/api/data?w=1")).body), {
    path: "/api/data?w=1",
    read: 1,
  });
  assert.equal(net.fetches.length, 1);

  // Another path, another read.
  const other = b.reads.read("/api/data?w=2");
  await settle();
  assert.equal(net.fetches.length, 2);
  net.answer();
  await other;

  // An announced change: the next read starts after it, conditionally.
  await new Promise((resolve) => setTimeout(resolve, 2));
  net.leaderSource().send("ep-1", "foundry_data_changed", {
    workspaceId: "w",
  });
  await settle();
  const after = c.reads.read("/api/data?w=1");
  await settle();
  assert.equal(net.fetches.length, 3, "read again");
  assert.equal(net.fetches[2].etag, '"/api/data?w=1-1"', "if it changed");
  net.answer({ status: 304, etag: '"/api/data?w=1-1"', body: "" });
  assert.equal(JSON.parse((await after).body).read, 1, "304: the held answer");

  // A transcript entry announces nothing a read returns.
  await new Promise((resolve) => setTimeout(resolve, 2));
  net.leaderSource().send("ep-2", "agent_session_event", {
    id: "e",
    sessionId: "s",
    at: "",
    label: "Tool",
    detail: "",
    level: "info",
  });
  await settle();
  await c.reads.read("/api/data?w=1");
  assert.equal(net.fetches.length, 3);

  // A tab's own write: its next read starts after it.
  b.reads.wrote();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const own = b.reads.read("/api/data?w=1");
  await settle();
  assert.equal(net.fetches.length, 4);
  net.answer();
  await own;
});

test("an answer older than the reuse window is read again", async () => {
  const net = browser();
  const a = net.openTab("a");
  a.follow();
  await settle();
  net.leaderSource().open();
  await settle();
  const first = a.reads.read("/x");
  await settle();
  net.answer();
  await first;
  const originalNow = Date.now;
  Date.now = () => originalNow() + sharedReadReuseMs + 1;
  try {
    const later = a.reads.read("/x");
    await settle();
    assert.equal(net.fetches.length, 2);
    net.answer();
    await later;
  } finally {
    Date.now = originalNow;
  }
});

test("a read asked of a leader that dies is made by the next one", async () => {
  const net = browser();
  const [a, b] = ["a", "b"].map((name) => net.openTab(name));
  a.follow();
  await settle();
  b.follow();
  await settle();
  const first = net.leaderSource();
  first.leader = "a";
  first.open();
  await settle();
  const read = b.reads.read("/x");
  await settle();
  assert.equal(net.fetches.length, 1);
  assert.equal(net.fetches[0].tab, "a");
  net.crash(a);
  await settle();
  assert.equal(net.fetches.length, 2, "asked again of the new leader: itself");
  assert.equal(net.fetches[1].tab, "b");
  // The dead tab's read ends unheard.
  net.answer();
  net.answer();
  assert.equal(JSON.parse((await read).body).path, "/x");
});

test("a failed read fails for every tab that asked; an error status is an answer", async () => {
  const net = browser();
  const [a, b] = ["a", "b"].map((name) => net.openTab(name));
  a.follow();
  await settle();
  b.follow();
  await settle();
  net.leaderSource().open();
  await settle();
  const asked = b.reads.read("/x");
  await settle();
  net.fetches[0].answered = true;
  net.fetches[0].resolve(Promise.reject(new Error("network down")));
  await assert.rejects(asked, /network down/);

  const missing = b.reads.read("/gone");
  await settle();
  net.answer({ status: 404, etag: "", body: '{"error":"not found"}' });
  assert.equal((await missing).status, 404);
  const again = b.reads.read("/gone");
  await settle();
  assert.equal(net.fetches.length, 3, "an error answer is not kept");
  net.answer({ status: 404, etag: "", body: "" });
  await again;
});

test("a caller's abort ends only its own wait", async () => {
  const net = browser();
  const [a, b] = ["a", "b"].map((name) => net.openTab(name));
  a.follow();
  await settle();
  b.follow();
  await settle();
  net.leaderSource().open();
  await settle();
  const controller = new AbortController();
  const aborted = b.reads.read("/x", controller.signal);
  const kept = a.reads.read("/x");
  await settle();
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  net.answer();
  assert.equal(JSON.parse((await kept).body).path, "/x");
  assert.equal(net.fetches.length, 1);
});

test("signing out in one tab reaches the others", async () => {
  const net = browser();
  const [a, b] = ["a", "b"].map((name) => net.openTab(name));
  let heard = 0;
  b.stream.onSignedOutElsewhere(() => (heard += 1));
  a.stream.announceSignedOut();
  await settle();
  assert.equal(heard, 1);
});

test("without Web Locks or BroadcastChannel each tab keeps its own connection", async () => {
  const sources = [];
  const EventSource = fakeEventSourceClass(sources);
  const tabs = ["a", "b"].map(() =>
    createFoundryStream({
      url: "http://api/api/events",
      eventSource: () => EventSource,
      tabs: () => undefined,
    }),
  );
  tabs.forEach((stream) => stream.onStreamLifecycle({}));
  assert.equal(sources.length, 2, "opened at once, as before");
  const fetches = [];
  const reads = createSharedReads({
    stream: tabs[0],
    timeoutMs: 30_000,
    fetch: async (path, etag) => {
      fetches.push(etag);
      return fetches.length === 1
        ? { status: 200, etag: '"1"', body: "{}" }
        : { status: 304, etag: '"1"', body: "" };
    },
  });
  await reads.read("/x");
  const again = await reads.read("/x");
  assert.deepEqual(fetches, ["", '"1"'], "every read asks, conditionally");
  assert.equal(again.body, "{}");
});
