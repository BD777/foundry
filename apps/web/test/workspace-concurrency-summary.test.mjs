import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "http://127.0.0.1/workspace?workspace=wa",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "PopStateEvent",
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { WorkspaceConcurrencySummary } =
  await import("../src/features/workspaces/workspace-concurrency-summary.tsx");
const { createRoot } = await import("react-dom/client");

test("the workspace settings summary is read-only and links to device settings", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(WorkspaceConcurrencySummary, {
          device: {
            id: "dev_a",
            label: "Studio",
            status: "connected",
            lastSeenLabel: "online",
            runtimeSettings: {
              activeRuntimeTtlMs: 900000,
              mode: "forced",
              forcedLimit: 7,
            },
            runtimeState: {
              capturedAt: "2026-11-10T12:00:00Z",
              mode: "forced",
              limit: 8,
              running: 1,
              queued: 0,
              hardHold: false,
              reasons: ["forced_mode"],
              signals: {},
              estimates: [],
            },
          },
        }),
      ),
    );
    assert.match(
      container.textContent,
      /This device currently runs up to 8 turns at once \(forced\)\./,
    );
    assert.equal(container.querySelectorAll("input, button, select").length, 0);
    const link = container.querySelector("a");
    assert.ok(link);
    assert.equal(
      link.getAttribute("href"),
      "/devices/dev_a/settings?workspace=wa",
    );
    await act(async () => link.click());
    assert.equal(window.location.pathname, "/devices/dev_a/settings");
    assert.equal(window.location.search, "?workspace=wa");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
