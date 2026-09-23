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
const { SkillsFeature } =
  await import("../src/features/skills/skills-feature.tsx");

test("workspace blocks duplicate invocation names before issuing a save", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async () => {
    writes++;
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const catalog = [
    {
      id: "a",
      name: "review",
      description: "",
      originDeviceId: "d",
      originRoot: "/one",
      latestRevision: 1,
    },
    {
      id: "b",
      name: "REVIEW",
      description: "",
      originDeviceId: "d",
      originRoot: "/two",
      latestRevision: 1,
    },
  ];
  try {
    await act(async () =>
      root.render(
        createElement(SkillsFeature, {
          workspaceId: "w",
          catalog,
          bindings: [{ workspaceId: "w", skillId: "a" }],
          devices: [],
        }),
      ),
    );
    const checks = [...document.querySelectorAll('input[type="checkbox"]')];
    await act(async () => checks[1].click());
    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save selection",
    );
    assert.equal(save.disabled, true);
    assert.match(document.body.textContent, /Choose only one/);
    assert.equal(writes, 0);
    await act(async () => checks[0].click());
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(writes, 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = original;
  }
});

test("workspace skill selection auto-enables related dependencies and supports text filtering", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = globalThis.fetch;
  let savedSkillIds = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.body) {
      const parsed = JSON.parse(init.body);
      savedSkillIds = parsed.skillIds;
    }
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const catalog = [
    {
      id: "skill-parent",
      name: "acme-tools",
      description: "Parent tool suite",
      originDeviceId: "d1",
      originRoot: "/skills",
      latestRevision: 1,
      dependencies: [
        {
          skillName: "acme-lint",
          strength: "related",
          evidence: "references/lint.md:1",
        },
      ],
    },
    {
      id: "skill-child",
      name: "acme-lint",
      description: "Lint rule tools",
      originDeviceId: "d1",
      originRoot: "/skills",
      latestRevision: 1,
    },
    {
      id: "skill-other",
      name: "unrelated-skill",
      description: "Something else",
      originDeviceId: "d1",
      originRoot: "/skills",
      latestRevision: 1,
    },
  ];

  try {
    await act(async () =>
      root.render(
        createElement(SkillsFeature, {
          workspaceId: "w1",
          catalog,
          bindings: [],
          devices: [{ id: "d1", label: "darwin-arm64" }],
        }),
      ),
    );

    // Filter by search text
    const searchInput = document.querySelector('input[type="text"]');
    assert.ok(searchInput);
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;

    await act(async () => {
      valueSetter.call(searchInput, "lint");
      searchInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });

    // Should only show acme-lint
    assert.match(document.body.textContent, /1 of 3 match this filter/);

    // Clear search
    await act(async () => {
      valueSetter.call(searchInput, "");
      searchInput.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.match(document.body.textContent, /3 skills available/);

    // Click acme-tools checkbox
    const toolsCheck = document.querySelector(
      'input[aria-label="Select acme-tools"]',
    );
    const lintCheck = document.querySelector(
      'input[aria-label="Select acme-lint"]',
    );
    assert.ok(toolsCheck);
    assert.ok(lintCheck);

    // Initially both unchecked
    assert.equal(toolsCheck.checked, false);
    assert.equal(lintCheck.checked, false);

    // Check parent (acme-tools)
    await act(async () => toolsCheck.click());

    // Both parent and related child (acme-lint) should be checked
    assert.equal(toolsCheck.checked, true);
    assert.equal(lintCheck.checked, true);

    // Auto-enabled notice should appear
    assert.match(
      document.body.textContent,
      /Auto-enabled related skills: acme-lint/,
    );

    // Save selection should persist both
    const saveBtn = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save selection",
    );
    assert.ok(saveBtn);
    assert.equal(saveBtn.disabled, false);
    await act(async () => saveBtn.click());

    assert.deepEqual(savedSkillIds.sort(), ["skill-child", "skill-parent"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    globalThis.fetch = original;
  }
});
