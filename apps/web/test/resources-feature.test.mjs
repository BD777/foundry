import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({
  url: "https://foundry.example/resources?workspace=ws_1",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
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

/** The tab's event stream; the test opens it and sends it messages. */
let stream;
globalThis.EventSource = class {
  constructor() {
    stream = this;
  }
  addEventListener() {}
  close() {}
  send(id, type, payload) {
    this.onmessage?.({
      lastEventId: id,
      data: JSON.stringify({ type, payload }),
    });
  }
};

const minute = 60_000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
const ready = { ready: true, level: "permitted" };
function instance(overrides) {
  return {
    id: `res_${overrides.key}`,
    platform: "macos",
    state: "available",
    readiness: ready,
    backends: [],
    detector: "test@1",
    discoveredAt: iso(-60 * minute),
    lastSeenAt: iso(-3 * minute),
    ...overrides,
  };
}
const studio = { kind: "device", id: "dev_a", label: "Studio" };
const laptop = { kind: "device", id: "dev_b", label: "Laptop" };
const chrome = instance({
  key: "browser/google-chrome",
  type: "browser",
  name: "Google Chrome",
  source: studio,
  backends: [
    {
      id: "foundry-worker",
      version: "0.9.1",
      mode: "listed",
      readiness: ready,
    },
  ],
  details: { path: "/Applications/Google Chrome.app" },
});
const firefox = instance({
  key: "browser/firefox",
  type: "browser",
  name: "Firefox",
  platform: "linux",
  source: laptop,
  state: "offline",
  stateReason: "The device is disconnected.",
});
const screen = instance({
  key: "computer_use/desktop",
  type: "computer_use",
  name: "Desktop",
  source: studio,
  state: "unready",
  stale: true,
  readiness: {
    ready: false,
    level: "installed",
    reason: "Screen Recording is off for the worker.",
    missing: ["tcc_screen_recording"],
  },
});
const oldSimulator = instance({
  key: "simulator/ios/1",
  type: "simulator",
  name: "iPhone 15",
  platform: "ios",
  source: studio,
  state: "gone",
  goneAt: iso(-2 * 24 * 60 * minute),
});
const sources = [
  {
    ...studio,
    online: true,
    lastReportAt: iso(-1 * minute),
    detectorErrors: [
      {
        detector: "computer-use@1",
        type: "computer_use",
        error: "timed out after 5s",
      },
    ],
    allowRemoteCommands: false,
  },
  {
    ...laptop,
    online: false,
    lastReportAt: iso(-90 * minute),
    detectorErrors: [],
    allowRemoteCommands: false,
  },
];

const reads = [];
/** Instances a test adds to the inventory; empty otherwise. */
let extraInstances = [];
/** The other requests made, and how a test answers them. */
const calls = [];
let routes = {};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "https://foundry.example");
  const method = (init.method ?? "GET").toUpperCase();
  if (url.pathname !== "/api/resources") {
    const call = {
      method,
      path: url.pathname,
      search: url.search,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    assert.ok(route, `unexpected ${method} ${url.pathname}`);
    const [status, body] = await route(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  reads.push(url.search);
  const device = url.searchParams.get("device");
  const instances = [
    chrome,
    firefox,
    screen,
    oldSimulator,
    ...extraInstances,
  ].filter(
    (item) =>
      (url.searchParams.get("includeGone") === "1" || item.state !== "gone") &&
      (!device || item.source.id === device),
  );
  return new Response(
    JSON.stringify({
      instances,
      sources: sources.filter((source) => !device || source.id === device),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const { createRoot } = await import("react-dom/client");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const { ResourcesFeature } = await import("../src/features/resources/index.ts");
const { DevicesFeature } = await import("../src/features/devices/index.ts");

async function settle() {
  await act(async () => new Promise((done) => setTimeout(done, 0)));
}

async function render(component, props = {}) {
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

const headings = (container) =>
  [...container.querySelectorAll(".fdy-res-type h2")].map(
    (node) => node.firstChild.textContent,
  );
const devicesOf = (container) =>
  [...container.querySelectorAll(".fdy-res-type")].map((group) =>
    [...group.querySelectorAll(".fdy-res-device")].map(
      (node) => node.dataset.source,
    ),
  );
const row = (container, name) =>
  [...container.querySelectorAll(".fdy-res-row")].find(
    (node) => node.querySelector("strong").textContent === name,
  );

test("the inventory is grouped by type, then device, with readiness in words", async () => {
  window.history.replaceState(null, "", "/resources?workspace=ws_1");
  reads.length = 0;
  const page = await render(ResourcesFeature);
  assert.deepEqual(reads, [""]);
  // The contract's type order; within a type, devices by label.
  assert.deepEqual(headings(page.container), ["Browser", "Computer use"]);
  assert.deepEqual(devicesOf(page.container), [["dev_b", "dev_a"], ["dev_a"]]);

  const chromeRow = row(page.container, "Google Chrome").textContent;
  assert.match(chromeRow, /macOS/);
  assert.match(chromeRow, /Available/);
  assert.match(chromeRow, /Ready · permitted/);
  assert.match(chromeRow, /Used through foundry-worker 0\.9\.1 \(detected\)/);
  assert.match(chromeRow, /path\/Applications\/Google Chrome\.app/);
  assert.match(chromeRow, /Last seen 3 minutes ago/);

  const screenRow = row(page.container, "Desktop");
  assert.equal(screenRow.dataset.state, "unready");
  assert.equal(screenRow.dataset.stale, "true");
  assert.match(
    screenRow.textContent,
    /Not ready · installed — Screen Recording is off for the worker\./,
  );
  assert.match(screenRow.textContent, /Stale/);
  assert.match(screenRow.textContent, /last known report/);

  const firefoxRow = row(page.container, "Firefox").textContent;
  assert.match(firefoxRow, /Device offline/);
  assert.match(firefoxRow, /The device is disconnected\./);

  // Each device group says whether the device is online, in words.
  const laptopHead = page.container.querySelector(
    '.fdy-res-device[data-source="dev_b"] .fdy-res-device-head',
  ).textContent;
  assert.match(laptopHead, /Laptop/);
  assert.match(laptopHead, /Offline · last report 2 hours ago/);

  const problems = page.container.querySelector(".fdy-res-problems");
  assert.match(problems.textContent, /Detection problems/);
  assert.match(
    problems.textContent,
    /Studio · Computer use: timed out after 5s/,
  );
  assert.match(problems.textContent, /Laptop is offline/);

  // Gone instances come only on request.
  assert.equal(row(page.container, "iPhone 15"), undefined);
  const showGone = page.container.querySelector(".fdy-res-check input");
  await act(async () => showGone.click());
  await settle();
  assert.equal(reads.at(-1), "?includeGone=1");
  const gone = row(page.container, "iPhone 15");
  assert.equal(gone.dataset.state, "gone");
  assert.match(gone.textContent, /Gone/);
  assert.match(gone.textContent, /Gone 2 days ago/);
  await page.unmount();
});

test("filters come from the URL once, are written back and leave with the page", async () => {
  window.history.replaceState(
    null,
    "",
    "/resources?workspace=ws_1&device=dev_a&type=computer_use",
  );
  const page = await render(ResourcesFeature);
  assert.deepEqual(headings(page.container), ["Computer use"]);
  assert.deepEqual(devicesOf(page.container), [["dev_a"]]);
  // Laptop is filtered out, so are its problems; Studio's stay.
  const problems = page.container.querySelector(".fdy-res-problems");
  assert.doesNotMatch(problems.textContent, /Laptop/);
  assert.match(problems.textContent, /timed out/);

  // Choosing every type writes the URL; the workspace stays.
  const trigger = page.container.querySelector('[aria-label^="Type:"]');
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
  const allTypes = [
    ...window.document.querySelectorAll('[role="menuitemradio"]'),
  ].find((item) => item.textContent.includes("All types"));
  assert.ok(allTypes, "the type menu offers every type");
  await act(async () => allTypes.click());
  await settle();
  assert.deepEqual(headings(page.container), ["Browser", "Computer use"]);
  const params = new URLSearchParams(window.location.search);
  assert.equal(params.get("type"), null);
  assert.equal(params.get("device"), "dev_a");
  assert.equal(params.get("workspace"), "ws_1");

  await page.unmount();
  assert.equal(window.location.search, "?workspace=ws_1");
});

test("a change on the stream or a resync reads the inventory again", async () => {
  window.history.replaceState(null, "", "/resources");
  reads.length = 0;
  const page = await render(ResourcesFeature);
  await act(async () => stream.onopen?.());
  const before = reads.length;
  await act(async () =>
    stream.send("ep-1", "resources_changed", { sourceId: "dev_a" }),
  );
  await settle();
  assert.equal(reads.length, before + 1);
  await act(async () => stream.send("ep-2", "resync", { reason: "expired" }));
  await settle();
  assert.equal(reads.length, before + 2);
  await page.unmount();
});

test("a device's Resources section sums up its inventory and opens the page", async () => {
  window.history.replaceState(
    null,
    "",
    "/devices/dev_a/resources?workspace=ws_1",
  );
  reads.length = 0;
  const pops = [];
  const onPop = () => pops.push(window.location.pathname);
  window.addEventListener("popstate", onPop);
  const view = await render(DevicesFeature, {
    devices: [{ ...studio, status: "connected", owned: true, resources: [] }],
    workspaces: [],
    activeWorkspaceId: "",
    profiles: [],
    agentProfiles: [],
    providerHealth: [],
    deviceProfiles: [],
    deviceSkillRoots: [],
    selectedDeviceId: "dev_a",
    section: "resources",
    onSelect: () => {},
    onOpenWorkspaces: () => {},
    onOpenWorkspace: async () => true,
    onRefresh: async () => {},
    onManageConnections: () => {},
  });
  assert.ok(reads.includes("?device=dev_a"), reads.join(" | "));
  const summary = view.container.querySelector(".fdy-device-resource-summary");
  assert.ok(summary, "the summary line renders");
  assert.match(summary.textContent, /2 resources · 1 not ready · 1 stale/);
  // The macOS screen-control actions keep their place below it.
  assert.match(view.container.textContent, /Detect again/);

  const open = [...summary.querySelectorAll("button")].find((node) =>
    node.textContent.includes("Open in Resources"),
  );
  await act(async () => open.click());
  assert.equal(window.location.pathname, "/resources");
  const params = new URLSearchParams(window.location.search);
  assert.equal(params.get("device"), "dev_a");
  assert.equal(params.get("workspace"), "ws_1");
  assert.deepEqual(pops, ["/resources"]);
  window.removeEventListener("popstate", onPop);
  await view.unmount();

  // Remote commands: their state, and the way to the compute row.
  window.history.replaceState(null, "", "/devices?workspace=ws_1");
  const again = await render(DevicesFeature, {
    devices: [{ ...studio, status: "connected", owned: true, resources: [] }],
    workspaces: [],
    activeWorkspaceId: "",
    profiles: [],
    agentProfiles: [],
    providerHealth: [],
    deviceProfiles: [],
    deviceSkillRoots: [],
    selectedDeviceId: "dev_a",
    section: "resources",
    onSelect: () => {},
    onOpenWorkspaces: () => {},
    onOpenWorkspace: async () => true,
    onRefresh: async () => {},
    onManageConnections: () => {},
  });
  const line = again.container.querySelector(".fdy-device-resource-remote");
  assert.match(line.textContent, /Remote commands: off\s*·\s*Manage/);
  await act(async () =>
    line
      .querySelector('button[aria-label="Manage remote commands of Studio"]')
      .click(),
  );
  const target = new URLSearchParams(window.location.search);
  assert.equal(window.location.pathname, "/resources");
  assert.equal(target.get("device"), "dev_a");
  assert.equal(target.get("type"), "compute");
  await again.unmount();
});

// --- Leases, setup and activity (the device's owner) ---

const cuaReady = {
  id: "cua-driver",
  version: "0.2.0",
  mode: "remote_ops",
  readiness: ready,
};
const held = instance({
  id: "res_mac",
  key: "computer_use/mac",
  type: "computer_use",
  name: "Mac screen",
  source: studio,
  state: "busy",
  backends: [cuaReady],
  holder: {
    leaseId: "lease_1",
    sessionId: "sess_1",
    workspaceId: "ws_2",
    state: "active",
    since: iso(-5 * minute),
    preemptAt: iso(10 * minute),
  },
  queue: 1,
});
const notInstalled = instance({
  id: "res_second",
  key: "computer_use/second",
  type: "computer_use",
  name: "Second screen",
  source: studio,
  state: "unready",
  readiness: {
    ready: false,
    level: "installed",
    missing: ["cua_driver_not_installed"],
  },
  backends: [
    {
      id: "cua-driver",
      mode: "remote_ops",
      readiness: {
        ready: false,
        level: "installed",
        reason: "cua-driver is not installed.",
        missing: ["cua_driver_not_installed"],
      },
    },
  ],
});
const needsAccess = instance({
  id: "res_third",
  key: "computer_use/third",
  type: "computer_use",
  name: "Third screen",
  source: studio,
  state: "unready",
  readiness: {
    ready: false,
    level: "installed",
    missing: ["tcc_accessibility", "tcc_screen_recording"],
  },
  backends: [
    {
      id: "cua-driver",
      mode: "remote_ops",
      readiness: {
        ready: false,
        level: "installed",
        missing: ["tcc_accessibility", "tcc_screen_recording"],
      },
    },
  ],
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const buttonIn = (node, text) =>
  [...node.querySelectorAll("button")].find((item) =>
    item.textContent.includes(text),
  );
const dialog = () => window.document.querySelector('[role="dialog"]');

async function click(node) {
  await act(async () => node.click());
  await settle();
}

async function renderOwned(owned = ["dev_a"]) {
  window.history.replaceState(null, "", "/resources?workspace=ws_1");
  extraInstances = [held, notInstalled, needsAccess];
  calls.length = 0;
  routes = {};
  return render(ResourcesFeature, { ownedDeviceIds: owned });
}

test.afterEach(() => {
  extraInstances = [];
  routes = {};
  for (const source of sources) source.allowRemoteCommands = false;
});

test("a held instance says who holds it; the owner releases it or lets it finish", async () => {
  const page = await renderOwned();
  const mac = row(page.container, "Mac screen");
  assert.equal(mac.dataset.state, "busy");
  assert.match(mac.querySelector(".fdy-badge").textContent, /In use/);
  assert.match(mac.textContent, /In use by a session/);
  assert.match(mac.textContent, /since 5 minutes ago/);
  assert.match(
    mac.textContent,
    /1 session waiting · Will be given to the waiting session at/,
  );
  assert.match(
    mac.textContent,
    /Used through cua-driver 0\.2\.0 \(operated through Foundry\) — Ready · permitted/,
  );

  // Let it finish postpones the preemption once.
  routes["POST /api/resources/res_mac/extend"] = () => [
    200,
    { lease: { id: "lease_1", preemptAt: iso(25 * minute) } },
  ];
  await click(buttonIn(mac, "Let it finish"));
  assert.deepEqual(
    calls.map((call) => [call.method, call.path, call.body]),
    [["POST", "/api/resources/res_mac/extend", {}]],
  );
  assert.match(mac.textContent, /Postponed: the waiting session gets it at/);

  // Release asks first, saying what happens to the session.
  const answer = deferred();
  routes["POST /api/resources/res_mac/release"] = () => answer.promise;
  await click(buttonIn(mac, "Release"));
  assert.equal(calls.length, 1, "nothing is released before confirming");
  assert.match(dialog().textContent, /Release Mac screen\?/);
  assert.match(dialog().textContent, /next operation on it fails/);
  assert.match(dialog().textContent, /keys and mouse buttons are let go/);
  await click(buttonIn(dialog(), "Release now"));
  assert.equal(dialog(), null);
  assert.deepEqual(calls.at(-1).path, "/api/resources/res_mac/release");
  const busy = buttonIn(mac, "Releasing…");
  assert.ok(busy, "the button says it is releasing");
  assert.equal(busy.disabled, true);
  assert.equal(buttonIn(mac, "Let it finish").disabled, true);
  await act(async () =>
    answer.resolve([200, { lease: { id: "lease_1", state: "revoked" } }]),
  );
  await settle();
  assert.match(mac.textContent, /Released\. The device resets it/);

  // The holder links to its session, in its workspace.
  await click(buttonIn(mac, "Open session"));
  assert.match(window.location.pathname, /sess_1/);
  assert.equal(
    new URLSearchParams(window.location.search).get("workspace"),
    "ws_2",
  );
  await page.unmount();
});

test("Stop all shows on a device group with a held instance, for its owner only", async () => {
  let page = await renderOwned([]);
  assert.equal(buttonIn(page.container, "Stop all"), undefined);
  assert.equal(buttonIn(page.container, "Release"), undefined);
  assert.equal(buttonIn(page.container, "Install cua-driver"), undefined);
  assert.equal(buttonIn(page.container, "Activity"), undefined);
  // Who holds it is shown to everyone who sees it.
  assert.match(row(page.container, "Mac screen").textContent, /In use by/);
  await page.unmount();

  page = await renderOwned();
  const groups = [...page.container.querySelectorAll(".fdy-res-device")];
  const withStop = groups.filter((group) => buttonIn(group, "Stop all"));
  assert.equal(withStop.length, 1, "only the group holding something");
  assert.match(
    withStop[0].closest(".fdy-res-type").querySelector("h2").textContent,
    /Computer use/,
  );
  routes["POST /api/devices/dev_a/resources/stop"] = () => [
    200,
    { released: 1 },
  ];
  await click(buttonIn(withStop[0], "Stop all on Studio"));
  assert.match(
    dialog().textContent,
    /Every session using this device's resources loses its lease at once/,
  );
  assert.match(dialog().textContent, /reset/);
  await click(buttonIn(dialog(), "Stop all"));
  assert.deepEqual(calls.at(-1).path, "/api/devices/dev_a/resources/stop");
  assert.match(withStop[0].textContent, /Released 1 lease on Studio\./);
  await page.unmount();
});

test("Install cua-driver shows only when it is not installed and reports how it went", async () => {
  const page = await renderOwned();
  assert.equal(
    buttonIn(row(page.container, "Mac screen"), "Install cua-driver"),
    undefined,
  );
  assert.equal(
    buttonIn(row(page.container, "Third screen"), "Install cua-driver"),
    undefined,
  );
  const second = row(page.container, "Second screen");
  assert.match(
    second.textContent,
    /Used through cua-driver \(operated through Foundry\) — Not ready · installed — cua-driver is not installed\./,
  );
  assert.equal(buttonIn(second, "Request access"), undefined);

  const answer = deferred();
  routes["POST /api/devices/dev_a/resources/install"] = () => answer.promise;
  await click(buttonIn(second, "Install cua-driver"));
  const copy = dialog().textContent;
  assert.match(copy, /Install cua-driver on Studio\?/);
  assert.match(copy, /cua\.ai on Studio only/);
  assert.match(copy, /telemetry off/);
  assert.match(copy, /MIT license/);
  assert.match(copy, /Accessibility and Screen Recording for CuaDriver\.app/);
  assert.equal(calls.length, 0);
  await click(buttonIn(dialog(), "Install"));
  assert.deepEqual(calls.at(-1).body, { backend: "cua-driver" });
  const busy = buttonIn(second, "Installing cua-driver…");
  assert.ok(busy);
  assert.equal(busy.disabled, true);
  assert.match(second.textContent, /this can take a few minutes/);

  await act(async () =>
    answer.resolve([
      200,
      {
        backend: "cua-driver",
        ok: false,
        error: "the installer exited with 1",
        output: "fetching cua-driver\ncurl: (6) could not resolve host",
        missing: ["cua_driver_not_installed"],
      },
    ]),
  );
  await settle();
  const outcome = second.querySelector(".fdy-res-install-result");
  assert.equal(outcome.dataset.tone, "error");
  assert.match(outcome.textContent, /Could not install cua-driver on Studio/);
  assert.match(outcome.textContent, /the installer exited with 1/);
  assert.match(
    outcome.textContent,
    /Still needed: cua-driver is not installed\./,
  );
  assert.match(
    outcome.querySelector("pre").textContent,
    /could not resolve host/,
  );
  assert.equal(buttonIn(second, "Install cua-driver").disabled, false);
  await page.unmount();
});

test("Request access asks the Mac for cua-driver's grants", async () => {
  const page = await renderOwned();
  const third = row(page.container, "Third screen");
  assert.match(
    third.textContent,
    /Not ready · installed/,
    "readiness of the backend in words",
  );
  routes["POST /api/devices/dev_a/resources/refresh"] = () => [
    200,
    { resources: [], opened: [] },
  ];
  await click(buttonIn(third, "Request access"));
  assert.deepEqual(calls.at(-1).body, { requestAccess: "cua-driver" });
  assert.match(
    third.textContent,
    /Studio is asking for Accessibility, Screen Recording and screen capture for CuaDriver\.app/,
  );
  await page.unmount();
});

test("the waiting message goes once cua-driver's grants are verified", async () => {
  const page = await renderOwned();
  const third = row(page.container, "Third screen");
  const permitted = { ready: true, level: "permitted" };
  routes["POST /api/devices/dev_a/resources/refresh"] = () => {
    extraInstances = [
      held,
      notInstalled,
      {
        ...needsAccess,
        state: "available",
        readiness: permitted,
        details: { grantRun: "verified" },
        backends: [
          { id: "cua-driver", mode: "remote_ops", readiness: permitted },
        ],
      },
    ];
    return [200, { resources: [], opened: [] }];
  };
  await click(buttonIn(third, "Request access"));
  const verified = row(page.container, "Third screen");
  assert.match(
    verified.textContent,
    /cua-driver verified CuaDriver's permissions on Studio/,
  );
  assert.doesNotMatch(verified.textContent, /Approve each prompt/);
  await page.unmount();
});

test("a ready cua-driver leaves the worker's own gaps as muted side notes", async () => {
  const permitted = { ready: true, level: "permitted" };
  window.history.replaceState(null, "", "/resources?workspace=ws_1");
  extraInstances = [
    instance({
      key: "computer_use/served",
      type: "computer_use",
      name: "Served screen",
      source: studio,
      state: "available",
      readiness: permitted,
      backends: [
        {
          id: "foundry-worker",
          mode: "native_session",
          readiness: {
            ready: false,
            level: "installed",
            reason:
              "Screen Recording and Accessibility not granted to the Foundry worker",
          },
        },
        { id: "cua-driver", mode: "remote_ops", readiness: permitted },
      ],
    }),
  ];
  const page = await render(ResourcesFeature, { ownedDeviceIds: ["dev_a"] });
  const lines = [
    ...row(page.container, "Served screen").querySelectorAll(
      ".fdy-res-backends .fdy-res-meta",
    ),
  ].map((line) => [
    line.textContent.split(" ").slice(0, 3).join(" "),
    line.dataset.ready,
  ]);
  assert.deepEqual(lines, [
    ["Used through cua-driver", "true"],
    ["Used through foundry-worker", "optional"],
  ]);
  await page.unmount();
});

test("each missing grant opens its System Settings pane; the check's outcome shows", async () => {
  const page = await renderOwned();
  const third = row(page.container, "Third screen");
  assert.match(third.textContent, /turn on CuaDriver/);
  routes["POST /api/devices/dev_a/resources/refresh"] = () => [
    200,
    { resources: [], opened: ["Accessibility"] },
  ];
  await click(buttonIn(third, "Open Accessibility settings"));
  assert.deepEqual(calls.at(-1).body, {
    requestAccess: "cua-driver:accessibility",
  });
  assert.match(
    third.textContent,
    /System Settings opened on Studio at Accessibility: turn on CuaDriver/,
  );
  await click(buttonIn(third, "Open Screen Recording settings"));
  assert.deepEqual(calls.at(-1).body, {
    requestAccess: "cua-driver:screen-recording",
  });
  await page.unmount();

  const unready = {
    ready: false,
    level: "configured",
    missing: ["tcc_accessibility", "tcc_screen_recording"],
  };
  window.history.replaceState(null, "", "/resources?workspace=ws_1");
  extraInstances = [
    instance({
      key: "computer_use/failed",
      type: "computer_use",
      name: "Failed screen",
      source: studio,
      state: "unready",
      readiness: unready,
      backends: [{ id: "cua-driver", mode: "remote_ops", readiness: unready }],
      details: {
        grantTo: "CuaDriver.app",
        grantRun: "failed",
        grantOutput: "Timed out waiting on: Accessibility.",
        permissionCheck: "live",
      },
    }),
  ];
  const failed = await render(ResourcesFeature, { ownedDeviceIds: ["dev_a"] });
  const screen = row(failed.container, "Failed screen");
  const outcome = screen.querySelector(".fdy-res-install-result");
  assert.equal(outcome.dataset.tone, "error");
  assert.match(
    outcome.textContent,
    /cua-driver could not verify CuaDriver's permissions on Studio/,
  );
  assert.match(
    outcome.querySelector("pre").textContent,
    /Timed out waiting on: Accessibility/,
  );
  assert.match(outcome.textContent, /Try again restarts CuaDriver on Studio/);
  assert.equal(buttonIn(screen, "Request access"), undefined);
  await click(buttonIn(screen, "Try again"));
  assert.deepEqual(calls.at(-1).body, { requestAccess: "cua-driver" });
  assert.doesNotMatch(
    screen.querySelector(".fdy-res-details")?.textContent ?? "",
    /grantRun|permissionCheck/,
    "the check is shown with its backend, not as raw details",
  );
  await failed.unmount();
});

test("cua-driver's readiness leads the headline; the worker's own grants come second", async () => {
  const waiting = {
    ready: false,
    level: "configured",
    reason:
      "Waiting for you on the Mac: approve CuaDriver's Accessibility, Screen Recording and screen-capture prompts.",
    missing: ["cua_driver_awaiting_approval"],
  };
  window.history.replaceState(null, "", "/resources?workspace=ws_1");
  extraInstances = [
    instance({
      key: "computer_use/both",
      type: "computer_use",
      name: "Both screen",
      source: studio,
      state: "unready",
      readiness: ready,
      backends: [
        { id: "foundry-worker", mode: "native_session", readiness: ready },
        { id: "cua-driver", mode: "remote_ops", readiness: waiting },
      ],
    }),
  ];
  const fresh = await render(ResourcesFeature, { ownedDeviceIds: ["dev_a"] });
  const both = row(fresh.container, "Both screen");
  assert.match(
    both.querySelector(".fdy-res-readiness").textContent,
    /^Not ready · configured — Waiting for you on the Mac/,
  );
  const lines = [...both.querySelectorAll(".fdy-res-backends > li")].map(
    (item) => item.textContent,
  );
  assert.match(lines[0], /^Used through cua-driver/);
  assert.match(
    lines[1],
    /^Used through foundry-worker \(sessions on the device only\)/,
  );
  assert.equal(buttonIn(both, "Request access"), undefined, "already asking");
  await fresh.unmount();
});

test("Activity lists an instance's latest operations, with empty and error states", async () => {
  const page = await renderOwned();
  routes["GET /api/resources/res_mac/operations"] = () => [
    200,
    {
      operations: [
        {
          id: "op_2",
          leaseId: "lease_1",
          resourceId: "res_mac",
          sessionId: "sess_1",
          op: "type_text",
          args: { text: 12 },
          status: "error",
          errorCode: "stale_frame",
          startedAt: iso(-1 * minute),
          durationMs: 7,
          bytesOut: 0,
        },
        {
          id: "op_1",
          leaseId: "lease_1",
          resourceId: "res_mac",
          sessionId: "sess_1",
          op: "click",
          args: { x: 10, y: 20 },
          status: "ok",
          startedAt: iso(-2 * minute),
          durationMs: 42,
          bytesOut: 120,
        },
      ],
    },
  ];
  await click(buttonIn(row(page.container, "Mac screen"), "Activity"));
  assert.equal(calls.at(-1).search, "?limit=50");
  const items = [...dialog().querySelectorAll(".fdy-res-op")];
  assert.equal(items.length, 2);
  assert.match(dialog().textContent, /Activity on Mac screen/);
  assert.match(items[0].textContent, /type_text/);
  assert.match(items[0].textContent, /Failed · stale_frame/);
  assert.match(items[0].textContent, /text: 12/);
  assert.match(items[1].textContent, /click/);
  assert.match(items[1].textContent, /OK/);
  assert.match(items[1].textContent, /42 ms/);
  assert.match(items[1].textContent, /x: 10, y: 20/);
  assert.match(items[1].textContent, /2 minutes ago/);
  assert.ok(buttonIn(items[0], "Open session"));
  await act(async () =>
    dialog().dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await settle();
  assert.equal(dialog(), null);

  routes["GET /api/resources/res_second/operations"] = () => [
    200,
    { operations: [] },
  ];
  await click(buttonIn(row(page.container, "Second screen"), "Activity"));
  assert.match(dialog().textContent, /No operations yet/);
  await act(async () =>
    dialog().dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  await settle();

  routes["GET /api/resources/res_third/operations"] = () => [
    500,
    { error: "the audit is unavailable" },
  ];
  await click(buttonIn(row(page.container, "Third screen"), "Activity"));
  assert.match(dialog().textContent, /Could not read the activity/);
  assert.match(dialog().textContent, /the audit is unavailable/);
  await page.unmount();
});

// --- Compute: the machine itself, and its owner's remote-commands switch ---

const computeDetails = {
  cpus: "10",
  memoryGiB: "16",
  os: "darwin",
  arch: "arm64",
  loadAvg: "1.2",
};
const studioCompute = instance({
  id: "res_compute_a",
  key: "compute",
  type: "compute",
  name: "Studio compute",
  source: studio,
  details: computeDetails,
});
const laptopCompute = instance({
  id: "res_compute_b",
  key: "compute",
  type: "compute",
  name: "Laptop compute",
  platform: "linux",
  source: laptop,
  state: "offline",
  details: { ...computeDetails, os: "linux", arch: "x64", cpus: "1" },
});
const allowLabel = "Allow remote commands from my sessions";
const allowSwitch = (node) =>
  [...node.querySelectorAll("label")]
    .find((label) => label.textContent.includes(allowLabel))
    ?.querySelector('input[type="checkbox"]');

async function renderCompute(owned, compute = [studioCompute, laptopCompute]) {
  window.history.replaceState(null, "", "/resources?workspace=ws_1");
  extraInstances = compute;
  calls.length = 0;
  routes = {};
  return render(ResourcesFeature, { ownedDeviceIds: owned });
}

test("a compute instance's details read as one line", async () => {
  const page = await renderCompute([]);
  assert.ok(headings(page.container).includes("Compute"));
  const studioRow = row(page.container, "Studio compute");
  assert.match(
    studioRow.textContent,
    /10 CPUs · 16 GiB · macOS arm64 · load 1\.2/,
  );
  assert.equal(studioRow.querySelector(".fdy-res-details"), null);
  assert.match(
    row(page.container, "Laptop compute").textContent,
    /1 CPU · 16 GiB · Linux x64 · load 1\.2/,
  );
  await page.unmount();
});

test("the remote-commands switch shows on the owner's compute instance only", async () => {
  let page = await renderCompute([]);
  assert.equal(allowSwitch(page.container), undefined);
  await page.unmount();

  page = await renderCompute(["dev_a"]);
  const control = allowSwitch(row(page.container, "Studio compute"));
  assert.ok(control, "the owner's device has it");
  assert.equal(control.checked, false, "off by default");
  assert.match(
    row(page.container, "Studio compute").textContent,
    /run as the worker's user in Foundry's scratch folder.*audited.*On by default; turn off to stop your sessions on other devices/,
  );
  assert.equal(allowSwitch(row(page.container, "Laptop compute")), undefined);
  // Other types never get it.
  assert.equal(allowSwitch(row(page.container, "Google Chrome")), undefined);

  // Turning it on saves at once; while saving it cannot be changed.
  const answer = deferred();
  routes["PUT /api/devices/dev_a/resources/settings"] = () => answer.promise;
  await click(control);
  assert.deepEqual(
    calls.map((call) => [call.method, call.path, call.body]),
    [
      [
        "PUT",
        "/api/devices/dev_a/resources/settings",
        { allowRemoteCommands: true },
      ],
    ],
  );
  const saving = allowSwitch(row(page.container, "Studio compute"));
  assert.equal(saving.disabled, true);
  assert.equal(saving.checked, true);
  assert.match(row(page.container, "Studio compute").textContent, /Saving…/);
  sources[0].allowRemoteCommands = true;
  await act(async () =>
    answer.resolve([200, { allowRemoteCommands: true, applied: false }]),
  );
  await settle();
  const saved = allowSwitch(row(page.container, "Studio compute"));
  assert.equal(saved.disabled, false);
  assert.equal(saved.checked, true);
  assert.match(
    row(page.container, "Studio compute").textContent,
    /takes effect once Studio's worker is online and up to date/,
  );

  // A refusal says the server's words and keeps the saved state.
  routes["PUT /api/devices/dev_a/resources/settings"] = () => [
    403,
    { error: "only the device's owner may change this" },
  ];
  await click(saved);
  assert.equal(calls.at(-1).body.allowRemoteCommands, false);
  const refused = row(page.container, "Studio compute");
  assert.match(
    refused.querySelector('[role="alert"]').textContent,
    /only the device's owner may change this/,
  );
  assert.equal(allowSwitch(refused).checked, true);
  await page.unmount();
});

test("turning remote commands off while a session holds compute asks first", async () => {
  sources[0].allowRemoteCommands = true;
  const page = await renderCompute(
    ["dev_a"],
    [
      {
        ...studioCompute,
        state: "busy",
        holder: {
          leaseId: "lease_c",
          sessionId: "sess_c",
          state: "active",
          since: iso(-2 * minute),
        },
      },
    ],
  );
  const control = allowSwitch(row(page.container, "Studio compute"));
  assert.equal(control.checked, true);
  routes["PUT /api/devices/dev_a/resources/settings"] = () => [
    200,
    { allowRemoteCommands: false, applied: true },
  ];
  await click(control);
  assert.equal(calls.length, 0, "nothing is saved before confirming");
  assert.match(dialog().textContent, /Stop remote commands on Studio\?/);
  assert.match(dialog().textContent, /ends its use at once/);
  await click(buttonIn(dialog(), "Turn off"));
  assert.equal(dialog(), null);
  assert.deepEqual(calls.at(-1).body, { allowRemoteCommands: false });
  await page.unmount();
});
