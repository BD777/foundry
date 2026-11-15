import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLIFrameElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
await import("../src/i18n/index.ts");
const { TextFileView, splitFrontMatter, frontMatterFields } =
  await import("../src/components/workspace/workspace-file-view.tsx");

test("front matter is split from the start of a Markdown file only", () => {
  assert.deepEqual(splitFrontMatter("---\nname: a\n---\n# Body\n"), {
    frontMatter: "name: a",
    body: "# Body\n",
  });
  assert.deepEqual(splitFrontMatter("---\r\nname: a\r\n---"), {
    frontMatter: "name: a",
    body: "",
  });
  assert.deepEqual(splitFrontMatter("# Title\n\n---\nname: a\n---\n"), {
    body: "# Title\n\n---\nname: a\n---\n",
  });
  assert.deepEqual(splitFrontMatter("---\nno closing line\n"), {
    body: "---\nno closing line\n",
  });
});

test("flat front matter becomes fields; anything else stays as written", () => {
  assert.deepEqual(
    frontMatterFields(
      "name: assistant-handoff\ndescription: \"Use when \\\"x\\\" happens: ok\"\nnote: 'it''s'\nfolded: >\n  two\n  lines\nversion: 2",
    ),
    [
      ["name", "assistant-handoff"],
      ["description", 'Use when "x" happens: ok'],
      ["note", "it's"],
      ["folded", "two lines\n"],
      ["version", "2"],
    ],
  );
  assert.equal(frontMatterFields("tags:\n  - a\n  - b"), undefined);
  assert.equal(frontMatterFields("meta:\n  a: 1"), undefined);
  assert.equal(frontMatterFields('broken: "unterminated'), undefined);
  assert.equal(frontMatterFields("just text"), undefined);
});

test("a SKILL.md shows its front matter as fields above the body", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(TextFileView, {
        content:
          "---\nname: assistant-handoff\ndescription: Use before handing work off.\n---\n\n# Handing work off\n\nBody text.\n",
        path: ".agents/skills/assistant-handoff/SKILL.md",
      }),
    ),
  );
  const fields = container.querySelector("dl");
  assert.ok(fields, "front matter fields");
  assert.deepEqual(
    [...fields.querySelectorAll("dt")].map((node) => node.textContent),
    ["name", "description"],
  );
  assert.equal(
    fields.querySelectorAll("dd")[1].textContent,
    "Use before handing work off.",
  );
  assert.equal(container.querySelector("hr"), null);
  assert.ok(!container.textContent.includes("name: assistant-handoff"));
  assert.match(
    container.querySelector("h1")?.textContent ?? "",
    /Handing work off/,
  );

  await act(async () =>
    root.render(
      createElement(TextFileView, {
        content: "---\ntags:\n  - a\n---\nBody\n",
        path: "notes.md",
      }),
    ),
  );
  assert.equal(container.querySelector("dl"), null);
  assert.equal(
    container.querySelector("pre code")?.textContent,
    "tags:\n  - a",
  );
  await act(async () => root.unmount());
  container.remove();
});
