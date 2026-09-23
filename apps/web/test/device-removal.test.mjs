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
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
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
const { DeviceRemovalDialog } =
  await import("../src/features/devices/device-removal-dialog.tsx");

const device = {
  id: "dev_remove_me",
  label: "Old Mac",
  status: "connected",
  lastSeenLabel: "online",
};
const workspaces = [
  { id: "ws_1", name: "A", deviceId: "dev_remove_me", localPath: "/a" },
  { id: "ws_2", name: "B", deviceId: "dev_remove_me", localPath: "/b" },
];

async function setup(overrides = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const removed = [];
  const closed = [];
  const props = {
    device,
    workspaces,
    activeWorkspaceId: "ws_somewhere_else",
    onClose: () => closed.push(true),
    onRemoved: async (row) => removed.push(row),
    ...overrides,
  };
  await act(() => root.render(createElement(DeviceRemovalDialog, props)));
  const click = async (text) => {
    const button = [...document.querySelectorAll("button")].find((row) =>
      row.textContent.includes(text),
    );
    assert.ok(button, `button ${text}`);
    await act(() => button.click());
  };
  return {
    container,
    removed,
    closed,
    click,
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

test("removal needs the explicit second click and describes scope accurately", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(JSON.stringify({ ...device, status: "removed" }), {
      status: 200,
    });
  };
  const view = await setup();
  try {
    const text = document.body.textContent;
    assert.match(text, /Remove device from Foundry/);
    assert.match(text, /2 workspaces/);
    // History preservation and local file safety must be stated.
    assert.match(text, /history are kept/);
    assert.match(text, /not been deleted|not deleted/);
    assert.match(text, /sealed keys stay available/);
    await view.click("Cancel");
    assert.equal(calls.length, 0);
    assert.equal(view.closed.length, 1);
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});

test("confirming calls DELETE once and reports removal", async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    return new Response(
      JSON.stringify({ ...device, status: "removed", lastSeenLabel: "x" }),
      { status: 200 },
    );
  };
  const view = await setup();
  try {
    await view.click("Remove device");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "DELETE");
    assert.match(calls[0].url, /\/api\/devices\/dev_remove_me$/);
    assert.equal(view.removed.length, 1);
    assert.equal(view.closed.length, 1);
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});

test("the current working location blocks removal instead of failing", async () => {
  const view = await setup({ activeWorkspaceId: "ws_1" });
  try {
    await act(() => {
      const confirm = [...document.querySelectorAll("button")].find((row) =>
        row.textContent.includes("Remove device"),
      );
      assert.equal(confirm.disabled, true);
    });
    assert.match(
      document.body.textContent,
      /owns your current working location/,
    );
  } finally {
    await view.cleanup();
  }
});

test("a 409 busy response is shown without closing the dialog", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error:
          "device has active work: 2 running or queued task(s) are still on this device",
      }),
      { status: 409 },
    );
  const view = await setup();
  try {
    await view.click("Remove device");
    assert.equal(view.removed.length, 0);
    assert.equal(view.closed.length, 0);
    assert.match(
      document.querySelector('[role="alert"]').textContent,
      /2 running/,
    );
  } finally {
    globalThis.fetch = original;
    await view.cleanup();
  }
});
