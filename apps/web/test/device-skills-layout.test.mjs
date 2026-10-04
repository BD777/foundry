import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value:
      key === "window" || key === "document" || key === "navigator"
        ? window[key]
        : window[key],
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

const { createRoot } = await import("react-dom/client");
const { DeviceSkills } =
  await import("../src/features/devices/device-skills.tsx");

test("device skills list comes first; scan folders are edited in a dialog", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const device = { id: "dev", label: "Mac", status: "connected" };
  const roots = [{ path: "~/.claude/skills", isDefault: true }];
  try {
    await act(async () =>
      root.render(
        createElement(DeviceSkills, {
          device,
          roots,
          skills: [],
          onChanged: async () => {},
        }),
      ),
    );
    // No folder editor on the page itself.
    assert.equal(
      container.querySelector('input[aria-label="Add skill directory"]'),
      null,
    );
    const heading = container.querySelector(".fdy-skill-catalog-heading");
    const open = [...heading.querySelectorAll("button")].find((b) =>
      b.textContent.startsWith("Scan folders"),
    );
    assert.match(open.textContent, /Scan folders \(1\)/);
    assert.ok(
      [...heading.querySelectorAll("button")].some(
        (b) => b.textContent === "Scan now",
      ),
      "Scan now is in the heading",
    );
    await act(async () => open.click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog, "the folders dialog opens");
    assert.match(dialog.textContent, /~\/\.claude\/skills/);
    assert.ok(dialog.querySelector('input[aria-label="Add skill directory"]'));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
