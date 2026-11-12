import assert from "node:assert/strict";
import { register } from "node:module";
import test, { afterEach } from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { toastGone, toastShown } from "./toast-wait.mjs";

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
const { SubscriptionsSection } =
  await import("../src/features/profiles/subscriptions-section.tsx");
const devices = [
  { id: "a", label: "Studio", status: "connected", owned: true },
  { id: "b", label: "Laptop", status: "disconnected", owned: true },
];

// The subscriptions on Model providers: each device's official login, with
// what its owner does about it (docs/model-providers-design.md).
async function setup(overrides = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let props = {
    devices,
    runtimes: ["claude", "codex"],
    profiles: [],
    providerHealth: [],
    bindings: [],
    serverProfiles: [],
    onRefresh: async () => {},
    ...overrides,
  };
  async function render(patch = {}) {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(createElement(SubscriptionsSection, props)),
    );
  }
  await render();
  return {
    container,
    render,
    click: async (text) => {
      const button = [...container.querySelectorAll("button")].find((row) =>
        row.textContent.includes(text),
      );
      assert.ok(button, text);
      await act(async () => button.click());
    },
    clickLabel: async (label) => {
      const button = container.querySelector(`button[aria-label="${label}"]`);
      assert.ok(button, label);
      await act(async () => button.click());
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("each device is a row of its own: an offline one cannot be checked and never borrows another's login", async () => {
  const view = await setup({
    profiles: [
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
  assert.match(view.container.textContent, /1 of 2 devices signed in/);
  const laptop = [
    ...view.container.querySelectorAll('button[aria-label$="on Laptop again"]'),
  ];
  assert.equal(laptop.length, 2);
  for (const button of laptop) assert.equal(button.disabled, true);
  const signIn = view.container.querySelector(
    'button[aria-label="Sign in to Claude Code on Laptop"]',
  );
  assert.equal(signIn?.disabled, true, "an offline device cannot sign in");
  // The studio's login is the studio's only.
  assert.equal(
    view.container.textContent.match(/studio@example\.test/g)?.length,
    1,
  );
  await view.cleanup();
});

test("a device without a login offers Sign in, and Check again only re-reads the login", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ runtime: "codex" }), { status: 200 });
  };
  const view = await setup({ devices: [devices[0]] });
  try {
    assert.ok(
      view.container.querySelector(
        'button[aria-label="Sign in to Codex on Studio"]',
      ),
    );
    await view.clickLabel("Check the Codex login on Studio again");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/devices\/a\/accounts\/codex\/inspect$/);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

// What /api/model-guides/resolve answers when no guide matches a target.
function unguided(options) {
  const { targets } = JSON.parse(options.body);
  return new Response(
    JSON.stringify({
      resolutions: targets.map((target) => ({
        suggestedId: target.model ?? "",
        suggestedIdTaken: false,
      })),
    }),
  );
}

test("official defaults save only the selected device preset, never a server profile or key", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/model-guides/resolve")) return unguided(options);
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
    devices: [devices[0]],
    runtimes: ["codex"],
    profiles: [
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
    await view.clickLabel("Codex on Studio: account, usage and defaults");
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
    await toastShown(act, ".fdy-toast");
    assert.match(view.container.textContent, /Device defaults saved/);
  } finally {
    globalThis.fetch = originalFetch;
    await view.cleanup();
  }
});

test("official account defaults reject saved models absent from the native catalog", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    String(url).endsWith("/model-guides/resolve")
      ? unguided(options)
      : new Response(
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
    devices: [devices[0]],
    runtimes: ["codex"],
    profiles: [
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
    await view.clickLabel("Codex on Studio: account, usage and defaults");
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
