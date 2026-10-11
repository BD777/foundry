import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);

class FakeEventSource {
  static last;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener() {}
  close() {}
}

/**
 * The titles and layout endpoints, counting reads. `hold(kind)` keeps that
 * kind's next reads waiting until `release(kind)`; `stall(kind)` leaves the
 * next read of that kind unanswered. A request ends when its signal aborts.
 */
function fakeServer() {
  const reads = { titles: 0, layout: 0 };
  const gates = {};
  const stalled = {};
  const layout = { revision: 1, groups: [], positions: [] };
  const aborted = (signal) =>
    new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  const answer = async (kind, body, signal) => {
    reads[kind] += 1;
    if (stalled[kind]) {
      delete stalled[kind];
      await aborted(signal);
    }
    if (gates[kind]) await Promise.race([gates[kind].promise, aborted(signal)]);
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  };
  return {
    reads,
    hold(kind) {
      let release;
      const promise = new Promise((resolve) => (release = resolve));
      gates[kind] = { promise, release };
    },
    release(kind) {
      gates[kind]?.release();
      delete gates[kind];
    },
    stall(kind) {
      stalled[kind] = true;
    },
    fetch: async (input, init = {}) => {
      const url = String(input);
      if (url.includes("/api/chat-titles?workspaceId=ws"))
        return answer(
          "titles",
          [{ chatId: "c1", title: "One", version: "1" }],
          init.signal,
        );
      if (url.includes("/api/chat-layout?workspaceId=ws"))
        return answer("layout", layout, init.signal);
      throw new Error(`unexpected request ${url}`);
    },
  };
}

/**
 * A page with the chat list's titles and layout. `render({ active, list,
 * readOnly })` shows or hides the list (the layout's ChatSidebar mounts with
 * it); `retain` keeps layouts as the chat feature does for the page's life.
 */
async function page(t, server, { retain = false } = {}) {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
    EventSource: FakeEventSource,
    fetch: server.fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  window.setTimeout = (...args) => globalThis.setTimeout(...args);
  window.clearTimeout = (id) => globalThis.clearTimeout(id);
  window.setInterval = (...args) => globalThis.setInterval(...args);
  window.clearInterval = (id) => globalThis.clearInterval(id);
  const { useChatTitles } =
    await import("../src/features/chat/use-chat-list-state.ts");
  const { useChatLayout, retainChatLayouts } =
    await import("../src/features/chat/use-chat-layout.ts");
  const release = retain ? retainChatLayouts() : () => {};
  const shown = { notices: [] };
  let props = { active: true, list: true, readOnly: true };
  function Sidebar({ readOnly }) {
    shown.layout = useChatLayout("ws", readOnly).layout;
    return null;
  }
  function Harness() {
    shown.titles = useChatTitles("ws", props.active, (message) =>
      shown.notices.push(message),
    ).titles;
    return props.list
      ? createElement(Sidebar, { readOnly: props.readOnly })
      : null;
  }
  const root = createRoot(window.document.createElement("div"));
  const settle = () =>
    act(async () => {
      for (let index = 0; index < 5; index++)
        await new Promise((resolve) => setImmediate(resolve));
    });
  const render = async (next = {}) => {
    props = { ...props, ...next };
    await act(() => root.render(createElement(Harness)));
    await settle();
  };
  await render();
  t.after(async () => {
    await act(() => root.unmount());
    release();
    // The tab's connection closes once nobody listens.
    t.mock.timers.tick(1100);
    t.mock.timers.reset();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  });
  const source = FakeEventSource.last;
  let id = 0;
  const message = (type, payload) =>
    act(() =>
      source.onmessage({
        lastEventId: `ep-${++id}`,
        data: JSON.stringify({ type, payload }),
      }),
    );
  return {
    shown,
    settle,
    render,
    window,
    open: () => act(() => source.onopen()),
    elapse: (ms) => act(() => t.mock.timers.tick(ms)),
    /** A push; without `extra` it says only that the list changed. */
    push: (type, workspaceId, extra = {}) =>
      message(type, { workspaceId, ...extra }),
    resync: () => message("resync", { reason: "expired" }),
  };
}

test("titles and layout: one read once the stream opens, then pushes apply without reading", async (t) => {
  const server = fakeServer();
  const view = await page(t, server);
  assert.deepEqual(
    server.reads,
    { titles: 0, layout: 0 },
    "the reads wait for the stream, so nothing pushed before them is lost",
  );
  await view.open();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 }, "one read each");
  assert.equal(view.shown.titles.c1?.title, "One");
  assert.equal(view.shown.layout.revision, 1);

  // No timer and no focus reads.
  await view.elapse(10 * 60_000);
  view.window.dispatchEvent(new view.window.Event("focus"));
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 }, "nothing polls");

  // What a push carries is shown as it is.
  await view.push("chat_titles_changed", "ws", {
    titles: [{ chatId: "c2", title: "Two", version: "2" }],
  });
  await view.push("chat_titles_changed", "ws", {
    titles: [{ chatId: "c1", title: "Renamed", version: "3" }],
  });
  await view.push("chat_titles_changed", "ws", { removed: ["c2"] });
  await view.push("chat_layout_changed", "ws", {
    layout: { revision: 3, groups: [{ id: "g", name: "G" }], positions: [] },
  });
  // A late push of an older layout changes nothing.
  await view.push("chat_layout_changed", "ws", {
    layout: { revision: 2, groups: [], positions: [] },
  });
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 }, "pushes: no read");
  assert.deepEqual(Object.keys(view.shown.titles), ["c1"]);
  assert.equal(view.shown.titles.c1.title, "Renamed");
  assert.equal(view.shown.layout.revision, 3);
  assert.deepEqual(view.shown.layout.groups, [{ id: "g", name: "G" }]);

  // Another workspace's changes are not this list's.
  await view.push("chat_titles_changed", "ws_other");
  await view.push("chat_layout_changed", "ws_other");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 });

  // An event that does not say what changed reads once.
  await view.push("chat_titles_changed", "ws");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 1 }, "titles only");
  await view.push("chat_layout_changed", "ws");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 }, "layout only");

  // Events may have been missed: each is read once more.
  await view.resync();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 3, layout: 3 }, "resync");
});

test("titles and layout: read before a late stream opened, they are read once more after", async (t) => {
  const { foundryStreamOpenWaitMs } = await import("../src/stream/index.ts");
  const server = fakeServer();
  const view = await page(t, server);
  await view.elapse(foundryStreamOpenWaitMs);
  await view.settle();
  assert.deepEqual(
    server.reads,
    { titles: 1, layout: 1 },
    "a slow stream does not keep the list empty",
  );
  await view.open();
  await view.settle();
  assert.deepEqual(
    server.reads,
    { titles: 2, layout: 2 },
    "what changed before the stream opened is read",
  );
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 });
});

test("titles and layout: a push while the read runs is kept over its answer", async (t) => {
  const server = fakeServer();
  server.hold("titles");
  server.hold("layout");
  const view = await page(t, server);
  await view.open();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 });
  await view.push("chat_titles_changed", "ws", {
    titles: [{ chatId: "c1", title: "Pushed", version: "2" }],
  });
  await view.push("chat_layout_changed", "ws", {
    layout: { revision: 4, groups: [{ id: "g", name: "G" }], positions: [] },
  });
  server.release("titles");
  server.release("layout");
  await view.settle();
  assert.equal(view.shown.titles.c1.title, "Pushed");
  assert.equal(view.shown.layout.revision, 4);
  assert.deepEqual(server.reads, { titles: 1, layout: 1 });
});

test("titles and layout: showing the list again reads nothing while what it holds is current", async (t) => {
  const server = fakeServer();
  const view = await page(t, server, { retain: true });
  await view.open();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 });

  // Another page, then the chats again; a viewer's list flips to editable.
  await view.render({ active: false, list: false });
  await view.push("chat_layout_changed", "ws", {
    layout: { revision: 2, groups: [{ id: "g", name: "G" }], positions: [] },
  });
  await view.push("chat_titles_changed", "ws", {
    titles: [{ chatId: "c1", title: "Away", version: "2" }],
  });
  await view.render({ active: true, list: true });
  await view.render({ readOnly: false });
  assert.deepEqual(server.reads, { titles: 1, layout: 1 }, "no read again");
  assert.equal(view.shown.layout.revision, 2, "the push made while away");
  assert.equal(view.shown.titles.c1.title, "Away");

  // Told only that they changed while away: read when shown again.
  await view.render({ active: false, list: false });
  await view.push("chat_titles_changed", "ws");
  await view.push("chat_layout_changed", "ws");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 }, "hidden: later");
  await view.render({ active: true, list: true });
  assert.deepEqual(server.reads, { titles: 2, layout: 2 }, "shown: once");

  // A resync while away: read once when shown.
  await view.render({ active: false, list: false });
  await view.resync();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 });
  await view.render({ active: true, list: true });
  assert.deepEqual(server.reads, { titles: 3, layout: 3 });
});

test("titles: a naming job seen running that failed is told once", async (t) => {
  const server = fakeServer();
  const view = await page(t, server);
  await view.open();
  await view.settle();
  const job = (generationStatus, generationError) => ({
    titles: [
      {
        chatId: "c1",
        title: "One",
        version: "1",
        generationSessionId: "sess_name",
        generationStatus,
        generationError,
      },
    ],
  });
  await view.push("chat_titles_changed", "ws", job("running"));
  await view.push("chat_titles_changed", "ws", job("failed", "no provider"));
  await view.push("chat_titles_changed", "ws", job("failed", "no provider"));
  await view.settle();
  assert.deepEqual(view.shown.notices, ["no provider"]);
  assert.equal(server.reads.titles, 1);
});

test("titles and layout: changes said during a read cause exactly one more read", async (t) => {
  const server = fakeServer();
  const view = await page(t, server);
  await view.open();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 });

  server.hold("titles");
  server.hold("layout");
  await view.push("chat_titles_changed", "ws");
  await view.push("chat_layout_changed", "ws");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 });
  for (let index = 0; index < 4; index++) {
    await view.push("chat_titles_changed", "ws");
    await view.push("chat_layout_changed", "ws");
  }
  await view.settle();
  assert.deepEqual(
    server.reads,
    { titles: 2, layout: 2 },
    "no read beside the one in flight",
  );
  server.release("titles");
  server.release("layout");
  await view.settle();
  assert.deepEqual(
    server.reads,
    { titles: 3, layout: 3 },
    "one read after it covers every change meanwhile",
  );
  await view.settle();
  assert.deepEqual(server.reads, { titles: 3, layout: 3 });
});

test("titles and layout: a read that stalls fails after the timeout, and the read queued behind it goes on", async (t) => {
  const { backgroundReadTimeoutMs } = await import("../src/api.ts");
  const server = fakeServer();
  const view = await page(t, server);
  await view.open();
  await view.settle();
  assert.deepEqual(server.reads, { titles: 1, layout: 1 });

  server.stall("titles");
  server.stall("layout");
  await view.push("chat_titles_changed", "ws");
  await view.push("chat_layout_changed", "ws");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 }, "both stall");
  await view.push("chat_titles_changed", "ws");
  await view.push("chat_layout_changed", "ws");
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 }, "queued behind");

  await view.elapse(backgroundReadTimeoutMs - 1);
  await view.settle();
  assert.deepEqual(server.reads, { titles: 2, layout: 2 }, "still waiting");
  await view.elapse(1);
  await view.settle();
  assert.deepEqual(
    server.reads,
    { titles: 3, layout: 3 },
    "the stalled reads failed and the queued ones went on",
  );
  assert.equal(view.shown.titles.c1?.title, "One");
});

test("layout: a change announced while this tab saves is read once the save settled", async () => {
  const { ChatLayoutSync } =
    await import("../src/features/chat/chat-layout-sync.ts");
  const { emptyChatLayout, addChatGroup } =
    await import("../src/features/chat/chat-layout.ts");
  let remote = { ...emptyChatLayout(), revision: 1 };
  let loads = 0;
  let finishSave;
  let shown;
  const sync = new ChatLayoutSync(remote, {
    load: async () => {
      loads += 1;
      return remote;
    },
    save: (next) =>
      new Promise((resolve) => {
        finishSave = () => resolve({ ...next, revision: 2 });
      }),
    changed: (layout) => {
      shown = layout;
    },
    failed: () => assert.fail("unexpected failure"),
  });
  sync.enqueue((layout) => addChatGroup(layout, "mine", undefined, []));
  // Another tab saves right after this one; its push arrives mid-save.
  await sync.refresh();
  assert.equal(loads, 0, "never read over an unsaved change");
  remote = {
    ...emptyChatLayout(),
    revision: 3,
    groups: [
      { id: "mine", name: "mine" },
      { id: "theirs", name: "theirs" },
    ],
  };
  finishSave();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1, "the waiting refresh runs once the save settled");
  assert.equal(shown.revision, 3);
  assert.deepEqual(
    shown.groups.map((group) => group.id),
    ["mine", "theirs"],
  );
  sync.dispose();
});

test("layout: a layout pushed while this tab saves shows once the save settled, newest revision first", async () => {
  const { ChatLayoutSync } =
    await import("../src/features/chat/chat-layout-sync.ts");
  const { emptyChatLayout, addChatGroup } =
    await import("../src/features/chat/chat-layout.ts");
  let finishSave;
  let shown;
  const sync = new ChatLayoutSync(
    { ...emptyChatLayout(), revision: 1 },
    {
      load: async () => assert.fail("a pushed layout needs no read"),
      save: (next) =>
        new Promise((resolve) => {
          finishSave = () => resolve({ ...next, revision: 2 });
        }),
      changed: (layout) => {
        shown = layout;
      },
      failed: () => assert.fail("unexpected failure"),
    },
  );
  sync.enqueue((layout) => addChatGroup(layout, "mine", undefined, []));
  const theirs = {
    ...emptyChatLayout(),
    revision: 3,
    groups: [
      { id: "mine", name: "mine" },
      { id: "theirs", name: "theirs" },
    ],
  };
  sync.apply(theirs);
  sync.apply({ ...emptyChatLayout(), revision: 2 });
  assert.deepEqual(
    shown.groups.map((group) => group.id),
    ["mine"],
    "this tab's change is not undone while it saves",
  );
  finishSave();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shown.revision, 3, "the newest push shows once it settled");
  assert.deepEqual(
    shown.groups.map((group) => group.id),
    ["mine", "theirs"],
  );
  sync.apply({ ...emptyChatLayout(), revision: 2 });
  assert.equal(shown.revision, 3, "an older push changes nothing");
  sync.dispose();
});
