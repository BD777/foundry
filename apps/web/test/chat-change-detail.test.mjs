import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createFileDiff } from "../src/components/ui/file-diff-engine.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The diff worker, run in-process: happy-dom has no Worker. */
class InlineDiffWorker {
  postMessage({ before, after }) {
    setTimeout(() => this.onmessage?.({ data: createFileDiff(before, after) }));
  }
  terminate() {}
}

async function withDom(body) {
  const window = new Window({ url: "http://127.0.0.1/" });
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
    Worker: InlineDiffWorker,
  };
  for (const key of [
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "InputEvent",
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
    await body(container, root);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

const item = (overrides = {}) => ({
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
  ...overrides,
});

const fileRead = {
  sessionId: "sess_1",
  path: "/repo/src/app.ts",
  workspacePath: "src/app.ts",
  origin: "tool",
  insideWorkspace: true,
  kind: "text",
  content: "export const answer = 42;\n",
  truncated: false,
  changedSinceRecorded: false,
};

const diffAnswer = (overrides = {}) => ({
  sessionId: "sess_1",
  path: "/repo/src/app.ts",
  workspacePath: "src/app.ts",
  origin: "tool",
  insideWorkspace: true,
  source: "hook",
  before: "export const answer = 41;\n",
  after: "export const answer = 42;\n",
  beforeLabel: "beforeEdits",
  afterLabel: "afterEdits",
  mayIncludeOtherEdits: false,
  changedSince: false,
  truncated: false,
  binary: false,
  tooLarge: false,
  added: 1,
  removed: 1,
  ...overrides,
});

async function renderPanel(root, selection, answer) {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const { ChatDetailPanel } =
    await import("../src/features/chat/chat-detail-panel.tsx");
  await act(async () =>
    root.render(
      createElement(ChatDetailPanel, {
        file: fileRead,
        loading: false,
        onClose: () => {},
        selection,
      }),
    ),
  );
  for (let index = 0; index < 5; index += 1) await act(tick);
  return requests;
}

const buttonNamed = (container, name) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === name,
  );

test("a change opens its diff; the layout choice is remembered", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withDom(async (container, root) => {
      const requests = await renderPanel(root, item(), diffAnswer());
      assert.equal(requests.length, 1);
      assert.match(
        requests[0],
        /\/api\/agent-sessions\/sess_1\/files\/diff\?path=%2Frepo%2Fsrc%2Fapp\.ts$/,
      );
      assert.ok(container.querySelector(".fdy-text-diff"), "renders FileDiff");
      assert.match(
        container.textContent,
        /Before this chat's edits → after its last edit/,
      );
      assert.match(container.textContent, /\+1−1/);
      assert.match(container.textContent, /answer = 41/);

      await act(async () => buttonNamed(container, "Side by side").click());
      assert.equal(localStorage.getItem("foundry.changeDiffView.v1"), "split");
      // Another change opens in the remembered layout.
      await renderPanel(
        root,
        item({ id: "/repo/b.ts", path: "/repo/b.ts", label: "b.ts" }),
        diffAnswer(),
      );
      assert.equal(
        buttonNamed(container, "Side by side").getAttribute("data-state"),
        "on",
      );
      // The File view shows the file itself.
      await act(async () => buttonNamed(container, "File").click());
      assert.equal(container.querySelector(".fdy-text-diff"), null);
      assert.match(container.textContent, /answer = 42/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one answer's change asks for that turn's diff", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withDom(async (container, root) => {
      const requests = await renderPanel(
        root,
        item({ diffTurnId: "in_2" }),
        diffAnswer({ inputId: "in_2" }),
      );
      assert.match(requests[0], /&inputId=in_2$/);
      assert.match(container.textContent, /This answer's edits/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unavailable, binary and too-large diffs say so and offer the file", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [answer, copy] of [
      [
        diffAnswer({
          before: undefined,
          after: undefined,
          unavailable: "noBaseline",
        }),
        /Diff unavailable: no copy from before/,
      ],
      [
        diffAnswer({ before: undefined, after: undefined, binary: true }),
        /Diff unavailable: this is a binary file/,
      ],
      [
        diffAnswer({ before: undefined, after: undefined, tooLarge: true }),
        /Diff unavailable: the file is over 1 MB/,
      ],
    ])
      await withDom(async (container, root) => {
        await renderPanel(root, item(), answer);
        assert.match(container.textContent, copy);
        assert.equal(container.querySelector(".fdy-text-diff"), null);
        await act(async () => buttonNamed(container, "View file").click());
        assert.match(container.textContent, /answer = 42/);
      });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a new Markdown file opens as the file, with Diff a click away", async () => {
  const originalFetch = globalThis.fetch;
  try {
    await withDom(async (container, root) => {
      const requests = await renderPanel(
        root,
        item({
          id: "/repo/README.md",
          path: "/repo/README.md",
          label: "README.md",
          op: "created",
        }),
        diffAnswer({ beforeLabel: "empty", before: "" }),
      );
      assert.equal(requests.length, 0, "no diff is read until asked for");
      await act(async () => buttonNamed(container, "Diff").click());
      for (let index = 0; index < 5; index += 1) await act(tick);
      assert.equal(requests.length, 1);
      assert.match(container.textContent, /New file → after its last edit/);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Changes rows show A/M/D and line counts; one answer's are that turn's", async () => {
  const { ChatContextCard } =
    await import("../src/features/chat/chat-context-card.tsx");
  const change = item({
    turnIds: ["in_1", "in_2"],
    lineChanges: { added: 12, removed: 3 },
    turnLineChanges: {
      in_1: { added: 10, removed: 0 },
      in_2: { added: 2, removed: 3 },
    },
  });
  const created = item({
    id: "/repo/new.md",
    path: "/repo/new.md",
    workspacePath: "new.md",
    label: "new.md",
    op: "created",
    turnIds: ["in_2"],
    lineChanges: { added: 4, removed: 0 },
    turnLineChanges: { in_2: { added: 4, removed: 0 } },
  });
  const data = {
    changes: [change, created],
    files: [],
    previews: [],
    sources: [],
    subagents: [],
    timers: [],
    background: [],
  };
  const selected = [];
  const rows = (container) =>
    [...container.querySelectorAll(".fdy-file-tree-row[data-kind='file']")].map(
      (row) => [
        row.querySelector(".fdy-file-tree-name").textContent,
        row.querySelector(".fdy-file-tree-lines")?.getAttribute("aria-label"),
        row.querySelector(".fdy-file-tree-status")?.textContent,
        row.querySelector(".fdy-file-tree-status")?.getAttribute("aria-label"),
      ],
    );
  await withDom(async (container, root) => {
    const render = (turnFilter) =>
      act(async () =>
        root.render(
          createElement(ChatContextCard, {
            data,
            onSelect: (value) => selected.push(value),
            turnFilter,
          }),
        ),
      );
    await render(undefined);
    assert.deepEqual(rows(container), [
      ["app.ts", "12 lines added, 3 removed", "M", "Edited"],
      ["new.md", "4 lines added, 0 removed", "A", "New"],
    ]);
    await render("in_1");
    assert.deepEqual(rows(container), [
      ["app.ts", "10 lines added, 0 removed", "M", "Edited"],
    ]);
    await act(async () =>
      container.querySelector(".fdy-file-tree-row[data-kind='file']").click(),
    );
    assert.equal(selected.at(-1).diffTurnId, "in_1");
  });
});
