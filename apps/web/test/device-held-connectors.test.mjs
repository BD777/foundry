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
          device("dev_mac", "macbook", [state("dev_mac")]),
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
          device("dev_vm", "sg-chaos", [
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
    ["macbook", "devbox", "laptop", "studio", "old-mac"],
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
  assert.ok(page.button("Install", none));
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
    /Not offered on sg-chaos: bytedcli needs access to the ByteDance network/,
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
          device("dev_mac", "macbook", [
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
      { status: "pending", verificationUrl: url },
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
  assert.match(dialog.textContent, /macbook starts bytedcli's own sign-in/);
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
  assert.match(notices.at(-1), /bytedcli is signed in on macbook/);
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
          device("dev_mac", "macbook", [
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
              verificationUrl: "https://cloud.bytedance.net/x",
            }
          : {
              status: "pending",
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
    /bytedcli on macbook expired yesterday\./,
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
  assert.match(confirm.textContent, /Sign bytedcli out on macbook\?/);
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

test("the workspace tab binds the person's own devices and lends to members only when asked", async () => {
  requests.length = 0;
  const notices = [];
  const view = (bindings) => ({
    workspaceId: "ws_1",
    connectors: [bytedcli],
    bindings,
    devices: [
      device("dev_mac", "macbook", [state("dev_mac")]),
      device("dev_vm", "sg-chaos", [
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
    "PUT /api/workspaces/ws_1/device-connectors": (body) => {
      bindings = [
        ...bindings.filter((binding) => binding.grantedBy !== "u_me"),
        ...body.bindings.map((binding) => ({
          workspaceId: "ws_1",
          grantedBy: "u_me",
          createdAt: iso(0),
          deviceName: "macbook",
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
  assert.match(
    section.textContent,
    /use bytedcli with that device's own sign-in/,
  );
  assert.match(
    section.textContent,
    /Sessions on macbook use its bytedcli sign-in/,
  );
  assert.equal(section.textContent.includes("sg-chaos"), false);
  assert.match(
    section.textContent,
    /Bound by other membersbob-macFor its owner's sessions/,
  );
  assert.equal(section.textContent.includes("someone@"), false);
  let boxes = section.querySelectorAll("input[type=checkbox]");
  assert.equal(boxes.length, 1);
  await tab.click(boxes[0]);
  assert.deepEqual(requests.at(-1), {
    method: "PUT",
    path: "/api/workspaces/ws_1/device-connectors",
    body: {
      bindings: [{ kind: "bytedcli", deviceId: "dev_mac", members: false }],
    },
  });
  assert.match(
    notices.at(-1),
    /Sessions here on macbook use its bytedcli sign-in/,
  );
  boxes = tab.container
    .querySelector('[role=region][aria-label="bytedcli"]')
    .querySelectorAll("input[type=checkbox]");
  assert.equal(boxes.length, 2, "lending to members is offered once bound");
  assert.equal(boxes[1].checked, false);
  await tab.click(boxes[1]);
  assert.deepEqual(requests.at(-1).body, {
    bindings: [{ kind: "bytedcli", deviceId: "dev_mac", members: true }],
  });
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
        connectors: [bytedcli],
        bindings: [],
        devices: [device("dev_mac", "macbook", [state("dev_mac")])],
      },
    ],
  };
  const tab = await render(WorkspaceConnectorsFeature, {
    workspaceId: "ws_1",
    currentUserId: "u_me",
    readOnlyReason: "You are a Viewer here; this needs Maintainer.",
    onNotice: () => {},
  });
  const boxes = tab.container.querySelectorAll("input[type=checkbox]");
  assert.ok(boxes.length > 0);
  for (const box of boxes) assert.equal(box.disabled, true);
  await tab.unmount();
});
