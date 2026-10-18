import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);
const { ChatTranscriptHistory } =
  await import("../src/features/chat/chat-transcript-history.tsx");
const { i18n } = await import("../src/i18n/index.ts");

const state = (overrides = {}) => ({
  earlier: {},
  earlierFailed: false,
  failed: false,
  loading: false,
  loadingEarlier: false,
  slow: false,
  ...overrides,
});

test("the history row stays, as the conversation's start, once the last older messages arrive", async () => {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  await i18n.changeLanguage("en");
  const container = window.document.createElement("div");
  const root = createRoot(container);
  const render = (next) =>
    act(() =>
      root.render(
        createElement(ChatTranscriptHistory, {
          onLoadEarlier: () => {},
          onRetry: () => {},
          state: next,
        }),
      ),
    );
  try {
    await render(state());
    assert.equal(container.innerHTML, "", "a chat without older pages");

    await render(state({ earlier: { sess_1: "evt_10" } }));
    assert.match(container.textContent, /Load earlier messages/);
    await render(
      state({ earlier: { sess_1: "evt_10" }, loadingEarlier: true }),
    );
    // The last older page arrived: the row must not go away (everything
    // below it would move up under the person reading).
    await render(state());
    const row = container.querySelector(".fdy-chat-history");
    assert.ok(row, "the row stays");
    assert.equal(row.dataset.state, "start");
    assert.match(row.textContent, /Beginning of the conversation/);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
});
