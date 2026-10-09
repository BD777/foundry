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
const { DeviceDiagnostics } =
  await import("../src/features/devices/device-diagnostics.tsx");

const device = {
  id: "dev_diag",
  label: "byte-dev",
  status: "connected",
  owned: true,
  lastDisconnect: {
    at: "2026-10-09T08:00:00Z",
    serverReason: "read tcp 10.0.0.1:443: i/o timeout",
    worker: {
      openedAt: "2026-10-09T07:58:46Z",
      closedAt: "2026-10-09T08:00:00Z",
      durationMs: 74_000,
      closedBy: "worker",
      sinceServerDataMs: 75_000,
    },
  },
};

const report = {
  generatedAt: "2026-10-09T08:05:00Z",
  workerVersion: "0.9.0",
  checks: [
    {
      id: "connection.server",
      status: "ok",
      values: { url: "https://dev.example", ms: 40, status: 200 },
    },
    {
      id: "connection.drops",
      status: "warn",
      values: { count: 3, last: "8:00", silentServer: 3 },
    },
    {
      id: "workspaces.missing",
      status: "warn",
      values: { count: 1, paths: "/gone" },
    },
  ],
  connections: [],
  logTail: ["[err] boom"],
};

async function setup(props = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const refreshed = [];
  await act(() =>
    root.render(
      createElement(DeviceDiagnostics, {
        device,
        onRefresh: async () => refreshed.push(true),
        ...props,
      }),
    ),
  );
  const button = (text) =>
    [...container.querySelectorAll("button")].find((row) =>
      row.textContent.includes(text),
    );
  return {
    container,
    refreshed,
    button,
    cleanup: async () => {
      await act(() => root.unmount());
      container.remove();
    },
  };
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method: options?.method, body });
    return new Response(JSON.stringify(handler(String(url), body)), {
      status: 200,
    });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

test("shows the last disconnect from both ends before anything runs", async () => {
  const view = await setup();
  try {
    const text = view.container.textContent;
    assert.match(text, /Last disconnect:/);
    assert.match(text, /i\/o timeout/);
    assert.match(text, /lasted 74/);
    assert.ok(view.button("Run diagnostics"));
    assert.equal(view.button("Copy report"), undefined);
  } finally {
    await view.cleanup();
  }
});

test("running shows grouped checks with advice only for problems", async () => {
  const fetch = mockFetch(() => report);
  const view = await setup();
  try {
    await act(() => view.button("Run diagnostics").click());
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].method, "POST");
    assert.match(fetch.calls[0].url, /\/api\/devices\/dev_diag\/diagnostics$/);
    const headings = [...view.container.querySelectorAll("h3")].map(
      (row) => row.textContent,
    );
    assert.deepEqual(headings, ["Connection", "Workspaces", "Repairs"]);
    const text = view.container.textContent;
    assert.match(text, /answered in 40 ms/);
    assert.match(text, /3 drops/);
    assert.match(text, /proxy between this device and the server/);
    assert.match(text, /Worker log \(1 line/);
    assert.ok(view.button("Copy report"));
    assert.ok(view.button("Forget 1 missing folder"));
  } finally {
    fetch.restore();
    await view.cleanup();
  }
});

test("a repair needs confirmation, then refreshes the device", async () => {
  const fetch = mockFetch(() => ({
    action: "clear-skill-scan-cache",
  }));
  const view = await setup();
  try {
    await act(() => view.button("Clear the skill scan cache").click());
    assert.equal(fetch.calls.length, 0);
    await act(() => view.button("Rescan every skill from scratch").click());
    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0].url, /\/repairs$/);
    assert.deepEqual(fetch.calls[0].body, { action: "clear-skill-scan-cache" });
    assert.equal(view.refreshed.length, 1);
    assert.match(view.container.textContent, /Cleared; the next skill scan/);
  } finally {
    fetch.restore();
    await view.cleanup();
  }
});

test("offline devices cannot run diagnostics or repairs", async () => {
  const view = await setup({ device: { ...device, status: "disconnected" } });
  try {
    assert.equal(view.button("Run diagnostics").disabled, true);
    assert.match(view.container.textContent, /offline/);
  } finally {
    await view.cleanup();
  }
});
