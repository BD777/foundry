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
const { ConnectorsFeature, WorkspaceAccountsFeature } =
  await import("../src/features/external-accounts/index.ts");

const hour = 3_600_000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
const feishu = {
  kind: "feishu",
  label: "Feishu",
  credentialMode: "server_held",
  authMethods: ["oauth_device"],
  tools: ["feishu-cli"],
};
const orgApp = {
  id: "xapp_org",
  provider: "feishu",
  ownerUserId: "u_admin",
  visibility: "instance",
  label: "Acme Feishu",
  clientId: "cli_org",
  hasSecret: true,
  createdVia: "pasted",
  createdAt: iso(0),
  updatedAt: iso(0),
};
function account(overrides = {}) {
  return {
    id: "xacc_ready",
    provider: "feishu",
    appId: "xapp_org",
    ownerUserId: "u_me",
    label: "Work Feishu",
    mode: "server_held",
    status: "ready",
    displayName: "Ada",
    tenant: "acme",
    keepAlive: true,
    lastRefreshedAt: iso(-3 * hour),
    refreshExpiresAt: iso(6 * 24 * hour),
    workspaceIds: ["ws_1"],
    createdAt: iso(-48 * hour),
    updatedAt: iso(-3 * hour),
    ...overrides,
  };
}

let routes = {};
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? "GET";
  const path = new URL(String(input), "https://foundry.example").pathname;
  requests.push({
    method,
    path,
    body: init.body ? JSON.parse(init.body) : undefined,
  });
  const handler = routes[`${method} ${path}`];
  if (!handler)
    return new Response(
      JSON.stringify({ error: `no route ${method} ${path}` }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  const [status, body] = handler(requests.at(-1).body);
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

async function settle(ms = 0) {
  await act(async () => new Promise((done) => setTimeout(done, ms)));
}

async function render(component, props) {
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(component, props)));
  await settle();
  const buttons = (scope = window.document.body) => [
    ...scope.querySelectorAll("button, a"),
  ];
  const button = (text, scope) => {
    const found = buttons(scope).find(
      (node) => node.textContent.trim() === text,
    );
    assert.ok(
      found,
      `button ${text}: ${buttons(scope)
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
    assert.ok(field, `field ${label}`);
    const input = field.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, button, click, type, unmount };
}

test("the page shows each account's state and what keeps it alive", async () => {
  requests.length = 0;
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [orgApp],
        secretsConfigured: true,
        accounts: [
          account(),
          account({
            id: "xacc_idle",
            label: "Idle",
            keepAlive: false,
            refreshExpiresAt: iso(20 * hour),
            status: "expiring",
          }),
          account({
            id: "xacc_dead",
            label: "Lapsed",
            status: "needs_reauth",
            statusDetail: "refresh_token_expired",
            workspaceIds: [],
          }),
          account({ id: "xacc_gone", label: "Gone", status: "revoked" }),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: () => {},
  });
  const rows = [...page.container.querySelectorAll(".fdy-xacc-row")];
  assert.deepEqual(
    rows.map((row) => row.dataset.status),
    ["ready", "expiring", "needs_reauth", "revoked"],
  );
  const [ready, idle, dead, gone] = rows.map((row) => row.textContent);
  assert.match(ready, /Ready/);
  assert.match(ready, /Ada · tenant acme · app Acme Feishu/);
  assert.match(ready, /Feishu · used by feishu-cli · Bound to 1 workspace/);
  assert.match(ready, /Kept alive by Foundry · last refreshed 3 hours ago/);
  assert.match(idle, /Expires soon/);
  assert.match(idle, /Not kept alive · lapses in 20 hours/);
  assert.match(dead, /Needs re-authorization/);
  assert.match(dead, /lapsed after a week without use/);
  assert.match(dead, /Not bound to a workspace/);
  assert.equal(page.button("Reconnect", rows[2]).disabled, false);
  assert.equal(rows[2].querySelector("input[type=checkbox]"), null);
  assert.match(gone, /Revoked/);
  assert.equal(gone.includes("Stop using now"), false);
  assert.match(page.container.textContent, /Acme Feishu/);
  assert.match(page.container.textContent, /Organization app · cli_org/);
  // Not the person's app, not an admin: no remove.
  assert.equal(page.container.textContent.includes("Remove app"), false);
  await page.unmount();
});

test("an app whose secret devices held asks, once, to rotate it; its owner replaces the secret", async () => {
  requests.length = 0;
  const notices = [];
  const ownApp = {
    ...orgApp,
    id: "xapp_mine",
    ownerUserId: "u_me",
    visibility: "personal",
    label: "My Feishu app",
    clientId: "cli_mine",
    rotateSecret: true,
  };
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [ownApp, { ...orgApp, rotateSecret: true }],
        secretsConfigured: true,
        accounts: [],
      },
    ],
    "PUT /api/external-apps/xapp_mine/secret": (body) =>
      body.clientSecret === "new-secret"
        ? [200, { ...ownApp, rotateSecret: false }]
        : [
            400,
            {
              error:
                "feishu tenant token refused (code 10014): app secret invalid",
            },
          ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: (line) => notices.push(line),
  });
  const [mine, org] = [...page.container.querySelectorAll(".fdy-xacc-app")];
  assert.match(mine.textContent, /Devices held this app's secret/);
  assert.equal(
    mine.querySelector("a").getAttribute("href"),
    "https://open.feishu.cn/app/cli_mine/baseinfo",
  );
  // Not this person's to manage: no hint, no action.
  assert.doesNotMatch(org.textContent, /Devices held/);
  assert.equal(org.querySelector("button"), null);

  await page.click(page.button("Replace secret", mine));
  await page.type("New app secret", "typo");
  await page.click(page.button("Save secret", mine));
  assert.deepEqual(requests.at(-1), {
    method: "PUT",
    path: "/api/external-apps/xapp_mine/secret",
    body: { clientSecret: "typo" },
  });
  assert.match(
    mine.querySelector("[role=alert]").textContent,
    /app secret invalid/,
  );
  await page.type("New app secret", "new-secret");
  await page.click(page.button("Save secret", mine));
  const [after] = [...page.container.querySelectorAll(".fdy-xacc-app")];
  assert.doesNotMatch(after.textContent, /Devices held this app's secret/);
  assert.equal(after.querySelector("input"), null);
  assert.match(notices.at(-1), /My Feishu app uses its new secret/);
  await page.unmount();
});

test("the Connectors page has a tab per service and the Feishu tab holds Feishu accounts only", async () => {
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [
          orgApp,
          { ...orgApp, id: "xapp_gh", provider: "github", label: "GitHub app" },
        ],
        secretsConfigured: true,
        accounts: [
          account(),
          account({
            id: "xacc_gh",
            provider: "github",
            label: "Octo",
            displayName: "Octo",
          }),
        ],
      },
    ],
  };
  const tabs = [];
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: (tab) => tabs.push(tab),
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: () => {},
  });
  assert.match(
    page.container.querySelector("header").textContent,
    /^Connectors/,
  );
  const group = page.container.querySelector('[aria-label="Connector types"]');
  assert.ok(group, "connector tabs");
  const tab = page.button("Feishu", group);
  assert.equal(tab.getAttribute("aria-checked"), "true");
  assert.equal(page.container.querySelectorAll(".fdy-xacc-row").length, 1);
  assert.equal(page.container.textContent.includes("Octo"), false);
  assert.equal(page.container.textContent.includes("GitHub app"), false);
  assert.equal(page.button("Connect Feishu account").disabled, false);
  await page.unmount();
});

test("keep-alive, stop using now and remove each ask the server and show its answer", async () => {
  requests.length = 0;
  const notices = [];
  let current = account();
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [orgApp],
        secretsConfigured: true,
        accounts: [current],
      },
    ],
    "PATCH /api/external-accounts/xacc_ready": (body) => [
      200,
      (current = { ...current, ...body }),
    ],
    "POST /api/external-accounts/xacc_ready/revoke": () => [
      200,
      (current = { ...current, status: "revoked" }),
    ],
    "DELETE /api/external-accounts/xacc_ready": () => [
      200,
      { status: "disconnected" },
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: (line) => notices.push(line),
  });
  const checkbox = page.container.querySelector(
    ".fdy-xacc-row input[type=checkbox]",
  );
  assert.equal(checkbox.checked, true);
  await page.click(checkbox);
  assert.deepEqual(requests.at(-1), {
    method: "PATCH",
    path: "/api/external-accounts/xacc_ready",
    body: { keepAlive: false },
  });
  assert.match(page.container.textContent, /Not kept alive/);

  // A destructive action takes two clicks.
  await page.click(page.button("Stop using now"));
  assert.equal(
    requests.some((request) => request.path.endsWith("/revoke")),
    false,
  );
  await page.click(page.button("Revoke now?"));
  assert.equal(
    requests.at(-1).path,
    "/api/external-accounts/xacc_ready/revoke",
  );
  assert.equal(
    page.container.querySelector(".fdy-xacc-row").dataset.status,
    "revoked",
  );
  assert.match(notices.at(-1), /Sessions lost access to it/);

  await page.click(page.button("Remove"));
  await page.click(page.button("Remove for good?"));
  assert.deepEqual(requests.at(-1), {
    method: "DELETE",
    path: "/api/external-accounts/xacc_ready",
    body: undefined,
  });
  assert.equal(page.container.querySelector(".fdy-xacc-row"), null);
  assert.match(page.container.textContent, /No Feishu accounts yet/);
  await page.unmount();
});

test("closing the connect dialog returns focus to the button that opened it", async () => {
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [orgApp],
        accounts: [account({ status: "needs_reauth" })],
        secretsConfigured: true,
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: () => {},
  });
  const modal = () => window.document.body.querySelector(".fdy-xacc-modal");
  // Keyboard activation: the opener holds focus as the dialog opens.
  const open = async (opener) => {
    opener.focus();
    await page.click(opener);
    assert.ok(modal(), "the dialog opens");
    assert.ok(modal().contains(window.document.activeElement));
  };

  const connect = page.button("Connect Feishu account");
  await open(connect);
  await page.click(page.button("Cancel", modal()));
  assert.equal(modal(), null);
  assert.equal(window.document.activeElement, connect);

  const reconnect = page.button(
    "Reconnect",
    page.container.querySelector(".fdy-xacc-row"),
  );
  await open(reconnect);
  await act(async () =>
    window.document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await settle();
  assert.equal(modal(), null);
  assert.equal(window.document.activeElement, reconnect);
  await page.unmount();
});

test("without a secret-store key nothing can be connected", async () => {
  routes = {
    "GET /api/external-accounts": () => [
      200,
      { providers: [feishu], apps: [], accounts: [], secretsConfigured: false },
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: true,
    onNotice: () => {},
  });
  assert.match(page.container.textContent, /no secret-store key/);
  assert.equal(page.button("Connect Feishu account").disabled, true);
  await page.unmount();
});

test("connect: paste an app, show the code to approve, finish when the login completes", async () => {
  requests.length = 0;
  const notices = [];
  const connected = account({
    id: "xacc_new",
    appId: "xapp_new",
    label: "Mine",
    workspaceIds: [],
  });
  let polls = 0;
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [],
        accounts: polls ? [connected] : [],
        secretsConfigured: true,
      },
    ],
    "POST /api/external-apps": (body) => [
      201,
      {
        ...orgApp,
        id: "xapp_new",
        visibility: body.visibility,
        ownerUserId: "u_me",
        label: "Feishu app cli_mine",
        clientId: body.clientId,
      },
    ],
    "POST /api/external-accounts/connect": () => [
      202,
      {
        id: "xlogin_1",
        provider: "feishu",
        appId: "xapp_new",
        status: "pending",
        userCode: "FAKE-0001",
        verificationUri: "https://accounts.example/verify",
        verificationUriComplete:
          "https://accounts.example/verify?user_code=FAKE-0001",
        expiresAt: iso(240_000),
        intervalSeconds: 0,
      },
    ],
    "GET /api/external-accounts/logins/xlogin_1": () => {
      polls += 1;
      return [
        200,
        polls < 2
          ? {
              id: "xlogin_1",
              provider: "feishu",
              appId: "xapp_new",
              status: "pending",
              userCode: "FAKE-0001",
              expiresAt: iso(200_000),
            }
          : {
              id: "xlogin_1",
              provider: "feishu",
              appId: "xapp_new",
              status: "complete",
              account: connected,
            },
      ];
    },
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: (line) => notices.push(line),
  });
  await page.click(page.button("Connect Feishu account"));
  const dialog = window.document.body.querySelector(".fdy-xacc-modal");
  assert.ok(dialog, "the dialog opens");
  // No app yet: the person's own app is the choice, its fields shown.
  assert.match(dialog.textContent, /Use my own app/);
  assert.equal(
    dialog.textContent.includes("Offer this app to everyone"),
    false,
  );
  await page.click(page.button("Show QR code", dialog));
  assert.match(dialog.textContent, /Enter the app ID/);
  assert.equal(
    requests.some((request) => request.method === "POST"),
    false,
  );

  await page.type("App ID", "cli_mine");
  await page.type("App secret", "s3cret-value");
  await page.type("Permissions", "docx:document  search:docs:read");
  await page.click(page.button("Show QR code", dialog));
  const posts = requests.filter((request) => request.method === "POST");
  assert.deepEqual(posts[0], {
    method: "POST",
    path: "/api/external-apps",
    body: {
      provider: "feishu",
      label: "",
      clientId: "cli_mine",
      clientSecret: "s3cret-value",
      visibility: "personal",
    },
  });
  assert.deepEqual(posts[1], {
    method: "POST",
    path: "/api/external-accounts/connect",
    body: { appId: "xapp_new", scopes: ["docx:document", "search:docs:read"] },
  });

  const code = window.document.body.querySelector(".fdy-xacc-user-code code");
  assert.equal(code.textContent, "FAKE-0001");
  assert.ok(window.document.body.querySelector(".fdy-xacc-qr svg"));
  assert.equal(
    page.button("Open link").getAttribute("href"),
    "https://accounts.example/verify?user_code=FAKE-0001",
  );
  assert.match(
    window.document.body.textContent,
    /Waiting for approval · expires in 3:5\d|Waiting for approval · expires in 4:00/,
  );
  // The secret never stays in the form once sent.
  assert.equal(window.document.body.innerHTML.includes("s3cret-value"), false);

  await settle(2100);
  assert.equal(polls, 1);
  assert.ok(window.document.body.querySelector(".fdy-xacc-modal"));
  await settle(2100);
  await settle();
  assert.equal(polls, 2);
  assert.equal(window.document.body.querySelector(".fdy-xacc-modal"), null);
  assert.match(notices.at(-1), /Connected Mine/);
  assert.match(page.container.textContent, /Mine/);
  await page.unmount();
});

test("connect: a refused login says why and offers to try again", async () => {
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [feishu],
        apps: [orgApp],
        accounts: [],
        secretsConfigured: true,
      },
    ],
    "POST /api/external-accounts/connect": () => [
      202,
      {
        id: "xlogin_2",
        provider: "feishu",
        appId: "xapp_org",
        status: "pending",
        userCode: "FAKE-0002",
        verificationUri: "https://accounts.example/verify",
        expiresAt: iso(240_000),
      },
    ],
    "GET /api/external-accounts/logins/xlogin_2": () => [
      200,
      {
        id: "xlogin_2",
        provider: "feishu",
        appId: "xapp_org",
        status: "failed",
        error: "access_denied: the person refused",
      },
    ],
  };
  requests.length = 0;
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: () => {},
  });
  await page.click(page.button("Connect Feishu account"));
  const dialog = window.document.body.querySelector(".fdy-xacc-modal");
  // An organization app is there: no app fields, the login goes through it.
  assert.equal(dialog.textContent.includes("App secret"), false);
  await page.click(page.button("Show QR code", dialog));
  assert.deepEqual(requests.at(-1).body, { appId: "xapp_org" });
  await settle(2100);
  assert.match(
    dialog.textContent,
    /Sign-in failed: access_denied: the person refused/,
  );
  await page.click(page.button("Try again", dialog));
  assert.ok(page.button("Show QR code", dialog));
  await page.unmount();
  window.document.body.innerHTML = "";
});

test("connect: scan to create an app, then scan to authorize it; a partial grant says what is missing", async () => {
  requests.length = 0;
  const notices = [];
  const registering = {
    provider: "feishu",
    ...feishu,
    registersApps: true,
    alwaysScopes: ["offline_access", "auth:user.id:read"],
    scopePreset: {
      name: "feishu-cli-recommended",
      source: "feishu-cli v1.41.0 auth login --recommend",
      scopes: ["docx:document:readonly", "search:docs:read", "im:message"],
      approvalScopes: ["search:app"],
    },
  };
  const created = {
    ...orgApp,
    id: "xapp_reg",
    visibility: "personal",
    ownerUserId: "u_me",
    label: "Feishu app cli_reg",
    clientId: "cli_reg",
    createdVia: "registered",
  };
  const connected = account({
    id: "xacc_reg",
    appId: "xapp_reg",
    label: "Ada",
    workspaceIds: [],
  });
  let polls = 0;
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [registering],
        apps: polls >= 1 ? [created] : [],
        accounts: polls >= 2 ? [connected] : [],
        secretsConfigured: true,
      },
    ],
    "POST /api/external-accounts/setup": () => [
      202,
      {
        id: "xlogin_reg",
        provider: "feishu",
        appId: "",
        status: "pending",
        phase: "register",
        userCode: "REG-0001",
        verificationUri: "https://open.feishu.cn/page/cli?user_code=REG-0001",
        verificationUriComplete:
          "https://open.feishu.cn/page/cli?user_code=REG-0001",
        expiresAt: iso(600_000),
        intervalSeconds: 0,
      },
    ],
    "GET /api/external-accounts/logins/xlogin_reg": () => {
      polls += 1;
      if (polls === 1)
        return [
          200,
          {
            id: "xlogin_reg",
            provider: "feishu",
            appId: "xapp_reg",
            status: "pending",
            phase: "authorize",
            app: created,
            userCode: "AUTH-0001",
            verificationUri: "https://accounts.feishu.cn/verify",
            verificationUriComplete:
              "https://accounts.feishu.cn/verify?user_code=AUTH-0001",
            expiresAt: iso(240_000),
            requestedScopes: [
              "docx:document:readonly",
              "search:docs:read",
              "im:message",
              "offline_access",
              "auth:user.id:read",
            ],
          },
        ];
      return [
        200,
        {
          id: "xlogin_reg",
          provider: "feishu",
          appId: "xapp_reg",
          status: "complete",
          phase: "authorize",
          app: created,
          account: connected,
          requestedScopes: [
            "docx:document:readonly",
            "search:docs:read",
            "im:message",
            "offline_access",
            "auth:user.id:read",
          ],
          missingScopes: ["im:message"],
          scopeApplyUrl:
            "https://open.feishu.cn/page/scope-apply?clientID=cli_reg&scopes=im%3Amessage",
        },
      ];
    },
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: (line) => notices.push(line),
  });
  await page.click(page.button("Connect Feishu account"));
  const dialog = window.document.body.querySelector(".fdy-xacc-modal");
  // Nothing to fill in: a new app is the choice, the long form is folded away.
  assert.match(dialog.textContent, /A new Feishu app, created as you scan/);
  assert.match(dialog.textContent, /Asks for 5 Feishu permissions/);
  assert.equal(dialog.querySelector(".fdy-xacc-advanced").open, false);
  assert.equal(dialog.querySelectorAll("input").length > 0, true);
  await page.click(page.button("Show QR code", dialog));
  assert.deepEqual(
    requests.filter((request) => request.method === "POST"),
    [
      {
        method: "POST",
        path: "/api/external-accounts/setup",
        body: { provider: "feishu" },
      },
    ],
  );
  assert.match(dialog.textContent, /Step 1 of 2/);
  assert.match(dialog.textContent, /Create Foundry's app/);
  assert.match(dialog.textContent, /Waiting for you to confirm the app/);
  assert.ok(dialog.querySelector(".fdy-xacc-qr svg"));
  assert.equal(
    page.button("Open link", dialog).getAttribute("href"),
    "https://open.feishu.cn/page/cli?user_code=REG-0001",
  );

  await settle(2100);
  assert.equal(polls, 1);
  assert.match(dialog.textContent, /Step 2 of 2/);
  assert.match(dialog.textContent, /Authorize Foundry/);
  assert.equal(
    page.button("Open link", dialog).getAttribute("href"),
    "https://accounts.feishu.cn/verify?user_code=AUTH-0001",
  );
  // The created app shows in the apps list at once.
  assert.match(page.container.textContent, /Feishu app cli_reg/);

  await settle(2100);
  await settle();
  assert.equal(polls, 2);
  assert.match(dialog.textContent, /Connected Ada, with 4 of 5 permissions/);
  assert.equal(
    page
      .button("Apply for the missing permissions", dialog)
      .getAttribute("href"),
    "https://open.feishu.cn/page/scope-apply?clientID=cli_reg&scopes=im%3Amessage",
  );
  assert.match(notices.at(-1), /Connected Ada/);
  await page.click(page.button("Done", dialog));
  assert.equal(window.document.body.querySelector(".fdy-xacc-modal"), null);
  await page.unmount();
  window.document.body.innerHTML = "";
});

test("connect: advanced options ask for approval scopes and paste an app", async () => {
  requests.length = 0;
  routes = {
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [
          {
            ...feishu,
            registersApps: true,
            alwaysScopes: ["offline_access", "auth:user.id:read"],
            scopePreset: {
              name: "p",
              source: "s",
              scopes: ["a:b"],
              approvalScopes: ["search:app", "spark:app:read"],
            },
          },
        ],
        apps: [],
        accounts: [],
        secretsConfigured: true,
      },
    ],
    "POST /api/external-accounts/setup": () => [
      500,
      { error: "feishu app registration refused: boom" },
    ],
  };
  const page = await render(ConnectorsFeature, {
    tab: "feishu",
    onTabChange: () => {},
    currentUserId: "u_me",
    isAdmin: false,
    onNotice: () => {},
  });
  await page.click(page.button("Connect Feishu account"));
  const dialog = window.document.body.querySelector(".fdy-xacc-modal");
  assert.match(dialog.textContent, /Asks for 3 Feishu permissions/);
  const approval = [...dialog.querySelectorAll("label")].find((row) =>
    row.textContent.includes("may need admin approval"),
  );
  await page.click(approval.querySelector("input"));
  assert.match(dialog.textContent, /Asks for 5 Feishu permissions/);
  await page.click(page.button("Show QR code", dialog));
  assert.deepEqual(requests.at(-1).body, {
    provider: "feishu",
    includeApprovalScopes: true,
  });
  assert.match(
    dialog.textContent,
    /Sign-in failed: feishu app registration refused: boom/,
  );
  // Pasting an app replaces the app choice with its fields.
  const own = [...dialog.querySelectorAll("label")].find((row) =>
    row.textContent.includes("Use my own app"),
  );
  await page.click(own.querySelector("input"));
  assert.equal(dialog.textContent.includes("Connect through"), false);
  assert.match(dialog.textContent, /App secret/);
  await page.unmount();
  window.document.body.innerHTML = "";
});

function workspaceView() {
  return {
    workspaceId: "ws_1",
    bindings: [
      {
        workspaceId: "ws_1",
        accountId: "xacc_ready",
        grantedBy: "u_me",
        createdAt: iso(0),
      },
      {
        workspaceId: "ws_1",
        accountId: "xacc_theirs",
        grantedBy: "u_bob",
        createdAt: iso(0),
      },
    ],
    accounts: [
      account(),
      account({
        id: "xacc_mine2",
        label: "Personal",
        workspaceIds: [],
        status: "needs_reauth",
      }),
      {
        id: "xacc_theirs",
        provider: "feishu",
        appId: "xapp_org",
        ownerUserId: "u_bob",
        label: "Bob's Feishu",
        mode: "server_held",
        status: "ready",
        keepAlive: false,
        createdAt: iso(0),
        updatedAt: iso(0),
      },
    ],
  };
}

test("the workspace tab binds the person's own accounts and shows others' without their identity", async () => {
  requests.length = 0;
  const notices = [];
  let opened = 0;
  routes = {
    "GET /api/workspaces/ws_1/external-accounts": () => [200, workspaceView()],
    "PUT /api/workspaces/ws_1/external-accounts": (body) => [
      200,
      {
        ...workspaceView(),
        bindings: [
          ...workspaceView().bindings.filter(
            (binding) => binding.grantedBy !== "u_me",
          ),
          ...body.accountIds.map((accountId) => ({
            workspaceId: "ws_1",
            accountId,
            grantedBy: "u_me",
            createdAt: iso(0),
          })),
        ],
      },
    ],
  };
  const tab = await render(WorkspaceAccountsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    onNotice: (line) => notices.push(line),
    onOpenConnectors: () => (opened += 1),
  });
  const text = tab.container.textContent;
  assert.match(text, /Only sessions you start, on devices you own/);
  assert.match(text, /Use Work Feishu in this workspace/);
  assert.match(
    text,
    /Needs re-authorization: sessions cannot use it until you reconnect it/,
  );
  assert.match(text, /Bound by other members/);
  assert.match(text, /Feishu account Bob's Feishu/);
  assert.equal(text.includes("ou_"), false);
  const [work, personal] = [
    ...tab.container.querySelectorAll(
      ".fdy-xacc-binding-row input[type=checkbox]",
    ),
  ];
  assert.equal(work.checked, true);
  assert.equal(personal.checked, false);
  await tab.click(personal);
  assert.deepEqual(requests.at(-1), {
    method: "PUT",
    path: "/api/workspaces/ws_1/external-accounts",
    body: { accountIds: ["xacc_ready", "xacc_mine2"] },
  });
  assert.equal(
    tab.container.querySelectorAll(
      ".fdy-xacc-binding-row input[type=checkbox]",
    )[1].checked,
    true,
  );
  assert.match(notices.at(-1), /Personal is used in this workspace/);
  await tab.click(tab.button("Manage connectors", tab.container));
  assert.equal(opened, 1);
  await tab.unmount();
});

test("a viewer sees the bindings but cannot change them", async () => {
  routes = {
    "GET /api/workspaces/ws_1/external-accounts": () => [200, workspaceView()],
  };
  const tab = await render(WorkspaceAccountsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    readOnlyReason: "You are a Viewer here; this needs Maintainer.",
    onNotice: () => {},
    onOpenConnectors: () => {},
  });
  assert.match(tab.container.textContent, /You are a Viewer here/);
  for (const box of tab.container.querySelectorAll("input[type=checkbox]"))
    assert.equal(box.disabled, true);
  await tab.unmount();
});
