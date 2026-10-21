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
await import("../src/i18n/index.ts");

const { DeviceList } = await import("../src/features/devices/device-list.tsx");
const { AccountShareExplanation } =
  await import("../src/features/devices/device-account-share.tsx");
const { Popover } = await import("../src/components/ui/popover.tsx");
const { Button } = await import("../src/components/ui/button.tsx");
const devices = [
  {
    id: "device-a",
    label: "Same name",
    status: "connected",
    owned: true,
    sharesSystemAccountWith: [
      {
        deviceId: "shared-a",
        ownerName: "Ann",
        noticePending: true,
        acceptedAt: "2026-10-20T00:00:00Z",
        acceptedBy: "Ann",
      },
    ],
  },
  {
    id: "device-b",
    label: "Same name",
    status: "disconnected",
    owned: true,
    sharesSystemAccountWith: [
      { deviceId: "shared-b", ownerName: "Bo", noticePending: true },
    ],
  },
  { id: "device-c", label: "Alone", status: "connected", owned: true },
];
let requests = [];
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
async function mount(component, props) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() => root.render(createElement(component, props)));
  await settle();
  return {
    container,
    root,
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
      await settle();
    },
  };
}
test.beforeEach(() => {
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    return new Response(null, { status: 204 });
  };
});

test("sharing lives on the exact card and never navigates or writes on focus; Escape restores focus", async () => {
  const selected = [];
  const view = await mount(DeviceList, {
    devices,
    workspaceCount: () => 0,
    triggers: new Map(),
    onOpen: (id) => selected.push(id),
    onRename: () => {},
    onRemove: () => {},
    onRefresh: async () => {},
  });
  try {
    const icons = [
      ...view.container.querySelectorAll(
        '[aria-label^="Unread shared account notice"]',
      ),
    ];
    assert.equal(icons.length, 2);
    assert.equal(view.container.querySelectorAll("button button").length, 0);
    assert.equal(view.container.querySelectorAll('[role="alert"]').length, 0);
    await act(() => icons[0].focus());
    await settle();
    assert.equal(document.activeElement, icons[0]);
    assert.equal(requests.length, 0);
    assert.match(document.querySelector('[role="dialog"]').textContent, /Ann/);
    assert.doesNotMatch(
      document.querySelector('[role="dialog"]').textContent,
      /Bo uses/,
    );
    await act(() => icons[0].click());
    await settle();
    assert.deepEqual(selected, []);
    await act(() =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    await settle();
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, icons[0]);
    await act(() => icons[1].click());
    await settle();
    assert.match(document.querySelector('[role="dialog"]').textContent, /Bo/);
    assert.equal(requests.length, 0);
  } finally {
    await view.cleanup();
  }
});

test("Got it is explicit, device scoped, busy, and keeps the sharing entry after acknowledgment", async () => {
  let complete;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    return await new Promise((resolve) => {
      complete = () => resolve(new Response(null, { status: 204 }));
    });
  };
  const view = await mount(DeviceList, {
    devices,
    workspaceCount: () => 0,
    triggers: new Map(),
    onOpen: () => {},
    onRename: () => {},
    onRemove: () => {},
    onRefresh: async () => {},
  });
  try {
    const icon = view.container.querySelector(
      '[aria-label^="Unread shared account notice"]',
    );
    await act(() => icon.click());
    await settle();
    const got = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Got it",
    );
    await act(async () => got.click());
    assert.equal(got.disabled, true);
    assert.equal(got.getAttribute("aria-busy"), "true");
    assert.equal(requests.length, 1);
    assert.match(
      requests[0].url,
      /devices\/device-a\/system-account-notice\/dismiss/,
    );
    await act(async () => complete());
    await settle();
    assert.ok(
      view.container.querySelector(
        '[aria-label="Shared computer account on Same name"]',
      ),
    );
    assert.match(
      document.querySelector('[role="dialog"]').textContent,
      /same files and the same Claude\/Codex sign-ins/,
    );
    assert.match(
      document.querySelector('[role="dialog"]').textContent,
      /Notice read/,
    );
  } finally {
    await view.cleanup();
  }
});

test("failed acknowledgment stays actionable; reading details does not invent acceptance provenance", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "synthetic failure" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  const device = {
    ...devices[0],
    sharesSystemAccountWith: [
      {
        deviceId: "a",
        ownerName: "Ann",
        noticePending: true,
        acceptedAt: "2026-10-20T00:00:00Z",
      },
    ],
  };
  const view = await mount(AccountShareExplanation, {
    device,
    onRefresh: async () => {},
  });
  try {
    assert.doesNotMatch(view.container.textContent, /chosen by Ann/);
    assert.match(view.container.textContent, /Sharing was accepted on/);
    const got = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Got it",
    );
    await act(async () => got.click());
    await settle();
    assert.equal(got.disabled, false);
    assert.match(view.container.textContent, /Could not save that you read/);
    assert.match(view.container.textContent, /synthetic failure/);
  } finally {
    await view.cleanup();
  }
});

test("acknowledgment success followed by refresh failure retries only the refresh", async () => {
  let refreshes = 0;
  const view = await mount(AccountShareExplanation, {
    device: devices[0],
    onRefresh: async () => {
      refreshes++;
      if (refreshes === 1) throw Error("refresh unavailable");
    },
  });
  try {
    const got = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Got it",
    );
    await act(async () => got.click());
    await settle();
    assert.match(
      view.container.textContent,
      /notice was read, but the device could not be refreshed/,
    );
    const refresh = [...view.container.querySelectorAll("button")].find(
      (b) => b.textContent === "Refresh status",
    );
    assert.ok(refresh);
    await act(async () => refresh.click());
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(refreshes, 2);
    assert.doesNotMatch(view.container.textContent, /refresh unavailable/);
  } finally {
    await view.cleanup();
  }
});

test("a default popover retains click-only behavior", async () => {
  const view = await mount(Popover, {
    label: "Default",
    trigger: createElement(Button, null, "Default trigger"),
    children: "Normal details",
  });
  try {
    const b = view.container.querySelector("button");
    await act(() => b.focus());
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(() => b.click());
    await settle();
    assert.match(
      document.querySelector('[role="dialog"]').textContent,
      /Normal details/,
    );
  } finally {
    await view.cleanup();
  }
});
