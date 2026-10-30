import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
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
const bytedcli = {
  kind: "bytedcli",
  label: "bytedcli",
  holding: "device_held",
  adapter: "bytedcli",
  tool: {
    command: "bytedcli",
    source: "npm",
    package: "@bytedance-dev/bytedcli",
    registry: "device",
  },
  requires: [
    {
      kind: "tcp_reachable",
      host: "cloud.bytedance.net",
      port: 443,
      label: "ByteDance network",
    },
  ],
  expiryReminderDays: 3,
};
function state(deviceId, overrides = {}) {
  return {
    deviceId,
    kind: "bytedcli",
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
    supported: true,
    states,
    ...overrides,
  };
}

let routes = {};
const requests = [];
globalThis.fetch = async (input, init = {}) => {
  const method = init.method ?? "GET";
  const url = new URL(String(input), "https://foundry.example");
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
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, button, click, unmount };
}

const props = {
  tab: "bytedcli",
  onTabChange: () => {},
  currentUserId: "u_me",
  isAdmin: false,
};

test("the bytedcli tab lists the person's devices with their sign-in, and names the ones it cannot work on", async () => {
  requests.length = 0;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [bytedcli],
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
              statusDetail: "ByteDance network",
              installed: false,
              signedIn: false,
            }),
          ]),
          device("dev_old", "old-mac", [], { supported: false }),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, {
    ...props,
    onNotice: () => {},
  });
  assert.equal(requests[0].path, "/api/connectors/devices?refresh=1");
  const group = page.container.querySelector('[aria-label="Connector types"]');
  assert.equal(
    page.button("bytedcli", group).getAttribute("aria-checked"),
    "true",
  );
  const rows = [...page.container.querySelectorAll(".fdy-xacc-row")];
  assert.deepEqual(
    rows.map((row) => row.querySelector("strong").textContent),
    ["mac-laptop", "devbox", "laptop", "studio", "old-mac"],
  );
  const [mac, soon, out, none, old] = rows;
  assert.match(
    mac.textContent,
    /Signed in as someone · site cn · expires in 29 days/,
  );
  assert.match(
    mac.textContent,
    /bytedcli 0\.170\.0, the device's own · checked/,
  );
  assert.equal(
    mac.querySelector("button.fdy-button-primary, [data-variant=primary]"),
    null,
  );
  assert.ok(page.button("Sign in again", soon));
  assert.ok(page.button("Sign in", out));
  assert.ok(page.button("Install bytedcli", none));
  assert.match(old.textContent, /worker is too old for bytedcli/);
  assert.equal(
    [...old.querySelectorAll("button")].filter(
      (node) => !node.getAttribute("aria-label"),
    ).length,
    0,
  );
  // The device that cannot reach the network is named, not offered.
  assert.match(
    page.container.textContent,
    /Not offered on dev-server: bytedcli needs access to the ByteDance network/,
  );
  // An expiring sign-in is reminded above the list.
  const reminder = page.container.querySelector('[role="alert"], .fdy-alert');
  assert.match(reminder.textContent, /bytedcli on devbox expires in 2 days/);
  await page.unmount();
});

test("sign-in shows the device's sign-in page as a link and QR code until the device completes it", async () => {
  requests.length = 0;
  let polls = 0;
  const notices = [];
  const url =
    "https://cloud.bytedance.net/open/ai/service_account/create_and_bind?code=x";
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [bytedcli],
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
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in": () => [
      202,
      {
        status: "pending",
        operationId: "op-test",
        expiresAt: iso(600_000),
        intervalSeconds: 3,
        verificationUrl: url,
      },
    ],
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in/poll": () => {
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
  assert.match(dialog.textContent, /mac-laptop starts bytedcli's own sign-in/);
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
  assert.match(notices.at(-1), /bytedcli is signed in on mac-laptop/);
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
        connectors: [bytedcli],
        devices: [
          device("dev_mac", "mac-laptop", [
            state("dev_mac", { status: "expired", expiresAt: iso(-day) }),
          ]),
        ],
      },
    ],
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in": () => {
      begun += 1;
      return [
        202,
        begun === 1
          ? {
              status: "denied",
              operationId: "op-denied",
              verificationUrl: "https://cloud.bytedance.net/x",
            }
          : {
              status: "pending",
              operationId: "op-next",
              verificationUrl: "https://cloud.bytedance.net/y",
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
    /bytedcli on mac-laptop expired yesterday\./,
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
    "https://cloud.bytedance.net/y",
  );
  await page.click(dialog.querySelector("button[aria-label^=Close]"));

  routes["POST /api/devices/dev_mac/connectors/bytedcli/sign-out"] = () => [
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
  assert.match(confirm.textContent, /Sign bytedcli out on mac-laptop\?/);
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
    connectors: [bytedcli],
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
      kind: "bytedcli",
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
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in": () => [
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
    '[role=region][aria-label="bytedcli"]',
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
    bindings: [{ kind: "bytedcli", deviceId: "dev_mac", members: true }],
  });
  assert.match(notices.at(-1), /Other members' sessions on mac-laptop/);
  box = tab.container.querySelector(
    '[role=region][aria-label="bytedcli"] input[type=checkbox]',
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
        connectors: [bytedcli],
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
    tab.container.querySelector('[aria-label="bytedcli"] input[type=checkbox]')
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
        connectors: [bytedcli],
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
  const descriptor = { ...bytedcli, authorizationGroups: [group] };
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
        devices: [
          device("dev_mac", "MacBook", [local], {
            authorizationSupported: true,
          }),
        ],
      },
    ],
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in": (body) => {
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
              "/api/devices/dev_mac/connectors/bytedcli/sign-in/image?operationId=operation-image&authorizationId=web_session&authorizationRevision=1",
          },
        },
      ];
    },
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in/poll": () => [
      200,
      { status: "pending", operationId: "operation-image" },
    ],
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in/dismiss": () => {
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
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in": (body) => {
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
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in/dismiss": () => [
      200,
      {},
    ],
  };
  const page = await render(DeviceSignInDialog, {
    target: {
      deviceId: "dev_mac",
      deviceName: "MacBook",
      kind: "bytedcli",
      label: "bytedcli",
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

test("AWS shows the terminal sign-in in its row, checks status and offers no unsupported auth/install actions", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "device" },
    authentication: "local",
  };
  let checks = 0;
  for (const status of ["not_installed", "signed_out", "ready", "error"]) {
    routes = {
      "GET /api/connectors/devices": () => [
        200,
        {
          connectors: [aws],
          devices: [
            device("dev_aws", "AWS device", [
              state("dev_aws", {
                kind: "aws",
                status,
                installed: status !== "not_installed",
                signedIn: status === "ready",
                identity: "AWS role",
                expiresAt: undefined,
              }),
            ]),
          ],
        },
      ],
      "POST /api/devices/dev_aws/connectors/aws/check": () => {
        checks++;
        return [
          200,
          state("dev_aws", {
            kind: "aws",
            status,
            signedIn: status === "ready",
          }),
        ];
      },
    };
    const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
    assert.match(page.container.textContent, /AWS_PROFILE/);
    assert.match(page.container.textContent, /Credentials on each device/);
    // Only a signed-out device needs the terminal step; the command is exact.
    assert.equal(
      /aws configure sso --profile default/.test(page.container.textContent),
      status === "signed_out",
    );
    const actions = [...page.container.querySelectorAll("button")].map((x) =>
      x.textContent.trim(),
    );
    assert.ok(
      !actions.some((x) =>
        ["Install", "Install AWS CLI", "Sign in", "Sign out"].includes(x),
      ),
    );
    // Checking again is the header's; the row menu holds nothing else here.
    assert.equal(
      page.container.querySelector(
        '[aria-label="More actions for AWS device"]',
      ),
      null,
    );
    await page.click(page.button("Check again"));
    assert.equal(
      checks,
      ["not_installed", "signed_out", "ready", "error"].indexOf(status) + 1,
    );
    await page.unmount();
  }
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
        connectors: [bytedcli],
        bindings: [],
        devices: [device("dev_mac", "MacBook", [current])],
      },
    ],
    "POST /api/devices/dev_mac/connectors/bytedcli/sign-in": () => [
      202,
      { status: "complete", operationId: "renew", state: state("dev_mac") },
    ],
  };
  const page = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    onNotice: () => {},
  });
  const section = page.container.querySelector('[aria-label="bytedcli"]');
  assert.doesNotMatch(section.textContent, /Available to your sessions/);
  assert.equal(section.querySelector("input[type=checkbox]"), null);
  await page.click(page.button("Sign in on device", section));
  assert.match(section.textContent, /Available to your sessions on MacBook/);
  assert.ok(!requests.some((r) => r.method === "PUT"));
  assert.equal(document.querySelector("[role=dialog]"), null);
  await page.unmount();
});

test("AWS installs from its row: progress, the device's failure reason with Retry, then the exact sign-in command", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "installer", minimumVersion: "2.0.0" },
    authentication: "local",
  };
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
          device("dev_new", "new-box", [missing("dev_new")], {
            installerSupported: true,
          }),
          device("dev_off", "away-box", [missing("dev_off")], {
            online: false,
            installerSupported: true,
          }),
          device("dev_old", "old-worker", [missing("dev_old")]),
          device(
            "dev_v1",
            "pip-box",
            [
              state("dev_v1", {
                kind: "aws",
                status: "ready",
                version: "1.32.0",
                identity: "arn:aws:iam::123456789012:user/me",
                expiresAt: undefined,
              }),
            ],
            { installerSupported: true },
          ),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const text = () => page.container.textContent;
  assert.match(
    text(),
    /Runs the official installer for your user, without sudo/,
  );
  assert.match(
    text(),
    /away-box is offline; you can install once it’s back online/,
  );
  assert.match(
    text(),
    /Update this device’s worker to install AWS CLI from here/,
  );
  assert.match(text(), /AWS CLI 1\.32\.0 is older than 2\.0\.0/);
  const installButton = (name) =>
    page.container.querySelector(
      `button[aria-label="Install AWS CLI on ${name}"]`,
    );
  assert.equal(installButton("away-box").disabled, true);
  assert.equal(installButton("old-worker").disabled, true);
  assert.equal(installButton("pip-box").disabled, false);

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
  assert.match(text(), /Sign in from new-box’s terminal/);
  assert.match(text(), /~\/\.local\/bin\/aws configure sso --profile default/);
  assert.ok(
    page.container.querySelector(
      'button[aria-label="Copy ~/.local/bin/aws configure sso --profile default"]',
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
  const page = await render(ConnectorsFeature, { ...props, tab: "bytedcli" });
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
            answered
              ? { installerSupported: true }
              : { installerSupported: true, checking: ["aws"] },
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
            {
              installerSupported: true,
              progress: progress ? [progress] : undefined,
            },
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

test("AWS signs in from the browser: the device's AWS page, the pasted code, then ready; the terminal is folded away", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "installer", minimumVersion: "2.0.0" },
    authentication: "local",
    browserSignIn: ["console", "sso"],
  };
  const signedOut = state("dev_mac", {
    kind: "aws",
    status: "signed_out",
    installed: true,
    installSource: "foundry",
    version: "2.39.2",
    signedIn: false,
    identity: undefined,
    expiresAt: undefined,
  });
  const ready = state("dev_mac", {
    kind: "aws",
    status: "ready",
    installed: true,
    installSource: "foundry",
    version: "2.39.2",
    signedIn: true,
    identity: "arn:aws:iam::123456789012:user/me",
    expiresAt: undefined,
    checkedAt: new Date().toISOString(),
  });
  const url = "https://us-east-1.signin.aws.amazon.com/v1/authorize?state=s";
  let codeSent;
  let polls = 0;
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [aws],
        devices: [
          device("dev_mac", "mac", [signedOut], {
            browserSignInSupported: true,
          }),
        ],
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
    "POST /api/devices/dev_mac/connectors/aws/sign-in/poll": () => {
      polls++;
      return codeSent
        ? [200, { status: "complete", operationId: "op1", state: ready }]
        : [
            200,
            { status: "pending", operationId: "op1", phase: "awaiting_user" },
          ];
    },
    "POST /api/devices/dev_mac/connectors/aws/sign-in/dismiss": () => [204, {}],
  };
  const opened = [];
  window.open = () => {
    const popup = {
      closed: false,
      opener: {},
      document: { title: "", body: { textContent: "" } },
      location: { href: "about:blank" },
      close() {
        this.closed = true;
      },
    };
    opened.push(popup);
    return popup;
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const row = () => page.container.querySelector(".fdy-xacc-device-row");
  assert.match(row().textContent, /Sign in to AWS/);
  // The terminal commands are the last resort, folded.
  const fallback = row().querySelector("details.fdy-xacc-terminal-fallback");
  assert.ok(fallback && !fallback.open);
  assert.match(fallback.textContent, /aws configure sso --profile default/);
  // The Region is only a default for commands, folded until asked for.
  assert.match(
    row().textContent,
    /Signing in covers every AWS Region your account allows; commands that name no Region use us-east-1\./,
  );
  assert.equal(row().querySelector(".fdy-xacc-field input"), null);
  await page.click(page.button("Change default Region", row()));
  assert.ok(row().querySelector(".fdy-xacc-field input"));
  await page.click(page.button("Open AWS sign-in", row()));
  const begin = requests.find((r) => r.path.endsWith("/aws/sign-in"));
  assert.deepEqual(begin.body.signInOptions, {
    method: "console",
    region: "us-east-1",
  });
  // The page opened at the click goes to AWS once the device has the link.
  assert.equal(opened.length, 1);
  assert.equal(opened[0].opener, null);
  assert.equal(opened[0].location.href, url);
  const link = row().querySelector(`a[href="${url}"]`);
  assert.ok(link && link.target === "_blank" && /noopener/.test(link.rel));
  assert.ok(row().querySelector('button[aria-label="Copy the sign-in link"]'));
  const input = row().querySelector(".fdy-xacc-code-form input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(input, "ABC.def-123");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await page.click(page.button("Finish sign-in", row()));
  assert.deepEqual(codeSent, { operationId: "op1", code: "ABC.def-123" });
  await settle(3200);
  assert.ok(polls >= 1);
  assert.match(
    row().textContent,
    /Signed in as arn:aws:iam::123456789012:user\/me/,
  );
  assert.doesNotMatch(row().textContent, /Sign in to AWS/);
  await page.unmount();
});

test("AWS IAM Identity Center sign-in asks for the portal, then shows the device code to confirm", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "installer" },
    authentication: "local",
    browserSignIn: ["console", "sso"],
  };
  const signedOut = state("dev_sso", {
    kind: "aws",
    status: "signed_out",
    installed: true,
    version: "2.39.2",
    signedIn: false,
    identity: undefined,
    expiresAt: undefined,
  });
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [aws],
        devices: [
          device("dev_sso", "sso-box", [signedOut], {
            browserSignInSupported: true,
          }),
        ],
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
  window.open = () => assert.fail("no window for the device-code sign-in");
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const row = () => page.container.querySelector(".fdy-xacc-device-row");
  await page.click(page.button("Use IAM Identity Center instead", row()));
  const set = async (label, value) => {
    const field = [...row().querySelectorAll(".fdy-xacc-field")].find((f) =>
      f.textContent.startsWith(label),
    );
    const input = field.querySelector("input");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  await set(
    "Access portal (start) URL",
    "https://my-company.awsapps.com/start",
  );
  await set("AWS account ID", "123456789012");
  await set("Permission set (role) name", "Developer");
  await page.click(page.button("Get sign-in code", row()));
  const begin = requests
    .filter((r) => r.path.endsWith("/dev_sso/connectors/aws/sign-in"))
    .at(-1);
  assert.deepEqual(begin.body.signInOptions, {
    method: "sso",
    region: "us-east-1",
    startUrl: "https://my-company.awsapps.com/start",
    ssoRegion: "us-east-1",
    accountId: "123456789012",
    roleName: "Developer",
  });
  assert.match(row().textContent, /WXYZ-1234/);
  assert.ok(row().querySelector('button[aria-label="Copy code WXYZ-1234"]'));
  assert.equal(
    row().querySelector(".fdy-xacc-code-form"),
    null,
    "nothing to paste back",
  );
  await settle(3200);
  assert.match(
    row().textContent,
    /Sign-in did not finish: An error occurred \(AccessDeniedException\)/,
  );
  assert.ok(page.button("Try again", row()));
  await page.unmount();
});

test("an offline device keeps the AWS browser sign-in, waiting for the device, with the terminal still folded", async () => {
  const aws = {
    kind: "aws",
    label: "AWS CLI",
    holding: "device_held",
    adapter: "aws",
    tool: { command: "aws", source: "installer", minimumVersion: "2.0.0" },
    authentication: "local",
    browserSignIn: ["console", "sso"],
  };
  const signedOut = state("dev_away", {
    kind: "aws",
    status: "signed_out",
    installed: true,
    installSource: "foundry",
    version: "2.39.2",
    signedIn: false,
    identity: undefined,
    expiresAt: undefined,
  });
  routes = {
    "GET /api/connectors/devices": () => [
      200,
      {
        connectors: [aws],
        // Offline: the device reports no capabilities.
        devices: [
          device("dev_away", "away-mac", [signedOut], { online: false }),
        ],
      },
    ],
  };
  const page = await render(ConnectorsFeature, { ...props, tab: "aws" });
  const row = () => page.container.querySelector(".fdy-xacc-device-row");
  assert.match(row().textContent, /Sign in to AWS/);
  assert.doesNotMatch(row().textContent, /Sign in from away-mac’s terminal/);
  assert.match(
    row().textContent,
    /away-mac is offline\. Sign-in opens here once it’s back online\./,
  );
  const open = page.button("Open AWS sign-in", row());
  assert.ok(open.disabled);
  assert.ok(row().querySelector("details.fdy-xacc-terminal-fallback"));
  assert.equal(
    row().querySelector("details.fdy-xacc-terminal-fallback").open,
    false,
  );
  await page.unmount();
});
