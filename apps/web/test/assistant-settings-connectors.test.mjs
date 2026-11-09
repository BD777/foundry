import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/assistant/settings/connectors",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "localStorage",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLDivElement",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "PopStateEvent",
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
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

const initialConnectors = [
  {
    id: "acct_feishu",
    kind: "feishu",
    label: "Work Feishu",
    holding: "server_held",
    status: "ready",
    enabled: true,
  },
  {
    id: "dev_mac:aws",
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    deviceId: "dev_mac",
    deviceName: "MacBook",
    status: "ready",
    enabled: true,
  },
];

let connectors = initialConnectors;
let failSave = false;
let calls = [];

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, path: url.pathname, body });
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (method === "GET" && url.pathname === "/api/personal-agent/connectors")
    return json({ connectors });
  if (method === "PUT" && url.pathname === "/api/personal-agent/connectors") {
    if (failSave) return json({ error: "Synthetic save failure" }, 500);
    connectors = connectors.map((connector) => ({
      ...connector,
      enabled: !body.disabled.includes(connector.id),
    }));
    return json({ connectors });
  }
  throw new Error(`unexpected ${method} ${url.pathname}`);
};

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { ToastProvider } = await import("../src/components/ui/toast.tsx");
const { ConnectorsSection } =
  await import("../src/features/personal-agent/settings-connectors.tsx");

async function settle() {
  for (let index = 0; index < 4; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render() {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(ToastProvider, null, createElement(ConnectorsSection)),
    ),
  );
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1)
    await act(async () => new Promise((done) => setTimeout(done, 25)));
}

function connectorSwitch(container, label) {
  const found = container.querySelector(
    `[role="switch"][aria-label="Let the Assistant use ${label}"]`,
  );
  assert.ok(found, `no switch for ${label}`);
  return found;
}

test("connector accounts render in server then device groups with their saved switch state", async () => {
  connectors = initialConnectors.map((connector, index) => ({
    ...connector,
    enabled: index === 0,
  }));
  calls = [];
  const page = await render();
  assert.match(
    page.container.textContent,
    /The Assistant can use these accounts\. New accounts are on by default\./,
  );
  assert.deepEqual(
    [...page.container.querySelectorAll("h3")].map((heading) =>
      heading.textContent.trim(),
    ),
    ["Server accounts", "MacBook"],
  );
  assert.match(page.container.textContent, /feishu · Ready/);
  assert.match(page.container.textContent, /aws · on MacBook/);
  assert.equal(
    connectorSwitch(page.container, "Work Feishu").getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    connectorSwitch(page.container, "AWS CLI").getAttribute("aria-checked"),
    "false",
  );
  await page.unmount();
});

test("toggling connector accounts sends the full disabled account list", async () => {
  connectors = initialConnectors.map((connector) => ({
    ...connector,
    enabled: true,
  }));
  calls = [];
  const page = await render();
  await act(async () => connectorSwitch(page.container, "Work Feishu").click());
  await settle();
  await act(async () => connectorSwitch(page.container, "AWS CLI").click());
  await settle();
  assert.deepEqual(
    calls.filter((call) => call.method === "PUT").map((call) => call.body),
    [
      { disabled: ["acct_feishu"] },
      { disabled: ["acct_feishu", "dev_mac:aws"] },
    ],
  );
  assert.equal(
    connectorSwitch(page.container, "Work Feishu").getAttribute("aria-checked"),
    "false",
  );
  assert.equal(
    connectorSwitch(page.container, "AWS CLI").getAttribute("aria-checked"),
    "false",
  );
  await page.unmount();
});

test("a failed connector save reverts the switch and shows the error inline", async () => {
  connectors = initialConnectors.map((connector) => ({
    ...connector,
    enabled: true,
  }));
  failSave = true;
  calls = [];
  const page = await render();
  await act(async () => connectorSwitch(page.container, "AWS CLI").click());
  await settle();
  await until(() =>
    /Could not change this connector/.test(page.container.textContent),
  );
  assert.equal(
    connectorSwitch(page.container, "AWS CLI").getAttribute("aria-checked"),
    "true",
  );
  assert.match(page.container.textContent, /Could not change this connector/);
  assert.match(page.container.textContent, /Synthetic save failure/);
  assert.deepEqual(
    calls.filter((call) => call.method === "PUT").map((call) => call.body),
    [{ disabled: ["dev_mac:aws"] }],
  );
  failSave = false;
  await page.unmount();
});
