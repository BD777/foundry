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
    value: window[key],
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

const { createRoot } = await import("react-dom/client");
const { DeviceSkills } =
  await import("../src/features/devices/device-skills.tsx");
const { SkillsFeature } =
  await import("../src/features/skills/skills-feature.tsx");

function scanned(name) {
  return {
    deviceId: "dev",
    root: "/home/me/.claude/skills",
    dirName: name,
    name,
    description: `${name} skill`,
    sizeBytes: 100,
    mtimeLabel: "",
    serverState: "unpublished",
  };
}

/** Answers /api/device-skills with `skills()` and records those requests. */
function stubDeviceSkills(skills) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    if (!String(url).includes("/api/device-skills")) {
      return new Response("[]", { status: 200 });
    }
    requests.push(String(url));
    return new Response(JSON.stringify({ roots: [], skills: skills() }), {
      status: 200,
    });
  };
  return { requests, restore: () => (globalThis.fetch = original) };
}

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    render: async (type, props) =>
      act(async () => root.render(createElement(type, props))),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a device's skills load on their own and again only when its skillsVersion moves", async () => {
  let list = [scanned("alpha")];
  const fetches = stubDeviceSkills(() => list);
  const view = await mount();
  const device = {
    id: "dev",
    label: "Mac",
    status: "connected",
    owned: true,
    skillsVersion: "1@t1/0@",
  };
  const props = {
    device,
    roots: [{ deviceId: "dev", path: "~/.claude/skills", isDefault: true }],
    workspaces: [],
    onChanged: async () => {},
  };
  try {
    await view.render(DeviceSkills, props);
    await settle();
    assert.equal(fetches.requests.length, 1);
    assert.match(fetches.requests[0], /\/api\/device-skills\?deviceId=dev$/);
    assert.match(view.container.textContent, /alpha/);

    // Workspace data refreshes with the same version: no reload.
    await view.render(DeviceSkills, { ...props, device: { ...device } });
    await settle();
    assert.equal(fetches.requests.length, 1);

    // A scan finished: the version moves and the list loads again.
    list = [scanned("alpha"), scanned("beta")];
    await view.render(DeviceSkills, {
      ...props,
      device: { ...device, skillsVersion: "2@t2/0@" },
    });
    await settle();
    assert.equal(fetches.requests.length, 2);
    assert.match(view.container.textContent, /beta/);
  } finally {
    fetches.restore();
    await view.cleanup();
  }
});

test("the workspace Skills page lists its device's local skills from the device's own list", async () => {
  const fetches = stubDeviceSkills(() => [scanned("local-draft")]);
  const view = await mount();
  const props = {
    workspaceId: "w",
    workspaceDeviceId: "dev",
    workspaces: [],
    catalog: [],
    bindings: [],
    devices: [{ id: "dev", label: "Mac", status: "connected", owned: true }],
  };
  try {
    await view.render(SkillsFeature, props);
    await settle();
    assert.equal(fetches.requests.length, 1);
    assert.match(fetches.requests[0], /\/api\/device-skills\?deviceId=dev$/);
    assert.match(view.container.textContent, /On Mac, not on the server yet/);
    assert.match(view.container.textContent, /local-draft/);
    // With skills to add right here, the empty catalog does not send people
    // to Devices.
    assert.doesNotMatch(view.container.textContent, /Go to Devices/);
  } finally {
    fetches.restore();
    await view.cleanup();
  }
});

test("a workspace device the caller does not own is not asked for its skills", async () => {
  const fetches = stubDeviceSkills(() => [scanned("local-draft")]);
  const view = await mount();
  try {
    await view.render(SkillsFeature, {
      workspaceId: "w",
      workspaceDeviceId: "dev",
      workspaces: [],
      catalog: [],
      bindings: [],
      devices: [{ id: "dev", label: "Mac", status: "connected" }],
    });
    await settle();
    assert.equal(fetches.requests.length, 0);
    assert.doesNotMatch(view.container.textContent, /local-draft/);
    assert.match(view.container.textContent, /Go to Devices/);
  } finally {
    fetches.restore();
    await view.cleanup();
  }
});
