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
const { WorkspacesFeature } =
  await import("../src/features/workspaces/workspaces-feature.tsx");

const devices = [{ id: "dev", label: "darwin-arm64", status: "connected" }];
const workspaces = [
  { id: "ws-current", name: "current-ws", deviceId: "dev", localPath: "/a" },
  { id: "ws-other", name: "other-ws", deviceId: "dev", localPath: "/b" },
];

async function setup(props = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const events = [];
  await act(async () =>
    root.render(
      createElement(WorkspacesFeature, {
        devices,
        workspaces,
        activeWorkspaceId: "ws-current",
        onEvent: (event) => {
          events.push(event);
          return true;
        },
        ...props,
      }),
    ),
  );
  return {
    container,
    events,
    click: async (button) => act(async () => button.click()),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("compact sidebar is one button with one tab stop", async () => {
  const view = await setup({ compact: true });
  const section = view.container.querySelector(".fdy-location");
  assert.equal(section.querySelectorAll("button").length, 1);
  assert.equal(
    [...section.querySelectorAll("button")].filter((b) => b.tabIndex >= 0)
      .length,
    1,
  );
  assert.equal(section.querySelectorAll(".fdy-location-entry-row").length, 2);
  await view.cleanup();
});

test("locations Switch activates with stayOnLocation; current row has no switch", async () => {
  const view = await setup();

  const currentRow = view.container.querySelector(
    '.fdy-location-workspace-row[data-current="true"]',
  );
  assert.ok(currentRow, "current row marked");
  assert.equal(
    currentRow.textContent.includes("Switch"),
    false,
    "current row offers no Switch action",
  );
  assert.match(currentRow.textContent, /Current/);
  assert.ok(
    currentRow.querySelector('[aria-label="View details for current-ws"]'),
    "current row still offers details",
  );

  const otherRow = view.container.querySelector(
    '.fdy-location-workspace-row[data-current="false"]',
  );
  const switchButton = [...otherRow.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Switch"),
  );
  assert.ok(switchButton, "non-current row has an explicit Switch button");
  await view.click(switchButton);

  const activations = view.events.filter(
    (event) => event.type === "workspace.activation.requested",
  );
  assert.equal(activations.length, 1);
  assert.equal(activations[0].workspaceId, "ws-other");
  assert.equal(
    activations[0].stayOnLocation,
    true,
    "locations switch must not navigate away from /locations",
  );
  assert.deepEqual(
    view.events.filter((event) => event.type === "workspace.return.requested"),
    [],
    "switching another workspace never fires a return-to-overview event",
  );
  await view.cleanup();
});

test("details button is separate from Switch and fires no activation", async () => {
  const view = await setup();
  const otherRow = view.container.querySelector(
    '.fdy-location-workspace-row[data-current="false"]',
  );
  const details = otherRow.querySelector(
    '[aria-label="View details for other-ws"]',
  );
  assert.ok(details);
  await view.click(details);
  // The dialog opens via inspectWorkspace; the key contract is no activation.
  assert.deepEqual(
    view.events.filter(
      (event) => event.type === "workspace.activation.requested",
    ),
    [],
  );
  await view.cleanup();
});

test("removed devices are excluded from new selection; their workspaces stay read-only history", async () => {
  const view = await setup({
    devices: [
      { id: "dev", label: "live", status: "connected" },
      { id: "ghost", label: "ghost-machine", status: "removed" },
    ],
    workspaces: [
      {
        id: "ws-current",
        name: "current-ws",
        deviceId: "dev",
        localPath: "/a",
      },
      { id: "ws-other", name: "other-ws", deviceId: "dev", localPath: "/b" },
      { id: "ws-ghost", name: "ghost-ws", deviceId: "ghost", localPath: "/g" },
    ],
  });
  // A removed device that is not the current context is not offered at all.
  const deviceButtons = () => [
    ...view.container.querySelectorAll(".fdy-location-device-list button"),
  ];
  assert.equal(
    deviceButtons().some((b) => b.textContent.includes("ghost-machine")),
    false,
    "non-current removed device hidden from selection",
  );
  // Its workspaces cannot appear while previewing the live device.
  assert.equal(view.container.textContent.includes("ghost-ws"), false);
  await view.cleanup();
});

test("current context on a removed device stays visible read-only and cannot switch", async () => {
  const view = await setup({
    activeWorkspaceId: "ws-ghost",
    devices: [
      { id: "dev", label: "live", status: "connected" },
      { id: "ghost", label: "ghost-machine", status: "removed" },
    ],
    workspaces: [
      {
        id: "ws-current",
        name: "current-ws",
        deviceId: "dev",
        localPath: "/a",
      },
      { id: "ws-ghost", name: "ghost-ws", deviceId: "ghost", localPath: "/g" },
    ],
  });
  const deviceRow = [
    ...view.container.querySelectorAll(".fdy-location-device-list button"),
  ].find((b) => b.textContent.includes("ghost-machine"));
  assert.ok(deviceRow, "current removed device is still shown");
  assert.equal(deviceRow.disabled, true, "removed device row not selectable");
  assert.match(deviceRow.textContent, /Removed/);

  const ghostRow = view.container.querySelector(
    '.fdy-location-workspace-row[data-current="true"]',
  );
  assert.ok(ghostRow);
  assert.match(ghostRow.textContent, /Current/);
  assert.equal(
    [...ghostRow.querySelectorAll("button")].some((b) =>
      b.textContent.includes("Switch"),
    ),
    false,
    "no Switch offered on a removed device",
  );
  assert.match(ghostRow.textContent, /Device removed/);
  assert.ok(
    ghostRow.querySelector('[aria-label="View details for ghost-ws"]'),
    "read-only details remain available",
  );
  // Manage and prefetch/select paths cannot activate anything.
  await view.click(
    ghostRow.querySelector('[aria-label="View details for ghost-ws"]'),
  );
  assert.deepEqual(
    view.events.filter(
      (event) => event.type === "workspace.activation.requested",
    ),
    [],
  );
  await view.cleanup();
});
