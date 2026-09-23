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

const { WorkspaceOverview } =
  await import("../src/features/workspaces/index.ts");

globalThis.fetch = async () =>
  new Response(JSON.stringify({ repositories: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

async function renderOverview(accessRole) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(WorkspaceOverview, {
        workspace: {
          id: "ws_1",
          name: "Shared",
          localPath: "/w",
          baseline: "main",
          contextSummary: "",
          acceptedCount: 0,
          resolvedCount: 0,
          accessRole,
        },
        deviceOnline: true,
        acceptedCount: 0,
      }),
    ),
  );
  const button = (label) =>
    [...container.querySelectorAll("button")].find((item) =>
      item.textContent.includes(label),
    );
  return {
    container,
    button,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a viewer may refresh status but not rescan, and sees why", async () => {
  const view = await renderOverview("viewer");
  assert.equal(view.button("Rescan repositories").disabled, true);
  assert.equal(view.button("Refresh status").disabled, false);
  assert.match(
    view.container.textContent,
    /You are a Viewer in this workspace; this needs Member or higher\./,
  );
  await view.cleanup();
});

test("a member may rescan", async () => {
  const view = await renderOverview("member");
  assert.equal(view.button("Rescan repositories").disabled, false);
  assert.doesNotMatch(view.container.textContent, /needs Member/);
  await view.cleanup();
});
