import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { toastGone, toastShown } from "./toast-wait.mjs";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "http://127.0.0.1/devices" });
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
  "PopStateEvent",
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
// A device's Resources section follows the inventory on the event stream.
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};
const { createRoot: createReactRoot } = await import("react-dom/client");
const { ToastProvider } = await import("../src/components/ui/toast.tsx");
const mountedRoots = new Set();
afterEach(async () => {
  await act(async () => {
    for (const root of [...mountedRoots]) root.unmount();
  });
  document.body.replaceChildren();
});
function createRoot(container) {
  const root = createReactRoot(container);
  const wrapped = {
    render: (node) => root.render(createElement(ToastProvider, null, node)),
    unmount: () => {
      if (!mountedRoots.has(wrapped)) return;
      document
        .querySelectorAll(".fdy-toast-close")
        .forEach((button) => button.click());
      root.unmount();
      mountedRoots.delete(wrapped);
    },
  };
  mountedRoots.add(wrapped);
  return wrapped;
}
const { DevicesFeature } = await import("../src/features/devices/index.ts");
const devices = [
  { id: "a", label: "Studio", status: "connected", owned: true },
  { id: "b", label: "Laptop", status: "disconnected", owned: true },
];
const workspaces = [
  { id: "wa", name: "Project A", deviceId: "a", localPath: "/a" },
  { id: "wb", name: "Project B", deviceId: "b", localPath: "/b" },
];

async function setup(overrides = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const selection = [],
    openings = [],
    workspaceLinks = [];
  let props = {
    devices,
    workspaces,
    activeWorkspaceId: "wa",
    profiles: [],
    agentProfiles: [],
    providerHealth: [],
    deviceProfiles: [],
    section: "agents",
    onSelect: (...args) => selection.push(args),
    onOpenWorkspaces: (deviceId) => workspaceLinks.push(deviceId),
    onOpenWorkspace: async (id) => {
      openings.push(id);
      return true;
    },
    onRefresh: async () => {},
    onManageConnections: () => {},
    ...overrides,
  };
  async function render(patch = {}) {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(DevicesFeature, props)));
  }
  await render();
  return {
    container,
    selection,
    openings,
    workspaceLinks,
    render,
    click: async (text) => {
      const button = [...container.querySelectorAll("button")].find((row) =>
        row.textContent.includes(text),
      );
      assert.ok(button, text);
      await act(async () => button.click());
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a device page manages the machine and links to its workspaces instead of listing them", async () => {
  const view = await setup();
  await view.click("Laptop");
  assert.deepEqual(view.selection, [["b"]]);
  await view.render({ selectedDeviceId: "b" });
  assert.doesNotMatch(view.container.textContent, /Project B|Switch here/);
  await view.click("1 workspace");
  assert.deepEqual(view.workspaceLinks, ["b"]);
  assert.deepEqual(view.openings, [], "nothing is activated");
  await view.cleanup();
});

test("a device's models and accounts are a summary that opens Model providers filtered to it", async () => {
  const view = await setup({
    selectedDeviceId: "a",
    section: "agents",
    agentProfiles: [
      {
        deviceId: "a",
        id: "claude_local",
        origin: "device",
        runtime: "claude",
        connectionType: "local_login",
        status: "healthy",
        accountLabel: "studio@example.test",
      },
      {
        deviceId: "a",
        id: "gw_default",
        label: "Gateway · default",
        origin: "device",
        runtime: "claude",
        connectionType: "external",
        status: "healthy",
        connector: { kind: "gateway", label: "Gateway" },
      },
    ],
  });
  assert.match(view.container.textContent, /Signed in as studio@example\.test/);
  assert.match(view.container.textContent, /Gateway · default/);
  assert.equal(
    view.container.querySelector('button[aria-label^="Check the"]'),
    null,
    "nothing is managed here",
  );
  await view.click("Manage in Model providers");
  assert.equal(window.location.pathname, "/model-providers/subscriptions");
  assert.match(window.location.search, /device=a/);
  await view.cleanup();
});

test("unknown devices show a recoverable empty state without another device's workspace", async () => {
  const view = await setup({ selectedDeviceId: "missing" });
  assert.match(view.container.textContent, /Device not found/);
  assert.doesNotMatch(view.container.textContent, /Project A/);
  await view.click("Back to devices");
  assert.deepEqual(view.selection, [[]]);
  await view.cleanup();
});

test("a device shared through a workspace is browse-only and shows the caller's role", async () => {
  const view = await setup({
    devices: [{ id: "s", label: "Alice's Mac", status: "connected" }],
    workspaces: [
      {
        id: "ws",
        name: "Shared",
        deviceId: "s",
        localPath: "/s",
        accessRole: "member",
      },
    ],
    activeWorkspaceId: "",
  });
  assert.match(view.container.textContent, /Shared with you/);
  assert.equal(
    view.container.querySelector('[aria-label="Actions for Alice\'s Mac"]'),
    null,
  );
  await view.render({ selectedDeviceId: "s", section: "settings" });
  const text = view.container.textContent;
  assert.match(text, /managed by the account that paired it/);
  assert.equal(
    view.container.querySelector('[aria-label="Device sections"]'),
    null,
  );
  assert.doesNotMatch(text, /Rename|Add workspace/);
  await view.cleanup();
});

test("adding a device opens one dialog that also shows how to check or repair a device", async () => {
  const view = await setup();
  await view.click("Add device");
  const dialog = window.document.querySelector('[role="dialog"]');
  assert.ok(dialog, "the dialog opens");
  assert.match(dialog.textContent, /Add or repair a device/);
  assert.match(dialog.textContent, /Create pairing command/);
  assert.match(dialog.textContent, /~\/\.foundry\/bin\/foundry-worker doctor/);
  assert.ok(
    dialog.querySelector('button[aria-label="About private npm mirrors"]'),
    "the mirror flag is behind its help button",
  );
  await view.cleanup();
});

test("an update the server records as running keeps the button busy on every visit", async () => {
  const view = await setup({
    selectedDeviceId: "a",
    section: "settings",
    devices: [
      {
        id: "a",
        label: "Studio",
        status: "connected",
        owned: true,
        capabilities: ["worker_update"],
        worker: { version: "0.5.6", command: "~/.foundry/bin/foundry-worker" },
        workerUpdate: { startedAt: "2026-10-08T12:00:00Z", version: "0.5.7" },
      },
    ],
  });
  const busy = [...view.container.querySelectorAll("button")].filter((b) =>
    b.textContent.includes("Updating"),
  );
  assert.ok(busy.length > 0, "the update shows as running");
  assert.ok(busy.every((button) => button.disabled));
  assert.match(view.container.textContent, /Updating since/);
  await view.cleanup();
});

test("an update the server probes shows its step, and a failure at once with Retry", async () => {
  const studio = (workerUpdate) => ({
    id: "a",
    label: "Studio",
    status: "connected",
    owned: true,
    capabilities: ["worker_update", "worker_update_status"],
    worker: { version: "0.5.6", command: "~/.foundry/bin/foundry-worker" },
    workerUpdate,
  });
  const view = await setup({
    selectedDeviceId: "a",
    section: "settings",
    devices: [
      studio({
        startedAt: "2026-10-08T12:00:00Z",
        version: "0.5.7",
        step: "downloading",
        stepDetail: "connect timeout; trying again in 5 s",
      }),
    ],
  });
  assert.match(view.container.textContent, /Downloading 0\.5\.7…/);
  assert.match(view.container.textContent, /Waiting: connect timeout/);
  await view.render({
    devices: [
      studio({
        startedAt: "2026-10-08T12:00:00Z",
        version: "0.5.7",
        step: "checking",
        failure: "could not ask the server which worker it serves",
        failureCode: "exited",
        exitCode: 1,
        logTail: ["ERROR [E5001] COMMAND_FAILED"],
      }),
    ],
  });
  // The failure is an error of its own, labelled, not part of a warning.
  const failures = [
    ...view.container.querySelectorAll('.fdy-alert[data-tone="error"]'),
  ].filter(
    (alert) =>
      alert.querySelector('[data-slot="alert-title"]')?.textContent ===
      "Update failed",
  );
  assert.ok(failures.length > 0, "the failure shows as an error alert");
  for (const failure of failures) {
    assert.equal(failure.getAttribute("role"), "alert");
    assert.equal(failure.closest('[data-tone="warning"]'), null);
    assert.ok(failure.querySelector("svg"), "the error has an icon");
    const text = failure.textContent;
    assert.match(
      text,
      /Reason: could not ask the server which worker it serves/,
    );
    assert.match(
      text,
      /Last step: Asking the server which worker to install\./,
    );
    assert.match(text, /Exit status 1\./);
    assert.match(text, /ERROR \[E5001\] COMMAND_FAILED/);
    const retry = [...failure.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Try the update again"),
    );
    assert.ok(retry && !retry.disabled, "the update can be started again");
  }
  await view.cleanup();
});

test("a stalled update shows as an error of its own with Retry", async () => {
  const view = await setup({
    selectedDeviceId: "a",
    section: "settings",
    devices: [
      {
        id: "a",
        label: "Studio",
        status: "connected",
        owned: true,
        capabilities: ["worker_update", "worker_update_status"],
        worker: { version: "0.5.6", command: "~/.foundry/bin/foundry-worker" },
        workerUpdate: {
          startedAt: "2026-10-08T12:00:00Z",
          version: "0.5.7",
          stalled: true,
          log: "~/.foundry/logs/update.log",
        },
      },
    ],
  });
  const stalled = [
    ...view.container.querySelectorAll('.fdy-alert[data-tone="error"]'),
  ].filter(
    (alert) =>
      alert.querySelector('[data-slot="alert-title"]')?.textContent ===
      "Update did not finish",
  );
  assert.ok(stalled.length > 0, "the stalled update shows as an error alert");
  for (const alert of stalled) {
    assert.equal(alert.getAttribute("role"), "alert");
    assert.equal(alert.closest('[data-tone="warning"]'), null);
    assert.match(
      alert.textContent,
      /did not finish: the device still runs its old worker\. Its log on the device: ~\/\.foundry\/logs\/update\.log/,
    );
    const retry = [...alert.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Try the update again"),
    );
    assert.ok(retry && !retry.disabled, "the update can be started again");
  }
  await view.cleanup();
});

test("without the server's release, a current worker is not offered an update but can switch its runner", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).includes("/api/worker/release")
      ? new Response("bad gateway", { status: 502 })
      : originalFetch(url);
  const device = {
    id: "a",
    label: "Studio",
    status: "connected",
    owned: true,
    capabilities: ["worker_update", "worker_update_status"],
    worker: { version: "0.5.8", command: "~/.foundry/bin/foundry-worker" },
    runner: {
      version: "0.5.7",
      targetVersion: "0.5.8",
      state: "pending",
      deadline: "2026-10-08T12:00:00Z",
      runningTurns: 2,
      heldTurns: 0,
      backgroundSessions: 0,
      waitingFor: "turns",
    },
  };
  const view = await setup({
    selectedDeviceId: "a",
    section: "settings",
    devices: [device],
  });
  try {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const buttons = [...view.container.querySelectorAll("button")].map(
      (button) => button.textContent,
    );
    assert.ok(!buttons.includes("Update Worker"), "no blind update");
    // Both the banner and Settings → Worker offer the switch.
    assert.equal(buttons.filter((text) => text === "Switch now").length, 2);
    assert.ok(
      view.container.querySelector(
        'button[aria-label="How Worker updates work"]',
      ),
      "the banner explains the two parts",
    );
  } finally {
    await view.cleanup();
    globalThis.fetch = originalFetch;
  }
});
