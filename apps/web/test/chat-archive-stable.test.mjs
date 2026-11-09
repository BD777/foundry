import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

register("./bundler-resolve.mjs", import.meta.url);
const { useChatArchive } =
  await import("../src/features/chat/archive/use-chat-archive.ts");

// The chat feature lives for the whole app and derives its lists from the
// archive; new empty lists on every render made useDeferredValue render the
// app without end on every other page (DEV-152).
test("an archive not read for this workspace keeps the same empty lists across renders", async () => {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const root = createRoot(window.document.createElement("div"));
  const seen = [];
  function Harness({ workspaceId, tick }) {
    const archive = useChatArchive(workspaceId, false);
    seen.push({ tick, archive });
    return null;
  }
  const render = (workspaceId, tick) =>
    act(() => root.render(createElement(Harness, { workspaceId, tick })));
  try {
    await render("ws_first", 0);
    await render("ws_second", 1);
    await render("ws_second", 2);
    const [first, second] = seen.filter(({ tick }) => tick >= 1).slice(-2);
    assert.deepEqual(second.archive.chats, []);
    assert.equal(first.archive.chats, second.archive.chats);
    assert.equal(first.archive.sessions, second.archive.sessions);
    assert.equal(first.archive.restored, second.archive.restored);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await window.happyDOM.close();
  }
});
