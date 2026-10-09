import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

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
const { SkillLibraryFeature } =
  await import("../src/features/skill-library/skill-library-feature.tsx");

const skill = (id, name, usedByWorkspaces) => ({
  id,
  name,
  description: "",
  originDeviceId: "d",
  originDeviceLabel: "Laptop",
  originRoot: "/skills",
  originDirName: name,
  latestRevision: 1,
  createdLabel: "",
  updatedLabel: "",
  usedByWorkspaces,
});

test("the library saves the checked skills as the person's defaults", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = globalThis.fetch;
  const writes = [];
  globalThis.fetch = async (url, init) => {
    const method = init?.method ?? "GET";
    if (String(url).includes("/api/skill-repositories"))
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    let skillIds = ["a"];
    if (method !== "GET") {
      writes.push({ url: String(url), method, body: JSON.parse(init.body) });
      skillIds = writes.at(-1).body.skillIds;
    }
    return new Response(JSON.stringify({ skillIds }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await act(async () =>
      root.render(
        createElement(SkillLibraryFeature, {
          catalog: [skill("a", "review", ["web"]), skill("b", "notes", [])],
          devices: [],
          canManage: false,
          onChanged: async () => {},
        }),
      ),
    );
    const checks = [...document.querySelectorAll('input[type="checkbox"]')];
    const byName = (name) =>
      checks.find((check) => check.getAttribute("aria-label")?.includes(name));
    assert.equal(byName("review").checked, true, "saved default is checked");
    assert.equal(byName("notes").checked, false);
    assert.match(document.body.textContent, /Used in 1 workspace/);
    assert.match(document.body.textContent, /An admin can add one/);
    assert.equal(
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent === "Add repository",
      ),
      false,
      "members cannot add repositories",
    );
    const save = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Save defaults",
    );
    assert.equal(save.disabled, true, "nothing to save yet");
    await act(async () => byName("notes").click());
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PUT");
    assert.match(writes[0].url, /\/api\/me\/default-skills$/);
    assert.deepEqual([...writes[0].body.skillIds].sort(), ["a", "b"]);
    assert.equal(save.disabled, true, "saved");
  } finally {
    globalThis.fetch = original;
    await act(async () => root.unmount());
    container.remove();
  }
});
