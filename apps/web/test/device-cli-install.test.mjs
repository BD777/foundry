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
  codex = cli({
    installCommand: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
  }),
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

test("a missing program installs with one click and shows where it stands", async (t) => {
  const requests = [];
  let answer;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method });
    await new Promise((resolve) => (answer = resolve));
    return new Response(
      JSON.stringify({
        runtime: "claude",
        ok: true,
        command: "Foundry-managed install (official npm release)",
        log: "Installed Claude Code 2.1.288. Foundry keeps it up to date.",
        cli: cli({}),
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const view = await mount(
    health(cli({ installed: false, version: undefined })),
  );
  t.after(view.unmount);

  assert.match(view.container.textContent, /no administrator rights needed/);
  assert.equal(
    view.button("Check the Codex login on Studio Mac again") !== null,
    true,
  );
  const install = view.button("Install Claude Code on Studio Mac");
  assert.ok(install, "the missing program shows an install button");

  await act(async () => install.click());
  assert.deepEqual(
    requests.map((r) => [r.method, r.url.replace(/^.*\/api/, "/api")]),
    [["POST", "/api/devices/dev_1/accounts/claude/install"]],
  );
  // While it runs: progress in words, and no second install button.
  assert.match(view.container.textContent, /Installing on Studio Mac/);
  assert.equal(view.button("Install Claude Code on Studio Mac"), null);

  await act(async () => answer());
  await tick();
  assert.match(
    view.container.textContent,
    /2\.1\.288, managed by Foundry; it updates automatically/,
  );
  assert.equal(view.button("Install Claude Code on Studio Mac"), null);
});

test("an offline device offers no install", async (t) => {
  const view = await mount(
    health(cli({ installed: false, version: undefined })),
    {
      id: "dev_2",
      status: "offline",
    },
  );
  t.after(view.unmount);
  assert.equal(view.button("Install Claude Code on Studio Mac"), null);
  assert.match(view.container.textContent, /Device offline/);
});

test("an older program stays usable and says how to update it", async (t) => {
  const view = await mount(health(cli({ version: "2.0.1", outdated: true })));
  t.after(view.unmount);
  assert.equal(view.button("Install Claude Code on Studio Mac"), null);
  assert.match(view.container.textContent, /2\.0\.1/);
  assert.match(view.container.textContent, /2\.1\.201/);
  assert.match(view.container.textContent, /Update this device.s worker/);
  assert.doesNotMatch(view.container.textContent, /claude update/);
});

test("a managed outdated runtime exposes automatic waiting and a direct update action", async (t) => {
  const view = await mount(
    health(
      cli({
        outdated: true,
        generation: "runtime-a",
        update: {
          state: "waiting_idle",
          target: "2.1.292",
          checkedAt: "2026-10-16T00:00:00Z",
        },
      }),
    ),
  );
  t.after(view.unmount);
  assert.match(view.container.textContent, /worker will update automatically/);
  assert.ok(view.button("Update Claude Code to stable"));
  assert.equal(view.button("Update Claude Code to stable").disabled, false);
  assert.doesNotMatch(view.container.textContent, /claude update/);
});

test("runtime updates cannot be started while offline or already updating", async (t) => {
  for (const [state, status] of [
    ["waiting_idle", "disconnected"],
    ["updating", "connected"],
  ]) {
    const view = await mount(
      health(
        cli({
          outdated: true,
          generation: "runtime-a",
          update: {
            state,
            target: "2.1.292",
            checkedAt: "2026-10-16T00:00:00Z",
          },
        }),
      ),
      { status },
    );
    t.after(view.unmount);
    assert.equal(view.button("Update Claude Code to stable").disabled, true);
  }
});
