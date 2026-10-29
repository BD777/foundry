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
  "CustomEvent",
  "Event",
  "SubmitEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
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

const { WorkspaceServiceTunnels } =
  await import("../src/components/workspace/workspace-service-tunnels.tsx");
const { i18n } = await import("../src/i18n/index.ts");
await i18n.changeLanguage("en");
const answer = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const item = {
  id: "mapped",
  workspaceId: "source",
  targetWorkspaceId: "remote",
  deviceId: "remote-device",
  deviceLabel: "Actual remote device",
  targetWorkspaceName: "Execution workspace",
  ownerUserId: "owner",
  name: "Existing application",
  port: 18082,
  protocol: "http",
  visibility: "private",
  enabled: true,
  revision: 4,
  createdAt: "",
  updatedAt: "",
  status: "ready",
  url: "https://app.preview.example",
  canManage: true,
};
const inventory = (items = [item]) => ({
  items,
  targets: [],
  canManage: false,
  configured: true,
  routed: true,
});
async function mount(id = "source") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (workspaceId) =>
    act(async () =>
      root.render(
        createElement(WorkspaceServiceTunnels, { workspaceId, services: [] }),
      ),
    );
  await render(id);
  return {
    container,
    render,
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
test("malformed endpoint inventory fails visibly without granting controls", async () => {
  globalThis.fetch = async () => answer([]);
  const view = await mount();
  assert.match(view.container.textContent, /Invalid service mapping inventory/);
  assert.equal(view.container.querySelector("button"), null);
  await view.close();
});
test("read-only endpoint status names the actual device and old worker cannot open", async () => {
  globalThis.fetch = async () =>
    answer(
      inventory([
        { ...item, status: "worker_update_required", canManage: false },
      ]),
    );
  const view = await mount();
  assert.match(view.container.textContent, /Actual remote device/);
  assert.match(view.container.textContent, /Execution workspace/);
  assert.match(view.container.textContent, /Worker update needed/);
  const buttons = [...view.container.querySelectorAll("button")];
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].disabled, true);
  assert.equal(view.container.querySelector('input[type="checkbox"]'), null);
  await view.close();
});
async function menuItem(container, label) {
  const trigger = container.querySelector('[aria-label^="Actions for"]');
  await act(async () =>
    trigger.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  return [...document.querySelectorAll('[role="menuitem"]')].find(
    (node) => node.textContent.trim() === label,
  );
}
test("closing access changes only the mapping and carries its revision", async () => {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") {
      writes.push({ url, body: JSON.parse(options.body) });
      return answer({ ...item, enabled: false, revision: 5 });
    }
    return answer(inventory());
  };
  const view = await mount();
  const close = await menuItem(view.container, "Close access");
  assert.ok(close, "close access is in the row menu");
  await act(async () => close.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  assert.equal(writes.length, 1);
  assert.match(writes[0].url, /\/service-tunnels\/mapped$/);
  assert.equal(writes[0].body.enabled, false);
  assert.equal(writes[0].body.expectedRevision, 4);
  assert.equal(writes[0].body.targetWorkspaceId, "remote");
  await view.close();
});
test("an unverified public route shows why and offers no link", async () => {
  globalThis.fetch = async () =>
    answer({
      ...inventory([{ ...item, status: "preview_unrouted", url: "" }]),
      routed: false,
    });
  const view = await mount();
  assert.match(view.container.textContent, /isn't routed to this server yet/);
  assert.match(view.container.textContent, /Not reachable yet/);
  const open = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Open",
  );
  assert.equal(open.disabled, true);
  await view.close();
});
test("sharing asks first and names who gains access", async () => {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "PUT") {
      writes.push(JSON.parse(options.body));
      return answer({ ...item, visibility: "workspace", revision: 5 });
    }
    return answer(inventory());
  };
  const view = await mount();
  const share = await menuItem(view.container, "Share with workspace members…");
  await act(async () => share.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  assert.equal(writes.length, 0, "nothing is shared before confirming");
  const dialog = document.querySelector("[role=dialog]");
  assert.match(
    dialog.textContent,
    /Member or above in this workspace, now and later/,
  );
  assert.match(dialog.textContent, /debugger, Docker/);
  const confirm = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "Share",
  );
  await act(async () => confirm.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  assert.equal(writes[0]?.visibility, "workspace");
  await view.close();
});
test("a stopped server says so, and removal asks first", async () => {
  const deletes = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "DELETE") {
      deletes.push(String(url));
      return new Response(null, { status: 204 });
    }
    return answer(
      inventory([
        {
          ...item,
          status: "not_listening",
          lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      ]),
    );
  };
  const view = await mount();
  assert.match(view.container.textContent, /Not running/);
  assert.match(view.container.textContent, /seen 5 minutes ago/);
  const open = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Open",
  );
  assert.equal(open.disabled, true);
  const remove = await menuItem(view.container, "Remove…");
  await act(async () => remove.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  assert.equal(deletes.length, 0, "nothing is removed before confirming");
  const dialog = document.querySelector("[role=dialog]");
  assert.match(dialog.textContent, /keeps running/);
  const confirm = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "Remove",
  );
  await act(async () => confirm.click());
  await act(async () => new Promise((r) => setTimeout(r, 0)));
  assert.equal(deletes.length, 1);
  assert.match(deletes[0], /\/service-tunnels\/mapped$/);
  await view.close();
});
test("a detected workspace listener publishes as a private local service", async () => {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") {
      writes.push(JSON.parse(options.body));
      return answer({ ...item, id: "new" });
    }
    return answer({
      ...inventory([]),
      detected: [{ port: 18555, process: "python3 serve.py" }],
    });
  };
  const view = await mount();
  assert.match(view.container.textContent, /Detected in this workspace/);
  assert.match(view.container.textContent, /python3 serve.py/);
  assert.doesNotMatch(view.container.textContent, /No web services yet/);
  const publish = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Publish",
  );
  await act(async () => publish.click());
  assert.equal(writes.length, 1);
  assert.deepEqual(
    {
      name: writes[0].name,
      port: writes[0].port,
      visibility: writes[0].visibility,
      targetWorkspaceId: writes[0].targetWorkspaceId,
    },
    {
      name: "python3 serve.py :18555",
      port: 18555,
      visibility: "private",
      targetWorkspaceId: "source",
    },
  );
  await view.close();
});
test("adding a service starts from a detected port on this workspace's device", async () => {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (options?.method === "POST") {
      writes.push(JSON.parse(options.body));
      return answer({ ...item, id: "new" });
    }
    return answer({
      ...inventory([]),
      canManage: true,
      detected: [{ port: 18555, process: "node server.js", tls: true }],
    });
  };
  const view = await mount();
  const add = [...view.container.querySelectorAll("button")].find(
    (b) => b.textContent === "Add web service",
  );
  await act(async () => add.click());
  assert.doesNotMatch(view.container.textContent, /Executing device/);
  assert.match(view.container.textContent, /Advanced/);
  const name = view.container.querySelector("form input");
  assert.equal(name.value, "node server.js :18555");
  const submit = [...view.container.querySelectorAll("form button")].find(
    (b) => b.getAttribute("type") === "submit",
  );
  await act(async () => submit.click());
  assert.equal(writes.length, 1);
  assert.equal(writes[0].port, 18555);
  assert.equal(writes[0].targetWorkspaceId, "source");
  assert.equal("protocol" in writes[0], false, "protocol left to detection");
  await view.close();
});
test("slow polling is coalesced and previous workspace replies cannot disclose its endpoints", async () => {
  const original = globalThis.setInterval;
  let poll;
  globalThis.setInterval = (callback) => ((poll = callback), 1);
  let resolve;
  const pending = new Promise((r) => (resolve = r));
  let reads = 0;
  try {
    globalThis.fetch = (url) => {
      if (String(url).includes("/source/")) {
        reads++;
        return pending;
      }
      return Promise.resolve(answer(inventory([])));
    };
    const view = await mount();
    await act(async () => {
      poll();
      poll();
    });
    assert.equal(reads, 1);
    await view.render("next");
    await act(async () => resolve(answer(inventory())));
    assert.doesNotMatch(view.container.textContent, /Existing application/);
    assert.match(view.container.textContent, /No web services yet/);
    await view.close();
  } finally {
    globalThis.setInterval = original;
  }
});
