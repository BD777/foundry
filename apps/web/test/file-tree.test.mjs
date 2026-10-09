import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

/** Renders into a happy-dom document; `body` runs with the container. */
async function withDom(render, body) {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
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
    // React DOM decides at load whether the DOM supports input events.
    const { createRoot } = await import("react-dom/client");
    await import("../src/i18n/index.ts");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(await render()));
    await body(container, root);
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

const rowNames = (container) =>
  [...container.querySelectorAll(".fdy-file-tree-row")].map(
    (row) => row.querySelector(".fdy-file-tree-name")?.textContent,
  );

test("single-child folders collapse and shared folders move to the heading", async () => {
  const { fileTreeNodes, rootPrefix } =
    await import("../src/components/ui/file-tree.tsx");
  const root = {
    id: "workspace",
    label: "Workspace",
    items: [
      { id: "a", path: "src/components/ui/a.tsx" },
      { id: "b", path: "src/components/ui/b.tsx" },
      { id: "x", path: "docs/x.md" },
      { id: "r", path: "README.md" },
    ],
  };
  const nodes = fileTreeNodes(root);
  assert.deepEqual(
    nodes.map((node) => [node.kind, node.name]),
    [
      ["folder", "docs"],
      ["folder", "src/components/ui"],
      ["file", "README.md"],
    ],
  );
  assert.equal(nodes[1].fileCount, 2);
  const outside = {
    id: "outside",
    label: "Outside workspace",
    items: [
      { id: "o", path: "/tmp/fdy-groupscan/products/omh.md" },
      { id: "r", path: "/tmp/fdy-groupscan/products/rev.md" },
    ],
  };
  assert.equal(rootPrefix(outside), "/tmp/fdy-groupscan/products");
  assert.deepEqual(
    fileTreeNodes(outside).map((node) => node.name),
    ["omh.md", "rev.md"],
  );
});

test("a large tree starts closed, filters, switches to a list and moves by keys", async () => {
  const { FileTree } = await import("../src/components/ui/file-tree.tsx");
  const items = Array.from({ length: 30 }, (_, index) => ({
    id: `f${index}`,
    path: `${index % 2 ? "reports" : "notes"}/item-${String(index).padStart(2, "0")}.md`,
  }));
  const selected = [];
  await withDom(
    () =>
      createElement(FileTree, {
        "aria-label": "Files",
        roots: [{ id: "workspace", label: "Workspace", items }],
        onSelect: (item) => selected.push(item.id),
      }),
    async (container) => {
      // Over the limit: folders start closed, and a filter box appears.
      assert.deepEqual(rowNames(container), ["notes", "reports"]);
      const filter = container.querySelector('input[type="search"]');
      assert.ok(filter, "a filter box above 15 files");

      // Right opens the focused folder, Down moves into it.
      const rows = () => [...container.querySelectorAll(".fdy-file-tree-row")];
      await act(async () => rows()[0].focus());
      await act(async () =>
        rows()[0].dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
      );
      assert.equal(rows()[0].getAttribute("aria-expanded"), "true");
      await act(async () =>
        rows()[0].dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        ),
      );
      assert.equal(document.activeElement, rows()[1]);
      assert.equal(rows()[1].getAttribute("tabindex"), "0");
      assert.equal(rows()[0].getAttribute("tabindex"), "-1");
      await act(async () => rows()[1].click());
      assert.deepEqual(selected, ["f0"]);

      // Filtering opens every folder with a match.
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      await act(async () => {
        setValue.call(filter, "item-07");
        filter.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      // One match: its folder moves into the heading.
      assert.deepEqual(rowNames(container), ["item-07.md"]);
      assert.match(
        container.querySelector(".fdy-file-tree-root").textContent,
        /reports/,
      );
      await act(async () => {
        setValue.call(filter, "");
        filter.dispatchEvent(new window.Event("input", { bubbles: true }));
      });

      // The list shows every file flat, with its folder beside it.
      const list = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "List",
      );
      await act(async () => list.click());
      assert.equal(rows().length, 30);
      assert.equal(rows()[0].querySelector("em")?.textContent, "notes");
    },
  );
});

test("a small tree starts open", async () => {
  const { FileTree } = await import("../src/components/ui/file-tree.tsx");
  await withDom(
    () =>
      createElement(FileTree, {
        "aria-label": "Files",
        roots: [
          {
            id: "outside",
            label: "Outside workspace",
            items: [
              {
                id: "a",
                path: "/tmp/out/a/one.md",
                status: "New",
                tone: "created",
              },
              { id: "b", path: "/tmp/out/b/two.md" },
            ],
          },
        ],
        onSelect: () => {},
      }),
    async (container) => {
      assert.equal(container.querySelector('input[type="search"]'), null);
      assert.deepEqual(rowNames(container), ["a", "one.md", "b", "two.md"]);
      assert.match(
        container.querySelector(".fdy-file-tree-root").textContent,
        /Outside workspace\/tmp\/out/,
      );
    },
  );
});

test("only the answer's verified paths become file buttons, and only once it settles", async () => {
  const { MarkdownContent } =
    await import("../src/components/conversation/chat-message-content.tsx");
  const opened = [];
  const text = [
    "Reports are in `/tmp/out/`:",
    "",
    "- `omh.md` and `missing.md`",
    "- [the plan](/w/docs/plan.md) or [the site](https://example.com)",
  ].join("\n");
  const references = [
    { text: "omh.md", path: "/tmp/out/omh.md", kind: "file" },
    { text: "/tmp/out/", path: "/tmp/out", kind: "dir" },
    { text: "/w/docs/plan.md", path: "/w/docs/plan.md", kind: "file" },
  ];
  const render = (streaming) =>
    withDom(
      () =>
        createElement(
          MarkdownContent,
          {
            fileReferences: references,
            onOpenFileReference: (reference) => opened.push(reference.path),
            streaming,
          },
          text,
        ),
      async (container) => {
        const buttons = [
          ...container.querySelectorAll(".fdy-chat-file-reference"),
        ];
        if (streaming) {
          assert.equal(buttons.length, 0);
          return;
        }
        assert.deepEqual(
          buttons.map((button) => button.textContent),
          ["/tmp/out/", "omh.md", "the plan"],
        );
        assert.ok(buttons.every((button) => button.tagName === "BUTTON"));
        // Unverified code stays code; other links still open a new tab.
        assert.ok(
          [...container.querySelectorAll("code")].some(
            (code) => code.textContent === "missing.md",
          ),
        );
        const site = container.querySelector('a[href^="https://example.com"]');
        assert.equal(site?.getAttribute("target"), "_blank");
        await act(async () => buttons[1].click());
        await act(async () => buttons[2].click());
      },
    );
  await render(true);
  await render(false);
  assert.deepEqual(opened, ["/tmp/out/omh.md", "/w/docs/plan.md"]);
});
