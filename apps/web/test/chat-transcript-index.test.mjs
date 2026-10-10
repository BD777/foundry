import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);
const {
  CHAT_FIRST_ITEM_INDEX,
  chatRenderedRows,
  chatTopRows,
  nextChatFirstItemIndex,
  useChatFirstItemIndex,
} = await import("../src/components/conversation/chat-transcript-index.ts");
const { useChatPrependAnchor } =
  await import("../src/components/conversation/use-chat-prepend-anchor.ts");
const {
  buildChatTurnAnchors,
  chatReadingMessageIndex,
  findActiveChatTurnIndexForMessage,
} = await import("../src/components/conversation/chat-turn-navigation.ts");

const messages = (...ids) => ids.map((id) => ({ id }));

test("older messages added in front lower the first index by their number", () => {
  const shown = messages("q2", "a2", "q3", "a3");
  const base = CHAT_FIRST_ITEM_INDEX;
  assert.equal(
    nextChatFirstItemIndex(
      shown,
      base,
      messages("q1", "a1", ...["q2", "a2", "q3", "a3"]),
    ),
    base - 2,
  );
  // Live messages at the end keep the numbering.
  assert.equal(
    nextChatFirstItemIndex(shown, base, messages("q2", "a2", "q3", "a3", "q4")),
    base,
  );
  // The first shown row can be regrouped with the older events: the shift is
  // read from the first message both lists still share.
  assert.equal(
    nextChatFirstItemIndex(
      messages("process-new", "q2", "a2"),
      base,
      messages("q1", "a1", "process-old", "q2", "a2"),
    ),
    base - 2,
  );
  // Messages dropped in front (a fresh recent window) raise it.
  assert.equal(
    nextChatFirstItemIndex(shown, base, messages("q3", "a3")),
    base + 2,
  );
  // Nothing shared: nothing shown stays, rows are replaced in place.
  assert.equal(nextChatFirstItemIndex(shown, base, messages("x", "y")), base);
  assert.equal(nextChatFirstItemIndex([], base - 7, shown), base);
});

test("rendered rows are numbered by position, so turn navigation survives prepends", () => {
  const before = [
    { id: "q2", role: "user", text: "Second" },
    { id: "a2", role: "bot", text: "Answer" },
    { id: "q3", role: "user", text: "Third" },
  ];
  const after = [
    { id: "q1", role: "user", text: "First" },
    { id: "a1", role: "bot", text: "Answer" },
    ...before,
  ];
  const firstItemIndex = nextChatFirstItemIndex(
    before,
    CHAT_FIRST_ITEM_INDEX,
    after,
  );
  // Virtuoso reports `firstItemIndex + position`; reading "q3" at the top.
  const rows = chatRenderedRows(
    [
      { index: firstItemIndex + 3, offset: 900 },
      { index: firstItemIndex + 4, offset: 1000 },
    ],
    firstItemIndex,
  );
  assert.deepEqual(rows, [
    { index: 3, offset: 900 },
    { index: 4, offset: 1000 },
  ]);
  const anchors = buildChatTurnAnchors(after);
  const reading = chatReadingMessageIndex(rows, 1010);
  assert.equal(after[reading].id, "q3");
  assert.equal(
    anchors[findActiveChatTurnIndexForMessage(anchors, reading)].id,
    "q3",
  );
  // Virtuoso's own position wins when it reports one.
  assert.deepEqual(
    chatRenderedRows([{ index: 9, offset: 0, originalIndex: 2 }], 5),
    [{ index: 2, offset: 0 }],
  );
});

test("each thread numbers from the start; prepends move it, appends do not", async () => {
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
  let props = { threadKey: "a", messages: messages("q2", "a2") };
  let result;
  let renders = 0;
  function Harness() {
    renders += 1;
    result = useChatFirstItemIndex(props.threadKey, props.messages);
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const render = (next) => {
    props = { ...props, ...next };
    return act(() =>
      root.render(createElement(StrictMode, null, createElement(Harness))),
    );
  };
  const base = CHAT_FIRST_ITEM_INDEX;
  try {
    await render({});
    assert.equal(result, base);

    await render({ messages: messages("q1", "a1", "q2", "a2") });
    assert.equal(result, base - 2);

    const settled = renders;
    await render({ messages: messages("q1", "a1", "q2", "a2", "q3") });
    assert.equal(result, base - 2, "live messages keep the numbering");
    assert.ok(renders - settled <= 2, "an append needs no extra render");

    await render({ messages: messages("q0", "q1", "a1", "q2", "a2", "q3") });
    assert.equal(result, base - 3);

    await render({ threadKey: "b", messages: messages("x1", "x2") });
    assert.equal(result, base, "another chat numbers from the start");

    await render({ messages: messages("x0", "x1", "x2") });
    assert.equal(result, base - 1);
    await render({ messages: messages("y1") });
    assert.equal(result, base - 1, "an unrelated list is replaced in place");
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
});

test("the rows at the top of the viewport carry how far it is past them", () => {
  const rows = [
    { index: 4, offset: 0 },
    { index: 5, offset: 300 },
    { index: 6, offset: 360 },
    { index: 7, offset: 900 },
  ];
  assert.deepEqual(chatTopRows(rows, 320), [
    { index: 5, inset: 20 },
    { index: 6, inset: -40 },
    { index: 7, inset: -580 },
  ]);
  // Above the first row (the header is in view): the first rows.
  assert.deepEqual(chatTopRows(rows, -58, 1), [{ index: 4, inset: -58 }]);
  assert.deepEqual(chatTopRows([], 0), []);
});

test("added in front while reading: the row at the top goes back where it was", async () => {
  const window = new Window();
  const previous = new Map();
  const frames = [];
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
  window.requestAnimationFrame = (callback) => frames.push(callback);
  window.cancelAnimationFrame = () => {};
  const scrolls = [];
  const virtuosoRef = { current: { scrollToIndex: (l) => scrolls.push(l) } };
  let scrolling = false;
  let top = [];
  let props = { firstItemIndex: 100, messages: messages("p1", "q2", "a2") };
  let anchor;
  function Harness() {
    anchor = useChatPrependAnchor({
      ...props,
      personScrolling: () => scrolling,
      topRows: () => top,
      virtuosoRef,
    });
    return null;
  }
  const root = createRoot(window.document.createElement("div"));
  const render = (next) => {
    props = { ...props, ...next };
    return act(() => root.render(createElement(Harness)));
  };
  const flush = () => act(() => frames.splice(0).forEach((f) => f(0)));
  try {
    await render({});
    // Reading "p1" 58px below the header, "q2" and "a2" below it.
    top = [
      { index: 0, inset: -58 },
      { index: 1, inset: -114 },
    ];
    // Older events regroup "p1" into "p0+p1"; two rows come first.
    await render({
      firstItemIndex: 98,
      messages: messages("x", "y", "p0+p1", "q2", "a2"),
    });
    await flush();
    assert.deepEqual(scrolls.at(-1), {
      align: "start",
      index: 3,
      offset: -114,
    });
    // Measured heights land: the same row is put back again.
    await act(() => anchor.listResized());
    assert.equal(scrolls.length, 2);
    assert.deepEqual(scrolls.at(-1), scrolls[0]);

    // Another page in a row keeps the row read before the first one.
    top = [{ index: 0, inset: 0 }];
    await render({
      firstItemIndex: 97,
      messages: messages("w", "x", "y", "p0+p1", "q2", "a2"),
    });
    await flush();
    assert.equal(scrolls.at(-1).index, 4);

    // Moving the list on purpose ends it.
    anchor.release();
    await act(() => anchor.listResized());
    assert.equal(scrolls.length, 3);

    // A person who is scrolling keeps control.
    scrolling = true;
    top = [{ index: 0, inset: 0 }];
    await render({
      firstItemIndex: 96,
      messages: messages("v", "w", "x", "y", "p0+p1", "q2", "a2"),
    });
    await flush();
    assert.equal(scrolls.length, 3);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
});
