import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { toastShown } from "./toast-wait.mjs";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({ url: "https://foundry.test/chats" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLAnchorElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "NodeFilter",
  "Blob",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: window[key],
  });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

const { i18n } = await import("../src/i18n/index.ts");
const { ToastProvider } = await import("../src/components/ui/toast.tsx");
const { ChatMessageRow } =
  await import("../src/components/conversation/chat-message-list.tsx");
const { AnswerPreviewDialog } =
  await import("../src/components/conversation/answer-preview.tsx");

await i18n.changeLanguage("en");

class FakeClipboardItem {
  static created = [];
  constructor(items) {
    this.items = items;
    FakeClipboardItem.created.push(this);
  }
}
globalThis.ClipboardItem = FakeClipboardItem;

function setClipboard({ write, writeText = async () => {} }) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write, writeText },
  });
}

async function render(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(ToastProvider, null, element)),
  );
  return {
    container,
    async close() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  assert.ok(check());
}

const answer = `# Result

This sentence proves the whole answer is present.

| Check | Result |
| --- | --- |
| tsc | PASS |

\`\`\`ts
const answer = 42;
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``;

const message = {
  id: "answer",
  at: "2026-11-10T12:00:00Z",
  kind: "message",
  role: "bot",
  text: answer,
  copyText: answer,
};

test("Preview opens the answer dialog; Escape, overlay and modal copy work", async () => {
  const copied = [];
  setClipboard({
    writeText: async (text) => copied.push(text),
    write: async () => {},
  });
  const view = await render(createElement(ChatMessageRow, { message }));
  try {
    const preview = view.container.querySelector(
      'button[aria-label="Preview answer"]',
    );
    assert.ok(preview, "the answer row has a Preview control");
    await act(async () => preview.click());

    let dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "Preview opens the answer dialog");
    assert.match(dialog.textContent, /whole answer is present/);
    assert.ok(dialog.querySelector("table"));
    assert.match(dialog.querySelector("pre")?.textContent ?? "", /answer = 42/);

    await act(async () =>
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.equal(document.querySelector('[role="dialog"]'), null);

    await act(async () => preview.click());
    dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the answer dialog reopens");
    const overlay = dialog.previousElementSibling;
    await act(async () => {
      overlay.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
      );
      overlay.dispatchEvent(
        new MouseEvent("click", { bubbles: true, button: 0 }),
      );
    });
    assert.equal(document.querySelector('[role="dialog"]'), null);

    await act(async () => preview.click());
    dialog = document.querySelector('[role="dialog"]');
    const copy = dialog.querySelector(
      'button[aria-label="Copy answer as Markdown"]',
    );
    assert.ok(copy);
    await act(async () => copy.click());
    await until(() => copied.length === 1);
    assert.deepEqual(copied, [answer]);
  } finally {
    await view.close();
  }
});

test("Copy as image renders the full export and writes a PNG ClipboardItem", async () => {
  const writes = [];
  setClipboard({
    write: async (items) => writes.push(items),
    writeText: async () => {},
  });
  FakeClipboardItem.created = [];
  let exported;
  let finishRender;
  const view = await render(
    createElement(AnswerPreviewDialog, {
      markdown: answer.replace(/\n```mermaid[\s\S]*$/, ""),
      onClose: () => {},
      renderImage: async (node, backgroundColor) => {
        exported = { node, backgroundColor };
        await new Promise((resolve) => {
          finishRender = resolve;
        });
        return new Blob(["png"], { type: "image/png" });
      },
    }),
  );
  try {
    const copy = document.querySelector(
      'button[aria-label="Copy answer as image"]',
    );
    assert.ok(copy);
    await act(async () => copy.click());
    await until(() => exported);
    assert.equal(copy.getAttribute("aria-busy"), "true");
    await act(async () => finishRender());
    await until(() => writes.length === 1);

    assert.ok(exported.node.matches("[data-answer-preview-export]"));
    assert.match(exported.node.textContent, /whole answer is present/);
    assert.equal(typeof exported.backgroundColor, "string");
    assert.equal(writes[0][0] instanceof FakeClipboardItem, true);
    assert.equal(writes[0][0].items["image/png"].type, "image/png");
    await toastShown(act, '.fdy-toast[data-tone="success"]');
  } finally {
    await view.close();
  }
});

test("a refused image clipboard write downloads the same PNG", async () => {
  setClipboard({
    write: async () => {
      throw new Error("clipboard refused");
    },
    writeText: async () => {},
  });
  const downloads = [];
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  const click = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:answer";
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };
  const view = await render(
    createElement(AnswerPreviewDialog, {
      markdown: answer.replace(/\n```mermaid[\s\S]*$/, ""),
      onClose: () => {},
      renderImage: async () => new Blob(["png"], { type: "image/png" }),
    }),
  );
  try {
    const copy = document.querySelector(
      'button[aria-label="Copy answer as image"]',
    );
    assert.ok(copy);
    await act(async () => copy.click());
    await until(() => downloads.length === 1);
    assert.deepEqual(downloads, ["answer.png"]);
    await toastShown(act, '.fdy-toast[data-tone="warning"]');
  } finally {
    await view.close();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    HTMLAnchorElement.prototype.click = click;
  }
});

test("an image render failure keeps the dialog and shows an error toast", async () => {
  setClipboard({
    write: async () => {},
    writeText: async () => {},
  });
  const view = await render(
    createElement(AnswerPreviewDialog, {
      markdown: "A short answer.",
      onClose: () => {},
      renderImage: async () => {
        throw new Error("render failed");
      },
    }),
  );
  try {
    const copy = document.querySelector(
      'button[aria-label="Copy answer as image"]',
    );
    assert.ok(copy);
    await act(async () => copy.click());
    await toastShown(act, '.fdy-toast[data-tone="error"]');
    assert.match(
      document.querySelector('.fdy-toast[data-tone="error"]').textContent,
      /Could not create the answer image/,
    );
    assert.ok(document.querySelector('[role="dialog"]'));
    assert.equal(copy.getAttribute("aria-busy"), null);
  } finally {
    await view.close();
  }
});
