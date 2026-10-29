import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const { devicePathReference, workspaceRelativePath } =
  await import("../src/components/conversation/file-path-candidate.ts");

const root = "/home/u/ws";

test("a device path inside the workspace is never guessed (DEV-081)", () => {
  assert.equal(devicePathReference("/home/u/ws/docs/a.md", root), undefined);
  assert.equal(devicePathReference("/home/u/ws", root), undefined);
  assert.equal(
    devicePathReference("/home/u/wsx/a.md", root)?.path,
    "/home/u/wsx/a.md",
  );
  assert.equal(
    devicePathReference("~/.local/share/app/app.key", root)?.device,
    true,
  );
  // Windows workspaces compare without case and slash style.
  assert.equal(
    devicePathReference("c:/WORK/ws/src/a.ts", "C:\\Work\\WS"),
    undefined,
  );
  assert.equal(
    devicePathReference("D:\\other\\a.ts", "C:\\work")?.path,
    "D:\\other\\a.ts",
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

test("only paths the device verified link; a guess stays copyable text (DEV-081)", async () => {
  // The live case: the folder the list sits in exists, its entries are named
  // bare. The device resolved them against that folder; one name is not there.
  const debate = `${root}/市直赛辩论_读万卷书VS行万里路`;
  const references = [
    { text: "市直赛辩论_读万卷书VS行万里路/", path: debate, kind: "dir" },
    {
      text: "00_备赛总览（先看这个）.docx",
      path: `${debate}/00_备赛总览（先看这个）.docx`,
      kind: "file",
    },
    { text: "正方_读万卷书/", path: `${debate}/正方_读万卷书`, kind: "dir" },
  ];
  const text = [
    "放在新建的子文件夹 `市直赛辩论_读万卷书VS行万里路/` 里。",
    "",
    "**文件夹结构**",
    "",
    "- `00_备赛总览（先看这个）.docx`",
    "- `正方_读万卷书/`",
    "- `不存在的文件夹/`、`reports/plan.md` 和 [notes](docs/notes.md)",
    "",
    "```sh",
    "ls 正方_读万卷书/",
    "```",
  ].join("\n");
  const opened = [];
  await render(
    {
      fileReferences: references,
      fileRoot: root,
      onOpenFileReference: (reference) => opened.push(reference),
    },
    text,
    async (container) => {
      const buttons = [
        ...container.querySelectorAll(".fdy-chat-file-reference"),
      ];
      assert.deepEqual(
        buttons.map((button) => button.textContent),
        references.map((reference) => reference.text),
      );
      // Unverified names stay code (or link text), selectable and copyable.
      const codes = [...container.querySelectorAll("code")].map(
        (code) => code.textContent,
      );
      for (const name of ["不存在的文件夹/", "reports/plan.md"])
        assert.ok(codes.includes(name), name);
      assert.equal(container.querySelectorAll("pre button").length, 0);
      for (const button of buttons) await act(async () => button.click());
    },
  );
  assert.deepEqual(
    opened.map((reference) => reference.path),
    references.map((reference) => reference.path),
  );

  // Nothing links while the answer streams.
  await render(
    {
      fileReferences: references,
      fileRoot: root,
      onOpenFileReference: () => {},
      streaming: true,
    },
    text,
    (container) =>
      assert.equal(
        container.querySelectorAll(".fdy-chat-file-reference").length,
        0,
      ),
  );
});
