import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";

async function withDom(body) {
  const window = new Window({ url: "http://127.0.0.1/" });
  const copied = [];
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => void copied.push(text) },
  });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    // The diff stays loading: only the switch is under test.
    fetch: () => new Promise(() => {}),
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "getComputedStyle",
  ])
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
    await import("../src/i18n/index.ts");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await body(container, root, copied);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

const item = {
  id: "/repo/src/app.ts",
  kind: "session-file",
  label: "app.ts",
  path: "/repo/src/app.ts",
  workspacePath: "src/app.ts",
  origin: "tool",
  op: "modified",
  inGitRepo: true,
  turnIds: ["in_1"],
  sessionId: "sess_1",
  workspaceId: "ws_1",
};
const file = {
  sessionId: "sess_1",
  path: "/repo/src/app.ts",
  origin: "tool",
  insideWorkspace: true,
  kind: "text",
  content: "export const app = 1;\n",
  truncated: false,
  changedSinceRecorded: false,
};

test("switching Diff and File keeps focus on the switch; the path copies", async () => {
  await withDom(async (container, root, copied) => {
    const { ChangeDetail } =
      await import("../src/features/chat/chat-detail-change.tsx");
    await act(async () =>
      root.render(createElement(ChangeDetail, { file, item })),
    );
    const segment = (label) =>
      Array.from(container.querySelectorAll("[role=radio]")).find(
        (button) => button.textContent === label,
      );
    const fileSegment = segment("File");
    fileSegment.focus();
    await act(async () => fileSegment.click());
    assert.match(container.textContent, /export const app/);
    assert.equal(document.activeElement, fileSegment);
    const diffSegment = segment("Diff");
    diffSegment.focus();
    await act(async () => diffSegment.click());
    assert.equal(document.activeElement, diffSegment);
    assert.equal(segment("File"), fileSegment);

    await act(async () => fileSegment.click());
    const copy = container.querySelector('button[aria-label="Copy path"]');
    await act(async () => copy.click());
    assert.deepEqual(copied, ["src/app.ts"]);
    assert.equal(copy.getAttribute("aria-label"), "Copied");
  });
});
