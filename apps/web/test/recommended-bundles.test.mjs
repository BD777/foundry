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

await import("../src/i18n/index.ts");
const { createRoot } = await import("react-dom/client");
const { RecommendedBundles, repositoryHref } =
  await import("../src/features/skill-library/recommended-bundles.tsx");

test("npm repositories link to their npmjs.com page", () => {
  assert.equal(
    repositoryHref("npm:@playwright/cli"),
    "https://www.npmjs.com/package/@playwright/cli",
  );
  assert.equal(
    repositoryHref("https://github.com/acme/tools"),
    "https://github.com/acme/tools",
  );
});

test("Recommended offers bundles not yet followed and adds them with their CLI", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const original = globalThis.fetch;
  const posts = [];
  let refreshed = 0;
  let answer;
  globalThis.fetch = async (url, init) => {
    posts.push({
      path: new URL(String(url), "http://x").pathname,
      body: JSON.parse(init.body),
    });
    return answer.clone();
  };
  const render = (repositories) =>
    act(async () =>
      root.render(
        createElement(RecommendedBundles, {
          repositories,
          disabled: false,
          onChanged: async () => {
            refreshed += 1;
          },
        }),
      ),
    );
  try {
    await render([]);
    const text = container.textContent;
    assert.match(text, /Recommended/);
    assert.match(text, /agent-browser.*by Vercel/);
    assert.match(text, /playwright-cli.*by Microsoft/);
    assert.match(text, /npm package @playwright\/cli/);
    assert.match(text, /browser-use.*by Browser Use/);
    assert.match(
      text,
      /skill from GitHub browser-use\/browser-use · CLI browser-use from PyPI, installed with uv/,
    );
    const addButton = (name) =>
      container.querySelector(`button[aria-label="Add ${name} as a bundle"]`);

    answer = new Response(JSON.stringify({ error: "npm answered 503" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    await act(async () => addButton("agent-browser").click());
    assert.deepEqual(posts[0], {
      path: "/api/skill-repositories",
      body: {
        url: "npm:agent-browser",
        ref: "",
        subpath: "skills",
        mode: "bundle",
        name: "agent-browser",
      },
    });
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /npm answered 503/,
    );
    assert.equal(refreshed, 0);

    answer = new Response("{}", {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
    await act(async () => addButton("agent-browser").click());
    assert.equal(refreshed, 1);
    assert.equal(container.querySelector('[role="alert"]'), null);

    // browser-use takes its skill from its repository and declares its
    // CLI, a Python package installed with uv.
    await act(async () => addButton("browser-use").click());
    assert.deepEqual(posts.at(-1), {
      path: "/api/skill-repositories",
      body: {
        url: "https://github.com/browser-use/browser-use",
        ref: "",
        subpath: "skills/browser-use",
        mode: "bundle",
        name: "browser-use",
        tools: [
          { source: "uv", package: "browser-use", command: "browser-use" },
        ],
      },
    });
    assert.equal(refreshed, 2);

    // Once followed, an entry leaves the list; with all followed it hides.
    await render([{ id: "r1", url: "npm:agent-browser", skills: [] }]);
    assert.equal(addButton("agent-browser"), null);
    assert.ok(addButton("playwright-cli"));
    await render([
      { id: "r1", url: "npm:agent-browser", skills: [] },
      { id: "r2", url: "npm:@playwright/cli", skills: [] },
      {
        id: "r3",
        url: "https://github.com/browser-use/browser-use",
        skills: [],
      },
    ]);
    assert.equal(container.textContent, "");
  } finally {
    globalThis.fetch = original;
    await act(async () => root.unmount());
    container.remove();
  }
});
