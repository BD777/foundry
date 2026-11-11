import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";

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
const { ConnectorsFeature, WorkspaceConnectorsFeature } =
  await import("../src/features/external-accounts/index.ts");

const day = 86_400_000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
const corpcli = {
  kind: "corpcli",
  label: "corpcli",
  holding: "device_held",
  adapter: "corpcli",
  tool: {
    command: "corpcli",
    source: "npm",
    package: "@corp-dev/corpcli",
    registry: "device",
  },
  requires: [
    {
      kind: "tcp_reachable",
      host: "intranet.corp.example",
      port: 443,
      label: "Corp network",
    },
  ],
  expiryReminderDays: 3,
  signIn: {
    methods: [{ id: "device", kind: "guided", label: "Scan a code" }],
  },
};
function state(deviceId, overrides = {}) {
  return {
    deviceId,
    kind: "corpcli",
    status: "ready",
    installed: true,
    installSource: "device",
    version: "0.170.0",
    signedIn: true,
    identity: "someone",
    sites: ["cn"],
    expiresAt: iso(29 * day),
    checkedAt: iso(-60_000),
    ...overrides,
  };
}
function device(deviceId, name, states, overrides = {}) {
  return {
    deviceId,
    name,
    online: true,
    states,
    ...overrides,
  };
}

// AWS as the server's catalog describes it (its sign-in methods and fields).
const awsCatalog = JSON.parse(
  readFileSync(
    new URL("../../server/internal/connectors/catalog.json", import.meta.url),
    "utf8",
  ),
).find((entry) => entry.kind === "aws");

let routes = {};
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? "GET";
  const url = new URL(String(input), "https://foundry.example");
  // The page's tabs: the catalog (not recorded; tests count device reads).
  if (
    method === "GET" &&
    url.pathname === "/api/connectors" &&
    !routes["GET /api/connectors"]
  )
    return new Response(
      JSON.stringify({
        connectors: [
          {
            kind: "feishu",
            label: "Feishu",
            holding: "server_held",
            adapter: "feishu",
            tool: { command: "feishu-cli" },
          },
          corpcli,
          awsCatalog,
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  requests.push({
    method,
    path: url.pathname + url.search,
    body: init.body ? JSON.parse(init.body) : undefined,
  });
  const handler =
    routes[`${method} ${url.pathname}${url.search}`] ??
    routes[`${method} ${url.pathname}`];
  if (!handler)
    return new Response(
      JSON.stringify({ error: `no route ${method} ${url.pathname}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  const [status, body] = await handler(requests.at(-1).body);
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
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, button, click, unmount };
}

const props = {
  tab: "corpcli",
  onTabChange: () => {},
  currentUserId: "u_me",
  isAdmin: false,
};

test("the corpcli tab lists the person's devices with their sign-in, and names the ones it cannot work on", async () => {
  requests.length = 0;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [
          device("dev_mac", "mac-laptop", [state("dev_mac")]),
          device("dev_soon", "devbox", [
            state("dev_soon", { status: "expiring", expiresAt: iso(2 * day) }),
          ]),
          device("dev_out", "laptop", [
            state("dev_out", {
              status: "signed_out",
              signedIn: false,
              identity: undefined,
              sites: undefined,
              expiresAt: undefined,
            }),
          ]),
          device("dev_none", "studio", [
            state("dev_none", {
              status: "not_installed",
              installed: false,
              signedIn: false,
              version: undefined,
              identity: undefined,
              sites: undefined,
              expiresAt: undefined,
            }),
          ]),
          device("dev_vm", "dev-server", [
            state("dev_vm", {
              status: "unavailable",
              statusDetail: "Corp network",
              installed: false,
              signedIn: false,
            }),
          ]),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: () => {},
  });
  // The stored readings first, then stale devices read again.
  assert.equal(requests[0].path, "/api/connectors/devices");
  assert.equal(requests.at(-1).path, "/api/connectors/devices?refresh=1");
  assert.ok(
    page.container.querySelector(
      '[role="combobox"][aria-label="Connector: corpcli"]',
    ),
  );
  const rows = [...page.container.querySelectorAll(".fdy-xacc-row")];
  assert.deepEqual(
    rows.map((row) => row.querySelector("strong").textContent),
    ["mac-laptop", "devbox", "laptop", "studio"],
  );
  const [mac, soon, out, none] = rows;
  assert.match(
    mac.textContent,
    /Signed in as someone · site cn · expires in 29 days/,
  );
  assert.match(
    mac.textContent,
    /corpcli 0\.170\.0, the device's own · checked/,
  );
  assert.equal(
    mac.querySelector("button.fdy-button-primary, [data-variant=primary]"),
    null,
  );
  assert.ok(page.button("Sign in again", soon));
  assert.ok(page.button("Sign in", out));
  assert.ok(page.button("Install corpcli", none));
  // The device that cannot reach the network is named, not offered.
  assert.match(
    page.container.textContent,
    /Not offered on dev-server: corpcli needs access to the Corp network/,
  );
  // An expiring sign-in is reminded above the list.
  const reminder = page.container.querySelector('[role="alert"], .fdy-alert');
  assert.match(reminder.textContent, /corpcli on devbox expires in 2 days/);
  await page.unmount();
});

test("signed in and usable in a session are shown apart, with the reason and any leak in isolation", async () => {
  requests.length = 0;
  const checkedAt = iso(-60_000);
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [
          device("dev_ok", "usable-box", [
            state("dev_ok", {
              sessionCheck: { usable: true, isolationHolds: true, checkedAt },
            }),
          ]),
          device("dev_bad", "broken-box", [
            state("dev_bad", {
              sessionCheck: {
                usable: false,
                reason: "corpcli is not on the PATH a session gets",
                checkedAt,
              },
            }),
          ]),
          device("dev_leak", "leaky-box", [
            state("dev_leak", {
              sessionCheck: {
                usable: true,
                isolationHolds: false,
                isolationReason:
                  "corpcli still reads as signed in under the isolation environment",
                checkedAt,
              },
            }),
          ]),
          device("dev_none", "unchecked-box", [state("dev_none")]),
          device("dev_out", "signed-out-box", [
            state("dev_out", {
              status: "signed_out",
              signedIn: false,
              identity: undefined,
              sites: undefined,
              expiresAt: undefined,
              sessionCheck: { usable: true, checkedAt },
            }),
          ]),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: () => {},
  });
  const rows = Object.fromEntries(
    [...page.container.querySelectorAll(".fdy-xacc-row")].map((row) => [
      row.querySelector("strong").textContent,
      row,
    ]),
  );
  assert.match(rows["usable-box"].textContent, /Signed in as someone/);
  assert.match(rows["usable-box"].textContent, /Sessions can use it/);
  assert.match(
    rows["broken-box"].textContent,
    /Signed in as someone.*Not usable in sessions: corpcli is not on the PATH a session gets/,
  );
  const problem = [...rows["broken-box"].querySelectorAll("span")].find(
    (node) => /Not usable in sessions/.test(node.textContent),
  );
  assert.equal(problem.getAttribute("data-state"), "failed");
  assert.match(
    rows["leaky-box"].textContent,
    /A session without access still gets this login: corpcli still reads as signed in/,
  );
  assert.doesNotMatch(rows["unchecked-box"].textContent, /session/i);
  // A login that is signed out has nothing to be usable.
  assert.doesNotMatch(
    rows["signed-out-box"].textContent,
    /Sessions can use it/,
  );
  await page.unmount();
});

test("sign-in shows the device's sign-in page as a link and QR code until the device completes it", async () => {
  requests.length = 0;
  let polls = 0;
  const notices = [];
  const url =
    "https://intranet.corp.example/open/ai/service_account/create_and_bind?code=x";
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [
          device("dev_mac", "mac-laptop", [
            state("dev_mac", {
              status: "signed_out",
              signedIn: false,
              identity: undefined,
              sites: undefined,
              expiresAt: undefined,
            }),
          ]),
        ],
      },
    ],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in": () => [
      202,
      {
        status: "pending",
        operationId: "op-test",
        expiresAt: iso(600_000),
        intervalSeconds: 3,
        verificationUrl: url,
      },
    ],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in/poll": () => {
      polls += 1;
      return polls < 2
        ? [200, { status: "pending" }]
        : [200, { status: "complete", state: state("dev_mac") }];
    },
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: (line) => notices.push(line),
  });
  await page.click(page.button("Sign in", page.container));
  const dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /mac-laptop starts corpcli's own sign-in/);
  assert.ok(dialog.querySelector(".fdy-xacc-qr svg"), "a QR code is shown");
  assert.equal(
    dialog.querySelector("a[target=_blank]").getAttribute("href"),
    url,
  );
  await settle(3_100);
  assert.equal(polls, 1);
  assert.match(
    document.querySelector("[role=dialog]").textContent,
    /Waiting for you to approve/,
  );
  await settle(3_100);
  assert.equal(polls, 2);
  assert.equal(
    document.querySelector("[role=dialog]"),
    null,
    "the dialog closes",
  );
  assert.match(notices.at(-1), /corpcli is signed in on mac-laptop/);
  assert.match(
    page.container.querySelector(".fdy-xacc-row").textContent,
    /Signed in as someone/,
  );
  await page.unmount();
});

test("a denied sign-in says so and can start again; sign-out asks first", async () => {
  requests.length = 0;
  let begun = 0;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [
          device("dev_mac", "mac-laptop", [
            state("dev_mac", { status: "expired", expiresAt: iso(-day) }),
          ]),
        ],
      },
    ],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in": () => {
      begun += 1;
      return [
        202,
        begun === 1
          ? {
              status: "denied",
              operationId: "op-denied",
              verificationUrl: "https://intranet.corp.example/x",
            }
          : {
              status: "pending",
              operationId: "op-next",
              verificationUrl: "https://intranet.corp.example/y",
            },
      ];
    },
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: () => {},
  });
  assert.match(
    page.container.textContent,
    /corpcli on mac-laptop expired yesterday\./,
  );
  await page.click(
    page.button("Sign in", page.container.querySelector(".fdy-xacc-row")),
  );
  let dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /The sign-in request was denied\./);
  await page.click(page.button("Try again", dialog));
  dialog = document.querySelector("[role=dialog]");
  assert.equal(begun, 2);
  assert.equal(
    dialog.querySelector("a[target=_blank]").getAttribute("href"),
    "https://intranet.corp.example/y",
  );
  await page.click(dialog.querySelector("button[aria-label^=Close]"));

  routes["POST /api/devices/dev_mac/connectors/corpcli/sign-out"] = () => [
    200,
    state("dev_mac", {
      status: "signed_out",
      signedIn: false,
      identity: undefined,
      sites: undefined,
      expiresAt: undefined,
    }),
  ];
  const row = page.container.querySelector(".fdy-xacc-row");
  const trigger = row.querySelector('[aria-label^="More actions for"]');
  await act(async () =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await settle();
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent.trim() === "Sign out…",
  );
  assert.ok(item, "sign out is in the menu, saying it asks first");
  await act(async () => item.click());
  await settle();
  const confirm = document.querySelector("[role=dialog]");
  assert.match(confirm.textContent, /Sign corpcli out on mac-laptop\?/);
  assert.equal(
    requests.some((request) => request.path.endsWith("/sign-out")),
    false,
    "nothing runs before the confirmation",
  );
  await page.click(page.button("Sign out", confirm));
  assert.ok(requests.some((request) => request.path.endsWith("/sign-out")));
  assert.match(
    page.container.querySelector(".fdy-xacc-row").textContent,
    /Not signed in/,
  );
  await page.unmount();
});

test("the workspace tab automatically offers the owner login and shares only when asked", async () => {
  requests.length = 0;
  const notices = [];
  const view = (bindings) => ({
    workspaceId: "ws_1",
    defaultDeviceId: "dev_mac",
    executionDevices: [{ deviceId: "dev_mac", name: "mac-laptop" }],
    connectors: [corpcli],
    bindings,
    devices: [
      device("dev_mac", "mac-laptop", [state("dev_mac")]),
      device("dev_vm", "dev-server", [
        state("dev_vm", {
          status: "unavailable",
          installed: false,
          signedIn: false,
        }),
      ]),
    ],
  });
  let bindings = [
    {
      workspaceId: "ws_1",
      kind: "corpcli",
      deviceId: "dev_bob",
      members: false,
      grantedBy: "u_bob",
      createdAt: iso(0),
      deviceName: "bob-mac",
    },
  ];
  routes = {
    "GET /api/workspaces/ws_1/external-accounts": () => [
      200,
      { workspaceId: "ws_1", bindings: [], accounts: [] },
    ],
    "GET /api/workspaces/ws_1/device-connectors": () => [200, view(bindings)],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in": () => [
      202,
      { status: "complete", operationId: "reuse", state: state("dev_mac") },
    ],
    "PUT /api/workspaces/ws_1/device-connectors": (body) => {
      bindings = [
        ...bindings.filter((binding) => binding.grantedBy !== "u_me"),
        ...body.bindings.map((binding) => ({
          workspaceId: "ws_1",
          grantedBy: "u_me",
          createdAt: iso(0),
          deviceName: "mac-laptop",
          members: false,
          ...binding,
        })),
      ];
      return [200, view(bindings)];
    },
  };
  const tab = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    onNotice: (line) => notices.push(line),
  });
  const section = tab.container.querySelector(
    '[role=region][aria-label="corpcli"]',
  );
  assert.match(section.textContent, /Login on mac-laptop/);
  assert.match(section.textContent, /Available to your sessions on mac-laptop/);
  assert.equal(section.textContent.includes("Use existing login"), false);
  assert.equal(section.textContent.includes("dev-server"), false);
  assert.equal(section.textContent.includes("bob-mac"), false);
  assert.equal(section.textContent.includes("someone@"), false);
  assert.ok(
    !requests.some((r) => r.method === "PUT" || r.path.includes("sign-in")),
    "loading a ready login requires no authorization or binding write",
  );
  let box = section.querySelector("input[type=checkbox]");
  assert.equal(box.checked, false);
  await tab.click(box);
  assert.deepEqual(requests.at(-1).body, {
    bindings: [{ kind: "corpcli", deviceId: "dev_mac", members: true }],
  });
  assert.match(notices.at(-1), /Other members' sessions on mac-laptop/);
  box = tab.container.querySelector(
    '[role=region][aria-label="corpcli"] input[type=checkbox]',
  );
  await tab.click(box);
  assert.deepEqual(requests.at(-1).body, { bindings: [] });
  assert.match(
    tab.container.textContent,
    /Available to your sessions on mac-laptop/,
  );
  assert.ok(
    bindings.some((b) => b.grantedBy === "u_bob"),
    "another member's binding survives",
  );
  assert.ok(!requests.some((r) => r.path.includes("sign-in")));
  await tab.unmount();
});

test("a viewer cannot change device bindings", async () => {
  routes = {
    "GET /api/workspaces/ws_1/external-accounts": () => [
      200,
      { workspaceId: "ws_1", bindings: [], accounts: [] },
    ],
    "GET /api/workspaces/ws_1/device-connectors": () => [
      200,
      {
        workspaceId: "ws_1",
        defaultDeviceId: "dev_mac",
        executionDevices: [{ deviceId: "dev_mac", name: "mac-laptop" }],
        connectors: [corpcli],
        bindings: [],
        devices: [device("dev_mac", "mac-laptop", [state("dev_mac")])],
      },
    ],
  };
  const tab = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    readOnlyReason: "You are a Viewer here; this needs Maintainer.",
    onNotice: () => {},
  });
  assert.equal(
    tab.container.querySelector('[aria-label="corpcli"] input[type=checkbox]')
      .disabled,
    true,
  );
  assert.match(
    tab.container.textContent,
    /Available to your sessions on mac-laptop/,
  );
  await tab.unmount();
});

test("same-named devices remain distinguishable in global connector management", async () => {
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [
          device("dev_one", "MacBook", [state("dev_one")]),
          device("dev_two", "MacBook", [state("dev_two")]),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: () => {},
  });
  const rows = [...page.container.querySelectorAll(".fdy-xacc-row")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /dev_one/);
  assert.match(rows[1].textContent, /dev_two/);
  await page.unmount();
});

test("additional capability keeps base login and renders the native image without an approval link", async () => {
  const group = {
    id: "web_session",
    revision: 1,
    label: "Extra service",
    capabilities: ["service_one", "service_two"],
    credential: "native_web_session",
  };
  const descriptor = { ...corpcli, authorizationGroups: [group] };
  const local = state("dev_mac", {
    authorizations: [
      {
        id: group.id,
        revision: 1,
        status: "needs_auth",
        checkedAt: iso(0),
        verification: "local_state",
      },
    ],
  });
  let dismissals = 0;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [descriptor],
        devices: [device("dev_mac", "MacBook", [local])],
      },
    ],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in": (body) => {
      assert.equal(body.authorizationId, group.id);
      assert.equal(body.authorizationRevision, 1);
      return [
        202,
        {
          status: "pending",
          operationId: "operation-image",
          expiresAt: iso(60000),
          challenge: {
            kind: "qr_image",
            imageUrl:
              "/api/devices/dev_mac/connectors/corpcli/sign-in/image?operationId=operation-image&authorizationId=web_session&authorizationRevision=1",
          },
        },
      ];
    },
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in/poll": () => [
      200,
      { status: "pending", operationId: "operation-image" },
    ],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in/dismiss": () => {
      dismissals++;
      return [200, {}];
    },
  };
  const StrictConnector = (props) =>
    createElement(StrictMode, null, createElement(ConnectorsFeature, props));
  const page = await render(StrictConnector, { ...props, onNotice: () => {} });
  assert.match(page.container.textContent, /Base login ready/);
  assert.match(page.container.textContent, /Needs authorization/);
  await page.click(page.button("Authorize capability"));
  const dialog = document.querySelector("[role=dialog]");
  assert.equal(
    dismissals,
    0,
    "StrictMode does not dismiss the active operation",
  );
  assert.ok(dialog.querySelector("img.fdy-xacc-auth-image"));
  assert.equal(dialog.querySelector(".fdy-xacc-qr svg"), null);
  assert.equal(
    dialog.querySelector("a[target=_blank]"),
    null,
    "an applink is not an approval action",
  );
  await page.click(dialog.querySelector("button[aria-label^=Close]"));
  assert.equal(dismissals, 1);
  assert.match(page.container.textContent, /Base login ready/);
  await page.unmount();
});

test("a lost initial receipt retries the same request id and shows preparation as pending", async () => {
  const { DeviceSignInDialog } =
    await import("../src/features/external-accounts/device-sign-in-dialog.tsx");
  const ids = [];
  routes = {
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in": (body) => {
      ids.push(body.requestId);
      return ids.length === 1
        ? [503, { error: "response lost" }]
        : [
            202,
            {
              status: "pending",
              phase: "checking",
              operationId: "same-operation",
              expiresAt: iso(60000),
            },
          ];
    },
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in/dismiss": () => [
      200,
      {},
    ],
  };
  const page = await render(DeviceSignInDialog, {
    target: {
      deviceId: "dev_mac",
      deviceName: "MacBook",
      kind: "corpcli",
      label: "corpcli",
    },
    onClose: () => {},
    onSignedIn: () => assert.fail("pending is not success"),
  });
  assert.match(document.body.textContent, /Connection interrupted/);
  assert.doesNotMatch(document.body.textContent, /sign-in did not finish/);
  await page.click(page.button("Try again"));
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.match(document.body.textContent, /Checking the existing login/);
  await page.unmount();
});

test("AWS workspace owner login is automatic and sharing never starts a login", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "device" },
    authentication: "local",
  };
  const current = state("dev_aws", { kind: "aws", expiresAt: undefined });
  let bindings = [];
  const view = () => ({
    workspaceId: "ws_aws",
    defaultDeviceId: "dev_aws",
    executionDevices: [{ deviceId: "dev_aws", name: "AWS device" }],
    connectors: [aws],
    devices: [device("dev_aws", "AWS device", [current])],
    bindings,
  });
  requests.length = 0;
  routes = {
    "GET /api/workspaces/ws_aws/external-accounts": () => [
      200,
      { workspaceId: "ws_aws", accounts: [], bindings: [] },
    ],
    "GET /api/workspaces/ws_aws/device-connectors": () => [200, view()],
    "PUT /api/workspaces/ws_aws/device-connectors": (body) => {
      bindings = body.bindings.map((b) => ({
        ...b,
        workspaceId: "ws_aws",
        grantedBy: "alice",
      }));
      return [200, view()];
    },
  };
  const page = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_aws",
    currentUserId: "alice",
    onNotice: () => {},
  });
  const section = page.container.querySelector('[aria-label="AWS CLI"]');
  assert.match(section.textContent, /Available to your sessions on AWS device/);
  assert.ok(!requests.some((r) => r.method === "POST" || r.method === "PUT"));
  await page.click(section.querySelector("input[type=checkbox]"));
  assert.equal(bindings[0].members, true);
  assert.ok(!requests.some((r) => r.path.includes("sign-in")));
  await page.click(section.querySelector("input[type=checkbox]"));
  assert.equal(bindings.length, 0);
  assert.match(section.textContent, /Available to your sessions/);
  await page.unmount();
});

test("expired workspace login offers sign-in and completion does not create an owner binding", async () => {
  let current = state("dev_mac", { status: "expired", expiresAt: iso(-day) });
  requests.length = 0;
  routes = {
    "GET /api/workspaces/ws_1/external-accounts": () => [
      200,
      { workspaceId: "ws_1", accounts: [], bindings: [] },
    ],
    "GET /api/workspaces/ws_1/device-connectors": () => [
      200,
      {
        workspaceId: "ws_1",
        defaultDeviceId: "dev_mac",
        executionDevices: [{ deviceId: "dev_mac", name: "MacBook" }],
        connectors: [corpcli],
        bindings: [],
        devices: [device("dev_mac", "MacBook", [current])],
      },
    ],
    "POST /api/devices/dev_mac/connectors/corpcli/sign-in": () => [
      202,
      { status: "complete", operationId: "renew", state: state("dev_mac") },
    ],
  };
  const page = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    onNotice: () => {},
  });
  const section = page.container.querySelector('[aria-label="corpcli"]');
  assert.doesNotMatch(section.textContent, /Available to your sessions/);
  assert.equal(section.querySelector("input[type=checkbox]"), null);
  await page.click(page.button("Sign in", section));
  assert.match(section.textContent, /Available to your sessions on MacBook/);
  assert.ok(!requests.some((r) => r.method === "PUT"));
  assert.equal(document.querySelector("[role=dialog]"), null);
  await page.unmount();
});

test("AWS installs from its row: progress, the device's failure reason with Retry, then signing in", async () => {
  const aws = awsCatalog;
  const missing = (deviceId) =>
    state(deviceId, {
      kind: "aws",
      status: "not_installed",
      installed: false,
      installSource: undefined,
      version: undefined,
      signedIn: false,
      identity: undefined,
      sites: undefined,
      expiresAt: undefined,
    });
  let installs = 0;
  let release;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [aws],
        devices: [
          device("dev_new", "new-box", [missing("dev_new")]),
          device("dev_off", "away-box", [missing("dev_off")], {
            online: false,
          }),
          device("dev_v1", "pip-box", [
            state("dev_v1", {
              kind: "aws",
              status: "ready",
              version: "1.32.0",
              identity: "arn:aws:iam::123456789012:user/me",
              expiresAt: undefined,
            }),
          ]),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const text = () => page.container.textContent;
  assert.match(
    text(),
    /Runs AWS CLI’s official installer for your user, without sudo/,
  );
  assert.match(
    text(),
    /away-box is offline; you can install once it’s back online/,
  );
  assert.match(text(), /AWS CLI 1\.32\.0 is older than 2\.0\.0/);
  const installButton = (name, verb = "Install") =>
    page.container.querySelector(
      `button[aria-label="${verb} AWS CLI on ${name}"]`,
    );
  assert.equal(installButton("away-box").disabled, true);
  // An outdated copy is updated, not installed.
  assert.equal(installButton("pip-box"), null);
  assert.equal(installButton("pip-box", "Update").disabled, false);

  // Failure: the device's own reason, without the server's prefix, and Retry.
  routes["POST /api/devices/dev_new/connectors/aws/install"] = () => {
    installs++;
    return [
      502,
      {
        error:
          "Installing AWS CLI on the device failed: could not download https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip: connect ECONNREFUSED 127.0.0.1:9",
      },
    ];
  };
  await page.click(installButton("new-box"));
  assert.equal(installs, 1);
  assert.match(text(), /Could not install AWS CLI on new-box/);
  assert.match(
    text(),
    /could not download https:\/\/awscli\.amazonaws\.com\/awscli-exe-linux-x86_64\.zip: connect ECONNREFUSED/,
  );
  assert.doesNotMatch(text(), /Installing AWS CLI on the device failed/);
  const retry = page.container.querySelector(
    'button[aria-label="Retry installing AWS CLI on new-box"]',
  );
  assert.ok(retry);

  // Success: progress while the device works, then the next command.
  routes["POST /api/devices/dev_new/connectors/aws/install"] = () => {
    installs++;
    return [
      200,
      state("dev_new", {
        kind: "aws",
        status: "signed_out",
        installed: true,
        installSource: "foundry",
        version: "2.31.20",
        signedIn: false,
        identity: undefined,
        expiresAt: undefined,
        checkedAt: new Date().toISOString(),
      }),
    ];
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/dev_new/connectors/aws/install"))
      await new Promise((done) => (release = done));
    return realFetch(input, init);
  };
  await page.click(retry);
  assert.match(text(), /Installing AWS CLI…/);
  assert.match(text(), /On new-box · /);
  // A second click while it runs joins the same install.
  assert.equal(
    page.container.querySelector(
      'button[aria-label="Retry installing AWS CLI on new-box"]',
    ),
    null,
  );
  release();
  await settle(10);
  globalThis.fetch = realFetch;
  assert.equal(installs, 2);
  assert.match(text(), /AWS CLI 2\.31\.20 installed/);
  // Installed and signed out: the row's next step is signing in.
  assert.ok(
    page.button(
      "Sign in",
      page.container.querySelector('[data-status="signed_out"]'),
    ),
  );
  // A Foundry-installed copy can be updated; that makes the menu worth showing.
  assert.ok(
    page.container.querySelector('[aria-label="More actions for new-box"]'),
  );
  assert.equal(
    page.container.querySelector('[aria-label="More actions for away-box"]'),
    null,
  );
  await page.unmount();
});

test("each tab says where its credentials are, with a hint opened by focus or click", async () => {
  routes = {
    "GET /api/connectors/devices": () => [200, { connectors: [], devices: [] }],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "corpcli" });
  assert.match(page.container.textContent, /Credentials on each device/);
  const info = window.document.body.querySelector(
    'button[aria-label="About Credentials on each device"]',
  );
  assert.ok(info);
  await act(async () => info.focus());
  await settle(10);
  const hint = window.document.body.querySelector(".fdy-xacc-holding-panel");
  assert.ok(hint, "focus opens the hint");
  for (const text of [
    "Where",
    "Who can use it",
    "Offline",
    "Revoke",
    "Foundry never reads or copies it",
  ])
    assert.ok(hint.textContent.includes(text), text);
  await page.unmount();
});

test("a device still being read shows its last reading as checking, then the answer once it lands", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "installer", minimumVersion: "2.0.0" },
    authentication: "local",
  };
  const reading = (status, minutes) =>
    state("dev_slow", {
      kind: "aws",
      status,
      installed: true,
      version: "2.31.0",
      signedIn: status === "ready",
      identity:
        status === "ready" ? "arn:aws:iam::123456789012:user/me" : undefined,
      expiresAt: undefined,
      checkedAt: iso(-minutes * 60_000),
    });
  let answered = false;
  const views = [];
  routes = {
    "GET /api/connectors/devices": () => {
      const view = {
        connectors: [aws],
        devices: [
          device(
            "dev_slow",
            "slow-box",
            [answered ? reading("ready", 0) : reading("signed_out", 9)],
            answered ? {} : { checking: ["aws"] },
          ),
        ],
      };
      views.push(Boolean(view.devices[0].checking));
      return [200, view];
    },
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const row = () => page.container.querySelector(".fdy-xacc-device-row");
  assert.match(row().textContent, /Checking now · last read 9 minutes ago/);
  assert.equal(
    row().querySelector("small[aria-busy]").getAttribute("aria-busy"),
    "true",
  );
  answered = true;
  await settle(2300);
  assert.doesNotMatch(row().textContent, /Checking now/);
  assert.match(
    row().textContent,
    /Signed in as arn:aws:iam::123456789012:user\/me/,
  );
  // The first read asked for a refresh; the follow-ups only read.
  assert.ok(
    requests.some((r) => r.path === "/api/connectors/devices?refresh=1"),
  );
  assert.ok(requests.some((r) => r.path === "/api/connectors/devices"));
  const polls = views.length;
  await settle(2300);
  assert.equal(
    views.length,
    polls,
    "polling stops once nothing is being checked",
  );
  await page.unmount();
});

test("a running install shows the device's download progress in its row", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "installer", minimumVersion: "2.0.0" },
    authentication: "local",
  };
  let progress;
  let release;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [aws],
        devices: [
          device(
            "dev_dl",
            "dl-box",
            [
              state("dev_dl", {
                kind: "aws",
                status: "not_installed",
                installed: false,
                installSource: undefined,
                version: undefined,
                signedIn: false,
                identity: undefined,
                sites: undefined,
                expiresAt: undefined,
              }),
            ],
            { progress: progress ? [progress] : undefined },
          ),
        ],
      },
    ],
    "POST /api/devices/dev_dl/connectors/aws/install": () => [
      200,
      state("dev_dl", {
        kind: "aws",
        status: "signed_out",
        installed: true,
        version: "2.39.2",
        signedIn: false,
        identity: undefined,
        expiresAt: undefined,
        checkedAt: new Date().toISOString(),
      }),
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith("/dev_dl/connectors/aws/install"))
      await new Promise((done) => (release = done));
    return realFetch(input, init);
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  await page.click(
    page.container.querySelector(
      'button[aria-label="Install AWS CLI on dl-box"]',
    ),
  );
  const row = () => page.container.querySelector(".fdy-xacc-device-row");
  const meter = () => row().querySelector("progress");
  // Before any report: an indeterminate meter already holds the slot.
  assert.ok(meter(), "the meter is there from the start");
  assert.equal(
    meter().getAttribute("aria-label"),
    "Installing AWS CLI on dl-box",
  );
  assert.equal(meter().hasAttribute("value"), false);
  assert.match(row().textContent, /Starting…/);
  progress = {
    kind: "aws",
    phase: "downloading",
    receivedBytes: 23 * 1024 * 1024,
    totalBytes: 61 * 1024 * 1024,
    bytesPerSecond: 1.2 * 1024 * 1024,
  };
  await settle(1700);
  assert.match(
    row().textContent,
    /Downloading 23\.0 MB of 61\.0 MB \(37%\) · 1\.2 MB\/s/,
  );
  assert.equal(Number(meter().getAttribute("value")), 23 * 1024 * 1024);
  assert.equal(Number(meter().getAttribute("max")), 61 * 1024 * 1024);
  progress = { kind: "aws", phase: "installing" };
  await settle(1700);
  assert.match(row().textContent, /Running the installer…/);
  globalThis.fetch = realFetch;
  release();
  await settle(20);
  assert.match(row().textContent, /AWS CLI 2\.39\.2 installed/);
  await page.unmount();
});

/** Types into a text field the way a person does. */
async function type(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

function fieldInput(scope, label) {
  const field = [...scope.querySelectorAll(".fdy-xacc-field")].find((f) =>
    f.querySelector("label")?.textContent.startsWith(label),
  );
  assert.ok(field, `field ${label}`);
  return field.querySelector("input");
}

const awsSignedOut = (deviceId, overrides = {}) =>
  state(deviceId, {
    kind: "aws",
    status: "signed_out",
    installed: true,
    installSource: "foundry",
    version: "2.39.2",
    signedIn: false,
    identity: undefined,
    expiresAt: undefined,
    configuration: { region: "us-east-1" },
    ...overrides,
  });

test("a connector's sign-in methods come from its descriptor: choose one, fill its fields, paste the code", async () => {
  const ready = state("dev_mac", {
    kind: "aws",
    status: "ready",
    signedIn: true,
    identity: "arn:aws:iam::123456789012:user/me",
    expiresAt: undefined,
    configuration: { region: "us-east-1" },
    checkedAt: new Date().toISOString(),
  });
  const url = "https://us-east-1.signin.aws.amazon.com/v1/authorize?state=s";
  let codeSent;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [awsCatalog],
        devices: [device("dev_mac", "mac", [awsSignedOut("dev_mac")])],
      },
    ],
    "POST /api/devices/dev_mac/connectors/aws/sign-in": () => [
      202,
      {
        status: "pending",
        phase: "awaiting_user",
        operationId: "op1",
        verificationUrl: url,
        codeEntry: true,
        intervalSeconds: 3,
      },
    ],
    "POST /api/devices/dev_mac/connectors/aws/sign-in/code": (body) => {
      codeSent = body;
      return [204, {}];
    },
    "POST /api/devices/dev_mac/connectors/aws/sign-in/poll": () =>
      codeSent
        ? [200, { status: "complete", operationId: "op1", state: ready }]
        : [
            200,
            { status: "pending", operationId: "op1", phase: "awaiting_user" },
          ],
    "POST /api/devices/dev_mac/connectors/aws/sign-in/dismiss": () => [204, {}],
  };
  const notices = [];
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "aws",
    onNotice: (m) => notices.push(m),
  });
  // The tab's sentence is the descriptor's own.
  assert.match(
    page.container.textContent,
    /run the aws command with that device's own sign-in/,
  );
  await page.click(page.button("Sign in"));
  const dialog = () => document.body.querySelector("[role=dialog]");
  // Three ways, the first chosen. Region is a device profile setting, not a
  // sign-in choice.
  const radios = [...dialog().querySelectorAll("input[type=radio]")];
  assert.equal(radios.length, 3);
  assert.ok(radios[0].checked);
  assert.match(
    dialog().textContent,
    /AWS console sign-in.*IAM Identity Center.*In a terminal on the device/,
  );
  assert.doesNotMatch(dialog().textContent, /Default AWS Region/);
  assert.match(
    dialog().textContent,
    /Permissions come from the AWS identity you sign in with/,
  );
  await page.click(page.button("Start sign-in", dialog()));
  const begin = requests.find((r) => r.path.endsWith("/aws/sign-in"));
  assert.deepEqual(begin.body.signInOptions, {
    method: "console",
  });
  assert.match(dialog().textContent, /Signing in with: AWS console sign-in/);
  assert.ok(dialog().querySelector(`a[href="${url}"]`));
  await type(
    dialog().querySelector(".fdy-xacc-code-form input"),
    "ABC.def-123",
  );
  await page.click(page.button("Finish sign-in", dialog()));
  assert.deepEqual(codeSent, { operationId: "op1", code: "ABC.def-123" });
  await settle(3200);
  assert.match(notices.at(-1), /AWS CLI is signed in on mac/);
  assert.match(
    page.container.querySelector(".fdy-xacc-device-row").textContent,
    /Signed in as arn:aws:iam::123456789012:user\/me/,
  );
  assert.match(
    page.container.querySelector(".fdy-xacc-device-row").textContent,
    /Default Region: us-east-1/,
  );
  await page.unmount();
});

test("AWS's default Region can be changed from the device details after sign-in", async () => {
  let changed;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [awsCatalog],
        devices: [
          device("dev_mac", "mac", [
            awsSignedOut("dev_mac", {
              configuration: { region: "us-east-1" },
            }),
          ]),
        ],
      },
    ],
    "PUT /api/devices/dev_mac/connectors/aws/configuration": (body) => {
      changed = body;
      return [
        200,
        awsSignedOut("dev_mac", {
          configuration: { region: body.configuration.region },
        }),
      ];
    },
  };
  const notices = [];
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "aws",
    onNotice: (message) => notices.push(message),
  });
  const row = page.container.querySelector(".fdy-xacc-device-row");
  assert.match(row.textContent, /Default Region: us-east-1/);
  await page.click(page.button("Change", row));
  await type(fieldInput(row, "Default AWS Region"), "eu-west-1");
  await page.click(page.button("Save Region", row));
  assert.deepEqual(changed, {
    configuration: { region: "eu-west-1" },
  });
  assert.match(row.textContent, /Default Region: eu-west-1/);
  assert.match(notices.at(-1), /Default AWS Region updated on mac/);
  await page.unmount();
});

test("Alibaba Cloud's sign-in asks for the site and takes the address the browser landed on", async () => {
  const aliyunCatalog = JSON.parse(
    readFileSync(
      new URL("../../server/internal/connectors/catalog.json", import.meta.url),
      "utf8",
    ),
  ).find((entry) => entry.kind === "alibabacloud");
  const url =
    "https://signin.aliyun.com/oauth2/v1/auth?client_id=1&redirect_uri=x&state=s";
  let codeSent;
  routes = {
    "GET /api/connectors": () => [200, { connectors: [aliyunCatalog] }],
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [aliyunCatalog],
        devices: [
          device("dev_cn", "cn-box", [
            state("dev_cn", {
              kind: "alibabacloud",
              status: "signed_out",
              installed: true,
              installSource: "foundry",
              version: "3.5.3",
              signedIn: false,
            }),
          ]),
        ],
      },
    ],
    "POST /api/devices/dev_cn/connectors/alibabacloud/sign-in": () => [
      202,
      {
        status: "pending",
        phase: "awaiting_user",
        operationId: "op9",
        verificationUrl: url,
        codeEntry: true,
        codeEntryFormat: "callback_url",
        intervalSeconds: 3,
      },
    ],
    "POST /api/devices/dev_cn/connectors/alibabacloud/sign-in/code": (body) => {
      codeSent = body;
      return [204, {}];
    },
    "POST /api/devices/dev_cn/connectors/alibabacloud/sign-in/poll": () => [
      200,
      { status: "pending", operationId: "op9", phase: "awaiting_user" },
    ],
    "POST /api/devices/dev_cn/connectors/alibabacloud/sign-in/dismiss": () => [
      204,
      {},
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "alibabacloud",
  });
  await page.click(page.button("Sign in"));
  const dialog = () => document.body.querySelector("[role=dialog]");
  assert.match(
    dialog().textContent,
    /Alibaba Cloud account sign-in.*CloudSSO.*In a terminal on the device/,
  );
  assert.match(dialog().textContent, /official-cli OAuth application/);
  await page.click(page.button("Start sign-in", dialog()));
  const begin = requests.find((r) => r.path.endsWith("/alibabacloud/sign-in"));
  assert.deepEqual(begin.body.signInOptions, {
    method: "oauth",
    site: "CN",
    region: "cn-hangzhou",
  });
  // The paste is the browser's address, labelled as such, not a code.
  const form = dialog().querySelector(".fdy-xacc-code-form");
  assert.match(
    form.textContent,
    /Address the browser opened after you signed in/,
  );
  assert.equal(
    form.querySelector("input").placeholder,
    "http://127.0.0.1:12345/cli/callback?code=…",
  );
  await type(
    form.querySelector("input"),
    "http://127.0.0.1:12345/cli/callback?code=c&state=s",
  );
  await page.click(page.button("Finish sign-in", dialog()));
  assert.deepEqual(codeSent, {
    operationId: "op9",
    code: "http://127.0.0.1:12345/cli/callback?code=c&state=s",
  });
  await page.unmount();
});

test("a method's required fields are asked for; another method shows a device code to confirm", async () => {
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [awsCatalog],
        devices: [device("dev_sso", "sso-box", [awsSignedOut("dev_sso")])],
      },
    ],
    "POST /api/devices/dev_sso/connectors/aws/sign-in": () => [
      202,
      {
        status: "pending",
        operationId: "op2",
        verificationUrl:
          "https://device.sso.us-east-1.amazonaws.com/?user_code=WXYZ-1234",
        userCode: "WXYZ-1234",
      },
    ],
    "POST /api/devices/dev_sso/connectors/aws/sign-in/poll": () => [
      200,
      {
        status: "failed",
        operationId: "op2",
        error: "An error occurred (AccessDeniedException)",
      },
    ],
    "POST /api/devices/dev_sso/connectors/aws/sign-in/dismiss": () => [204, {}],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  await page.click(page.button("Sign in"));
  const dialog = () => document.body.querySelector("[role=dialog]");
  const sso = [...dialog().querySelectorAll("label.fdy-xacc-method")].find(
    (l) => /IAM Identity Center/.test(l.textContent),
  );
  await page.click(sso.querySelector("input"));
  await page.click(page.button("Start sign-in", dialog()));
  assert.match(dialog().textContent, /Enter Access portal \(start\) URL\./);
  await type(
    fieldInput(dialog(), "Access portal (start) URL"),
    "https://my-company.awsapps.com/start",
  );
  await type(fieldInput(dialog(), "AWS account ID"), "123456789012");
  await type(fieldInput(dialog(), "Permission set (role) name"), "Developer");
  await page.click(page.button("Start sign-in", dialog()));
  const begin = requests
    .filter((r) => r.path.endsWith("/dev_sso/connectors/aws/sign-in"))
    .at(-1);
  assert.deepEqual(begin.body.signInOptions, {
    method: "sso",
    startUrl: "https://my-company.awsapps.com/start",
    accountId: "123456789012",
    roleName: "Developer",
  });
  assert.match(dialog().textContent, /WXYZ-1234/);
  assert.equal(
    dialog().querySelector(".fdy-xacc-code-form"),
    null,
    "nothing to paste back",
  );
  await settle(3200);
  assert.match(
    dialog().textContent,
    /An error occurred \(AccessDeniedException\)/,
  );
  // A failed way can go back to choosing, keeping what was typed.
  await page.click(page.button("Choose another way", dialog()));
  assert.equal(fieldInput(dialog(), "AWS account ID").value, "123456789012");
  await page.unmount();
});

test("a terminal way shows its commands and checks the device; an offline device waits", async () => {
  let signedIn = false;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [awsCatalog],
        devices: [
          device("dev_t", "term-box", [awsSignedOut("dev_t")]),
          device("dev_away", "away-mac", [awsSignedOut("dev_away")], {
            online: false,
          }),
        ],
      },
    ],
    "POST /api/devices/dev_t/connectors/aws/check": () => [
      200,
      signedIn
        ? state("dev_t", {
            kind: "aws",
            status: "ready",
            signedIn: true,
            identity: "me",
            expiresAt: undefined,
          })
        : awsSignedOut("dev_t"),
    ],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const rows = [...page.container.querySelectorAll(".fdy-xacc-device-row")];
  const away = rows.find((row) => /away-mac/.test(row.textContent));
  assert.equal(
    [...away.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "Sign in",
    ),
    false,
    "an offline device offers no sign-in",
  );
  // AWS is signed out in its own terminal: no sign-out anywhere.
  assert.doesNotMatch(page.container.textContent, /Sign out/);
  const term = rows.find((row) => /term-box/.test(row.textContent));
  await page.click(page.button("Sign in", term));
  const dialog = () => document.body.querySelector("[role=dialog]");
  const terminal = [...dialog().querySelectorAll("label.fdy-xacc-method")].find(
    (l) => /terminal/.test(l.textContent),
  );
  await page.click(terminal.querySelector("input"));
  assert.match(dialog().textContent, /aws configure sso --profile default/);
  assert.ok(
    dialog().querySelector(
      'button[aria-label="Copy aws configure sso --profile default"]',
    ),
  );
  await page.click(page.button("I’ve signed in — check again", dialog()));
  assert.match(dialog().textContent, /term-box isn’t signed in yet/);
  signedIn = true;
  await page.click(page.button("I’ve signed in — check again", dialog()));
  assert.equal(
    dialog(),
    null,
    "the dialog closes once the device is signed in",
  );
  await page.unmount();
});

test("an extension's connector lists the devices that have it, and says how to set it up elsewhere", async () => {
  const limen = {
    kind: "gateway",
    label: "Gateway",
    description: "Gives this device Claude through your gateway.",
    holding: "device_held",
    adapter: "extension:gw",
    extension: { id: "gw", name: "Gateway tools", version: "0.1.0" },
    tool: { command: "gw", source: "device" },
    provides: { modelAccess: { runtimes: ["claude"] } },
    setup: { command: "curl -fsSL https://gw.example/install | sh" },
    signIn: {
      methods: [
        {
          id: "invite",
          kind: "guided",
          label: "Join with an invite code",
          fields: [
            {
              id: "invite",
              label: "Invite code",
              type: "secret",
              required: true,
            },
          ],
        },
      ],
    },
  };
  routes = {
    "GET /api/connectors": () => [200, { connectors: [limen] }],
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [limen],
        devices: [
          device(
            "dev_gw",
            "gw-box",
            [
              state("dev_gw", {
                kind: "gateway",
                identity: "default",
                sites: ["default"],
                expiresAt: undefined,
              }),
            ],
            { extensionKinds: ["gateway"] },
          ),
          device("dev_plain", "plain-box", []),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "gateway" });
  const text = page.container.textContent;
  assert.match(text, /Gives this device Claude through your gateway\./);
  assert.match(
    text,
    /Gateway tools extension 0\.1\.0, installed from a local folder\./,
  );
  assert.equal(
    page.container.querySelectorAll(".fdy-xacc-device-row").length,
    1,
  );
  assert.match(text, /Gives this device’s chats Claude through Gateway/);
  assert.match(
    text,
    /Not on plain-box: install the Gateway tools extension there to use it\./,
  );
  assert.ok(
    page.container.querySelector(
      'button[aria-label="Copy curl -fsSL https://gw.example/install | sh"]',
    ),
  );
  // Add a connector explains extensions and lists what is installed.
  await page.click(page.button("Add a connector"));
  const dialog = document.body.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /foundry-worker extension add <folder>/);
  assert.match(dialog.textContent, /Gateway tools 0\.1\.0 — Gateway/);
  // One section per case: your own tool, a public service, writing one.
  assert.deepEqual(
    [...dialog.querySelectorAll("h3")].map((h) => h.textContent),
    [
      "Your company’s or your own tool",
      "A public service Foundry doesn’t have",
      "Writing an extension",
    ],
  );
  const links = [...dialog.querySelectorAll("a")];
  assert.ok(
    links.some(
      (a) =>
        a.textContent === "Request a service" &&
        a.href.endsWith("/issues/new") &&
        a.target === "_blank",
    ),
  );
  assert.ok(
    links.some(
      (a) =>
        a.textContent === "Read the extension spec" &&
        a.href.endsWith("/docs/connector-extensions.md"),
    ),
  );
  await page.unmount();
});

test("an extension installs on another device from its repository, updates and is removed from the page", async () => {
  requests.length = 0;
  const source = {
    git: "https://github.com/acme/gateway.git",
    path: "tools/foundry-extension",
  };
  const gateway = {
    kind: "gateway",
    label: "Gateway",
    holding: "device_held",
    adapter: "extension:gw",
    extension: { id: "gw", name: "Gateway tools", version: "0.1.0", source },
    tool: { command: "gw", source: "device" },
    signIn: {
      methods: [
        { id: "invite", kind: "guided", label: "Join with an invite code" },
      ],
      repeat: { label: "Join another profile" },
    },
  };
  const commit = "a".repeat(40);
  const newer = "b".repeat(40);
  routes = {
    "GET /api/connectors": () => [200, { connectors: [gateway] }],
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [gateway],
        devices: [
          device(
            "dev_gw",
            "gw-box",
            [
              state("dev_gw", {
                kind: "gateway",
                identity: "default",
                sites: undefined,
                expiresAt: undefined,
              }),
            ],
            {
              extensionKinds: ["gateway"],
              extensions: [
                {
                  id: "gw",
                  name: "Gateway tools",
                  version: "0.1.0",
                  source,
                  commit,
                  latestCommit: newer,
                },
              ],
            },
          ),
          device("dev_plain", "plain-box", [
            state("dev_plain", {
              kind: "github",
              signedIn: false,
              status: "signed_out",
            }),
          ]),
        ],
      },
    ],
    "POST /api/devices/dev_plain/extensions": () => [
      200,
      {
        action: "created",
        extension: {
          id: "gw",
          name: "Gateway tools",
          version: "0.1.0",
          connectors: ["gateway"],
        },
      },
    ],
    "POST /api/devices/dev_gw/extensions": () => [
      200,
      {
        action: "updated",
        extension: {
          id: "gw",
          name: "Gateway tools",
          version: "0.2.0",
          connectors: ["gateway"],
        },
      },
    ],
    "PATCH /api/devices/dev_gw/extensions/gw": () => [
      200,
      {
        action: "updated",
        extension: {
          id: "gw",
          name: "Gateway tools",
          version: "0.1.0",
          connectors: ["gateway"],
          source,
          autoUpdate: false,
        },
      },
    ],
    "DELETE /api/devices/dev_gw/extensions/gw": () => [
      200,
      { action: "removed" },
    ],
  };
  const notices = [];
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "gateway",
    onNotice: (line) => notices.push(line),
  });
  const text = page.container.textContent;
  assert.match(
    text,
    /Gateway tools is not on plain-box\. Install it there from the repository it is published in:/,
  );

  // Installing on the device without it: the dialog says what is fetched,
  // where, and that it runs as the person; nothing runs before the click.
  await page.click(page.button("Install Gateway tools"));
  const dialog = document.body.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /https:\/\/github\.com\/acme\/gateway\.git/);
  assert.match(dialog.textContent, /tools\/foundry-extension/);
  assert.match(dialog.textContent, /The default branch/);
  assert.match(dialog.textContent, /GitHub CLI is not signed in on plain-box/);
  assert.match(dialog.textContent, /runs as you on plain-box/);
  assert.ok(!requests.some((r) => r.method === "POST"));
  await page.click(page.button("Install on plain-box", dialog));
  const install = requests.find(
    (r) => r.path === "/api/devices/dev_plain/extensions",
  );
  assert.deepEqual(install.body, { source });
  assert.ok(notices.includes("Gateway tools is installed on plain-box."));

  // The device with an older commit offers the update where it can be seen.
  const row = page.container.querySelector(".fdy-xacc-device-row");
  assert.match(
    row.textContent,
    /Gateway tools has a newer commit in its repository \(bbbbbbb\)/,
  );
  assert.match(
    row.textContent,
    /Updates automatically when the repository moves/,
  );
  const autoUpdate = row.querySelector('[aria-label="Auto-update"]');
  assert.ok(autoUpdate);
  assert.equal(autoUpdate.getAttribute("aria-checked"), "true");
  await page.click(autoUpdate);
  assert.deepEqual(
    requests.find(
      (r) =>
        r.method === "PATCH" && r.path === "/api/devices/dev_gw/extensions/gw",
    ).body,
    { autoUpdate: false },
  );
  await page.click(
    page.button(
      "Update Gateway tools",
      page.container.querySelector(".fdy-xacc-device-row"),
    ),
  );
  assert.deepEqual(
    requests.find((r) => r.path === "/api/devices/dev_gw/extensions").body,
    { source },
  );
  assert.ok(notices.includes("Gateway tools on gw-box is updated."));

  // The menu: joining another profile, and removing the extension (asked first).
  const trigger = row.querySelector('[aria-label^="More actions for"]');
  await act(async () =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await settle();
  const items = [...document.querySelectorAll('[role="menuitem"]')].map(
    (node) => node.textContent.trim(),
  );
  assert.ok(items.includes("Join another profile"), items.join(" | "));
  const remove = [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) =>
      node.textContent
        .trim()
        .startsWith("Remove Gateway tools from this device"),
  );
  await act(async () => remove.click());
  await settle();
  const confirm = document.querySelector("[role=dialog]");
  assert.match(confirm.textContent, /Remove Gateway tools from gw-box\?/);
  assert.ok(!requests.some((r) => r.method === "DELETE"));
  await page.click(page.button("Remove", confirm));
  assert.ok(
    requests.some(
      (r) =>
        r.method === "DELETE" && r.path === "/api/devices/dev_gw/extensions/gw",
    ),
  );
  assert.ok(notices.includes("Gateway tools is removed from gw-box."));
  await page.unmount();
});

test("a bundled extension installs on a device without a repository", async () => {
  requests.length = 0;
  const bundled = {
    kind: "pack",
    label: "Pack",
    holding: "device_held",
    adapter: "extension:pack",
    extension: {
      id: "pack",
      name: "Pack tools",
      version: "1.0.0",
      bundled: true,
      state: "available",
    },
    tool: { command: "pack", source: "device" },
  };
  routes = {
    "GET /api/connectors": () => [200, { connectors: [bundled] }],
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [bundled],
        devices: [
          device("dev_mac", "mac-laptop", [], {
            extensions: [bundled.extension],
            extensionErrors: [
              {
                extensionId: "broken",
                extensionName: "Broken tools",
                kind: "broken",
                reason: "serverHeld.upstream header is not canonical",
              },
            ],
          }),
          device("dev_off", "offline-box", [], {
            online: false,
            extensions: [bundled.extension],
          }),
        ],
      },
    ],
    "POST /api/devices/dev_mac/extensions": () => [
      200,
      {
        action: "created",
        extension: {
          id: "pack",
          name: "Pack tools",
          version: "1.0.0",
          connectors: ["pack"],
          bundled: true,
          state: "installed",
        },
      },
    ],
  };
  const notices = [];
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "pack",
    onNotice: (line) => notices.push(line),
  });
  assert.match(page.container.textContent, /bundled with the Worker/);
  assert.match(page.container.textContent, /Install Pack tools on a device/);
  assert.match(
    page.container.textContent,
    /offline-box.*Offline; install it once the device is back/,
  );
  const installButtons = [...page.container.querySelectorAll("button")].filter(
    (button) => button.textContent.trim() === "Install on this device",
  );
  assert.deepEqual(
    installButtons.map((button) => button.disabled),
    [false, true],
  );
  assert.match(
    page.container.textContent,
    /Invalid Broken tools descriptor on mac-laptop/,
  );
  assert.match(
    page.container.textContent,
    /serverHeld\.upstream header is not canonical/,
  );
  await page.click(page.button("Install on this device"));
  assert.deepEqual(
    requests.find(
      (request) => request.path === "/api/devices/dev_mac/extensions",
    ).body,
    { bundledExtensionId: "pack" },
  );
  assert.ok(notices.includes("Pack tools is installed on mac-laptop."));
  await page.unmount();
});

test("restricted connectors are collapsed, explain both gates, and recheck", async () => {
  requests.length = 0;
  const restrictedConnector = {
    ...corpcli,
    kind: "gated",
    label: "Gated",
    adapter: "extension:gated",
    holder: undefined,
    requires: [
      {
        kind: "tcp_reachable",
        host: "intranet.example",
        port: 443,
        label: "Internal network",
      },
    ],
    access: {
      via: "github",
      repository: "owner/private-repository",
      hint: "Read the private repository to use this connector.",
    },
    extension: {
      id: "gated",
      name: "Gated tools",
      version: "1.0.0",
      bundled: true,
      state: "available",
    },
  };
  delete restrictedConnector.holder;
  routes = {
    "GET /api/connectors": () => [
      200,
      {
        connectors: [
          {
            kind: "feishu",
            label: "Feishu",
            holding: "server_held",
            adapter: "feishu",
            tool: { command: "feishu-cli" },
          },
        ],
        restrictedConnectors: [
          {
            connector: restrictedConnector,
            devices: [
              {
                deviceId: "dev_mac",
                name: "mac-laptop",
                online: true,
                viaLabel: "GitHub CLI",
                requirementsCheck: {
                  ok: false,
                  requirement: "Internal network",
                  checkedAt: iso(-60_000),
                },
                accessCheck: {
                  via: "github",
                  status: "no_access",
                  identity: "reader",
                  checkedAt: iso(-60_000),
                },
              },
              {
                deviceId: "dev_linux",
                name: "linux-runner",
                online: true,
                viaLabel: "GitHub CLI",
                requirementsCheck: {
                  ok: true,
                  checkedAt: iso(-60_000),
                },
                accessCheck: {
                  via: "github",
                  status: "not_signed_in",
                  checkedAt: iso(-60_000),
                },
              },
            ],
          },
        ],
      },
    ],
    "GET /api/connectors/devices": () => [200, { connectors: [], devices: [] }],
    "GET /api/external-accounts": () => [
      200,
      { providers: [], apps: [], accounts: [], secretsConfigured: true },
    ],
    "POST /api/connectors/recheck-access": () => [
      200,
      {
        connectors: [
          {
            kind: "feishu",
            label: "Feishu",
            holding: "server_held",
            adapter: "feishu",
            tool: { command: "feishu-cli" },
          },
        ],
        restrictedConnectors: [],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "feishu",
    onNotice: () => {},
  });
  const trigger = page.container.querySelector('[role="combobox"]');
  await act(async () => trigger.click());
  await settle();
  const collapsed = page.button("Needs access (1)");
  assert.equal(collapsed.getAttribute("aria-expanded"), "false");
  await page.click(collapsed);
  assert.match(
    window.document.querySelector("[role=listbox]").textContent,
    /2 devices do not meet the conditions/,
  );
  assert.doesNotMatch(
    window.document.querySelector("[role=listbox]").textContent,
    /owner\/private-repository/,
  );
  const restricted = [
    ...window.document.querySelectorAll("[cmdk-list] button"),
  ].find((node) =>
    node.textContent.includes("2 devices do not meet the conditions"),
  );
  assert.ok(restricted);
  await page.click(restricted);
  assert.match(
    page.container.textContent,
    /Needs to reach Internal network \(intranet\.example:443\)/,
  );
  assert.match(
    page.container.textContent,
    /GitHub CLI account reader cannot read owner\/private-repository/,
  );
  assert.match(
    page.container.textContent,
    /GitHub CLI is not signed in on this device/,
  );
  const details = page.container.querySelector(
    '[aria-label="Gated access details"]',
  );
  assert.ok(details);
  await page.click(page.button("Check again", details));
  await settle(20);
  assert.ok(
    requests.some(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/connectors/recheck-access",
    ),
  );
  await page.unmount();
});

test("Add a connector installs an extension from a repository the person names", async () => {
  requests.length = 0;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [
          device("dev_mac", "mac-laptop", [state("dev_mac")]),
          device("dev_off", "away", [], { online: false }),
        ],
      },
    ],
    "POST /api/devices/dev_mac/extensions": () => [
      200,
      {
        action: "created",
        extension: {
          id: "acme",
          name: "Acme tools",
          version: "1.0.0",
          connectors: ["acmecli"],
        },
      },
    ],
  };
  const notices = [];
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: (line) => notices.push(line),
  });
  await page.click(page.button("Add a connector"));
  await page.click(
    page.button(
      "Install from a repository…",
      document.body.querySelector("[role=dialog]"),
    ),
  );
  const dialog = document.body.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /Install a connector extension/);
  // A repository is required.
  await page.click(page.button("Install on mac-laptop", dialog));
  assert.match(
    dialog.textContent,
    /Enter the repository the extension is published in\./,
  );
  assert.ok(!requests.some((r) => r.method === "POST"));
  await type(
    fieldInput(dialog, "Repository"),
    "https://github.com/acme/tools.git",
  );
  await type(fieldInput(dialog, "Folder"), "foundry-extension");
  await page.click(page.button("Install on mac-laptop", dialog));
  assert.deepEqual(requests.find((r) => r.method === "POST").body, {
    source: {
      git: "https://github.com/acme/tools.git",
      path: "foundry-extension",
    },
  });
  await settle(20);
  assert.ok(notices.includes("Acme tools is installed on mac-laptop."));
  await page.unmount();
});

test("GitHub's permission picker: recommended, all from GitHub's list, custom with removal (DEV-136)", async () => {
  const { AuthorizationScopePicker } =
    await import("../src/features/external-accounts/authorization-scope-picker.tsx");
  const group = JSON.parse(
    readFileSync(
      new URL(
        "../../../apps/server/internal/connectors/catalog.json",
        import.meta.url,
      ),
    ),
  )
    .find((c) => c.kind === "github")
    .authorizationGroups.find((g) => g.id === "permissions");
  const chosen = [];
  const box = (id) =>
    [...page.container.querySelectorAll("label")]
      .find((row) => row.querySelector("small")?.textContent.startsWith(id))
      ?.querySelector("input");
  // First authorization: the recommended set, which includes workflow.
  let page = await render(AuthorizationScopePicker, {
    group,
    onStart: (options) => chosen.push(options),
  });
  await page.click(page.button("Authorize selected permissions"));
  const sorted = (list) => list.split(",").sort().join(",");
  assert.equal(
    sorted(chosen[0].scopes),
    "gist,read:org,read:packages,repo,workflow",
  );
  // GitHub's documentation is the complete list, so All is offered.
  assert.match(page.container.textContent, /All is every scope in GitHub Docs/);
  await page.click(page.button("All"));
  await page.click(page.button("Authorize selected permissions"));
  // Broad scopes stand for their children, as GitHub normalizes them.
  assert.equal(chosen[1].scopes.includes("repo:status"), false);
  assert.equal(chosen[1].scopes.includes("delete_repo"), true);
  assert.equal(chosen[1].scopes.split(",").length, 16);
  await page.unmount();

  // An update starts from what is granted; unchecking says it removes.
  page = await render(AuthorizationScopePicker, {
    group,
    granted: ["repo", "repo:status", "read:org", "gist", "delete_repo"],
    onStart: (options) => chosen.push(options),
  });
  assert.equal(box("repo").checked, true);
  assert.equal(box("repo").disabled, true);
  assert.equal(box("repo:status").disabled, true);
  assert.match(page.container.textContent, /included in repo/);
  await page.click(box("delete_repo"));
  await page.click(box("workflow"));
  assert.match(
    page.container.textContent,
    /Adds workflow · Removes delete_repo/,
  );
  assert.match(
    page.container.textContent,
    /Unchecking a granted scope removes it/,
  );
  await page.click(page.button("Authorize selected permissions"));
  assert.equal(sorted(chosen[2].scopes), "gist,read:org,repo,workflow");
  await page.unmount();
});

test("a device-held tab draws the stored reading at once and marks stale devices checking until the refresh answers", async () => {
  requests.length = 0;
  let answer;
  const refreshed = new Promise((done) => (answer = done));
  const stale = state("dev_mac", { checkedAt: iso(-10 * 60_000) });
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [corpcli],
        devices: [device("dev_mac", "mac-laptop", [stale])],
      },
    ],
    "GET /api/connectors/devices?refresh=1": async () => {
      await refreshed;
      return [
        200,
        {
          connectors: [corpcli],
          devices: [device("dev_mac", "mac-laptop", [state("dev_mac")])],
        },
      ];
    },
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: () => {},
  });
  const row = () => page.container.querySelector(".fdy-xacc-row");
  // The last reading shows, said to be checked again, not as verified now.
  assert.match(row().textContent, /mac-laptop/);
  assert.match(row().textContent, /Checking now · last read 10 minutes ago/);
  const check = page.button("Checking…");
  assert.equal(check.getAttribute("aria-busy"), "true");
  assert.equal(
    page.container.querySelector("[aria-busy='true'] .fdy-xacc-row") !== null,
    true,
  );
  await act(async () => answer());
  await settle();
  assert.doesNotMatch(row().textContent, /Checking now/);
  assert.equal(page.button("Check again").disabled, false);
  await page.unmount();
});

test("the connector picker groups public and private connectors, shows each one's status and filters as you type", async () => {
  requests.length = 0;
  const limen = {
    ...corpcli,
    kind: "limen",
    label: "Limen",
    adapter: "extension:corp",
    description: "Private model gateway",
    extension: { id: "corp", name: "Corp tools", version: "1.0.0" },
  };
  const chosen = [];
  routes = {
    "GET /api/connectors": () => [
      200,
      {
        connectors: [
          {
            kind: "feishu",
            label: "Feishu",
            holding: "server_held",
            adapter: "feishu",
            tool: { command: "feishu-cli" },
          },
          awsCatalog,
          limen,
        ],
      },
    ],
    "GET /api/external-accounts": () => [
      200,
      {
        providers: [],
        apps: [],
        secretsConfigured: true,
        accounts: [
          {
            id: "xacc_1",
            provider: "feishu",
            status: "needs_reauth",
            label: "Me",
          },
        ],
      },
    ],
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [awsCatalog, limen],
        devices: [
          device(
            "dev_mac",
            "mac-laptop",
            [
              state("dev_mac", { kind: "aws" }),
              state("dev_mac", {
                kind: "limen",
                signedIn: false,
                status: "signed_out",
              }),
            ],
            { extensionKinds: ["limen"] },
          ),
          // Signed in when last read, but offline since: not a current login.
          device("dev_old", "old-box", [state("dev_old", { kind: "limen" })], {
            online: false,
            extensionKinds: ["limen"],
          }),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    tab: "aws",
    onTabChange: (tab) => chosen.push(tab),
    onNotice: () => {},
  });
  const trigger = page.container.querySelector('[role="combobox"]');
  assert.equal(trigger.getAttribute("aria-label"), "Connector: AWS CLI");
  assert.match(trigger.textContent, /Signed in/);
  await act(async () => {
    trigger.dispatchEvent(
      new window.PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    trigger.click();
  });
  await settle();
  const list = () => window.document.querySelector("[cmdk-list]");
  assert.ok(list(), "the picker opens");
  const groups = [...window.document.querySelectorAll("[cmdk-group]")]
    .map((group) => group.querySelector("[cmdk-group-heading]")?.textContent)
    .filter(Boolean);
  assert.deepEqual(groups, [
    "PublicBuilt into Foundry",
    "PrivateFrom connector extensions on your devices, visible only to you",
  ]);
  const items = () =>
    [...window.document.querySelectorAll("[cmdk-item]")].map((item) =>
      item.textContent.replace(/\s+/g, " ").trim(),
    );
  const labels = () =>
    [...window.document.querySelectorAll("[cmdk-item] span.truncate")].map(
      (label) => label.textContent,
    );
  assert.deepEqual(labels(), ["Feishu", "AWS CLI", "Limen", "Edge access"]);
  assert.match(items()[0], /Needs sign-in/);
  assert.match(items()[1], /Signed in/);
  assert.match(items()[2], /Last seen signed in/);
  // A description word finds the private gateway.
  const input = window.document.querySelector("[cmdk-input]");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "gateway");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
  assert.deepEqual(labels(), ["Limen"]);
  const visible = [...window.document.querySelectorAll("[cmdk-item]")];
  await act(async () => visible[0].click());
  await settle();
  assert.deepEqual(chosen, ["limen"]);
  await page.unmount();
});
