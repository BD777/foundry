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

test("offline device accounts cannot be checked and do not borrow the active device's status", async () => {
  const view = await setup({
    selectedDeviceId: "b",
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
    ],
  });
  assert.doesNotMatch(view.container.textContent, /studio@example/);
  const logins = view.container.querySelectorAll(
    'button[aria-label^="Check the"]',
  );
  assert.equal(logins.length, 2);
  for (const button of logins) assert.equal(button.disabled, true);
  assert.deepEqual(view.openings, []);
  await view.cleanup();
});

test("a device without a login says where to sign in and only re-reads the login", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ runtime: "codex" }), { status: 200 });
  };
  const view = await setup({ selectedDeviceId: "a", section: "agents" });
  try {
    // Signing in happens on the device, in the agent's own CLI.
    assert.match(view.container.textContent, /On Studio, run codex login/);
    assert.equal(
      view.container.querySelector('button[aria-label^="Sign in"]'),
      null,
    );
    const button = view.container.querySelector(
      'button[aria-label="Check the Codex login on Studio again"]',
    );
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/devices\/a\/accounts\/codex\/inspect$/);
    assert.deepEqual(view.openings, []);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

test("unknown devices show a recoverable empty state without another device's workspace", async () => {
  const view = await setup({ selectedDeviceId: "missing" });
  assert.match(view.container.textContent, /Device not found/);
  assert.doesNotMatch(view.container.textContent, /Project A/);
  await view.click("Back to devices");
  assert.deepEqual(view.selection, [[]]);
  await view.cleanup();
});

test("official defaults save only the selected device preset, never a server profile or key", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith("/models"))
      return new Response(JSON.stringify([{ id: "saved-model" }]));
    if (String(url).endsWith("/inspect"))
      return new Response(
        JSON.stringify({
          runtime: "codex",
          source: "/native",
          sources: ["/native"],
          executionSource: "/native",
          status: "local_login",
          checkedAt: new Date().toISOString(),
          message: "Unverified",
          usage: [],
        }),
      );
    return new Response(JSON.stringify({ id: "codex_local" }), { status: 200 });
  };
  const view = await setup({
    selectedDeviceId: "a",
    section: "agents",
    agentProfiles: [
      {
        id: "codex_local",
        deviceId: "a",
        origin: "device",
        runtime: "codex",
        label: "Codex Local",
        connectionType: "local_login",
        status: "healthy",
        model: "saved-model",
      },
    ],
  });
  try {
    await view.click("Codex");
    assert.equal(
      view.container.querySelector(
        'input[aria-label="codex official default model"]',
      ),
      null,
    );
    assert.ok(
      view.container.querySelector(
        'button[aria-label="codex official default model"]',
      ),
    );
    await view.click("Save defaults");
    const writes = calls.filter((call) =>
      call.url.endsWith("/api/agent-profiles"),
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.deviceId, "a");
    assert.equal(writes[0].body.id, "codex_local");
    assert.equal(writes[0].body.connectionType, "local_login");
    assert.equal(writes[0].body.model, "saved-model");
    assert.equal(writes[0].body.apiKey, undefined);
    assert.equal(writes[0].body.baseUrl, undefined);
    assert.match(view.container.textContent, /Device defaults saved/);
    assert.deepEqual(view.openings, []);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

test("official account defaults reject saved models absent from the native catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/models")
          ? [{ id: "official-model" }]
          : {
              runtime: "codex",
              source: "/native",
              executionSource: "/native",
              sources: ["/native"],
              checkedAt: new Date().toISOString(),
              status: "local_login",
              message: "Local only",
              usage: [],
            },
      ),
    );
  const view = await setup({
    selectedDeviceId: "a",
    section: "agents",
    agentProfiles: [
      {
        id: "codex_local",
        deviceId: "a",
        origin: "device",
        runtime: "codex",
        label: "Codex",
        connectionType: "local_login",
        status: "healthy",
        model: "custom-gateway-model",
      },
    ],
  });
  try {
    await view.click("Codex");
    assert.match(view.container.textContent, /not in this official catalog/);
    const save = [...view.container.querySelectorAll("button")].find(
      (row) => row.textContent === "Save defaults",
    );
    assert.equal(save.disabled, true);
    await view.click("Use native default");
    assert.equal(save.disabled, false);
  } finally {
    await view.cleanup();
    globalThis.fetch = originalFetch;
  }
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
  assert.match(
    dialog.textContent,
    /--registry https:\/\/registry\.npmjs\.org\//,
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
    (alert) => alert.querySelector("strong")?.textContent === "Update failed",
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
      alert.querySelector("strong")?.textContent === "Update did not finish",
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
