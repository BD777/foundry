import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);
const { useConversationInput } =
  await import("../src/components/conversation/use-conversation-input.ts");
const { useChatQueue } = await import("../src/features/chat/use-chat-queue.ts");
const { i18n } = await import("../src/i18n/index.ts");

const prefix = "foundry.chat-composer";
const composer = {
  mode: "selectable",
  runtimeControls: { selectedRuntime: "claude" },
};
const wait = (ms = 0) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/**
 * The server's queue of one chat, as the API answers: revisions, 409s with
 * the current queue, and the stream every tab hears. `hold()` keeps the next
 * requests waiting so a test sees what the page shows meanwhile.
 */
function fakeServer() {
  let revision = 0;
  let sequence = 0;
  let items = [];
  let gate;
  let failNext;
  const listeners = new Set();
  const keys = new Map();
  const calls = [];
  const enqueued = [];
  const snapshot = () => ({
    workspaceId: "w",
    chatId: "chat",
    revision,
    items: items.map((item) => ({ ...item })),
  });
  const publish = () => listeners.forEach((listener) => listener(snapshot()));
  const changed = () => {
    revision += 1;
    publish();
    return { ok: true, queue: snapshot() };
  };
  const refused = (code, error) => ({
    ok: false,
    status: 409,
    code,
    error,
    queue: snapshot(),
  });
  async function request(name, run) {
    calls.push(name);
    if (gate) await gate.promise;
    if (failNext) {
      failNext = undefined;
      throw new Error("network down");
    }
    return run();
  }
  const add = (text) => {
    sequence += 1;
    items.push({
      id: `srv-${sequence}`,
      chatId: "chat",
      position: sequence,
      text,
      runSettings: {},
      createdAt: "",
      updatedAt: "",
      revision: 1,
      state: "queued",
    });
  };
  return {
    calls,
    enqueued,
    get items() {
      return items;
    },
    add(text) {
      add(text);
      return changed();
    },
    hold() {
      let release;
      const promise = new Promise((resolve) => (release = resolve));
      gate = { promise, release };
    },
    async release() {
      const current = gate;
      gate = undefined;
      current?.release();
      await wait(0);
    },
    failNextRequest() {
      failNext = true;
    },
    /** The server sent a message; `quietly` before the stream says so. */
    send(id, { quietly = false } = {}) {
      items = items.filter((item) => item.id !== id);
      revision += 1;
      if (!quietly) publish();
    },
    /** Another tab edited a message. */
    editElsewhere(id, text) {
      const item = items.find((entry) => entry.id === id);
      item.text = text;
      item.revision += 1;
      changed();
    },
    /** A change whose stream event this tab has not heard yet. */
    bumpQuietly() {
      revision += 1;
    },
    emit: (queue) => listeners.forEach((listener) => listener(queue)),
    transport: {
      get: () => request("get", () => ({ ok: true, queue: snapshot() })),
      enqueue(chatId, input, key) {
        return request("enqueue", () => {
          if (keys.has(key)) return { ok: true, queue: keys.get(key) };
          add(input.text);
          enqueued.push({
            chatId,
            text: input.text,
            key,
            settings: input.runSettings,
          });
          const result = changed();
          keys.set(key, result.queue);
          return result;
        });
      },
      edit: (chatId, id, input) =>
        request("edit", () => {
          const item = items.find((entry) => entry.id === id);
          if (!item)
            return refused("already_sent", "this message was already sent");
          if (item.revision !== input.expectedRevision)
            return refused("changed", "the queue changed in another tab");
          item.text = input.text;
          item.revision += 1;
          return changed();
        }),
      remove: (chatId, id) =>
        request("remove", () => {
          if (!items.some((item) => item.id === id))
            return refused("already_sent", "this message was already sent");
          items = items.filter((item) => item.id !== id);
          return changed();
        }),
      reorder: (chatId, ids, expected) =>
        request("reorder", () => {
          if (expected !== revision)
            return refused("changed", "the queue changed in another tab");
          items = ids.map((id) => items.find((item) => item.id === id));
          return changed();
        }),
      steer: (chatId, id) =>
        request("steer", () => {
          items = items.filter((item) => item.id !== id);
          return changed();
        }),
      retry: () => request("retry", () => changed()),
      subscribe(onQueue) {
        listeners.add(onQueue);
        return () => listeners.delete(onQueue);
      },
    },
  };
}

/** A browser with one chat page: the chat's queue hook feeding the conversation. */
function page(t, server) {
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
  const roots = [];
  t.after(async () => {
    for (const root of roots) await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  async function open(options = {}) {
    let state,
      props = {
        threadKey: "w:chat",
        chatId: "chat",
        messages: [],
        composer,
        storageKeyPrefix: prefix,
        onSend: async () => true,
        onSteer: async () => true,
        ...options,
      };
    const root = createRoot(window.document.createElement("div"));
    roots.push(root);
    function Probe() {
      const serverQueue = useChatQueue({
        workspaceId: "w",
        chatId: props.chatId,
        runSettings: () => ({ agentId: "agent_claude", claudeEffort: "low" }),
        transport: server.transport,
      });
      state = useConversationInput({ ...props, serverQueue }, () => {});
      return null;
    }
    const render = async (next = {}) => {
      props = { ...props, ...next };
      await act(async () => root.render(createElement(Probe)));
    };
    await render();
    await wait(0);
    return {
      get input() {
        return state;
      },
      texts: () => state.queue.map((item) => item.text),
      render,
      type: (text) => act(() => state.updateDraft(text)),
      submit: () =>
        act(async () => {
          state.submit();
          await Promise.resolve();
        }),
      run: (action) => act(async () => void (await action(state))),
    };
  }
  return { open };
}

test("the page shows the server's queue and what other tabs change", async (t) => {
  const server = fakeServer();
  server.add("first");
  server.add("second");
  const tab = await page(t, server).open();
  assert.deepEqual(tab.texts(), ["first", "second"]);
  await act(async () =>
    server.editElsewhere("srv-2", "second, from another tab"),
  );
  assert.deepEqual(tab.texts(), ["first", "second, from another tab"]);
  // A late event older than what is shown changes nothing.
  await act(async () =>
    server.emit({ workspaceId: "w", chatId: "chat", revision: 1, items: [] }),
  );
  assert.deepEqual(tab.texts(), ["first", "second, from another tab"]);
  await act(async () => server.send("srv-1"));
  assert.deepEqual(tab.texts(), ["second, from another tab"]);
});

test("edits, deletes and reorders show at once and give way to the server's queue when refused", async (t) => {
  const server = fakeServer();
  server.add("one");
  server.add("two");
  server.add("three");
  const tab = await page(t, server).open();
  const item = (text) => tab.input.queue.find((entry) => entry.text === text);

  // An edit shows before the server answers and stays once it accepts.
  server.hold();
  let saved;
  await act(async () => {
    saved = tab.input.saveEdit(item("two"), "two, edited");
    await Promise.resolve();
  });
  assert.deepEqual(tab.texts(), ["one", "two, edited", "three"]);
  await server.release();
  assert.equal(await saved, true);
  assert.deepEqual(tab.texts(), ["one", "two, edited", "three"]);

  // Another tab edited the same message first: this tab shows the latest.
  server.hold();
  await act(async () => {
    saved = tab.input.saveEdit(item("three"), "three, mine");
    await Promise.resolve();
  });
  assert.equal(item("three, mine").text, "three, mine");
  server.items[2].text = "three, theirs";
  server.items[2].revision += 1;
  server.bumpQuietly();
  await server.release();
  assert.equal(await saved, false);
  assert.deepEqual(tab.texts(), ["one", "two, edited", "three, theirs"]);
  assert.equal(
    tab.input.queueNotice,
    i18n.t("conversation:errors.queueChanged"),
  );

  // A message the server sent before the stream said so cannot be deleted.
  server.send("srv-1", { quietly: true });
  server.hold();
  await act(async () => {
    tab.input.remove(item("one"));
    await Promise.resolve();
  });
  assert.deepEqual(tab.texts(), ["two, edited", "three, theirs"]);
  await server.release();
  assert.deepEqual(tab.texts(), ["two, edited", "three, theirs"]);
  assert.equal(
    tab.input.queueNotice,
    i18n.t("conversation:errors.alreadySent"),
  );

  // A reorder made on an old revision is refused and the server's order shows.
  server.bumpQuietly();
  await act(async () => {
    tab.input.move("srv-3", "before", "srv-2");
  });
  assert.deepEqual(tab.texts(), ["three, theirs", "two, edited"]);
  await act(async () => {
    tab.input.commitOrder();
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(tab.texts(), ["two, edited", "three, theirs"]);
  assert.equal(
    tab.input.queueNotice,
    i18n.t("conversation:errors.queueChanged"),
  );
  // On the current revision it is kept.
  await act(async () => {
    tab.input.move("srv-3", "before", "srv-2");
  });
  await act(async () => {
    tab.input.commitOrder();
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(tab.texts(), ["three, theirs", "two, edited"]);
  assert.deepEqual(
    server.items.map((entry) => entry.id),
    ["srv-3", "srv-2"],
  );

  // A request that never reached the server puts back what was shown.
  server.failNextRequest();
  await act(async () => {
    tab.input.remove(item("two, edited"));
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(tab.texts(), ["three, theirs", "two, edited"]);
});

test("moving a message from the keyboard reorders the server's queue in one step", async (t) => {
  const server = fakeServer();
  server.add("one");
  server.add("two");
  server.add("three");
  const tab = await page(t, server).open();
  const item = (text) => tab.input.queue.find((entry) => entry.text === text);

  // Up and down swap a message with its neighbour; the server keeps it.
  await act(async () => {
    tab.input.shift(item("three"), -1);
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(tab.texts(), ["one", "three", "two"]);
  assert.deepEqual(
    server.items.map((entry) => entry.id),
    ["srv-1", "srv-3", "srv-2"],
  );
  await act(async () => {
    tab.input.shift(item("one"), 1);
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(tab.texts(), ["three", "one", "two"]);

  // Past either end nothing is sent.
  const before = server.items.map((entry) => entry.id);
  await act(async () => {
    tab.input.shift(item("three"), -1);
    tab.input.shift(item("two"), 1);
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(
    server.items.map((entry) => entry.id),
    before,
  );

  // Refused on an old revision: the server's order shows again.
  server.bumpQuietly();
  await act(async () => {
    tab.input.shift(item("two"), -1);
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(tab.texts(), ["three", "one", "two"]);
  assert.equal(
    tab.input.queueNotice,
    i18n.t("conversation:errors.queueChanged"),
  );
});

test("messages queued during a turn go to the server, after the message this tab is still sending", async (t) => {
  const server = fakeServer();
  let finishSend;
  const sent = [];
  const tab = await page(t, server).open({
    onSend: (text) => {
      sent.push(text);
      return new Promise((resolve) => (finishSend = resolve));
    },
  });
  await tab.type("direct");
  await tab.submit();
  await tab.type("queued while sending");
  await tab.submit();
  await wait(0);
  assert.deepEqual(sent, ["direct"]);
  assert.deepEqual(server.enqueued, []);
  assert.deepEqual(tab.texts(), ["queued while sending"]);
  await act(async () => finishSend(true));
  await wait(0);
  await tab.render({ active: true, activeExecutionId: "chat" });
  await wait(0);
  assert.deepEqual(
    server.enqueued.map(({ chatId, text, settings }) => [
      chatId,
      text,
      settings.agentId,
    ]),
    [["chat", "queued while sending", "agent_claude"]],
  );
  assert.deepEqual(tab.texts(), ["queued while sending"]);
  assert.equal(tab.input.queue[0].state, "queued");

  await tab.type("queued during the turn");
  await tab.submit();
  await wait(0);
  assert.deepEqual(
    server.enqueued.map((entry) => entry.text),
    ["queued while sending", "queued during the turn"],
  );
  assert.deepEqual(sent, ["direct"]);
});

test("a new chat's queued messages reach the server once its first message made it a chat", async (t) => {
  const server = fakeServer();
  let finishSend;
  const tab = await page(t, server).open({
    threadKey: "w:new",
    chatId: undefined,
    onSend: () => new Promise((resolve) => (finishSend = resolve)),
  });
  await tab.type("start a chat");
  await tab.submit();
  await tab.type("and then this");
  await tab.submit();
  await act(async () => finishSend({ threadKey: "w:chat" }));
  await wait(0);
  assert.deepEqual(server.enqueued, []);
  await tab.render({ threadKey: "w:chat", chatId: "chat", active: true });
  await wait(0);
  assert.deepEqual(
    server.enqueued.map((entry) => entry.text),
    ["and then this"],
  );
});

test("a queue this browser kept moves to the server once, each message under its own id", async (t) => {
  const server = fakeServer();
  const { open } = page(t, server);
  localStorage.setItem(
    `${prefix}:w:chat`,
    JSON.stringify({
      v: 1,
      updatedAt: Date.now(),
      draft: "an unsent draft",
      queue: [
        { id: "local-1", text: "kept one" },
        { id: "local-2", text: "kept two" },
        { id: "local-3", text: "maybe sent", sending: { tab: "x", at: 1 } },
      ],
    }),
  );
  const tab = await open({ active: true });
  await wait(0);
  await wait(0);
  assert.deepEqual(
    server.enqueued.map(({ text, key }) => [text, key]),
    [
      ["kept one", "local-1"],
      ["kept two", "local-2"],
    ],
  );
  assert.deepEqual(tab.texts(), ["kept one", "kept two", "maybe sent"]);
  assert.equal(
    tab.input.queueNotice,
    i18n.t("conversation:errors.maybeSentMarked"),
  );
  const entry = JSON.parse(localStorage.getItem(`${prefix}:w:chat`));
  assert.equal(entry.draft, "an unsent draft");
  assert.deepEqual(
    entry.queue.map((item) => item.id),
    ["local-3"],
  );
  // Another tab shows the server's copies; only the doubtful one is still local.
  const other = await open({ active: true });
  await wait(0);
  assert.deepEqual(other.texts(), ["kept one", "kept two", "maybe sent"]);
  assert.equal(server.items.length, 2);
});

test("a message that finds a turn already running waits in the queue instead of steering it", async (t) => {
  const server = fakeServer();
  const tab = await page(t, server).open({ onSend: async () => "queue" });
  await tab.type("meant for the next turn");
  await tab.submit();
  await wait(0);
  await wait(0);
  assert.deepEqual(
    server.enqueued.map((entry) => entry.text),
    ["meant for the next turn"],
  );
  assert.equal(tab.input.draft, "");
  assert.equal(tab.input.error ?? "", "");
});
