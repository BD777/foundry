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
    openings = [];
  let props = {
    devices,
    workspaces,
    activeWorkspaceId: "wa",
    profiles: [],
    agentProfiles: [],
    providerHealth: [],
    deviceProfiles: [],
    section: "workspaces",
    onSelect: (...args) => selection.push(args),
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

test("device list navigation never activates a workspace; open is an explicit separate action", async () => {
  const view = await setup();
  await view.click("Laptop");
  assert.deepEqual(view.selection, [["b", "workspaces"]]);
  assert.deepEqual(view.openings, []);
  await view.render({ selectedDeviceId: "b" });
  assert.match(view.container.textContent, /Project B/);
  assert.doesNotMatch(view.container.textContent, /Project A/);
  await view.click("Switch here");
  assert.deepEqual(view.openings, ["wb"]);
  await view.cleanup();
});

test("current workspace has a status instead of redundant switch; details do not activate it", async () => {
  const view = await setup({ selectedDeviceId: "a" });
  assert.match(view.container.textContent, /Current workspace/);
  assert.equal(
    [...view.container.querySelectorAll("button")].some((button) =>
      button.textContent.includes("Switch here"),
    ),
    false,
  );
  assert.ok(view.container.querySelector('[data-current="true"]'));
  assert.ok(
    view.container.querySelector('[aria-label="View details for Project A"]'),
  );
  assert.ok(
    view.container.querySelector('[aria-label="Actions for Project A"]'),
  );
  assert.deepEqual(view.openings, []);
  await view.cleanup();
});

test("offline device accounts cannot start login and do not borrow the active device's status", async () => {
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
    'button[aria-label^="Sign in to"]',
  );
  assert.equal(logins.length, 2);
  for (const button of logins) assert.equal(button.disabled, true);
  assert.deepEqual(view.openings, []);
  await view.cleanup();
});

test("official sign-in names the target device and never creates a global profile", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(
      JSON.stringify({
        id: "flow",
        runtime: "codex",
        profileId: "device-account:codex",
        status: "failed",
        message: "Synthetic authorization failure",
      }),
      { status: 200 },
    );
  };
  const view = await setup({ selectedDeviceId: "a", section: "agents" });
  try {
    const button = view.container.querySelector(
      'button[aria-label="Sign in to Codex on Studio"]',
    );
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(calls.length, 1);
    assert.match(
      calls[0].url,
      /\/api\/devices\/a\/accounts\/codex\/authorization$/,
    );
    assert.match(view.container.textContent, /Synthetic authorization failure/);
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
  assert.match(text, /Member access/);
  assert.equal(
    view.container.querySelector('[aria-label="Actions for Shared"]'),
    null,
  );
  assert.doesNotMatch(text, /Add workspace/);
  await view.cleanup();
});
