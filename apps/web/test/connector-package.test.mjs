import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";

register("./bundler-resolve.mjs", import.meta.url);

const window = new Window({
  url: "https://foundry.example/workspace?workspace=ws_test",
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

await import("../src/i18n/index.ts");
const { i18n } = await import("../src/i18n/index.ts");
const { createRoot } = await import("react-dom/client");
const { ConnectorPackage, packageToolVersion } =
  await import("../src/features/external-accounts/connector-package.tsx");
await i18n.changeLanguage("en");

const connector = {
  kind: "openlark",
  label: "OpenLark",
  holding: "device_held",
  adapter: "extension:openlark",
  tool: { command: "olk" },
  package: {
    upstream: {
      via: "github",
      repository: "https://github.com/nwverse/open-lark",
    },
    skills: { path: "plugins/open-lark/skills" },
    tools: [
      {
        command: "olk",
        source: "repository",
        path: "plugins/open-lark",
        bins: { olk: "bin/olk", "olk-ctx": "bin/olk-ctx" },
      },
    ],
  },
};
const repository = {
  id: "repo_openlark",
  url: "https://github.com/nwverse/open-lark",
  label: "github.com/nwverse/open-lark",
  subpath: "plugins/open-lark/skills",
  mode: "bundle",
  name: "OpenLark",
  commit: "abcdef1234567890",
  createdAt: "",
  skills: [
    {
      skillId: "sk_docs",
      dir: "plugins/open-lark/skills/olk-docs",
      commit: "abcdef1234567890",
      name: "olk-docs",
    },
    {
      skillId: "sk_setup",
      dir: "plugins/open-lark/skills/setup",
      commit: "abcdef1234567890",
      name: "setup",
    },
  ],
};
const view = {
  connector,
  enabled: true,
  repositoryId: repository.id,
  devices: [
    {
      deviceId: "dev_mac",
      name: "Ada's MacBook",
      online: true,
      selected: true,
      eligible: true,
    },
    {
      deviceId: "dev_linux",
      name: "Build Linux",
      online: true,
      selected: false,
      eligible: true,
    },
    {
      deviceId: "dev_offline",
      name: "Home mini",
      online: false,
      selected: false,
      eligible: false,
      reason: "The device is offline.",
    },
  ],
};

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

test("package devices explain eligibility and save only the chosen set", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const writes = [];
  const saved = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), window.location.href).pathname;
    assert.equal(path, "/api/connector-packages/openlark/devices");
    const body = JSON.parse(String(init.body));
    writes.push({ method: init.method, body });
    const updated = {
      ...view,
      devices: view.devices.map((device) => ({
        ...device,
        selected: body.deviceIds.includes(device.deviceId),
      })),
    };
    return new Response(JSON.stringify(updated), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await act(async () =>
      root.render(
        createElement(ConnectorPackage, {
          view,
          repository,
          onSaved: (next) => saved.push(next),
          onNotice: () => {},
        }),
      ),
    );
    await settle();

    assert.equal(packageToolVersion(repository), "abcdef1");
    const text = document.body.textContent.replace(/\s+/g, " ");
    assert.match(text, /olk · abcdef1/);
    assert.match(text, /Build Linux/);
    assert.match(text, /Online now\. Select this device/);
    assert.match(text, /Cannot enable: the device is offline/);
    assert.match(text, /olk-docs/);

    const byDevice = (name) =>
      [...document.querySelectorAll('input[type="checkbox"]')].find((input) =>
        input.getAttribute("aria-label")?.includes(name),
      );
    assert.equal(byDevice("Ada's MacBook").checked, true);
    assert.equal(
      byDevice("Build Linux").checked,
      false,
      "new device is not auto-selected",
    );
    assert.equal(byDevice("Home mini").disabled, true);

    const save = [...document.querySelectorAll("button")].find(
      (button) => button.textContent.trim() === "Save devices",
    );
    assert.equal(save.disabled, true, "unchanged selection needs no save");
    await act(async () => byDevice("Build Linux").click());
    assert.equal(save.disabled, false);
    await act(async () => save.click());
    await settle();

    assert.equal(writes.length, 1);
    assert.equal(writes[0].method, "PUT");
    assert.deepEqual(writes[0].body.deviceIds.sort(), ["dev_linux", "dev_mac"]);
    assert.equal(saved.length, 1);
    const skillLinks = [...document.querySelectorAll("a")].filter((link) =>
      link.textContent.includes("olk-docs"),
    );
    assert.equal(skillLinks.length, 1);
    const target = new URL(skillLinks[0].href);
    assert.equal(target.pathname, "/skill-library");
    assert.equal(target.searchParams.get("repository"), "repo_openlark");
    assert.equal(target.searchParams.get("skill"), "sk_docs");
    assert.equal(target.searchParams.get("workspace"), "ws_test");
  } finally {
    globalThis.fetch = original;
    await act(async () => root.unmount());
    container.remove();
  }
});
