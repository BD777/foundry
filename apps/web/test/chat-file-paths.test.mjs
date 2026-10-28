import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const { workspacePathReference, workspaceRelativePath } =
  await import("../src/components/conversation/file-path-candidate.ts");

const root = "/home/u/ws";

test("paths named inside the workspace link, unverified, with a guessed kind", () => {
  const cases = [
    ["docs/plan.md", "/home/u/ws/docs/plan.md", "file"],
    [
      "./scripts/check-changed.sh",
      "/home/u/ws/scripts/check-changed.sh",
      "file",
    ],
    ["apps/web/", "/home/u/ws/apps/web", "dir"],
    ["docs/", "/home/u/ws/docs", "dir"],
    ["./bin", "/home/u/ws/bin", "dir"],
    ["package.json", "/home/u/ws/package.json", "file"],
    ["deploy/Dockerfile", "/home/u/ws/deploy/Dockerfile", "file"],
    ["/home/u/ws/reports/a.md", "/home/u/ws/reports/a.md", "file"],
    ["/home/u/ws/src/main.go:12", "/home/u/ws/src/main.go", "file"],
    ["src/app.ts#L10-L20", "/home/u/ws/src/app.ts", "file"],
    ["file:///home/u/ws/out/report.html", "/home/u/ws/out/report.html", "file"],
  ];
  for (const [text, path, kind] of cases)
    assert.deepEqual(
      workspacePathReference(text, root),
      { text, path, kind, unverified: true },
      text,
    );
  // A trailing slash on the root changes nothing.
  assert.equal(
    workspacePathReference("docs/plan.md", "/home/u/ws/")?.path,
    "/home/u/ws/docs/plan.md",
  );
});

test("prose, names and places outside the workspace stay text", () => {
  for (const text of [
    "/home/u/.local/share/app/app.key",
    "~/.ssh/id_ed25519",
    "/home/u/ws",
    "/home/u/wsx/a.md",
    "/home/u/ws/../etc/passwd",
    "../other/a.md",
    "a/../../b.md",
    "feat/dev043-053",
    "origin/main",
    "@bd777/foundry-protocol",
    "10.0.0.0/8",
    "192.0.2.10/32",
    "github.com/a/b.md",
    "example.com/",
    "http://192.0.2.10:18083/mcp",
    "net/http.Client",
    "console.log",
    "Node.js",
    "v1.2.3",
    "Bearer <key>",
    "pnpm audit:ui",
    "18083",
    "sess_1793116876771359572",
  ])
    assert.equal(workspacePathReference(text, root), undefined, text);
  assert.equal(workspacePathReference("docs/plan.md", undefined), undefined);
});

test("Windows workspaces compare without case and slash style", () => {
  assert.equal(
    workspacePathReference("C:\\Work\\WS\\src\\a.ts", "c:/work/ws")?.kind,
    "file",
  );
  assert.equal(
    workspacePathReference("D:\\other\\a.ts", "C:\\work"),
    undefined,
  );
});

test("relative paths for the workspace file API", () => {
  assert.equal(
    workspaceRelativePath("/home/u/ws/docs/a.md", root),
    "docs/a.md",
  );
  assert.equal(
    workspaceRelativePath("/home/u/ws/docs/a.md", `${root}/`),
    "docs/a.md",
  );
});

async function render(props, text, inspect) {
  const window = new Window();
  const previous = new Map();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    IntersectionObserver: window.IntersectionObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of ["Node", "Element", "HTMLElement", "Event", "MouseEvent"])
    globals[key] = window[key];
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  }
  let reactRoot;
  try {
    const { MarkdownContent } =
      await import("../src/components/conversation/markdown-content.tsx");
    const container = document.createElement("div");
    document.body.append(container);
    reactRoot = createRoot(container);
    await act(async () =>
      reactRoot.render(createElement(MarkdownContent, props, text)),
    );
    await inspect(container);
  } finally {
    if (reactRoot) await act(async () => reactRoot.unmount());
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    await window.happyDOM.close();
  }
}

test("an answer's workspace paths are buttons; fenced code and outside paths are not", async () => {
  const opened = [];
  const onOpenFileReference = (reference) => opened.push(reference);
  const text = [
    "Read `reports/plan.md`, [the notes](docs/notes.md) and [abs](/home/u/ws/a.md).",
    "The key is in `/home/u/.local/share/app/app.key`; branch `feat/x`.",
    "",
    "```sh",
    "cat reports/plan.md",
    "```",
  ].join("\n");
  await render(
    { fileRoot: root, onOpenFileReference },
    text,
    async (container) => {
      const buttons = [
        ...container.querySelectorAll(".fdy-chat-file-reference"),
      ];
      assert.deepEqual(
        buttons.map((button) => button.textContent),
        ["reports/plan.md", "the notes", "abs"],
      );
      assert.equal(
        buttons[0].getAttribute("title"),
        "Open /home/u/ws/reports/plan.md",
      );
      // Fenced code stays code; outside the workspace stays a code span.
      assert.equal(container.querySelectorAll("pre button").length, 0);
      assert.ok(
        [...container.querySelectorAll("code")].some(
          (code) => code.textContent === "/home/u/.local/share/app/app.key",
        ),
      );
      for (const button of buttons) await act(async () => button.click());
    },
  );
  assert.deepEqual(
    opened.map((reference) => [reference.path, reference.unverified]),
    [
      ["/home/u/ws/reports/plan.md", true],
      ["/home/u/ws/docs/notes.md", true],
      ["/home/u/ws/a.md", true],
    ],
  );

  // Nothing links while the answer streams, or without a workspace folder.
  for (const props of [
    { fileRoot: root, onOpenFileReference, streaming: true },
    { onOpenFileReference },
  ])
    await render(props, "Read `reports/plan.md`.", (container) =>
      assert.equal(
        container.querySelectorAll(".fdy-chat-file-reference").length,
        0,
      ),
    );
});

test("a verified reference wins over the guess for the same text", async () => {
  const verified = {
    text: "reports/plan.md",
    path: "/home/u/ws/reports/plan.md",
    kind: "file",
  };
  const opened = [];
  await render(
    {
      fileReferences: [verified],
      fileRoot: root,
      onOpenFileReference: (reference) => opened.push(reference),
    },
    "Read `reports/plan.md`.",
    async (container) => {
      await act(async () =>
        container.querySelector(".fdy-chat-file-reference").click(),
      );
    },
  );
  assert.deepEqual(opened, [verified]);
});
