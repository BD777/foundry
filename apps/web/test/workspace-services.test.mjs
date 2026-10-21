import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");

const { WorkspaceServices } =
  await import("../src/components/workspace/workspace-services.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const answer = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
async function mounted(workspaceId = "ws_a") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (id, canControl = true) =>
    act(async () =>
      root.render(
        createElement(WorkspaceServices, { workspaceId: id, canControl }),
      ),
    );
  await render(workspaceId);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
test("refresh is busy, then recovers from a failed inventory without leaving an error", async () => {
  globalThis.fetch = async () =>
    answer({ error: "temporary unavailable" }, 503);
  const view = await mounted();
  assert.match(view.container.textContent, /temporary unavailable/);
  const pending = deferred();
  globalThis.fetch = () => pending.promise;
  const refresh = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Refresh",
  );
  await act(async () => refresh.click());
  assert.equal(refresh.disabled, true);
  assert.equal(refresh.getAttribute("aria-busy"), "true");
  await act(async () => pending.resolve(answer([])));
  assert.equal(refresh.disabled, false);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  assert.match(view.container.textContent, /No persistent services/);
  await view.close();
});
test("late inventory replies from an old workspace never replace the new workspace", async () => {
  const pending = deferred();
  globalThis.fetch = (url) =>
    String(url).includes("ws_a")
      ? pending.promise
      : Promise.resolve(answer([]));
  const view = await mounted();
  await view.render("ws_b", false);
  await act(async () =>
    pending.resolve(answer({ error: "stale failure" }, 503)),
  );
  assert.doesNotMatch(view.container.textContent, /stale failure/);
  assert.match(view.container.textContent, /No persistent services/);
  assert.match(view.container.textContent, /Read-only access/);
  assert.equal(view.container.querySelector('[role="alert"]'), null);
  await view.close();
});
test("successful background refresh clears a load failure", async () => {
  const original = globalThis.setInterval;
  let poll;
  globalThis.setInterval = (callback) => {
    poll = callback;
    return 1;
  };
  try {
    globalThis.fetch = async () => answer({ error: "offline inventory" }, 503);
    const view = await mounted();
    assert.match(view.container.textContent, /offline inventory/);
    globalThis.fetch = async () => answer([]);
    await act(async () => poll());
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.match(view.container.textContent, /No persistent services/);
    await view.close();
  } finally {
    globalThis.setInterval = original;
  }
});

test("slow inventories are shared by polling and manual refresh instead of overlapping", async () => {
  const original = globalThis.setInterval;
  let poll;
  globalThis.setInterval = (callback) => {
    poll = callback;
    return 1;
  };
  try {
    const pending = deferred();
    let reads = 0;
    globalThis.fetch = () => {
      reads++;
      return pending.promise;
    };
    const view = await mounted();
    await act(async () => {
      poll();
      poll();
    });
    assert.equal(reads, 1);
    await act(async () => pending.resolve(answer([])));
    assert.match(view.container.textContent, /No persistent services/);
    assert.equal(view.container.querySelector("button").disabled, false);
    await view.close();
  } finally {
    globalThis.setInterval = original;
  }
});
