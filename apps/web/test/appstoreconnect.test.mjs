import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://foundry.example/" });
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
  "HTMLFormElement",
  "MutationObserver",
  "ResizeObserver",
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
await import("../src/i18n/index.ts");
const { ConnectorsFeature } =
  await import("../src/features/external-accounts/index.ts");
const { AppStoreConnectConnector } =
  await import("../src/features/external-accounts/appstoreconnect-connector.tsx");

const iso = new Date().toISOString();
const connection = {
  appId: "xapp_asc",
  accountId: "xacc_asc",
  label: "Fixture team",
  issuerId: "11111111-2222-3333-4444-555555555555",
  keyId: "ABCDEF1234",
  hasKey: true,
  status: "ready",
  createdAt: iso,
  updatedAt: iso,
};
const apps = [
  {
    id: "123456789",
    name: "Fixture App",
    bundleId: "com.example.fixture",
    sku: "FIXTURE",
  },
  {
    id: "987654321",
    name: "Second App",
    bundleId: "com.example.second",
    sku: "SECOND",
  },
];
const provider = {
  kind: "appstoreconnect",
  label: "App Store Connect",
  credentialMode: "server_held",
  authMethods: ["api_key"],
  tools: ["asc"],
  accessLevels: [{ name: "read" }, { name: "commerce" }],
};
const account = {
  id: connection.accountId,
  provider: "appstoreconnect",
  appId: connection.appId,
  ownerUserId: "fixture-user",
  label: connection.label,
  mode: "server_held",
  status: "ready",
  subject: connection.issuerId,
  displayName: connection.label,
  workspaceIds: [],
  createdAt: iso,
  updatedAt: iso,
};

let routes = {};
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? "GET";
  const path = new URL(String(input), "https://foundry.example").pathname;
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ method, path, body });
  const handler =
    routes[`${method} ${path}`] ??
    (method === "GET" && path === "/api/connectors"
      ? () => [
          200,
          {
            connectors: [
              {
                kind: "appstoreconnect",
                label: "App Store Connect",
                holding: "server_held",
                adapter: "appstoreconnect",
                tool: { command: "asc" },
              },
            ],
          },
        ]
      : undefined);
  if (!handler)
    return new Response(
      JSON.stringify({ error: `no route ${method} ${path}` }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  const [status, answer] = handler(body);
  return new Response(JSON.stringify(answer), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

const mounted = new Set();
test.afterEach(async () => {
  for (const root of mounted) await act(async () => root.unmount());
  mounted.clear();
  window.document.body.innerHTML = "";
});

async function settle(ms = 0) {
  await act(async () => new Promise((done) => setTimeout(done, ms)));
}

async function render(component, props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  mounted.add(root);
  await act(async () => root.render(createElement(component, props)));
  await settle();
  const button = (text, scope = window.document.body) => {
    const found = [...scope.querySelectorAll("button, a")].find(
      (node) => node.textContent.trim() === text,
    );
    assert.ok(
      found,
      `button ${text}: ${[...scope.querySelectorAll("button, a")]
        .map((node) => node.textContent.trim())
        .join(" | ")}`,
    );
    return found;
  };
  const click = async (node) => {
    await act(async () => node.click());
    await settle();
  };
  const type = async (label, value) => {
    const field = [...window.document.body.querySelectorAll("label")].find(
      (row) => row.querySelector("span")?.textContent.startsWith(label),
    );
    const input =
      field?.querySelector("input, textarea") ??
      window.document.body.querySelector(`[aria-label="${label}"]`);
    assert.ok(input, `control ${label}`);
    const prototype =
      input instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value").set;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  return { container, button, click, type };
}

function baseRoutes() {
  return {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [provider],
        apps: [],
        accounts: [],
        secretsConfigured: true,
      },
    ],
    "GET /api/connectors/appstoreconnect/keys": () => [200, { keys: [] }],
  };
}

async function fillKeyDialog(
  page,
  privateKey = "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
) {
  await page.click(page.button("Add team key"));
  const dialog = window.document.body.querySelector("[role=dialog]");
  assert.ok(dialog);
  await page.click(page.button("Paste text", dialog));
  await page.type("Issuer ID", connection.issuerId);
  await page.type("Key ID", connection.keyId);
  await page.type("Private key (.p8)", privateKey);
  return dialog;
}

test("the key form validates, submits once, shows visible apps, then discards the .p8", async () => {
  requests.length = 0;
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nSECRET-FIXTURE\n-----END PRIVATE KEY-----";
  routes = {
    ...baseRoutes(),
    "POST /api/connectors/appstoreconnect/keys": () => [201, connection],
    "GET /api/connectors/appstoreconnect/accounts/xacc_asc/apps": () => [
      200,
      { apps },
    ],
    "GET /api/workspaces": () => [
      200,
      [
        {
          id: "ws_asc",
          name: "Fixture project",
          accessRole: "owner",
          deviceId: "dev_asc",
          localPath: "/fixture/asc",
        },
      ],
    ],
    "GET /api/devices": () => [
      200,
      [{ id: "dev_asc", label: "Fixture device" }],
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "appstoreconnect",
    onTabChange: () => {},
    currentUserId: "fixture-user",
    isAdmin: false,
    onNotice: () => {},
  });
  await page.click(page.button("Add team key"));
  const emptyDialog = window.document.body.querySelector("[role=dialog]");
  assert.ok(emptyDialog.querySelector('input[type="file"]'));
  await page.click(page.button("Validate and save", emptyDialog));
  assert.match(emptyDialog.textContent, /Issuer ID as a UUID/);
  assert.equal(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/connectors/appstoreconnect/keys",
    ),
    false,
  );
  await page.click(page.button("Paste text", emptyDialog));
  await page.type("Issuer ID", connection.issuerId);
  await page.type("Key ID", connection.keyId);
  await page.type("Private key (.p8)", privateKey);
  await page.click(page.button("Validate and save", emptyDialog));
  await settle(20);
  const submitted = requests.find(
    (request) =>
      request.method === "POST" &&
      request.path === "/api/connectors/appstoreconnect/keys",
  );
  assert.equal(submitted.body.privateKey, privateKey);
  assert.equal(window.document.body.querySelector("[role=dialog]"), null);
  assert.match(page.container.textContent, /Key validated · 2 apps visible/);
  assert.match(page.container.textContent, /Fixture App/);
  assert.match(page.container.textContent, /Second App/);
  assert.equal(
    window.document.body.innerHTML.includes("SECRET-FIXTURE"),
    false,
  );
});

test("a rejected key shows Apple's reason and requires a fresh .p8 to retry", async () => {
  requests.length = 0;
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nREJECTED\n-----END PRIVATE KEY-----";
  routes = {
    ...baseRoutes(),
    "POST /api/connectors/appstoreconnect/keys": () => [
      400,
      {
        error:
          "App Store Connect: The API key is not allowed to access this resource.: Grant the key App Manager access.",
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "appstoreconnect",
    onTabChange: () => {},
    currentUserId: "fixture-user",
    isAdmin: false,
    onNotice: () => {},
  });
  const dialog = await fillKeyDialog(page, privateKey);
  await page.click(page.button("Validate and save", dialog));
  await settle(20);
  assert.match(dialog.textContent, /Apple rejected this team key/);
  assert.match(dialog.textContent, /App Manager access/);
  assert.match(dialog.textContent, /last \.p8 was discarded/);
  assert.equal(window.document.body.innerHTML.includes("REJECTED"), false);
});

test("revoking a key needs an explicit second confirmation", async () => {
  requests.length = 0;
  let keys = [connection];
  routes = {
    ...baseRoutes(),
    "GET /api/connectors/appstoreconnect/keys": () => [200, { keys }],
    "GET /api/connectors/appstoreconnect/accounts/xacc_asc/apps": () => [
      200,
      { apps },
    ],
    "GET /api/workspaces": () => [
      200,
      [
        {
          id: "ws_asc",
          name: "Fixture project",
          accessRole: "owner",
          deviceId: "dev_asc",
          localPath: "/fixture/asc",
        },
      ],
    ],
    "GET /api/devices": () => [
      200,
      [{ id: "dev_asc", label: "Fixture device" }],
    ],
    "DELETE /api/connectors/appstoreconnect/keys/xapp_asc": () => {
      keys = [];
      return [
        200,
        {
          ...connection,
          hasKey: false,
          status: "revoked",
        },
      ];
    },
  };
  const page = await render(ConnectorsFeature, {
    tab: "appstoreconnect",
    onTabChange: () => {},
    currentUserId: "fixture-user",
    isAdmin: false,
    onNotice: () => {},
  });
  await page.click(page.button("Revoke key"));
  const dialog = window.document.body.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Revoke Fixture team\?/);
  assert.match(dialog.textContent, /immediately stops every session/);
  assert.equal(
    requests.some((request) => request.method === "DELETE"),
    false,
  );
  await page.click(page.button("Revoke and stop access", dialog));
  await settle(20);
  assert.deepEqual(requests.at(-2), {
    method: "DELETE",
    path: "/api/connectors/appstoreconnect/keys/xapp_asc",
    body: undefined,
  });
  assert.equal(requests.at(-1).path, "/api/connectors/appstoreconnect/keys");
  assert.match(page.container.textContent, /No App Store Connect team key/);
});

test("workspace binding saves selected apps and commerce access", async () => {
  requests.length = 0;
  let binding = undefined;
  const view = () => ({
    workspaceId: "ws_asc",
    accounts: [account],
    bindings: binding ? [binding] : [],
  });
  routes = {
    ...baseRoutes(),
    "GET /api/connectors/appstoreconnect/keys": () => [
      200,
      { keys: [connection] },
    ],
    "GET /api/connectors/appstoreconnect/accounts/xacc_asc/apps": () => [
      200,
      { apps },
    ],
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [provider],
        apps: [],
        accounts: [account],
        secretsConfigured: true,
      },
    ],
    "PUT /api/workspaces/ws_asc/external-accounts": (body) => {
      binding = {
        workspaceId: "ws_asc",
        accountId: body.accountIds[0],
        grantedBy: "fixture-user",
        resourceIds: body.resources[body.accountIds[0]],
        access: "",
        createdAt: iso,
      };
      return [200, view()];
    },
    "PUT /api/workspaces/ws_asc/external-accounts/xacc_asc/access": (body) => {
      binding = { ...binding, access: body.access };
      return [200, view()];
    },
  };
  const page = await render(AppStoreConnectConnector, {
    currentUserId: "fixture-user",
    workspaceId: "ws_asc",
    workspaceView: view(),
    onNotice: () => {},
  });
  const appRow = [...page.container.querySelectorAll("label")].find((label) =>
    label.textContent.includes("Fixture App"),
  );
  assert.ok(appRow);
  await page.click(appRow.querySelector("input[type=checkbox]"));
  await page.click(page.container.querySelector("input[value=commerce]"));
  await page.click(page.button("Save apps and access"));
  await settle(20);
  const bindingCall = requests.find(
    (request) =>
      request.method === "PUT" &&
      request.path === "/api/workspaces/ws_asc/external-accounts",
  );
  assert.deepEqual(bindingCall.body, {
    accountIds: ["xacc_asc"],
    resources: { xacc_asc: ["123456789"] },
  });
  assert.deepEqual(requests.at(-1), {
    method: "PUT",
    path: "/api/workspaces/ws_asc/external-accounts/xacc_asc/access",
    body: { access: "commerce" },
  });
});
