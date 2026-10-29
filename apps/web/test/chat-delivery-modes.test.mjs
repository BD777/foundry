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
const { countdown, deliveryForModifier, deliveryOptions, deliveryShortcut } =
  await import("../src/components/conversation/delivery-choices.ts");
const { i18n } = await import("../src/i18n/index.ts");

const wait = (ms = 0) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** A chat queue server that records what each request asked for. */
function fakeServer() {
  let revision = 0;
  let items = [];
  const requests = [];
  const listeners = new Set();
  const snapshot = () => ({
    workspaceId: "w",
    chatId: "chat",
    revision,
    items: items.map((item) => ({ ...item })),
  });
  const changed = () => {
    revision += 1;
    const queue = snapshot();
    listeners.forEach((listener) => listener(queue));
    return { ok: true, queue };
  };
  return {
    requests,
    get items() {
      return items;
    },
    transport: {
      get: async () => ({ ok: true, queue: snapshot() }),
      async enqueue(chatId, input) {
        requests.push({
          kind: "enqueue",
          text: input.text,
          delivery: input.delivery,
        });
        items.push({
          id: `srv-${items.length + 1}`,
          chatId,
          position: items.length + 1,
          text: input.text,
          runSettings: {},
          createdAt: "",
          updatedAt: "",
          revision: 1,
          state: "queued",
          ...(input.delivery ? { delivery: input.delivery } : {}),
        });
        return changed();
      },
      async edit(chatId, id, input) {
        requests.push({
          kind: "edit",
          id,
          delivery: input.delivery,
          expected: input.expectedRevision,
        });
        const item = items.find((entry) => entry.id === id);
        if (input.delivery !== undefined)
          item.delivery =
            input.delivery === "turn_end" ? undefined : input.delivery;
        item.revision += 1;
        return changed();
      },
      remove: async (chatId, id) => {
        items = items.filter((item) => item.id !== id);
        return changed();
      },
      reorder: async () => changed(),
      steer: async () => changed(),
      retry: async () => changed(),
      subscribe(onQueue) {
        listeners.add(onQueue);
        return () => listeners.delete(onQueue);
      },
    },
  };
}

async function openChat(t, server, runtime) {
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
  let state;
  let props = {
    threadKey: "w:chat",
    messages: [],
    composer: {
      mode: "selectable",
      runtimeControls: { selectedRuntime: runtime },
    },
    storageKeyPrefix: "foundry.delivery-test",
    active: true,
    onSend: async () => true,
    onSteer: async () => true,
  };
  function Probe() {
    const serverQueue = useChatQueue({
      workspaceId: "w",
      chatId: "chat",
      runSettings: () => ({}),
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
    render,
    async send(text, delivery) {
      await act(async () => state.updateDraft(text));
      await act(async () => {
        state.submit(delivery);
        await Promise.resolve();
      });
      await wait(0);
    },
  };
}

test("Enter, Ctrl/⌘+Enter and Alt/⌥+Enter pick a delivery", () => {
  assert.equal(deliveryForModifier("none"), "boundary");
  assert.equal(deliveryForModifier("mod"), "interrupt");
  assert.equal(deliveryForModifier("alt"), "turn_end");
  assert.equal(deliveryShortcut("interrupt", true), "⌘ Enter");
  assert.equal(deliveryShortcut("interrupt", false), "Ctrl+Enter");
  assert.equal(deliveryShortcut("turn_end", false), "Alt+Enter");
  assert.equal(
    countdown("2026-10-29T10:15:00.000Z", Date.parse("2026-10-29T10:00:01Z")),
    "14:59",
  );
  assert.equal(
    countdown("2026-10-29T10:15:00.000Z", Date.parse("2026-10-29T10:20:00Z")),
    "0:00",
  );
  assert.equal(countdown(undefined, 0), "");
});

test("the menu says when each delivery lands, Claude's interrupt after its tool call", async () => {
  await i18n.changeLanguage("en");
  const t = i18n.getFixedT("en", "conversation");
  const claude = deliveryOptions(t, "claude", { mac: false });
  const codex = deliveryOptions(t, "codex", { mac: false });
  assert.deepEqual(
    claude.map((option) => option.value),
    ["boundary", "interrupt", "turn_end"],
  );
  assert.deepEqual(
    claude.map((option) => option.shortcut),
    ["Enter", "Ctrl+Enter", "Alt+Enter"],
  );
  assert.match(claude[1].reason, /current tool call/);
  assert.doesNotMatch(codex[1].reason, /tool call/);
  assert.ok(
    deliveryOptions(t, "codex", { disabled: true }).every(
      (option) => option.disabled,
    ),
  );
  assert.ok(
    deliveryOptions(t, "codex", { shortcuts: false }).every(
      (option) => !option.shortcut,
    ),
  );
});

test("a message sent during a turn goes to the server with its delivery, and can change it", async (t) => {
  const server = fakeServer();
  const chat = await openChat(t, server, "codex");
  assert.equal(chat.input.deliveryChoices, true);
  await chat.send("next step");
  await chat.send("right now", "interrupt");
  await chat.send("later", "turn_end");
  assert.deepEqual(
    server.requests.map((request) => [request.text, request.delivery]),
    [
      ["next step", "boundary"],
      ["right now", "interrupt"],
      ["later", undefined],
    ],
  );
  assert.deepEqual(
    chat.input.queue.map((item) => item.delivery),
    ["boundary", "interrupt", undefined],
  );
  // Before it goes in, the person switches it to wait for the turn's end.
  const first = chat.input.queue[0];
  await act(async () => {
    chat.input.setDelivery(first, "turn_end");
    await Promise.resolve();
  });
  await wait(0);
  assert.deepEqual(server.requests.at(-1), {
    kind: "edit",
    id: first.id,
    delivery: "turn_end",
    expected: 1,
  });
  assert.equal(chat.input.queue[0].delivery, undefined);
});

test("an idle chat sends at once, without a delivery", async (t) => {
  const server = fakeServer();
  const sent = [];
  const chat = await openChat(t, server, "claude");
  await chat.render({
    active: false,
    onSend: async (text) => {
      sent.push(text);
      return true;
    },
  });
  await chat.send("hello", "interrupt");
  assert.deepEqual(sent, ["hello"]);
  assert.equal(server.requests.length, 0);
});
