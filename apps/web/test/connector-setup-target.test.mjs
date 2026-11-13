import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({
  url: "http://localhost/connectors/gateway?setup=dev_1&ws=w1",
});
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
  });
test.after(() => window.happyDOM.close());
const { takeConnectorSetup } = await import("../src/lib/in-app-navigation.ts");
const { DeviceConnectorRow } =
  await import("../src/features/external-accounts/device-connector-row.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");

test("a setup link names its device once and leaves the rest of the address", () => {
  assert.equal(takeConnectorSetup(), "dev_1");
  assert.equal(window.location.search, "?ws=w1");
  assert.equal(takeConnectorSetup(), undefined);
});

test("the targeted row is marked and focuses its next step; nothing runs until a click", () => {
  let signIns = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = {
    connector: {
      kind: "gateway",
      label: "Gateway",
      tool: { command: "gateway", source: "device" },
      signIn: { methods: [{ id: "guided", kind: "guided" }] },
    },
    distinguishDevice: false,
    device: { deviceId: "dev_1", name: "server", online: true, states: [] },
    state: {
      kind: "gateway",
      status: "signed_out",
      installed: true,
      signedIn: false,
      checkedAt: new Date().toISOString(),
    },
    busy: false,
    onState: () => {},
    onCheck: () => {},
    onSignIn: () => (signIns += 1),
    onSignOut: () => {},
    setupTarget: true,
  };
  act(() =>
    root.render(
      createElement("ul", null, createElement(DeviceConnectorRow, props)),
    ),
  );
  const row = host.querySelector("li");
  assert.equal(row.getAttribute("data-setup-target"), "true");
  assert.match(row.textContent, /From the setup panel/);
  const focused = document.activeElement;
  assert.equal(focused?.textContent, "Sign in");
  assert.equal(signIns, 0);
  act(() => focused.click());
  assert.equal(signIns, 1);

  act(() =>
    root.render(
      createElement(
        "ul",
        null,
        createElement(DeviceConnectorRow, { ...props, setupTarget: false }),
      ),
    ),
  );
  assert.equal(
    host.querySelector("li").getAttribute("data-setup-target"),
    null,
  );
  act(() => root.unmount());
});

test("focus follows the targeted row's next step once its reading arrives", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const base = {
    connector: {
      kind: "gateway",
      label: "Gateway",
      tool: { command: "gateway", source: "device" },
      signIn: { methods: [{ id: "guided", kind: "guided" }] },
    },
    distinguishDevice: false,
    device: { deviceId: "dev_1", name: "server", online: true, states: [] },
    busy: false,
    onState: () => {},
    onCheck: () => {},
    onSignIn: () => {},
    onSignOut: () => {},
    setupTarget: true,
  };
  const draw = (props) =>
    act(() =>
      root.render(
        createElement("ul", null, createElement(DeviceConnectorRow, props)),
      ),
    );
  draw(base);
  assert.equal(document.activeElement?.textContent, "Check again");
  draw({
    ...base,
    state: {
      kind: "gateway",
      status: "signed_out",
      installed: true,
      signedIn: false,
      checkedAt: new Date().toISOString(),
    },
  });
  assert.equal(document.activeElement?.textContent, "Sign in");
  act(() => root.unmount());
});
