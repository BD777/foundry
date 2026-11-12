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
const { DeviceReferences } =
  await import("../src/features/personal-agent/settings-device-references.tsx");
const { ownedDeviceCandidates } = await import("../src/lib/devices.ts");
const devices = [
  { id: "offline", label: "Old computer", status: "disconnected", owned: true },
  { id: "online", label: "Home", status: "connected", owned: true },
  { id: "shared", label: "Shared", status: "connected", owned: false },
];
const settings = {
  devices: [{ deviceId: "gone", allowWork: true, allowCreate: true }],
  preferredDeviceId: "gone",
};
const permissionPackage = {
  id: "perm_default",
  owner: "usr_1",
  workspaces: { scope: "all", include: [], exclude: [] },
  connectorAccounts: [],
  identityResources: { scope: "all", allowed: [] },
};
globalThis.fetch = async (input) =>
  new Response(
    JSON.stringify(
      String(input).endsWith("/permission-package") ? permissionPackage : [],
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );

test("owned candidates retain offline identities, excluding shared", () => {
  assert.deepEqual(
    ownedDeviceCandidates(devices).map((d) => d.id),
    ["offline", "online"],
  );
});

test("unlisted permissions have no checkbox or management link; current invalid preferred value stays explicit", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const opened = [];
  await act(async () =>
    root.render(
      createElement(PlacesSection, {
        draft: settings,
        change: () => {},
        devices,
        assistants: [],
        workspaces: [],
        homeDeviceId: "online",
        onOpenComputer: (id) => opened.push(id),
        onNotice: () => {},
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

test("unlisted current bindings expose their origin without a control action", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(() =>
    root.render(
      createElement(DeviceReferences, {
        agent: { homeDeviceId: "gone" },
        draft: settings,
        devices,
      }),
    ),
  );
  assert.ok(container.querySelector('[role="alert"]'));
  assert.ok(container.textContent.includes("gone"));
  assert.ok(
    container.textContent.includes(
      "files and previous locations have been kept",
    ),
  );
  assert.equal(container.querySelectorAll("button,input").length, 0);
  await act(() => root.unmount());
  container.remove();
});
