import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

// Synthetic fetch interception: the installer never runs, the response is a
// worker-shaped install result.
const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
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
const { DeviceAccounts } =
  await import("../src/features/devices/device-accounts.tsx");

const device = { id: "dev_1", label: "Studio Mac", status: "connected" };
const cli = (overrides) => ({
  installed: true,
  version: "2.1.288",
  minimumVersion: "2.1.201",
  outdated: false,
  installCommand: "curl -fsSL https://claude.ai/install.sh | bash",
  updateCommand: "claude update",
  ...overrides,
});
const health = (
  claude,
  codex = cli({ installCommand: "npm install -g @openai/codex" }),
) => [
  {
    provider: "claude",
    status: claude.installed ? "healthy" : "unavailable",
    cli: claude,
  },
  { provider: "codex", status: "healthy", cli: codex },
];
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function mount(rows, overrides = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  let refreshed = 0;
  await act(async () => {
    root.render(
      createElement(DeviceAccounts, {
        device: { ...device, ...overrides },
        profiles: [],
        health: rows,
        legacyProfiles: [],
        bindings: [],
        onRefresh: async () => {
          refreshed += 1;
        },
      }),
    );
  });
  return {
    container,
    refreshed: () => refreshed,
    button: (label) => container.querySelector(`button[aria-label="${label}"]`),
    unmount: () => act(async () => root.unmount()),
  };
}

test("a missing program offers an install that runs only after a confirming click", async (t) => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    return new Response(
      JSON.stringify({
        runtime: "claude",
        ok: true,
        command: "curl -fsSL https://claude.ai/install.sh | bash",
        log: "Claude Code installed",
        cli: cli({}),
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const view = await mount(
    health(cli({ installed: false, version: undefined })),
  );
  t.after(view.unmount);

  assert.match(
    view.container.textContent,
    /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/,
  );
  assert.equal(view.button("Sign in to Codex on Studio Mac") !== null, true);
  const install = view.button("Install Claude Code on Studio Mac");
  assert.ok(install, "the missing program shows an install button");

  await act(async () => install.click());
  assert.equal(requests.length, 0, "the first click only arms the button");
  assert.match(install.textContent, /Run the installer on Studio Mac\?/);

  await act(async () => install.click());
  await tick();
  assert.deepEqual(
    requests.map((r) => [r.method, r.url.replace(/^.*\/api/, "/api")]),
    [["POST", "/api/devices/dev_1/accounts/claude/install"]],
  );
  assert.match(
    view.container.textContent,
    /Claude Code is installed on Studio Mac/,
  );
  assert.equal(view.refreshed(), 1);
});

test("an offline device cannot start an install", async (t) => {
  const view = await mount(
    health(cli({ installed: false, version: undefined })),
    {
      status: "offline",
    },
  );
  t.after(view.unmount);
  assert.equal(view.button("Install Claude Code on Studio Mac").disabled, true);
});

test("an older program stays usable and says how to update it", async (t) => {
  const view = await mount(health(cli({ version: "2.0.1", outdated: true })));
  t.after(view.unmount);
  assert.equal(view.button("Install Claude Code on Studio Mac"), null);
  assert.match(view.container.textContent, /2\.0\.1/);
  assert.match(view.container.textContent, /2\.1\.201/);
  assert.match(view.container.textContent, /claude update/);
});
