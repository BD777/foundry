import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window();
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "MutationObserver",
  "ResizeObserver",
  "CustomEvent",
  "Event",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "NodeFilter",
  "DOMRect",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value:
      key === "window" || key === "document" || key === "navigator"
        ? window[key]
        : window[key],
  });
Object.defineProperty(globalThis, "getComputedStyle", {
  configurable: true,
  value: window.getComputedStyle.bind(window),
});
Object.defineProperty(globalThis, "requestAnimationFrame", {
  configurable: true,
  value: window.requestAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
  configurable: true,
  value: window.cancelAnimationFrame.bind(window),
});
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

await import("../src/i18n/index.ts");
const { createRoot } = await import("react-dom/client");
const { BundleToolStatus, toolInstallRows } =
  await import("../src/features/skill-library/bundle-tool-status.tsx");

const tool = { name: "feishu-cli", version: "v1.41.0", assets: [] };
const device = (id, overrides = {}) => ({
  id,
  label: id,
  status: "connected",
  lastSeenLabel: "",
  owned: true,
  capabilities: ["tool_install"],
  ...overrides,
});
const devices = [
  device("current"),
  device("older"),
  device("missing"),
  device("away", { status: "disconnected" }),
  device("legacy", { capabilities: [] }),
  device("shared", { owned: false }),
];
const deviceTools = [
  {
    deviceId: "current",
    tool: "feishu-cli",
    available: true,
    checkedAt: "",
    version: "v1.41.0",
  },
  {
    deviceId: "older",
    tool: "feishu-cli",
    available: true,
    checkedAt: "",
    version: "v1.40.0",
  },
];

test("each owned device gets a state it can act on", () => {
  assert.deepEqual(
    toolInstallRows(tool, devices, deviceTools).map((row) => [
      row.device.id,
      row.state,
    ]),
    [
      ["current", "current"],
      ["older", "older"],
      ["missing", "missing"],
      ["away", "offline"],
      ["legacy", "unsupported"],
    ],
  );
});

test("Manage installs opens the devices; Install runs for that device only", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const installed = [];
  let finish;
  try {
    await act(async () =>
      root.render(
        createElement(BundleToolStatus, {
          tool,
          devices,
          deviceTools,
          disabled: false,
          install: (target) => {
            installed.push(target.id);
            return new Promise((resolve) => (finish = resolve));
          },
        }),
      ),
    );
    assert.match(
      container.textContent,
      /installed on 1 of 5 devices · some have an older version/,
    );
    const manage = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Manage installs",
    );
    await act(async () => manage.click());
    const dialog = document.querySelector("[role=dialog]");
    assert.ok(dialog, "the dialog opened");
    const text = dialog.textContent;
    assert.match(text, /feishu-cli v1\.41\.0 on your devices/);
    assert.match(text, /older.*v1\.40\.0 installed/);
    assert.match(text, /away.*Offline/);
    assert.match(text, /legacy.*worker is too old/);
    const buttons = [...dialog.querySelectorAll("li button")].map(
      (b) => b.textContent,
    );
    assert.deepEqual(
      buttons,
      ["Update", "Install"],
      "only devices that can act get a button",
    );
    const install = [...dialog.querySelectorAll("li button")].find(
      (b) => b.textContent === "Install",
    );
    await act(async () => install.click());
    assert.deepEqual(installed, ["missing"]);
    assert.equal(install.textContent, "Installing…");
    assert.equal(install.disabled, true);
    await act(async () => finish());
    assert.equal(install.textContent, "Install");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("an npm tool needs a worker that installs npm packages, and offers its setup once installed", async () => {
  const npmTool = {
    name: "agent-browser",
    version: "0.38.2",
    source: "npm",
    package: "agent-browser",
    setup: { args: ["install"], description: "" },
  };
  const npmDevices = [
    device("ready", { capabilities: ["tool_install", "tool_sources"] }),
    device("fresh", { capabilities: ["tool_install", "tool_sources"] }),
    device("before-npm"),
  ];
  const reports = [
    {
      deviceId: "ready",
      tool: "agent-browser",
      available: true,
      checkedAt: "",
      version: "0.38.2",
    },
  ];
  assert.deepEqual(
    toolInstallRows(npmTool, npmDevices, reports).map((row) => row.state),
    ["current", "missing", "unsupported"],
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const setups = [];
  let finish;
  let fail;
  try {
    await act(async () =>
      root.render(
        createElement(BundleToolStatus, {
          tool: npmTool,
          devices: npmDevices,
          deviceTools: reports,
          disabled: false,
          install: async () => {},
          setup: (target) => {
            setups.push(target.id);
            return new Promise((resolve, reject) => {
              finish = resolve;
              fail = reject;
            });
          },
        }),
      ),
    );
    const manage = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Manage installs",
    );
    await act(async () => manage.click());
    const dialog = document.querySelector("[role=dialog]");
    assert.match(
      dialog.textContent,
      /installs agent-browser@0\.38\.2 from npm.*without running the package's install scripts/,
    );
    assert.match(dialog.textContent, /run its setup \(agent-browser install\)/);
    const buttons = () =>
      [...dialog.querySelectorAll("li button")].map((b) => b.textContent);
    assert.deepEqual(buttons(), ["Run setup", "Install"]);
    const setup = [...dialog.querySelectorAll("li button")].find(
      (b) => b.textContent === "Run setup",
    );
    await act(async () => setup.click());
    assert.deepEqual(setups, ["ready"]);
    assert.equal(setup.textContent, "Setting up…");
    assert.equal(setup.disabled, true);
    assert.match(dialog.textContent, /downloads can take a few minutes/);
    await act(async () => fail(new Error("Setting up agent-browser failed")));
    assert.match(
      dialog.querySelector('[role="alert"]').textContent,
      /Setting up agent-browser failed/,
    );
    await act(async () => setup.click());
    await act(async () => finish("Downloading Chrome\nChrome installed\n"));
    assert.equal(setup.textContent, "Run setup");
    assert.match(dialog.textContent, /Setup finished: Chrome installed/);
    assert.equal(dialog.querySelector('[role="alert"]'), null);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("a uv tool installs from PyPI on request and says when the device lacks uv", async () => {
  const uvTool = {
    name: "browser-use",
    version: "0.13.11",
    source: "uv",
    package: "browser-use",
  };
  const uvDevices = [
    device("laptop", { capabilities: ["tool_install", "tool_sources"] }),
    device("before-uv"),
  ];
  assert.deepEqual(
    toolInstallRows(uvTool, uvDevices, []).map((row) => row.state),
    ["missing", "unsupported"],
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const installs = [];
  try {
    await act(async () =>
      root.render(
        createElement(BundleToolStatus, {
          tool: uvTool,
          devices: uvDevices,
          deviceTools: [],
          disabled: false,
          install: async (target) => {
            installs.push(target.id);
            throw new Error(
              "Installing browser-use on the device failed: browser-use needs uv, which is not on this device; install uv (docs.astral.sh/uv) and try again",
            );
          },
        }),
      ),
    );
    const manage = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Manage installs",
    );
    await act(async () => manage.click());
    const dialog = document.querySelector("[role=dialog]");
    assert.match(
      dialog.textContent,
      /installs browser-use 0\.13\.11 from PyPI with the device's uv/,
    );
    assert.doesNotMatch(dialog.textContent, /Run setup|run its setup/);
    const buttons = [...dialog.querySelectorAll("li button")];
    assert.deepEqual(
      buttons.map((b) => b.textContent),
      ["Install"],
    );
    assert.match(dialog.textContent, /worker is too old to install programs/);
    await act(async () => buttons[0].click());
    assert.deepEqual(installs, ["laptop"]);
    assert.match(
      dialog.querySelector('[role="alert"]').textContent,
      /needs uv, which is not on this device; install uv/,
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
