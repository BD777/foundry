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

const { WorkspaceServiceTunnels } =
  await import("../src/components/workspace/workspace-service-tunnels.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const answer = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const item = {
  id: "mapped",
  workspaceId: "source",
  targetWorkspaceId: "remote",
  deviceId: "remote-device",
  deviceLabel: "Actual remote device",
  targetWorkspaceName: "Execution workspace",
  ownerUserId: "owner",
  name: "Existing application",
  port: 18082,
  protocol: "http",
  visibility: "private",
  enabled: true,
  revision: 4,
  createdAt: "",
  updatedAt: "",
  status: "ready",
  url: "https://app.preview.example",
  canManage: true,
};
const inventory = (items = [item]) => ({
  items,
  targets: [],
  canManage: false,
  configured: true,
});
async function mount(id = "source") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (workspaceId) =>
    act(async () =>
      root.render(
        createElement(WorkspaceServiceTunnels, { workspaceId, services: [] }),
      ),
    );
  await render(id);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
test("malformed endpoint inventory fails visibly without granting controls", async () => {
  globalThis.fetch = async () => answer([]);
  const view = await mount();
  assert.match(view.container.textContent, /Invalid service mapping inventory/);
  assert.equal(view.container.querySelector("button"), null);
  await view.close();
});
test("read-only endpoint status names the actual device and old worker cannot open", async () => {
  globalThis.fetch = async () =>
    answer(
      inventory([
        { ...item, status: "worker_update_required", canManage: false },
      ]),
    );
  const view = await mount();
  assert.match(view.container.textContent, /Actual remote device/);
  assert.match(view.container.textContent, /Execution workspace/);
  assert.match(view.container.textContent, /Update the executing device/);
  const buttons = [...view.container.querySelectorAll("button")];
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].disabled, true);
  assert.equal(view.container.querySelector('input[type="checkbox"]'), null);
  await view.close();
});
test("closing access changes only the mapping and carries its revision", async () => {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") {
      writes.push({ url, body: JSON.parse(options.body) });
      return answer({ ...item, enabled: false, revision: 5 });
    }
    return answer(inventory());
  };
  const view = await mount();
  const close = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Close access",
  );
  await act(async () => close.click());
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/service-tunnels\/mapped$/);
  assert.equal(writes[0].body.enabled, false);
  assert.equal(writes[0].body.expectedRevision, 4);
  assert.equal(writes[0].body.targetWorkspaceId, "remote");
  await view.close();
});
test("slow polling is coalesced and previous workspace replies cannot disclose its endpoints", async () => {
  const original = globalThis.setInterval;
  let poll;
  globalThis.setInterval = (callback) => ((poll = callback), 1);
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  let reads = 0;
  try {
    globalThis.fetch = (url) => {
      if (String(url).includes("/source/")) {
        reads++;
        return pending;
      }
      return Promise.resolve(answer(inventory([])));
    };
    const view = await mount();
    await act(async () => {
      poll();
      poll();
    });
    assert.equal(reads, 1);
    await view.render("next");
    await act(async () => resolve(answer(inventory())));
    assert.doesNotMatch(view.container.textContent, /Existing application/);
    assert.match(view.container.textContent, /No web services registered/);
    await view.close();
  } finally {
    globalThis.setInterval = original;
  }
});
