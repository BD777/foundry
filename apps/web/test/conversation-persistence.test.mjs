import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);
const { useConversationInput } =
  await import("../src/components/conversation/use-conversation-input.ts");
const {
  clearConversationStorage,
  conversationStorageLimits,
  pruneConversationStorage,
} = await import("../src/components/conversation/conversation-storage.ts");

const prefix = "foundry.chat-composer";
const composer = {
  mode: "selectable",
  runtimeControls: { selectedRuntime: "codex" },
};
const wait = (ms) =>
  act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const stored = (threadKey) =>
  JSON.parse(localStorage.getItem(`${prefix}:${threadKey}`) ?? "null");

/** One browser: every mounted input ("tab") shares its storage and locks. */
function browser(t) {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    localStorage: window.localStorage,
    StorageEvent: window.StorageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  const tabs = [];
  t.after(async () => {
    for (const tab of tabs) await tab.close();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  /** Mounts an input as a freshly loaded page would. */
  async function open(options = {}) {
    let state,
      closed = false,
      props = {
        threadKey: "w:chat",
        messages: [],
        composer,
        storageKeyPrefix: prefix,
        onSend: async () => true,
        ...options,
      };
    const root = createRoot(window.document.createElement("div"));
    function Probe() {
      state = useConversationInput(props, () => {});
      return null;
    }
    const render = async (next = {}) => {
      props = { ...props, ...next };
      await act(() => root.render(createElement(Probe)));
    };
    const tab = {
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
      /** A reload: the page goes away without any further write. */
      close: async () => {
        if (closed) return;
        closed = true;
        await act(() => root.unmount());
      },
    };
    tabs.push(tab);
    await render();
    await wait(0);
    return tab;
  }
  /** Tells every tab another tab changed this key, as the browser would. */
  const announce = (threadKey) =>
    act(() => {
      window.dispatchEvent(
        new window.StorageEvent("storage", { key: `${prefix}:${threadKey}` }),
      );
    });
  return { window, open, announce };
}

test("a typed draft survives a reload and is cleared once sent", async (t) => {
  const { window, open } = browser(t);
  const first = await open();
  await first.type("a long message I do not want to lose");
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(stored("w:chat").draft, "a long message I do not want to lose");
  await first.close();

  const sent = [];
  const reloaded = await open({
    onSend: async (text) => {
      sent.push(text);
      return true;
    },
  });
  assert.equal(reloaded.input.draft, "a long message I do not want to lose");
  await reloaded.submit();
  await wait(450);
  assert.deepEqual(sent, ["a long message I do not want to lose"]);
  assert.equal(reloaded.input.draft, "");
  assert.equal(localStorage.getItem(`${prefix}:w:chat`), null);
});

test("draft writes are debounced and a new chat keeps its own draft", async (t) => {
  const { open } = browser(t);
  const tab = await open({ threadKey: "w:new" });
  await tab.type("n");
  await tab.type("ne");
  await tab.type("new chat idea");
  assert.equal(stored("w:new"), null);
  await wait(450);
  assert.equal(stored("w:new").draft, "new chat idea");
  await tab.render({ threadKey: "w:other" });
  assert.equal(tab.input.draft, "");
  await tab.close();
  const reloaded = await open({ threadKey: "w:new" });
  assert.equal(reloaded.input.draft, "new chat idea");
});

test("queued messages survive a reload and are sent in order after the running turn, each with its id as idempotency key", async (t) => {
  const { open } = browser(t);
  const running = { active: true, activeExecutionId: "turn1" };
  const before = await open(running);
  await before.type("first queued");
  await before.submit();
  await before.type("second queued");
  await before.submit();
  await before.type("unsent draft");
  const ids = before.input.queue.map((item) => item.id);
  await before.close();

  const sent = [];
  const after = await open({
    ...running,
    onSend: async (text, attachments, options) => {
      sent.push([text, options?.idempotencyKey]);
      return true;
    },
  });
  assert.deepEqual(
    after.input.queue.map((item) => item.text),
    ["first queued", "second queued"],
  );
  assert.equal(after.input.draft, "unsent draft");
  await wait(240);
  assert.deepEqual(sent, []);

  await after.render({ active: false });
  await wait(240);
  assert.deepEqual(sent, [["first queued", ids[0]]]);
  assert.deepEqual(
    stored("w:chat").queue.map((item) => item.text),
    ["second queued"],
  );
  await after.render({ active: true, activeExecutionId: "turn2" });
  await after.render({ active: false });
  await wait(240);
  assert.deepEqual(sent, [
    ["first queued", ids[0]],
    ["second queued", ids[1]],
  ]);
  assert.equal(after.input.queue.length, 0);
  assert.deepEqual(stored("w:chat").queue, []);
  assert.equal(stored("w:chat").draft, "unsent draft");
});

test("queued attachments are kept as uploaded references", async (t) => {
  const { open } = browser(t);
  const attachment = {
    id: "att1",
    kind: "image",
    name: "shot.png",
    path: "/workspace/.foundry/shot.png",
    mimeType: "image/png",
    size: 10,
  };
  const before = await open({ active: true, attachments: [attachment] });
  await before.type("look at this");
  await before.submit();
  await before.close();
  const after = await open({ active: true });
  assert.deepEqual(after.input.queue[0].attachments, [attachment]);
});

test("two tabs restoring the same queue send each message once", async (t) => {
  const { open, announce } = browser(t);
  localStorage.setItem(
    `${prefix}:w:chat`,
    JSON.stringify({
      v: 1,
      updatedAt: Date.now(),
      draft: "",
      queue: [
        { id: "q1", text: "one" },
        { id: "q2", text: "two" },
      ],
    }),
  );
  const sent = [];
  const onSend = async (text, _attachments, options) => {
    sent.push(options?.idempotencyKey ?? text);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return true;
  };
  const tabA = await open({ onSend });
  const tabB = await open({ onSend });
  assert.equal(tabA.input.queue.length, 2);
  assert.equal(tabB.input.queue.length, 2);
  await wait(400);
  await announce("w:chat");
  // Until q1's turn shows up, only the tab that sent it may send q2.
  await wait(400);
  assert.deepEqual(sent, ["q1"]);
  // Both tabs see the next turn run and finish.
  for (const tab of [tabA, tabB])
    await tab.render({ active: true, activeExecutionId: "turn" });
  for (const tab of [tabA, tabB]) await tab.render({ active: false });
  await wait(400);
  await announce("w:chat");
  await wait(400);
  assert.deepEqual(sent, ["q1", "q2"]);
  assert.equal(tabA.input.queue.length, 0);
  assert.equal(tabB.input.queue.length, 0);

  // The tab draining the queue leaves; the other takes over.
  await tabA.close();
  await tabB.type("three");
  await tabB.render({ active: true });
  await tabB.submit();
  await tabB.render({ active: false });
  await wait(400);
  assert.equal(sent.length, 3);
  assert.equal(tabB.input.queue.length, 0);
});

test("a tab never sends a message another tab already sent or is sending", async (t) => {
  const { open } = browser(t);
  let release;
  t.after(() => release?.(true));
  const sent = [];
  const tabA = await open({
    onSend: (text) => {
      sent.push(`A:${text}`);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const tabB = await open({
    onSend: async (text) => {
      sent.push(`B:${text}`);
      return true;
    },
  });
  await tabA.render({ active: true });
  await tabA.type("only once");
  await tabA.submit();
  await tabA.render({ active: false });
  await wait(240);
  assert.deepEqual(sent, ["A:only once"]);
  // B's memory is stale (no storage event yet) and the person clicks Send.
  const stale = { ...stored("w:chat").queue[0] };
  delete stale.sending;
  await act(() => tabB.input.sendQueued(stale));
  assert.deepEqual(sent, ["A:only once"]);
  await act(async () => release(true));
  await act(() => tabB.input.sendQueued(stale));
  assert.deepEqual(sent, ["A:only once"]);
  assert.equal(tabB.input.queue.length, 0);
});

test("a message whose sending tab closed mid-request waits for the person", async (t) => {
  const { open } = browser(t);
  localStorage.setItem(
    `${prefix}:w:chat`,
    JSON.stringify({
      v: 1,
      updatedAt: Date.now(),
      draft: "",
      queue: [
        {
          id: "q1",
          text: "maybe sent",
          sending: { tab: "closed-tab", at: Date.now() - 1000 },
        },
        { id: "q2", text: "later" },
      ],
    }),
  );
  const sent = [];
  const tab = await open({
    onSend: async (text) => {
      sent.push(text);
      return true;
    },
  });
  await wait(400);
  assert.deepEqual(sent, []);
  assert.match(tab.input.error, /may already be in the conversation/);
  await act(() => tab.input.sendQueued(tab.input.queue[0]));
  assert.deepEqual(sent, ["maybe sent"]);
  assert.deepEqual(
    stored("w:chat").queue.map((item) => item.id),
    ["q2"],
  );
});

test("a new chat's or adopted native chat's draft and queue move to the session's key", async (t) => {
  const { open } = browser(t);
  let accept;
  const tab = await open({
    threadKey: "w:native_1",
    onSend: () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  });
  await tab.type("adopt this chat");
  await tab.submit();
  await tab.type("follow-up");
  await tab.submit();
  await tab.type("still typing");
  await wait(450);
  assert.equal(stored("w:native_1").queue[0].text, "follow-up");
  await tab.render({ threadKey: "w:sess_1", active: true });
  await act(async () => accept({ threadKey: "w:sess_1" }));
  assert.equal(stored("w:native_1"), null);
  assert.equal(stored("w:sess_1").queue[0].text, "follow-up");
  assert.equal(stored("w:sess_1").draft, "still typing");
  assert.equal(tab.input.queue[0].text, "follow-up");
  assert.equal(tab.input.draft, "still typing");
  await tab.close();
  const reloaded = await open({ threadKey: "w:sess_1", active: true });
  assert.equal(reloaded.input.queue[0].text, "follow-up");
  assert.equal(reloaded.input.draft, "still typing");
});

test("a full storage evicts old conversations, and an unusable one leaves the composer working", async (t) => {
  const { open } = browser(t);
  localStorage.setItem(
    `${prefix}:w:old`,
    JSON.stringify({ v: 1, updatedAt: 1, draft: "old", queue: [] }),
  );
  // A storage that refuses writes while `failures` lasts, like a full quota.
  const real = localStorage;
  let failures = 1;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      get length() {
        return real.length;
      },
      key: (index) => real.key(index),
      getItem: (key) => real.getItem(key),
      removeItem: (key) => real.removeItem(key),
      setItem(key, value) {
        if (failures-- > 0)
          throw new DOMException("quota", "QuotaExceededError");
        real.setItem(key, value);
      },
    },
  });
  const tab = await open({ active: true });
  await tab.type("queued under pressure");
  await tab.submit();
  assert.equal(stored("w:old"), null);
  assert.equal(stored("w:chat").queue[0].text, "queued under pressure");

  failures = Infinity;
  await tab.type("cannot be saved");
  await tab.submit();
  await tab.type("draft too");
  await wait(450);
  assert.deepEqual(
    tab.input.queue.map((item) => item.text),
    ["queued under pressure", "cannot be saved"],
  );
  assert.equal(tab.input.draft, "draft too");
  failures = 0;
  const sent = [];
  await tab.render({
    active: false,
    onSend: async (text) => {
      sent.push(text);
      return true;
    },
  });
  await wait(240);
  await tab.render({ active: true, activeExecutionId: "r" });
  await tab.render({ active: false });
  await wait(240);
  assert.deepEqual(sent, ["queued under pressure", "cannot be saved"]);
});

test("signing out wipes stored drafts and queues, including a draft still being typed", async (t) => {
  const { open } = browser(t);
  localStorage.setItem(
    "foundry.issue-draft:issue_1",
    "legacy issue draft text",
  );
  localStorage.setItem("foundry.theme", "dark");
  const tab = await open({ active: true });
  await tab.type("queued secret");
  await tab.submit();
  await tab.type("typed secret");
  clearConversationStorage();
  await tab.close();
  await wait(450);
  assert.equal(localStorage.getItem(`${prefix}:w:chat`), null);
  assert.equal(localStorage.getItem("foundry.issue-draft:issue_1"), null);
  assert.equal(localStorage.getItem("foundry.theme"), "dark");
});

test("old and excess entries are pruned; legacy plain issue drafts still restore", async (t) => {
  const { open } = browser(t);
  const now = Date.now();
  localStorage.setItem(
    `${prefix}:w:stale`,
    JSON.stringify({
      v: 1,
      updatedAt: now - conversationStorageLimits.maxAgeMs - 1,
      draft: "stale",
      queue: [],
    }),
  );
  for (let index = 0; index < conversationStorageLimits.maxEntries + 2; index++)
    localStorage.setItem(
      `${prefix}:w:c${index}`,
      JSON.stringify({
        v: 1,
        updatedAt: now - 1000 + index,
        draft: "x",
        queue: [],
      }),
    );
  pruneConversationStorage(now);
  assert.equal(localStorage.getItem(`${prefix}:w:stale`), null);
  assert.equal(localStorage.getItem(`${prefix}:w:c0`), null);
  assert.equal(localStorage.getItem(`${prefix}:w:c1`), null);
  assert.ok(localStorage.getItem(`${prefix}:w:c2`));

  localStorage.setItem("foundry.issue-draft:issue_2", '{"not":"an entry"}');
  const issue = await open({
    threadKey: "issue_2",
    storageKeyPrefix: "foundry.issue-draft",
  });
  assert.equal(issue.input.draft, '{"not":"an entry"}');
});
