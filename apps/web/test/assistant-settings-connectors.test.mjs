import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement, useState } from "react";

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
    level: "write",
    enabled: true,
  },
  {
    id: "acct_analytics",
    kind: "cloudflare",
    label: "Analytics",
    holding: "server_held",
    status: "ready",
    level: "read",
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
    level: "off",
    enabled: false,
  },
];

const tenantConnectors = [
  {
    id: "acct_feishu_cn",
    kind: "feishu",
    label: "Ada",
    displayName: "Ada",
    appName: "Foundry Agent",
    tenantName: "Acme China",
    holding: "server_held",
    status: "ready",
    level: "off",
    enabled: false,
  },
  {
    id: "acct_feishu_global",
    kind: "feishu",
    label: "Ada",
    displayName: "Ada",
    appName: "Foundry Agent",
    tenantName: "Acme Global",
    holding: "server_held",
    status: "ready",
    level: "off",
    enabled: false,
  },
];

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
    return json({ connectors: initialConnectors });
  if (method === "PUT" && url.pathname === "/api/personal-agent/connectors") {
    return json({ connectors: initialConnectors });
  }
  throw new Error(`unexpected ${method} ${url.pathname}`);
};

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { connectorLevels, ConnectorsSection } =
  await import("../src/features/personal-agent/settings-connectors.tsx");
const { setPersonalAgentConnectors } =
  await import("../src/api/personal-agent.ts");

async function settle() {
  for (let index = 0; index < 4; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render(component = ConnectorsSection, props = {}) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, props)));
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function accessControl(container, label) {
  const found = container.querySelector(
    `[aria-label="Access level for ${label}"]`,
  );
  assert.ok(found, `no access levels for ${label}`);
  return found;
}

function levelRadio(container, label, level) {
  const found = [
    ...accessControl(container, label).querySelectorAll("[role=radio]"),
  ].find((node) => node.textContent.trim() === level);
  assert.ok(found, `no ${level} level for ${label}`);
  return found;
}

test("connector accounts render in server then device groups with all three saved levels", async () => {
  const page = await render(ConnectorsSection, {
    connectors: initialConnectors,
    loadError: "",
    onChange: () => {},
    onRetry: () => {},
  });
  assert.match(
    page.container.textContent,
    /Deleting, sending messages outward, DNS changes, and App Store Connect changes ask you first/,
  );
  assert.deepEqual(
    [...page.container.querySelectorAll("h3")].map((heading) =>
      heading.textContent.trim(),
    ),
    ["Server accounts", "MacBook"],
  );
  assert.equal(
    levelRadio(page.container, "Work Feishu", "Read/write").getAttribute(
      "aria-checked",
    ),
    "true",
  );
  assert.equal(
    levelRadio(page.container, "Analytics", "Read only").getAttribute(
      "aria-checked",
    ),
    "true",
  );
  assert.equal(
    levelRadio(page.container, "AWS CLI", "Off").getAttribute("aria-checked"),
    "true",
  );
  await page.unmount();
});

test("same-named accounts show their organisations and a new assistant starts off", async () => {
  const page = await render(ConnectorsSection, {
    connectors: tenantConnectors,
    loadError: "",
    newAssistant: true,
    onChange: () => {},
    onRetry: () => {},
  });
  const names = [...page.container.querySelectorAll("p")]
    .map((node) => node.textContent.trim())
    .filter((text) => text === "Ada");
  assert.equal(names.length, 2);
  assert.match(
    page.container.textContent,
    /Acme China · Foundry Agent · feishu · Ready/,
  );
  assert.match(
    page.container.textContent,
    /Acme Global · Foundry Agent · feishu · Ready/,
  );
  assert.match(
    page.container.textContent,
    /New assistants cannot use any account by default/,
  );
  assert.equal(
    levelRadio(
      page.container,
      "Ada · Acme China · Foundry Agent",
      "Off",
    ).getAttribute("aria-checked"),
    "true",
  );
  await page.unmount();
});

test("choosing read for a device-held account explains that writes are not isolated yet", async () => {
  const changes = [];
  function Harness() {
    const [connectors, setConnectors] = useState(
      initialConnectors.map((connector) => ({
        ...connector,
        level: connector.id === "dev_mac:aws" ? "write" : connector.level,
      })),
    );
    return createElement(ConnectorsSection, {
      connectors,
      loadError: "",
      onChange: (accountId, level) => {
        changes.push({ accountId, level });
        setConnectors((current) =>
          current.map((connector) =>
            connector.id === accountId ? { ...connector, level } : connector,
          ),
        );
      },
      onRetry: () => {},
    });
  }
  const page = await render(Harness);
  assert.doesNotMatch(
    page.container.textContent,
    /Read-only cannot block writes for this account yet/,
  );
  await act(async () =>
    levelRadio(page.container, "AWS CLI", "Read only").click(),
  );
  await settle();
  assert.deepEqual(changes, [{ accountId: "dev_mac:aws", level: "read" }]);
  assert.match(
    page.container.textContent,
    /Foundry cannot stop writes through an account that lives on a device yet/,
  );
  assert.doesNotMatch(
    page.container.textContent,
    /Read-only cannot block writes for this account yet.*Analytics/s,
  );
  await page.unmount();
});

test("saving sends every account's three-state level as the full replacement payload", async () => {
  calls = [];
  await setPersonalAgentConnectors(
    undefined,
    connectorLevels(initialConnectors),
  );
  assert.deepEqual(
    calls.filter((call) => call.method === "PUT").map((call) => call.body),
    [
      {
        levels: [
          { accountId: "acct_feishu", level: "write" },
          { accountId: "acct_analytics", level: "read" },
          { accountId: "dev_mac:aws", level: "off" },
        ],
      },
    ],
  );
});
