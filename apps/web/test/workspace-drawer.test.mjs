import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

test("location page separates browsing, activation, retry and workspace management", async () => {
  const window = new Window();
  const previous = new Map();
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const { WorkspacesFeature } =
    await import("../src/features/workspaces/workspaces-feature.tsx");
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const events = [];
  let finish;
  const props = {
    activeWorkspaceId: "current",
    devices: [
      { id: "a", label: "Studio", status: "connected" },
      { id: "b", label: "Laptop", status: "disconnected" },
      { id: "empty", label: "Empty device", status: "connected" },
    ],
    workspaces: [
      {
        id: "current",
        name: "Current project",
        localPath: "/current",
        deviceId: "a",
      },
      { id: "target", name: "Next project", localPath: "/next", deviceId: "b" },
    ],
    onEvent: (event) => {
      events.push(event);
      if (event.type === "workspace.activation.requested")
        return new Promise((resolve) => {
          finish = resolve;
        });
    },
  };
  const button = (text) =>
    [...container.querySelectorAll("button")].find((row) =>
      row.textContent.includes(text),
    );
  try {
    await act(() =>
      root.render(
        createElement(WorkspacesFeature, { ...props, compact: true }),
      ),
    );
    await act(() =>
      container.querySelector('[aria-label="Open working location"]').click(),
    );
    assert.deepEqual(events.pop(), { type: "workspace.browse.requested" });
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    await act(() => root.render(createElement(WorkspacesFeature, props)));
    assert.match(container.textContent, /Working location/);
    assert.doesNotMatch(
      container.textContent,
      /Add workspace|Rename|Remove workspace/,
    );
    await act(() => button("Empty device").click());
    assert.match(container.textContent, /No workspaces on this device/);
    await act(() => button("Laptop").click());
    assert.equal(events.length, 0, "preview does not activate a device");
    assert.match(
      container.querySelector(".fdy-location-current").textContent,
      /Current project/,
    );
    const rowFor = (name) =>
      [...container.querySelectorAll(".fdy-location-workspace-row")].find(
        (row) => row.textContent.includes(name),
      );
    const switchFor = (name) =>
      rowFor(name)?.querySelector(
        "button:not(.fdy-location-workspace-details)",
      );
    assert.ok(
      rowFor("Next project")?.querySelector(".fdy-location-workspace-details"),
      "row exposes a separate read-only details entry",
    );
    await act(() => {
      switchFor("Next project").click();
      switchFor("Next project").click();
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].stayOnLocation, true);
    assert.equal(switchFor("Next project").getAttribute("aria-busy"), "true");
    assert.match(switchFor("Next project").textContent, /Switching/);
    await act(async () => finish(false));
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Could not switch/,
    );
    await act(() => switchFor("Next project").click());
    await act(async () => finish(true));
    assert.equal(events.length, 2);
    await act(() => button("Manage workspaces").click());
    assert.deepEqual(events.at(-1), {
      type: "workspace.management.requested",
      deviceId: "b",
    });
    await act(() => button("Back to workspace").click());
    assert.deepEqual(events.at(-1), { type: "workspace.return.requested" });
    const search = container.querySelector('[aria-label="Find workspace"]');
    await act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set.call(search, "missing");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    assert.match(container.textContent, /No matching workspaces/);
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
