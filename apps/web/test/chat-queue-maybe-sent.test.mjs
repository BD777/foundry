import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

async function withDom(body) {
  const window = new Window({ url: "http://127.0.0.1/" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "getComputedStyle"])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  try {
    const { createRoot } = await import("react-dom/client");
    const { i18n } = await import("../src/i18n/index.ts");
    await i18n.changeLanguage("en");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await body(container, root, i18n);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

// A steer its device never answered: the server fails the message but marks
// it maybe sent. The queue says so instead of "Not sent", and the message
// can still be retried or deleted.
test("a message its device may have taken is shown as unconfirmed, retryable and deletable", async () => {
  await withDom(async (container, root, i18n) => {
    const { ConversationQueue } =
      await import("../src/components/conversation/conversation-queue.tsx");
    const retried = [];
    const removed = [];
    const queue = [
      {
        id: "q1",
        text: "steer me",
        state: "failed",
        error: "byte-dev did not answer within 8 s.",
        maybeSent: true,
      },
      {
        id: "q2",
        text: "refused",
        state: "failed",
        error: "the message was not recorded",
      },
    ];
    const input = {
      queue,
      queueNotice: "",
      serverMode: true,
      isLocal: () => false,
      canSteer: false,
      active: true,
      pending: false,
      unavailable: false,
      inlineEdit: true,
      retry: (item) => retried.push(item.id),
      remove: (item) => removed.push(item.id),
      steer: () => {},
      sendQueued: () => {},
      move: () => {},
      commitOrder: () => {},
      shift: () => {},
    };
    await act(async () =>
      root.render(
        createElement(ConversationQueue, {
          input,
          focus: () => {},
          onPreview: () => {},
        }),
      ),
    );
    const rows = [...container.querySelectorAll(".fdy-chat-queue-item")];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.maybeSent, "true");
    assert.equal(rows[1].dataset.maybeSent, "false");
    assert.equal(
      rows[0].querySelector('[role="alert"]').textContent,
      i18n.t("conversation:queue.unconfirmed", {
        error: "byte-dev did not answer within 8 s.",
      }),
    );
    assert.match(
      rows[0].querySelector('[role="alert"]').textContent,
      /may already be in the conversation/,
    );
    assert.doesNotMatch(rows[0].textContent, /Not sent/);
    assert.match(
      rows[1].querySelector('[role="alert"]').textContent,
      /^Not sent: the message was not recorded$/,
    );

    const retry = rows[0].querySelector(
      `button[aria-label="${i18n.t("conversation:queue.retryHint")}"]`,
    );
    const remove = rows[0].querySelector(
      `button[aria-label="${i18n.t("conversation:queue.remove")}"]`,
    );
    assert.ok(retry && !retry.disabled, "Retry is offered");
    assert.ok(remove && !remove.disabled, "Delete is offered");
    await act(async () => retry.click());
    await act(async () => remove.click());
    assert.deepEqual(retried, ["q1"]);
    assert.deepEqual(removed, ["q1"]);
  });
});
