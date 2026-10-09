import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);

test("a workspace its device no longer serves says so and offers Add again", async () => {
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
  const { WorkspaceSelectionPanel } =
    await import("../src/features/workspaces/workspace-selection-panel.tsx");
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const unavailableOnDevice = {
    reason: "not_served",
    since: "2026-10-10T00:00:00Z",
  };
  const calls = [];
  let finishAdd;
  const props = {
    activeWorkspaceId: "current",
    busyWorkspaceId: "",
    error: "",
    devices: [
      {
        id: "mac",
        label: "CanWendeMac-mini",
        status: "connected",
        owned: true,
      },
      { id: "off", label: "Laptop", status: "disconnected", owned: true },
      { id: "shared", label: "Teammate", status: "connected" },
    ],
    workspaces: [
      { id: "current", name: "Served", localPath: "/served", deviceId: "mac" },
      {
        id: "stale",
        name: "foundry",
        localPath: "/Volumes/work/foundry",
        deviceId: "mac",
        unavailableOnDevice,
      },
      {
        id: "offline",
        name: "Offline stale",
        localPath: "/offline",
        deviceId: "off",
        unavailableOnDevice,
      },
      {
        id: "theirs",
        name: "Shared stale",
        localPath: "/theirs",
        deviceId: "shared",
        accessRole: "member",
        unavailableOnDevice,
      },
    ],
    onReset: () => {},
    onSelect: async () => true,
    onPrepare: () => {},
    onOpenDevice: () => {},
    onBrowse: () => {},
    onReturn: () => {},
    onChanged: async () => {
      calls.push("changed");
    },
    onAddAgain: (workspace, device) => {
      calls.push(`add ${device.id} ${workspace.localPath}`);
      return new Promise((resolve) => {
        finishAdd = resolve;
      });
    },
  };
  const rowFor = (name) =>
    [...container.querySelectorAll(".fdy-location-workspace-row")].find((row) =>
      row.textContent.includes(name),
    );
  const addAgainIn = (row) =>
    [...row.querySelectorAll("button")].find((button) =>
      /^Add .* again on /.test(button.getAttribute("aria-label") ?? ""),
    );
  try {
    await act(() => root.render(createElement(WorkspaceSelectionPanel, props)));
    const served = rowFor("Served");
    assert.equal(served.getAttribute("data-unserved"), null);
    assert.equal(addAgainIn(served), undefined);

    const stale = rowFor("foundry");
    assert.equal(stale.getAttribute("data-unserved"), "true");
    const note = stale.querySelector(".fdy-location-unserved-note");
    assert.match(
      note.textContent,
      /CanWendeMac-mini no longer serves this folder/,
    );
    assert.equal(
      stale
        .querySelector(".fdy-location-workspace-details")
        .getAttribute("aria-describedby"),
      note.id,
    );
    // History stays reachable: the row can still be switched to.
    assert.ok(
      [...stale.querySelectorAll("button")].some((button) =>
        /Switch to foundry/.test(button.getAttribute("aria-label") ?? ""),
      ),
    );

    const add = addAgainIn(stale);
    assert.equal(add.textContent, "Add again");
    assert.equal(add.disabled, false);
    await act(() => add.click());
    assert.deepEqual(calls, ["add mac /Volumes/work/foundry"]);
    assert.equal(
      addAgainIn(rowFor("foundry")).getAttribute("aria-busy"),
      "true",
    );
    assert.match(addAgainIn(rowFor("foundry")).textContent, /Adding/);
    await act(async () => finishAdd());
    assert.deepEqual(calls, ["add mac /Volumes/work/foundry", "changed"]);
    assert.match(
      container.querySelector('[role="status"]').textContent,
      /foundry is served by CanWendeMac-mini again/,
    );

    // An offline device cannot take the folder yet; another person's device
    // is not this person's to change.
    assert.equal(addAgainIn(rowFor("Offline stale")).disabled, true);
    assert.equal(addAgainIn(rowFor("Shared stale")), undefined);
    assert.ok(
      rowFor("Shared stale").querySelector(".fdy-location-unserved-note"),
    );
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test("a failed Add again shows the device's answer and keeps the row", async () => {
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
  const { WorkspaceSelectionPanel } =
    await import("../src/features/workspaces/workspace-selection-panel.tsx");
  const { createRoot } = await import("react-dom/client");
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let changed = 0;
  try {
    await act(() =>
      root.render(
        createElement(WorkspaceSelectionPanel, {
          activeWorkspaceId: "",
          busyWorkspaceId: "",
          error: "",
          devices: [
            { id: "mac", label: "Mac", status: "connected", owned: true },
          ],
          workspaces: [
            {
              id: "stale",
              name: "gone",
              localPath: "/gone",
              deviceId: "mac",
              unavailableOnDevice: { reason: "not_served", since: "x" },
            },
          ],
          onReset: () => {},
          onSelect: async () => true,
          onPrepare: () => {},
          onOpenDevice: () => {},
          onBrowse: () => {},
          onReturn: () => {},
          onChanged: async () => {
            changed += 1;
          },
          onAddAgain: async () => {
            throw new Error("Choose an existing folder");
          },
        }),
      ),
    );
    const add = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Add again",
    );
    await act(async () => add.click());
    assert.match(
      container.querySelector('[role="alert"]').textContent,
      /Choose an existing folder/,
    );
    assert.equal(changed, 0);
    assert.equal(add.disabled, false);
  } finally {
    await act(() => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
