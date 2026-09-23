import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);
const { useConversationInput } =
  await import("../src/components/conversation/use-conversation-input.ts");

async function harness(t, composer, options = {}) {
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
  let state,
    props = {
      threadKey: "thread",
      messages: [],
      composer,
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
  t.after(async () => {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
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
    settle: () => act(() => new Promise((resolve) => setTimeout(resolve, 240))),
  };
}
const modes = {
  fixed: { mode: "fixed", runtime: "claude", model: "test" },
  selectable: {
    mode: "selectable",
    runtimeControls: { selectedRuntime: "claude" },
  },
};
test("a conversational reply completes without waiting for an implementation run", async (t) => {
  const sent = [];
  const h = await harness(t, modes.fixed, {
    onSend: async (text) => {
      sent.push(text);
      return "replied";
    },
  });
  await h.type("What is the goal?");
  await h.submit();
  await h.settle();
  assert.equal(h.input.active, false);
  await h.type("Here is the next answer");
  await h.submit();
  await h.settle();
  assert.deepEqual(sent, ["What is the goal?", "Here is the next answer"]);
  assert.equal(h.input.active, false);
});
test("read-only status questions bypass the execution queue without steering or starting another run", async (t) => {
  const sent = [];
  const h = await harness(t, modes.fixed, {
    active: true,
    activeExecutionId: "current-run",
    canSendDuringExecution: (text) => text === "status",
    onSend: async (text) => {
      sent.push(text);
      return "replied";
    },
  });
  await h.type("next implementation feedback");
  await h.submit();
  assert.equal(h.input.queue.length, 1);
  await h.type("status");
  await h.submit();
  await h.settle();
  assert.deepEqual(sent, ["status"]);
  assert.equal(h.input.queue[0].text, "next implementation feedback");
  assert.equal(h.input.active, true);
});
for (const [name, composer] of Object.entries(modes)) {
  test(`${name}: a failed send retains the original message and any newly typed draft`, async (t) => {
    let rejectSend;
    const h = await harness(t, composer, {
      onSend: () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    });
    await h.type("first message");
    await h.submit();
    await h.type("new draft");
    await act(async () => {
      rejectSend(new Error("offline"));
    });
    assert.equal(h.input.draft, "new draft");
    assert.equal(h.input.queue[0].text, "first message");
    assert.match(h.input.error, /offline/);
    await h.settle();
    assert.equal(h.input.queue.length, 1);
  });
  test(`${name}: Claude queue and steer preserve attachments and target the original execution`, async (t) => {
    const attachment = {
      id: "image",
      kind: "image",
      name: "image.png",
      path: "/image.png",
    };
    const removed = [],
      restored = [],
      steered = [];
    const h = await harness(t, composer, {
      active: true,
      activeExecutionId: "run1",
      attachments: [attachment],
      onAttachmentRemove: (id) => removed.push(id),
      onAttachmentsRestore: (files) => restored.push(...files),
      onSteer: async (...args) => {
        steered.push(args);
        return true;
      },
    });
    await h.type("guide");
    await h.submit();
    assert.equal(h.input.queue.length, 1);
    assert.deepEqual(removed, ["image"]);
    await act(() => h.input.steer(h.input.queue[0]));
    assert.deepEqual(steered, [["guide", "run1"]]);
    assert.deepEqual(restored, [attachment]);
    assert.equal(h.input.queue.length, 0);
    await h.render({ attachments: [] });
    await h.type("stale guide");
    await h.submit();
    await h.render({ activeExecutionId: "run2" });
    await act(() => h.input.steer(h.input.queue[0]));
    assert.equal(steered.length, 1);
    assert.equal(h.input.queue.length, 1);
    assert.match(h.input.error, /active response changed/);
  });
  test(`${name}: stop waits for idle, sends one queued turn, and never retries a failed send automatically`, async (t) => {
    const sent = [],
      stopped = [];
    let succeed = true;
    const h = await harness(t, composer, {
      active: true,
      activeExecutionId: "r1",
      onStop: async (id) => stopped.push(id),
      onSend: async (text) => {
        sent.push(text);
        return succeed;
      },
    });
    await h.type("one");
    await h.submit();
    await h.type("two");
    await h.submit();
    await act(() => h.input.stop());
    await h.settle();
    assert.deepEqual(stopped, ["r1"]);
    assert.deepEqual(sent, []);
    await h.render({ active: false });
    await h.settle();
    assert.deepEqual(sent, ["one"]);
    await h.settle();
    assert.deepEqual(sent, ["one"]);
    await h.render({ active: true, activeExecutionId: "r2" });
    succeed = false;
    await h.render({ active: false });
    await h.settle();
    assert.deepEqual(sent, ["one", "two"]);
    await h.settle();
    assert.equal(sent.length, 2);
    assert.equal(h.input.queue[0].text, "two");
  });
  test(`${name}: drafts stay with their conversation and terminal conversations do not send`, async (t) => {
    const sent = [];
    const h = await harness(t, composer, {
      draftStorageKey: "draft:first",
      onSend: async (text) => {
        sent.push(text);
        return true;
      },
    });
    await h.type("first draft");
    assert.equal(localStorage.getItem("draft:first"), "first draft");
    await h.render({ threadKey: "second", draftStorageKey: "draft:second" });
    assert.equal(h.input.draft, "");
    await h.type("second draft");
    await h.render({ threadKey: "thread", draftStorageKey: "draft:first" });
    assert.equal(h.input.draft, "first draft");
    await h.render({ readOnly: "Accepted" });
    await h.submit();
    assert.deepEqual(sent, []);
  });
}
test("Codex keeps messages queued and a new chat migrates its queue to its assigned thread", async (t) => {
  const composer = { mode: "fixed", runtime: "codex" };
  const h = await harness(t, composer, {
    threadKey: "workspace:new",
    active: true,
    activeExecutionId: "r1",
    onSteer: async () => true,
  });
  await h.type("next");
  await h.submit();
  await h.type("draft");
  await h.render({ threadKey: "workspace:assigned" });
  assert.equal(h.input.draft, "draft");
  assert.equal(h.input.queue[0].text, "next");
  assert.equal(h.input.canSteer, false);
  await h.render({ threadKey: "other" });
  assert.equal(h.input.queue.length, 0);
  assert.equal(h.input.draft, "");
});

test("a send acknowledged after a new chat receives its id does not leave the next new chat blocked", async (t) => {
  let resolveSend;
  const h = await harness(t, modes.fixed, {
    threadKey: "w:new",
    onSend: () =>
      new Promise((resolve) => {
        resolveSend = resolve;
      }),
  });
  await h.type("first");
  await h.submit();
  await h.render({
    threadKey: "w:assigned",
    active: true,
    activeExecutionId: "r1",
  });
  await act(async () => {
    resolveSend(true);
  });
  await h.render({
    threadKey: "w:new",
    active: false,
    activeExecutionId: undefined,
  });
  assert.equal(h.input.active, false);
  assert.equal(h.input.draft, "");
});
