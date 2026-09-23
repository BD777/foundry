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
Object.assign(globalThis, {
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const originalFetch = globalThis.fetch;
const { createRoot } = await import("react-dom/client");
const { DevicesFeature } = await import("../src/features/devices/index.ts");

const device = {
  id: "d1",
  label: "Studio",
  status: "connected",
  owned: true,
  lastSeenLabel: "just now",
};
const profiles = [
  {
    authMode: "custom",
    baseUrl: "https://relay.test/v1",
    connectionType: "openai_compatible",
    hasCredential: true,
    id: "p1",
    label: "Relay",
    model: "gpt-5",
    runtime: "codex",
  },
  {
    authMode: "custom",
    baseUrl: "http://gateway.internal/v1",
    connectionType: "openai_compatible",
    hasCredential: false,
    id: "p2",
    label: "LLM Gateway",
    model: "flux/gpt-6",
    runtime: "codex",
  },
];

function buttonWith(text) {
  return [...window.document.querySelectorAll("button")].find((button) =>
    button.textContent.includes(text),
  );
}

async function setup({ refreshImpl, putImpl } = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const refreshes = [];
  const props = {
    activeWorkspaceId: "w1",
    agentProfiles: [],
    deviceProfiles: [
      { deviceId: "d1", enabled: true, profileId: "p1" },
      { deviceId: "d1", enabled: true, profileId: "legacy-official" },
    ],
    devices: [device],
    onManageConnections() {},
    onOpenWorkspace: async () => true,
    onRefresh: async () => {
      refreshes.push(1);
      if (refreshImpl) await refreshImpl(refreshes.length);
    },
    onSelect() {},
    profiles,
    providerHealth: [],
    section: "agents",
    selectedDeviceId: "d1",
    workspaces: [{ id: "w1", name: "W", deviceId: "d1", localPath: "/w" }],
  };
  await act(async () => root.render(createElement(DevicesFeature, props)));
  // Switch to the Server API connections tab.
  await act(async () => buttonWith("Server API connections").click());
  return {
    container,
    props,
    refreshes,
    render: async (patch = {}) =>
      act(async () =>
        root.render(createElement(DevicesFeature, { ...props, ...patch })),
      ),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
    putImpl,
  };
}

function intercept(impl) {
  globalThis.fetch = async (url, options) => {
    if (
      options.method === "PUT" &&
      String(url).endsWith("/api/devices/d1/profiles")
    )
      return impl(JSON.parse(options.body), String(url));
    return new Response(JSON.stringify([]), { status: 200 });
  };
}

const pickerRows = () => [
  ...window.document.querySelectorAll(".fdy-connection-assign-row"),
];
const dialogSave = () =>
  [...window.document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === "Save",
  );
const rowFor = (label) =>
  pickerRows().find((element) => element.textContent.includes(label));
async function openPickerAndToggleGateway() {
  await act(async () => buttonWith("Add connection").click());
  await act(async () => rowFor("LLM Gateway").querySelector("input").click());
}

test("Add connection preselects assigned connections and saves once on Save", async () => {
  const writes = [];
  intercept((body, url) => {
    writes.push({ url, body });
    return new Response(JSON.stringify([]), { status: 200 });
  });
  const view = await setup();
  try {
    await act(async () => buttonWith("Add connection").click());
    assert.equal(rowFor("Relay").querySelector("input").checked, true);
    assert.equal(rowFor("LLM Gateway").querySelector("input").checked, false);

    await act(async () => rowFor("LLM Gateway").querySelector("input").click());
    assert.deepEqual(writes, []);
    await act(async () => dialogSave().click());

    assert.equal(writes.length, 1);
    assert.match(writes[0].url, /\/api\/devices\/d1\/profiles$/);
    assert.deepEqual([...writes[0].body.profileIds].sort(), [
      "legacy-official",
      "p1",
      "p2",
    ]);
    assert.equal(view.refreshes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

test("cancelling the picker never writes", async () => {
  const writes = [];
  intercept((body, url) => {
    writes.push({ url, body });
    return new Response(JSON.stringify([]), { status: 200 });
  });
  const view = await setup();
  try {
    await act(async () => buttonWith("Add connection").click());
    await act(async () => rowFor("LLM Gateway").querySelector("input").click());
    await act(async () => buttonWith("Cancel").click());
    assert.deepEqual(writes, []);
    assert.equal(view.refreshes.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

test("a failed write keeps the picker open with the draft for one retry", async () => {
  const writes = [];
  intercept((body) => {
    writes.push(body);
    if (writes.length === 1)
      return new Response("synthetic write failure", { status: 500 });
    return new Response(JSON.stringify([]), { status: 200 });
  });
  const view = await setup();
  try {
    await openPickerAndToggleGateway();
    await act(async () => dialogSave().click());

    assert.equal(writes.length, 1);
    assert.match(
      window.document.querySelector('[role="alert"]').textContent,
      /synthetic write failure/,
    );
    assert.equal(
      window.document.querySelectorAll(".fdy-connection-assign-dialog").length,
      1,
    );
    assert.equal(rowFor("LLM Gateway").querySelector("input").checked, true);
    assert.equal(view.refreshes.length, 0);

    await act(async () => dialogSave().click());
    assert.equal(writes.length, 2);
    assert.deepEqual([...writes[1].profileIds].sort(), [
      "legacy-official",
      "p1",
      "p2",
    ]);
    assert.equal(
      window.document.querySelectorAll(".fdy-connection-assign-dialog").length,
      0,
    );
    assert.equal(view.refreshes.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

test("a saved write with a failed refresh closes the picker and retries refresh only", async () => {
  const writes = [];
  intercept((body) => {
    writes.push(body);
    return new Response(JSON.stringify([]), { status: 200 });
  });
  const view = await setup({
    refreshImpl: async (attempt) => {
      if (attempt === 1) throw new Error("snapshot stream down");
    },
  });
  try {
    await openPickerAndToggleGateway();
    await act(async () => dialogSave().click());
    await act(async () => {});

    // Exactly one write, and the picker closed: the assignment was saved.
    assert.equal(writes.length, 1);
    assert.equal(
      window.document.querySelectorAll(".fdy-connection-assign-dialog").length,
      0,
    );
    // There is no save-failure alert inside a dialog; instead the section
    // reports the refresh failure separately, honestly.
    const refreshAlert = [
      ...window.document.querySelectorAll('[role="alert"]'),
    ].find((element) => /could not be refreshed/.test(element.textContent));
    assert.ok(refreshAlert, "expected a refresh-only error");
    assert.match(refreshAlert.textContent, /snapshot stream down/);

    const retry = [...window.document.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Retry refresh",
    );
    assert.ok(retry, "refresh failure offers an explicit retry");
    assert.equal(retry.disabled, false);

    // Retrying refreshes the list only; it never writes again.
    await act(async () => retry.click());
    assert.equal(writes.length, 1);
    assert.equal(view.refreshes.length, 2);
    assert.equal(
      window.document.querySelectorAll('[role="alert"]').length,
      0,
      "the refresh alert clears once the retry succeeds",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});
