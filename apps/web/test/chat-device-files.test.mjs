import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const { devicePathReference } =
  await import("../src/components/conversation/file-path-candidate.ts");

test("files outside the workspace, absolute or in the home folder, link for the owner", () => {
  for (const [text, path] of [
    ["/home/u/.local/share/app/app.key", "/home/u/.local/share/app/app.key"],
    ["~/.local/share/app/app.key", "~/.local/share/app/app.key"],
    ["~/.zshrc", "~/.zshrc"],
    ["/srv/app/.env", "/srv/app/.env"],
    ["/opt/build/Dockerfile", "/opt/build/Dockerfile"],
    ["/var/log/app.log:12", "/var/log/app.log"],
  ])
    assert.deepEqual(
      devicePathReference(text),
      { text, path, kind: "file", unverified: true, device: true },
      text,
    );
  for (const text of [
    "~/",
    "~",
    "~/notes/",
    "/var/log/",
    "/usr/bin",
    "../x.md",
    "notes/x.md",
    "/a/../etc/passwd",
    "http://10.0.0.1:8080/mcp",
    "sess_1793116876771359572",
  ])
    assert.equal(devicePathReference(text), undefined, text);
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

test("only the device's owner gets links outside the workspace", async () => {
  const text =
    "Key in `~/.local/share/app/app.key`, report `/home/u/ws/docs/a.md`.";
  const opened = [];
  const onOpenFileReference = (reference) => opened.push(reference);
  await render(
    { deviceFiles: true, fileRoot: "/home/u/ws", onOpenFileReference },
    text,
    async (container) => {
      const buttons = [
        ...container.querySelectorAll(".fdy-chat-file-reference"),
      ];
      assert.deepEqual(
        buttons.map((button) => button.textContent),
        ["~/.local/share/app/app.key"],
      );
      assert.match(buttons[0].getAttribute("title"), /on this device/);
      for (const button of buttons) await act(async () => button.click());
    },
  );
  // The workspace path links only once verified; the other is the device's.
  assert.deepEqual(
    opened.map((reference) => [reference.path, Boolean(reference.device)]),
    [["~/.local/share/app/app.key", true]],
  );
  // Not the owner (or switched off): the key stays code.
  await render(
    { fileRoot: "/home/u/ws", onOpenFileReference },
    text,
    (container) =>
      assert.deepEqual(
        [...container.querySelectorAll(".fdy-chat-file-reference")].map(
          (button) => button.textContent,
        ),
        [],
      ),
  );
});
