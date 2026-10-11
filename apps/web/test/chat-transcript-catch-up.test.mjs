import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("./bundler-resolve.mjs", import.meta.url);

const { createTranscriptLoader } =
  await import("../src/features/chat/chat-transcript-loader.ts");

const settle = async () => {
  for (let index = 0; index < 5; index++)
    await new Promise((resolve) => setImmediate(resolve));
};

const event = (sessionId, id) => ({
  id,
  sessionId,
  at: "2026-10-11T00:00:00.000Z",
  label: "Tool",
  detail: id,
  level: "info",
});

/** A chat whose transport records what each load asked for. */
function chat({ windows, after, withCatchUp = true }) {
  const calls = [];
  const loaded = [];
  let epoch = 0;
  const transport = {
    loadRecent: async (threadId) => {
      calls.push(["recent", threadId]);
      return windows.shift();
    },
    loadEarlier: async () => {
      throw new Error("not paged here");
    },
  };
  if (withCatchUp)
    transport.loadAfter = async (sessionId, cursor) => {
      calls.push(["after", sessionId, cursor]);
      return after(sessionId, cursor);
    };
  const loader = createTranscriptLoader({
    transport,
    onLoaded: (sessions) => loaded.push(sessions),
    onState: () => undefined,
    epoch: () => epoch,
    now: () => 1_000_000 + calls.length * 60_000,
  });
  return {
    calls,
    loaded,
    loader,
    resync() {
      epoch += 1;
      loader.request("resync");
    },
  };
}

test("a resync reads only the events after the newest held, then continues from there", async () => {
  const window = [{ id: "s", events: [event("s", "e1")], eventsAfter: "c1" }];
  const { calls, loaded, loader, resync } = chat({
    windows: [window, window],
    after: (sessionId, cursor) => ({
      id: sessionId,
      status: "running",
      events: cursor === "c1" ? [event("s", "e2")] : [],
      eventsAfter: cursor === "c1" ? "c2" : cursor,
    }),
  });
  loader.select("thread");
  loader.request("missing");
  await settle();
  assert.deepEqual(calls, [["recent", "thread"]]);

  resync();
  await settle();
  assert.deepEqual(calls.at(-1), ["after", "s", "c1"], "no window reload");
  assert.deepEqual(
    loaded.at(-1).map((session) => session.events.map((item) => item.id)),
    [["e2"]],
    "the missed event is merged like any load",
  );

  resync();
  await settle();
  assert.deepEqual(calls.at(-1), ["after", "s", "c2"], "from the new cursor");
  assert.equal(
    calls.filter(([kind]) => kind === "recent").length,
    1,
    "the window was read once",
  );

  // An explicit retry reads the window.
  loader.request("retry");
  await settle();
  assert.deepEqual(calls.at(-1), ["recent", "thread"]);
});

test("a repair reloads the window when a session cannot catch up", async (t) => {
  const cases = {
    "more than a window behind": {
      window: [{ id: "s", events: [event("s", "e1")], eventsAfter: "c1" }],
      after: () => ({
        id: "s",
        events: [],
        eventsAfter: "c1",
        eventsMore: true,
      }),
    },
    "the server no longer knows the cursor": {
      window: [{ id: "s", events: [event("s", "e1")], eventsAfter: "c1" }],
      after: () => {
        throw new Error("410 the cursor names no event of the session");
      },
    },
    "a session the window returned without events": {
      window: [
        { id: "s", events: [event("s", "e1")], eventsAfter: "c1" },
        { id: "fresh", events: [] },
      ],
      after: (id) => ({ id, events: [], eventsAfter: "c1" }),
    },
  };
  for (const [name, { window, after }] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { calls, loader, resync } = chat({
        windows: [window, window],
        after,
      });
      loader.select("thread");
      loader.request("missing");
      await settle();
      resync();
      await settle();
      assert.deepEqual(calls.at(-1), ["recent", "thread"]);
      assert.equal(calls.filter(([kind]) => kind === "recent").length, 2);
    });
  }

  await t.test("a transport that cannot catch up", async () => {
    const window = [{ id: "s", events: [event("s", "e1")], eventsAfter: "c1" }];
    const { calls, loader, resync } = chat({
      windows: [window, window],
      after: () => assert.fail("not asked"),
      withCatchUp: false,
    });
    loader.select("thread");
    loader.request("missing");
    await settle();
    resync();
    await settle();
    assert.deepEqual(calls, [
      ["recent", "thread"],
      ["recent", "thread"],
    ]);
  });
});

test("a resync while the first window loads catches up from it once it lands", async () => {
  let land;
  const calls = [];
  let epoch = 0;
  const loader = createTranscriptLoader({
    transport: {
      loadRecent: (threadId) => {
        calls.push(["recent", threadId]);
        return new Promise((resolve) => (land = resolve));
      },
      loadEarlier: async () => undefined,
      loadAfter: async (sessionId, cursor) => {
        calls.push(["after", sessionId, cursor]);
        return { id: sessionId, events: [], eventsAfter: cursor };
      },
    },
    onLoaded: () => undefined,
    onState: () => undefined,
    epoch: () => epoch,
  });
  loader.select("thread");
  loader.request("missing");
  await settle();
  epoch += 1;
  loader.request("resync");
  land([{ id: "s", events: [event("s", "e1")], eventsAfter: "c1" }]);
  await settle();
  assert.deepEqual(calls, [
    ["recent", "thread"],
    ["after", "s", "c1"],
  ]);
});
