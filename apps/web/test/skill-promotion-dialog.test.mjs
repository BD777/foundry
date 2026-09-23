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
const { SkillPromotionDialog } =
  await import("../src/features/devices/skill-promotion-dialog.tsx");

const dep = (name, strength = "required") => ({
  skillName: name,
  targetRoot: "/skills",
  targetDirName: name,
  status: "resolved",
  strength,
  evidence: "SKILL.md:1: dependency",
});
const skill = (name, dependencies = []) => ({
  deviceId: "device",
  root: "/skills",
  dirName: name,
  name,
  description: "",
  sizeBytes: 1,
  mtimeLabel: "",
  dependencies,
  dependenciesAnalyzed: true,
  sourceDigest: "hash-" + name,
  serverState: "unpublished",
});

test("open and checkbox changes resolve the saved graph with zero fetches", async () => {
  const a = skill("a", [dep("b", "related")]),
    b = skill("b", [dep("c")]),
    c = skill("c");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("No I/O allowed in preview");
  };
  try {
    await act(async () =>
      root.render(
        createElement(SkillPromotionDialog, {
          skill: a,
          online: true,
          skills: [a, b, c],
          onClose: () => {},
          onChanged: async () => {},
        }),
      ),
    );
    assert.match(document.body.textContent, /3 skills to publish/);
    assert.equal(document.body.textContent.includes("Scanning"), false);
    assert.equal(
      document.querySelector('input[type="checkbox"]').checked,
      true,
    );
    await act(async () =>
      document.querySelector('input[type="checkbox"]').click(),
    );
    assert.match(document.body.textContent, /1 skill to publish/);
    assert.equal(
      document.querySelector('input[type="checkbox"]').checked,
      false,
    );
    await act(async () =>
      document.querySelector('input[type="checkbox"]').click(),
    );
    assert.match(document.body.textContent, /3 skills to publish/);
    await act(async () =>
      root.render(
        createElement(SkillPromotionDialog, {
          skill: a,
          skills: [a, b, c],
          online: false,
          onClose: () => {},
          onChanged: async () => {},
        }),
      ),
    );
    assert.match(document.body.textContent, /Device offline/);
    const publish = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Publish 3 skills",
    );
    assert.equal(publish.disabled, true);
    assert.equal(requests, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = original;
  }
});
