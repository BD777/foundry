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
  "MutationObserver",
  "ResizeObserver",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === "window" ? window : window[key],
  });

const { createRoot } = await import("react-dom/client");
const { DetectedProfilesPanel } =
  await import("../src/features/devices/detected-profiles-panel.tsx");

function profile(overrides) {
  return {
    id: "codex_local",
    deviceId: "dev_1",
    runtime: "codex",
    label: "Codex Local",
    status: "healthy",
    authMode: "local_config",
    secretStored: "local",
    configScope: "device",
    configLabel: "device local login",
    connectionType: "local_login",
    origin: "device",
    lastSeenLabel: "online",
    ...overrides,
  };
}

async function render(profiles) {
  const host = window.document.createElement("div");
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(DetectedProfilesPanel, {
        detectedProfiles: profiles,
        device: { id: "dev_1", label: "darwin-arm64" },
        onPromote: () => {},
        serverProfileCount: 0,
      }),
    );
  });
  return { host, root };
}

test("a signed-in local login names its account", async () => {
  const { host, root } = await render([
    profile({ accountLabel: "person@example.com" }),
  ]);

  assert.match(host.textContent, /Signed in as person@example\.com/);

  await act(async () => root.unmount());
});

test("a login with no account falls back to why it is unusable", async () => {
  const { host, root } = await render([
    profile({
      status: "missing_auth",
      authMode: "missing",
      statusDetail: "Codex is not signed in on this device.",
    }),
  ]);

  assert.match(host.textContent, /Codex is not signed in on this device\./);
  assert.doesNotMatch(host.textContent, /Signed in as/);

  await act(async () => root.unmount());
});
