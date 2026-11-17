import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "NodeFilter",
  "DOMRect",
  "PopStateEvent",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { navBadge } = await import("../src/app/app-sidebar.tsx");

const counts = (extra) => ({
  review: 0,
  running: 0,
  activeSkills: 0,
  pending: 0,
  assistantUnread: false,
  ...extra,
});

test("an unseen answer marks the assistant entry with a dot, not a count", () => {
  const assistant = { id: "assistant", label: "Assistant" };
  assert.deepEqual(navBadge(assistant, counts({ assistantUnread: true })), {
    dot: true,
  });
  assert.equal(navBadge(assistant, counts({})), undefined);
  assert.deepEqual(navBadge({ id: "pending" }, counts({ pending: 3 })), {
    children: 3,
    tone: "brass",
  });
});
