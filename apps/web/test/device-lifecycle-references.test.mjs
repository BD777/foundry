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

const { PlacesSection } =
  await import("../src/features/personal-agent/settings-places.tsx");
const { DeviceReferences, currentDeviceGrants } =
  await import("../src/features/personal-agent/settings-device-references.tsx");
const { ownedDeviceCandidates } = await import("../src/lib/devices.ts");
const devices = [
  { id: "removed", label: "Old computer", status: "removed", owned: true },
  { id: "offline", label: "Old computer", status: "disconnected", owned: true },
  { id: "online", label: "Home", status: "connected", owned: true },
  { id: "shared", label: "Shared", status: "connected", owned: false },
];
const settings = {
  devices: [{ deviceId: "removed", allowWork: true, allowCreate: true }],
  preferredDeviceId: "removed",
};
globalThis.fetch = async () =>
  new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("owned candidates retain offline and same-name identities, excluding removed and shared", () => {
  assert.deepEqual(
    ownedDeviceCandidates(devices).map((d) => d.id),
    ["offline", "online"],
  );
});

test("removed permissions have no checkbox or management link; current invalid preferred value stays explicit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opened = [];
  await act(async () =>
    root.render(
      createElement(PlacesSection, {
        draft: settings,
        change: () => {},
        owned: devices.filter((d) => d.owned),
        homeDeviceId: "online",
        onOpenComputer: (id) => opened.push(id),
      }),
    ),
  );
  const rows = [...container.querySelectorAll(".fdy-pa-place")];
  assert.equal(rows.length, 2);
  assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 4);
  assert.ok(container.textContent.includes("Computer no longer available"));
  const computerButtons = rows.map((row) => row.querySelector("button"));
  for (const button of computerButtons) await act(() => button.click());
  assert.deepEqual(opened, ["offline", "online"]);
  await act(() => root.unmount());
  container.remove();
});

test("removed current bindings expose their origin without a control action", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      createElement(DeviceReferences, {
        agent: { homeDeviceId: "removed" },
        draft: settings,
        devices,
      }),
    ),
  );
  assert.ok(container.querySelector('[role="alert"]'));
  assert.ok(container.textContent.includes("Old computer"));
  assert.ok(
    container.textContent.includes(
      "files and previous locations have been kept",
    ),
  );
  assert.equal(container.querySelectorAll("button,input").length, 0);
  await act(() => root.unmount());
  container.remove();
});

test("a removal refresh changes the saved and draft grants equally, preserving other unsaved edits", () => {
  const saved = currentDeviceGrants(settings, devices);
  const draft = currentDeviceGrants(
    { ...settings, assistantName: "edited" },
    devices,
  );
  assert.deepEqual(saved.devices, []);
  assert.deepEqual(draft.devices, saved.devices);
  assert.equal(draft.assistantName, "edited");
  assert.equal(saved.preferredDeviceId, "removed");
  assert.equal(currentDeviceGrants(saved, devices), saved);
});

test("a removed memory source cannot be described as ready or temporarily offline", async () => {
  const { KnowledgeDeviceStatus } =
    await import("../src/features/personal-agent/settings-knowledge-location.tsx");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      createElement(
        KnowledgeDeviceStatus,
        { device: devices[0] },
        "Ready source",
      ),
    ),
  );
  assert.ok(container.textContent.includes("Removed"));
  assert.ok(!container.textContent.includes("Ready source"));
  assert.ok(!container.textContent.includes("offline"));
  await act(() => root.unmount());
  container.remove();
});

test("removed knowledge roots retain metadata without reading source files or enabling source operations", async () => {
  const { KnowledgeSection } =
    await import("../src/features/personal-agent/settings-knowledge.tsx");
  const originalFetch = globalThis.fetch;
  let entryReads = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/entries")) {
      entryReads++;
      return new Response(JSON.stringify({ error: "device_removed" }), {
        status: 410,
      });
    }
    const data = url.endsWith("/knowledge/vaults")
      ? [
          {
            id: "vault_removed",
            kind: "memory",
            workspaceId: "ws_old",
            deviceId: "removed",
            rootPath: "knowledge",
            state: "active",
            epoch: 1,
            revision: 1,
          },
        ]
      : [];
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        createElement(KnowledgeSection, {
          devices,
          workspaces: [
            {
              id: "ws_old",
              name: "Historical memory project",
              deviceId: "removed",
              accessRole: "owner",
            },
          ],
          profiles: [],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(entryReads, 0);
    assert.equal(
      container.querySelector("#pa-knowledge-title")?.disabled,
      true,
    );
    assert.equal(container.querySelector("#pa-knowledge-body")?.disabled, true);
    assert.ok(container.textContent.includes("Historical memory project"));
    assert.ok(
      !container.textContent.includes("Knowledge action could not finish"),
    );
    assert.ok(!container.textContent.includes("device_removed"));
    for (const label of [
      "Start verified migration",
      "Rebuild index",
      "Add knowledge",
    ]) {
      const button = [...container.querySelectorAll("button")].find((b) =>
        b.textContent.includes(label),
      );
      assert.ok(button, label);
      assert.ok(button.disabled, label);
    }
    assert.ok(
      [...container.querySelectorAll("button")].find(
        (b) => b.textContent === "Refresh" && !b.disabled,
      ),
    );
  } finally {
    await act(() => root.unmount());
    container.remove();
    globalThis.fetch = originalFetch;
  }
});
