import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
register("./bundler-resolve.mjs", import.meta.url);
const window = new Window({ url: "https://fixture.example/" });
for (const name of [
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: window[name],
  });
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: window,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "BroadcastChannel", {
  configurable: true,
  value: undefined,
});
globalThis.EventSource = class {
  readyState = 1;
  constructor() {
    queueMicrotask(() => this.onopen?.({}));
  }
  addEventListener() {}
  close() {}
};
const { createRoot } = await import("react-dom/client");
const { useSessionWork } =
  await import("../src/features/chat/use-session-work.ts");
const { mixedSidebarInventory } =
  await import("./fixtures/timer-sidebar-data.ts");

test("sidebar controller cannot post bulk/hidden controls and retries a visible timer with the same key", async () => {
  let items = mixedSidebarInventory();
  const beforeService = structuredClone(items.find((x) => x.id === "service"));
  const posts = [];
  let fail = true;
  const reply = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json" },
    });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/operations")) {
      posts.push(JSON.parse(init.body));
      return fail
        ? reply({ error: "Response lost" }, 503)
        : reply({ id: "op", state: "pending" });
    }
    return reply({ items, operations: [], coverage: {}, barrier: false });
  };
  let controller;
  function Probe() {
    controller = useSessionWork("fixture-session");
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(Probe)));
    const timer = controller.list.items.find((x) => x.id === "timer-active");
    const service = controller.list.items.find((x) => x.id === "service");
    const nativeAgent = controller.list.items.find(
      (x) => x.id === "agent-native",
    );
    await act(async () => {
      await controller.control("stop_all");
      await controller.control("stop_all", timer);
      await controller.control("pause_all", timer);
      await controller.control("stop", service);
      await controller.control("stop", nativeAgent);
    });
    assert.equal(posts.length, 0);
    await act(async () => controller.control("pause", timer));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, "timer-active");
    assert.equal(posts[0].action, "pause");
    assert.equal(posts[0].expectedRevision, 1);
    assert.equal(controller.controlTargetId, "timer-active");
    assert.match(controller.controlError, /Response lost/);
    fail = false;
    await act(async () => controller.retryControl());
    assert.deepEqual(posts[1], posts[0]);
    assert.deepEqual(
      items.find((x) => x.id === "service"),
      beforeService,
    );

    fail = true;
    await act(async () => controller.control("stop", timer));
    const count = posts.length;
    items = items.map((x) =>
      x.id === "timer-active" ? { ...x, kind: "process" } : x,
    );
    await act(async () => controller.refresh());
    await act(async () => controller.retryControl());
    assert.equal(
      posts.length,
      count,
      "a retry must not act on a now-hidden record",
    );
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
  }
});
