import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { closeRadixDialogs, flushRadixTimers } from "./radix-cleanup.mjs";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/connectors/acme-api",
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
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLDivElement",
  "HTMLFormElement",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "FocusEvent",
  "NodeFilter",
  "DOMRect",
  "PopStateEvent",
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
const { i18n } = await import("../src/i18n/index.ts");
const { ConnectorsFeature, WorkspaceConnectorsFeature } =
  await import("../src/features/external-accounts/index.ts");

const now = Date.now();
const iso = (offset = 0) => new Date(now + offset).toISOString();
const descriptor = {
  kind: "acme-api",
  label: "Acme API",
  labels: { "zh-CN": "Acme API" },
  description: "Read Acme projects through Foundry's server-held gateway.",
  descriptions: {
    "zh-CN": "经 Foundry 的服务器保管网关读取 Acme 项目。",
  },
  holding: "server_held",
  adapter: "extension:acme",
  tool: { command: "acme", source: "device" },
  extension: { id: "acme", name: "Acme tools", version: "1.0.0" },
  serverHeld: {
    instances: "many",
    fields: [
      {
        id: "baseUrl",
        type: "url",
        required: true,
        label: "Acme HTTPS address",
        help: "Use the public HTTPS root. Read [the setup guide](https://docs.acme.example) before generating an `ACME_READ_TOKEN`.",
        placeholder: "https://acme.example.com",
      },
      {
        id: "readToken",
        type: "secret",
        required: true,
        label: "Read token",
        help: "Run `acme token create --read` on the server, then paste the value here.",
        placeholder: "ACME_READ_TOKEN",
      },
      {
        id: "account",
        type: "select",
        required: false,
        label: "Project account",
        help: "Leave empty for the primary account or choose one after validation.",
        optionsFrom: "probe:accounts",
      },
    ],
    steps: [["baseUrl", "readToken"], ["account"]],
    probe: [
      {
        id: "capabilities",
        method: "GET",
        path: "/v1/capabilities",
        extract: {
          values: { scope: "/token/scope" },
        },
      },
      {
        id: "accounts",
        method: "GET",
        path: "/v1/accounts",
        extract: {
          values: { version: "/version" },
          options: {
            items: "/accounts",
            value: "/id",
            label: "/name",
          },
        },
      },
      {
        id: "routes",
        method: "GET",
        path: "/v1/",
        extract: {
          routes: {
            items: "/routes",
            method: "/method",
            path: "/path",
            access: "/access",
          },
        },
      },
    ],
    upstream: {
      baseField: "baseUrl",
      pathPrefix: "/v1",
      headers: { Authorization: "Bearer {secret:readToken}" },
    },
    access: {
      from: "probe:routes",
      default: "deny",
      allowBy: {
        value: "probe:capabilities/scope",
        map: { full: ["read", "write"], read: ["read"] },
        otherwise: ["read"],
      },
    },
    session: {
      env: {
        ACME_API_BASE: "{gatewayBase}",
        ACME_API_TOKEN: "{standIn}",
        ACME_API_READ_ONLY: "{probeMap:capabilities/scope|full=0|*=1}",
      },
    },
    network: { holdings: ["server", "device"], publicOnly: true },
  },
};

const fieldOptions = {
  account: [
    { value: "primary", label: "Primary account" },
    { value: "research", label: "Research account" },
  ],
};

function instance(overrides = {}) {
  return {
    id: "inst_acme",
    accountId: "xacc_acme",
    kind: "acme-api",
    label: "Production",
    network: "server",
    status: "ready",
    statusDetail: "ok",
    access: "write",
    version: "2026.11",
    routeCount: 6,
    values: { baseUrl: "https://acme.example.com", account: "primary" },
    secretFields: ["readToken"],
    fieldOptions,
    probeValues: { version: "2026.11" },
    createdAt: iso(-86_400_000),
    updatedAt: iso(-60_000),
    ...overrides,
  };
}

function workspaceAccount(overrides = {}) {
  return {
    id: "xacc_acme",
    provider: "acme-api",
    appId: "app_acme",
    ownerUserId: "u_me",
    label: "Production",
    displayName: "Production",
    mode: "server_held",
    status: "ready",
    workspaceIds: [],
    createdAt: iso(-86_400_000),
    updatedAt: iso(-60_000),
    ...overrides,
  };
}

function probeResult(overrides = {}) {
  return {
    values: {
      baseUrl: "https://acme.example.com",
    },
    secretFields: ["readToken"],
    probeValues: { version: "2026.11" },
    fieldOptions,
    version: "2026.11",
    routeCount: 6,
    ...overrides,
  };
}

let api;
let requests = [];

function routes(overrides = {}) {
  return {
    "GET /api/connectors": {
      body: {
        connectors: [
          {
            kind: "feishu",
            label: "Feishu",
            holding: "server_held",
            adapter: "feishu",
            tool: { command: "feishu-cli" },
          },
          descriptor,
        ],
      },
    },
    "GET /api/connectors/devices": {
      body: { connectors: [], devices: [] },
    },
    "GET /api/external-accounts": {
      body: {
        providers: [],
        apps: [],
        accounts: [workspaceAccount()],
        secretsConfigured: true,
      },
    },
    "GET /api/connectors/extensions/acme-api/instances": {
      body: {
        kind: "acme-api",
        descriptor,
        instances: [instance()],
        devices: [
          { deviceId: "dev_mac", name: "Alice's Mac", online: true },
          { deviceId: "dev_nas", name: "Office NAS", online: false },
        ],
      },
    },
    "POST /api/connectors/extensions/acme-api/instances/probe": {
      body: probeResult(),
    },
    "POST /api/connectors/extensions/acme-api/instances": {
      status: 201,
      body: instance({ id: "inst_new", label: "Staging" }),
    },
    "PUT /api/connectors/extensions/acme-api/instances/inst_acme": {
      body: instance({ label: "Production", status: "ready" }),
    },
    "POST /api/connectors/extensions/acme-api/instances/inst_acme/check": {
      body: instance({ updatedAt: iso(0) }),
    },
    "DELETE /api/connectors/extensions/acme-api/instances/inst_acme": {
      body: instance({ status: "revoked", statusDetail: "revoked" }),
    },
    "GET /api/workspaces/ws_1/external-accounts": {
      body: {
        workspaceId: "ws_1",
        accounts: [workspaceAccount()],
        bindings: [],
      },
    },
    "PUT /api/workspaces/ws_1/external-accounts": {
      body: {
        workspaceId: "ws_1",
        accounts: [workspaceAccount()],
        bindings: [
          {
            workspaceId: "ws_1",
            accountId: "xacc_acme",
            grantedBy: "u_me",
          },
        ],
      },
    },
    ...overrides,
  };
}

globalThis.fetch = async (input, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  const url = new URL(String(input), "https://foundry.example");
  const body = init.body ? JSON.parse(init.body) : undefined;
  requests.push({ method, path: url.pathname + url.search, body });
  const route = api[`${method} ${url.pathname}`];
  if (!route) {
    return new Response(
      JSON.stringify({ error: `no route ${method} ${url.pathname}` }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  const answer = typeof route === "function" ? await route(body) : route;
  return new Response(JSON.stringify(answer.body), {
    status: answer.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
};

async function settle() {
  for (let index = 0; index < 6; index += 1)
    await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render(component, props) {
  window.document.body.replaceChildren();
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, props)));
  await settle();
  const button = (text, scope = window.document.body) => {
    const found = [...scope.querySelectorAll("button, a")].find(
      (node) => node.textContent.replace(/\s+/g, " ").trim() === text,
    );
    assert.ok(
      found,
      `button ${text}: ${[...scope.querySelectorAll("button")]
        .map((node) => node.textContent.replace(/\s+/g, " ").trim())
        .join(" | ")}`,
    );
    return found;
  };
  const click = async (node) => {
    await act(async () => node.click());
    await settle();
  };
  const input = (label) => {
    const all = [
      ...window.document.querySelectorAll("input:not([type=checkbox])"),
    ];
    const found = all.find(
      (node) =>
        node.labels?.[0]?.textContent
          .replace(/\s+/g, " ")
          .replace(/\s*\*\s*$/, "")
          .trim() === label || node.getAttribute("aria-label") === label,
    );
    assert.ok(
      found,
      `input ${label}: ${all
        .map(
          (node) =>
            node.labels?.[0]?.textContent ??
            node.getAttribute("aria-label") ??
            node.placeholder,
        )
        .join(" | ")}`,
    );
    return found;
  };
  const fill = async (label, value) => {
    const node = input(label);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(node, value);
      node.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await settle();
  };
  const unmount = async () => {
    await closeRadixDialogs(window);
    await act(async () => root.unmount());
    container.remove();
    await flushRadixTimers(window);
    window.document.body.replaceChildren();
  };
  return { container, button, click, fill, input, unmount };
}

const connectorProps = {
  tab: "acme-api",
  onTabChange: () => {},
  currentUserId: "u_me",
  isAdmin: false,
  onNotice: () => {},
};

test("a server-held extension appears under Private and its form is generated from the descriptor", async () => {
  await i18n.changeLanguage("en");
  api = routes();
  requests = [];
  const page = await render(ConnectorsFeature, connectorProps);
  const trigger = page.container.querySelector('[role="combobox"]');
  assert.equal(trigger.getAttribute("aria-label"), "Connector: Acme API");
  await page.click(trigger);
  const groups = [...window.document.querySelectorAll("[cmdk-group]")];
  const privateGroup = groups.find((group) =>
    group.textContent.includes("From connector extensions on your devices"),
  );
  const publicGroup = groups.find((group) =>
    group.textContent.includes("Built into Foundry"),
  );
  assert.ok(privateGroup);
  assert.ok(publicGroup);
  assert.match(privateGroup.textContent, /Acme API/);
  assert.doesNotMatch(publicGroup.textContent, /Acme API/);
  await act(async () =>
    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    ),
  );
  await settle();

  await page.click(page.button("Add instance"));
  assert.match(window.document.body.textContent, /Step 1 of 3/);
  assert.match(window.document.body.textContent, /Foundry server direct/);
  await page.click(page.button("Continue"));
  assert.match(window.document.body.textContent, /Step 2 of 3/);
  assert.equal(
    page.input("Acme HTTPS address").placeholder,
    "https://acme.example.com",
  );
  assert.equal(page.input("Read token").placeholder, "ACME_READ_TOKEN");
  assert.equal(
    page.input("Read token").className.includes("fdy-field-boxed"),
    true,
  );
  const help = window.document.querySelector(".fdy-markdown");
  assert.ok(help);
  const setupLink = help.querySelector("a");
  assert.equal(setupLink?.textContent, "the setup guide", help.innerHTML);
  assert.equal(setupLink?.getAttribute("href"), "https://docs.acme.example/");
  assert.ok(window.document.querySelector("code"));
  await page.unmount();
});

test("server-held instances show the permission found during validation", async () => {
  await i18n.changeLanguage("en");
  api = routes({
    "GET /api/connectors/extensions/acme-api/instances": {
      body: {
        kind: "acme-api",
        descriptor,
        instances: [
          instance({ id: "inst_write", access: "write" }),
          instance({
            id: "inst_read",
            accountId: "xacc_read",
            label: "Production read-only",
            access: "read",
          }),
        ],
      },
    },
  });
  const page = await render(ConnectorsFeature, connectorProps);
  assert.match(page.container.textContent, /Read\/write/);
  assert.match(page.container.textContent, /Read-only/);
  await page.unmount();
});

test("validate probes the first step, then loads select options from that result", async () => {
  await i18n.changeLanguage("en");
  requests = [];
  api = routes({
    "POST /api/connectors/extensions/acme-api/instances": (body) => ({
      status: 201,
      body: instance({
        id: "inst_new",
        label: body.label,
        values: body.fields,
      }),
    }),
  });
  const page = await render(ConnectorsFeature, connectorProps);
  await page.click(page.button("Add instance"));
  await page.click(page.button("Continue"));
  await page.fill("Instance name", "Staging");
  await page.fill("Acme HTTPS address", "https://staging.acme.example");
  await page.fill("Read token", "acme-secret");
  await page.click(page.button("Validate"));

  const probe = requests.find(
    (request) =>
      request.method === "POST" && request.path.endsWith("/instances/probe"),
  );
  assert.deepEqual(probe.body, {
    label: "Staging",
    network: "server",
    fields: {
      baseUrl: "https://staging.acme.example",
      readToken: "acme-secret",
      account: "",
    },
  });
  assert.match(window.document.body.textContent, /Step 3 of 3/);
  assert.match(
    window.document.body.textContent,
    /Probe passed · 6 allowed routes/,
  );
  assert.doesNotMatch(window.document.body.textContent, /acme-secret/);

  const account = window.document.querySelector(
    '[aria-label="Project account"]',
  );
  assert.ok(account);
  await act(async () =>
    account.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await settle();
  const option = [
    ...window.document.querySelectorAll('[role="menuitemradio"]'),
  ].find((node) =>
    node.textContent.replace(/\s+/g, " ").includes("Research account"),
  );
  assert.ok(option);
  await page.click(option);
  await page.click(page.button("Validate and add"));
  const create = requests.find(
    (request) =>
      request.method === "POST" &&
      request.path === "/api/connectors/extensions/acme-api/instances",
  );
  assert.deepEqual(create.body, {
    label: "Staging",
    network: "server",
    fields: {
      baseUrl: "https://staging.acme.example",
      readToken: "acme-secret",
      account: "research",
    },
  });
  assert.match(page.container.textContent, /Staging/);
  await page.unmount();
});

test("a device-network instance chooses an online validation device", async () => {
  await i18n.changeLanguage("en");
  requests = [];
  api = routes();
  const page = await render(ConnectorsFeature, connectorProps);
  await page.click(page.button("Add instance"));
  await page.click(page.button("Via a device (internal)"));
  const choose = page.button("Alice's Mac");
  assert.ok(choose, window.document.body.textContent);
  await page.click(page.button("Continue"));
  await page.fill("Acme HTTPS address", "http://10.37.93.185/openlark");
  await page.fill("Read token", "intranet-secret");
  await page.click(page.button("Validate"));
  const probe = requests.find((request) =>
    request.path.endsWith("/instances/probe"),
  );
  assert.deepEqual(
    {
      network: probe.body.network,
      deviceId: probe.body.deviceId,
      baseUrl: probe.body.fields.baseUrl,
    },
    {
      network: "device",
      deviceId: "dev_mac",
      baseUrl: "http://10.37.93.185/openlark",
    },
  );
  await page.unmount();
});

test("probe failures are grouped into readable causes instead of raw upstream output", async () => {
  await i18n.changeLanguage("en");
  api = routes({
    "POST /api/connectors/extensions/acme-api/instances/probe": {
      status: 400,
      body: {
        error:
          "the connector rejected the credential: internal debug dump api_key=not-shown",
      },
    },
  });
  const page = await render(ConnectorsFeature, connectorProps);
  await page.click(page.button("Add instance"));
  await page.click(page.button("Continue"));
  await page.fill("Acme HTTPS address", "https://bad.acme.example");
  await page.fill("Read token", "wrong-token");
  await page.click(page.button("Validate"));
  assert.match(window.document.body.textContent, /Credential rejected/);
  assert.match(
    window.document.body.textContent,
    /Replace the token or secret, then validate again/,
  );
  assert.match(window.document.body.textContent, /Step 2 of 3/);
  await page.unmount();
});

test("replace token keeps a sealed secret blank, and revoke states the consequences before deleting it", async () => {
  await i18n.changeLanguage("en");
  requests = [];
  api = routes();
  const page = await render(ConnectorsFeature, connectorProps);
  await page.click(page.button("Replace token"));
  await page.click(page.button("Continue"));
  assert.match(
    window.document.body.textContent,
    /Replace Acme API credentials/,
  );
  assert.equal(
    page.input("Read token").placeholder,
    "Leave blank to keep the sealed value",
  );
  assert.equal(page.input("Read token").value, "");
  await page.click(page.button("Validate"));
  const probe = requests.find((request) => request.path.endsWith("/probe"));
  assert.equal(probe.body.fields.readToken, "");
  await act(async () =>
    window.document.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      }),
    ),
  );
  await settle();

  await page.click(page.button("Revoke"));
  assert.match(window.document.body.textContent, /Revoke Production?/);
  assert.match(
    window.document.body.textContent,
    /immediately stops every session using this instance and removes its workspace bindings/,
  );
  assert.equal(
    requests.some((request) => request.method === "DELETE"),
    false,
  );
  await page.click(page.button("Revoke and stop access"));
  assert.equal(
    requests.filter((request) => request.method === "DELETE").length,
    1,
  );
  assert.match(page.container.textContent, /Revoked/);
  await page.unmount();
});

test("a workspace can bind the server-held instance through its account id", async () => {
  await i18n.changeLanguage("en");
  requests = [];
  api = routes();
  const page = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    onNotice: () => {},
  });
  const section = page.container.querySelector('[aria-label="Acme API"]');
  assert.ok(section);
  assert.match(
    section.textContent,
    /Choose which of your Acme API instances this workspace may use/,
  );
  const checkbox = section.querySelector('input[type="checkbox"]');
  assert.ok(checkbox);
  await page.click(checkbox);
  const call = requests.find(
    (request) =>
      request.method === "PUT" &&
      request.path === "/api/workspaces/ws_1/external-accounts",
  );
  assert.deepEqual(call.body, { accountIds: ["xacc_acme"] });
  assert.equal(checkbox.checked, true);
  await page.unmount();
});
